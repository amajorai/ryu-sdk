"""One error type for every Ryu standalone service.

Mirrors ``packages/services/src/errors.ts`` and ``status-codes.ts``: each
service answers errors in its own envelope (problem+json on the control-plane
host, ``{ok:false,type:"notify.error",...}`` from Notify and Box, OpenAI-style
``{error:{message,type,code}}`` from Gateway, ``{code,error}`` from Connect,
``{error:"<code>", message}`` from Messaging, and so on).
:func:`parse_error_response` reads all of them into a :class:`RyuError` whose
``code`` is stable and safe to branch on, in the same detection order as the
TypeScript SDK.

Every error is a subclass of :class:`RyuError`, which is itself an
``Exception``. In object mode (``Ryu(result="object")``) the same instances
are returned in ``Result.error`` instead of being raised.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from typing import Any, Optional, Union
from urllib.parse import urlsplit

from ._service_titles import SERVICE_TITLES
from .transport import (
    Deprecation,
    RateLimit,
    is_retryable_failure,
    parse_deprecation,
    parse_retry_after,
    read_rate_limit,
)

#: The services this SDK talks to. Values match the TypeScript ``RyuService``
#: union so logs and ``to_dict()`` output line up across languages.
SERVICES = (
    "managedAgents",
    "messaging",
    "mail",
    "notify",
    "box",
    "gateway",
    "connect",
    "passport",
    "sites",
)

#: HTTP status -> ``(code, title)``, lockstep with ``STATUS_CODES`` in
#: packages/services/src/status-codes.ts (checked by the vectors test).
STATUS_CODES: dict[int, tuple[str, str]] = {
    400: ("bad_request", "Bad Request"),
    401: ("unauthenticated", "Unauthorized"),
    403: ("forbidden", "Forbidden"),
    404: ("not_found", "Not Found"),
    405: ("method_not_allowed", "Method Not Allowed"),
    409: ("conflict", "Conflict"),
    410: ("gone", "Gone"),
    413: ("payload_too_large", "Content Too Large"),
    415: ("unsupported_media_type", "Unsupported Media Type"),
    422: ("unprocessable_content", "Unprocessable Content"),
    429: ("rate_limited", "Too Many Requests"),
    500: ("internal_error", "Internal Server Error"),
    502: ("bad_gateway", "Bad Gateway"),
    503: ("service_unavailable", "Service Unavailable"),
    504: ("gateway_timeout", "Gateway Timeout"),
}


def describe_status(status: int) -> tuple[str, str]:
    """The default ``(code, title)`` for ``status``."""
    found = STATUS_CODES.get(status)
    if found is not None:
        return found
    return ("server_error", "Server Error") if status >= 500 else ("client_error", "Client Error")


def redact_url(url: str) -> str:
    """Drops the query string and fragment so tokens in URLs never reach logs."""
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return re.split(r"[?#]", url)[0]
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}{parts.path}"
    return re.split(r"[?#]", url)[0]


#: The label between a RyuError's own message and the hint appended to it.
_HINT_LABEL = "Hint:"

#: Sentence-ending punctuation: a message ending in one takes the hint without an added period.
_SENTENCE_END = re.compile(r"[.!?]$")


def _without_sentence_end(text: str) -> str:
    """``text`` without trailing whitespace and one trailing sentence-ending mark."""
    return _SENTENCE_END.sub("", text.rstrip(), count=1)


def _ends_with_hint(message: str, hint: str) -> bool:
    """Whether ``message`` already ends with ``hint``, ignoring a final period on either.

    Only the end counts: a short hint such as ``key`` that appears
    mid-message is still appended.
    """
    tail = _without_sentence_end(hint)
    return bool(tail) and _without_sentence_end(message).endswith(tail)


def message_with_hint(message: str, hint: Optional[str]) -> str:
    """``message`` with ``hint`` appended as `` Hint: <hint>``.

    Mirrors ``messageWithHint`` in ``@ryuhq/services`` so the message alone
    says what to do next (in a log line, ``str(error)`` or a traceback). The
    message is returned unchanged when there is no hint or when it already
    ends with the hint. Only the ``hint`` field is added, never the ``docs``
    field, the URL, headers or a key (a hint's own text may name a docs page).
    """
    nxt = (hint or "").strip()
    if not nxt or _ends_with_hint(message, nxt):
        return message
    base = message.rstrip()
    if not base:
        return f"{_HINT_LABEL} {nxt}"
    return f"{base}{'' if _SENTENCE_END.search(base) else '.'} {_HINT_LABEL} {nxt}"


def message_without_hint(error: RyuError) -> str:
    """A RyuError's message without the hint :func:`message_with_hint` appended.

    For output that prints the hint on its own line or in its own field. A
    message that carried the hint in its own words is returned unchanged.
    For a RyuError this is exactly the message it was built with. For an
    object without that record (one rebuilt from ``to_dict()``) only the
    `` Hint: <hint>`` suffix can be removed, so a period
    :func:`message_with_hint` added before it stays: ``bad key`` comes back
    as ``bad key.``. Mirrors ``messageWithoutHint`` in ``@ryuhq/services``.
    """
    own = getattr(error, "_own_message", None)
    if isinstance(own, str) and message_with_hint(own, error.hint) == error.message:
        return own
    hint = (error.hint or "").strip()
    if not hint:
        return error.message
    suffix = f"{_HINT_LABEL} {hint}"
    if error.message == suffix:
        return ""
    if error.message.endswith(f" {suffix}"):
        return error.message[: -(len(suffix) + 1)]
    return error.message


class RyuError(Exception):
    """A failed call to a Ryu service.

    Branch on ``code`` (stable) and, for a code you do not know, on
    ``status``. ``status`` is 0 when no response arrived (configuration,
    connection or timeout). ``retryable`` says whether retrying the same
    request could succeed; the SDK already retried when it was safe.
    ``message`` (and ``str(error)``) ends with `` Hint: <hint>`` when the
    error has a hint the message does not already end with; ``hint`` keeps
    the hint on its own and is read-only, like the TypeScript field (use
    :func:`with_ryu_error_fields` for a copy with another hint).
    """

    default_code = "client_error"
    default_retryable: Optional[bool] = None

    def __init__(
        self,
        message: str,
        *,
        service: str,
        status: int = 0,
        code: Optional[str] = None,
        title: Optional[str] = None,
        type: Optional[str] = None,
        request_id: Optional[str] = None,
        retry_after_seconds: Optional[int] = None,
        rate_limit: Optional[RateLimit] = None,
        deprecation: Optional[Deprecation] = None,
        details: Any = None,
        docs: Optional[str] = None,
        hint: Optional[str] = None,
        auth_challenge: Optional[str] = None,
        envelope: str = "client",
        method: str = "",
        url: str = "",
        idempotency_key: Optional[str] = None,
        retryable: Optional[bool] = None,
        attempts: int = 0,
    ) -> None:
        self._own_message = message
        message = message_with_hint(message, hint)
        super().__init__(message)
        self.message = message
        self.service = service
        self.status = status
        self.code = code if code is not None else self._code_for(status)
        self.title = title
        self.type = type
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds
        self.rate_limit = rate_limit
        self.deprecation = deprecation
        self.details = details
        self.docs = docs
        self._hint = hint
        self.auth_challenge = auth_challenge
        self.envelope = envelope
        self.method = method
        self.url = redact_url(url)
        self.idempotency_key = idempotency_key
        if retryable is None:
            retryable = self.default_retryable
        self.retryable = is_retryable_failure(status, self.code) if retryable is None else retryable
        self.attempts = attempts

    @classmethod
    def _code_for(cls, status: int) -> str:
        return cls.default_code

    @property
    def hint(self) -> Optional[str]:
        """The next step on its own; ``message`` already ends with it."""
        return self._hint

    @hint.setter
    def hint(self, _value: Optional[str]) -> None:
        # ``message`` and ``str(error)`` were built with the hint, so changing it in place would
        # leave them stale; a copy rebuilds both.
        raise AttributeError("RyuError.hint is read-only; use with_ryu_error_fields(error, hint=...) for a copy")

    @property
    def name(self) -> str:
        return type(self).__name__

    def _fields(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "status": self.status,
            "code": self.code,
            "title": self.title,
            "type": self.type,
            "request_id": self.request_id,
            "retry_after_seconds": self.retry_after_seconds,
            "rate_limit": self.rate_limit,
            "deprecation": self.deprecation,
            "details": self.details,
            "docs": self.docs,
            "hint": self.hint,
            "auth_challenge": self.auth_challenge,
            "envelope": self.envelope,
            "method": self.method,
            "url": self.url,
            "idempotency_key": self.idempotency_key,
            "retryable": self.retryable,
            "attempts": self.attempts,
        }

    def __reduce__(self) -> Any:
        # BaseException rebuilds from ``args`` alone, which lacks the keyword-only fields; this
        # keeps every field across pickle (ProcessPoolExecutor, multiprocessing, Celery) and copy.
        return (_rebuild_ryu_error, (type(self), message_without_hint(self), self._fields()), self.__dict__.copy())

    def __setstate__(self, state: Optional[dict[str, Any]]) -> None:
        self.__dict__.update(state or {})

    def to_dict(self) -> dict[str, Any]:
        """A plain dict for logs and tool results, in the TypeScript ``toJSON()`` shape.

        Keys are camelCase so a log line from Python and one from Node read the
        same. Never contains keys or request headers.
        """
        return {
            "name": self.name,
            "message": self.message,
            "service": self.service,
            "status": self.status,
            "code": self.code,
            "title": self.title,
            "type": self.type,
            "requestId": self.request_id,
            "retryAfterSeconds": self.retry_after_seconds,
            "rateLimit": self.rate_limit.to_dict() if self.rate_limit else None,
            "deprecation": self.deprecation.to_dict() if self.deprecation else None,
            "details": self.details,
            "docs": self.docs,
            "hint": self.hint,
            "authChallenge": self.auth_challenge,
            "envelope": self.envelope,
            "method": self.method,
            "url": self.url,
            "idempotencyKey": self.idempotency_key,
            "retryable": self.retryable,
            "attempts": self.attempts,
        }

    def __repr__(self) -> str:
        return (
            f"{self.name}(service={self.service!r}, status={self.status}, code={self.code!r}, message={self.message!r})"
        )


def _rebuild_ryu_error(cls: type[RyuError], message: str, fields: dict[str, Any]) -> RyuError:
    return cls(message, **fields)


class RyuConfigurationError(RyuError):
    """Missing or unsupported configuration. Returned, not raised, in object mode."""

    default_code = "configuration_error"
    default_retryable = False


class RyuConnectionError(RyuError):
    """The request never got a response (DNS, TCP, TLS, reset)."""

    default_code = "connection_error"


class RyuTimeoutError(RyuError):
    """``timeout`` elapsed before the response arrived."""

    default_code = "timeout"


class RyuAbortError(RyuError):
    """The caller aborted the call. Never retried.

    Kept for parity with the TypeScript SDK. Python cancellation itself
    (``asyncio.CancelledError``, ``KeyboardInterrupt``) propagates unchanged.
    """

    default_code = "aborted"
    default_retryable = False


class RyuRedirectError(RyuError):
    """The server answered with a redirect. The SDK never follows one, so keys never change origin."""

    default_code = "redirect_refused"
    default_retryable = False


class RyuInvalidRequestError(RyuError):
    """400, 413, 415 or 422: the request itself is wrong."""

    @classmethod
    def _code_for(cls, status: int) -> str:
        return describe_status(status)[0]


class RyuAuthenticationError(RyuError):
    """401: the credential is missing, malformed or revoked."""

    default_code = "unauthenticated"


class RyuPaymentRequiredError(RyuError):
    """402: billing refused the request. Never retried."""

    default_code = "payment_required"


class RyuPermissionError(RyuError):
    """403: the credential is valid but lacks the permission or feature."""

    default_code = "forbidden"


class RyuNotFoundError(RyuError):
    """404."""

    default_code = "not_found"


class RyuConflictError(RyuError):
    """409, including idempotency conflicts and stale revisions."""

    default_code = "conflict"


class RyuRateLimitError(RyuError):
    """429: slow down. ``retry_after_seconds`` says for how long when the server said so."""

    default_code = "rate_limited"


class RyuQuotaExceededError(RyuRateLimitError):
    """``quota_exceeded``: a persistent quota, not a burst limit. Never retried."""

    default_code = "quota_exceeded"
    default_retryable = False


class RyuUnavailableError(RyuError):
    """503, or a feature that is off or not configured for this deployment."""

    default_code = "service_unavailable"


class RyuServerError(RyuError):
    """Any other 5xx."""

    @classmethod
    def _code_for(cls, status: int) -> str:
        return describe_status(status)[0]


class RyuResponseValidationError(RyuError):
    """A 2xx whose body was not the JSON the SDK expects."""

    default_code = "invalid_response"
    default_retryable = False


#: The stable codes a webhook verifier fails with.
WEBHOOK_VERIFICATION_CODES = (
    "webhook_missing_headers",
    "webhook_invalid_secret",
    "webhook_invalid_signature",
    "webhook_timestamp_out_of_range",
    "webhook_payload_invalid",
)


class RyuWebhookVerificationError(RyuError):
    """A webhook delivery failed verification. Answer it with 401 and do not process it."""

    default_code = "webhook_invalid_signature"
    default_retryable = False


#: Codes that mean "this feature is off or not set up here", whatever the status.
AVAILABILITY_CODES = frozenset({"managed_agents_disabled", "not_configured", "metering_unavailable"})

_INVALID_REQUEST_STATUSES = frozenset({400, 413, 415, 422})

_STATUS_CLASSES: dict[int, type[RyuError]] = {
    401: RyuAuthenticationError,
    402: RyuPaymentRequiredError,
    403: RyuPermissionError,
    404: RyuNotFoundError,
    409: RyuConflictError,
    429: RyuRateLimitError,
    503: RyuUnavailableError,
}

_STATUS_ZERO_CLASSES: dict[str, type[RyuError]] = {
    "aborted": RyuAbortError,
    "configuration_error": RyuConfigurationError,
    "connection_error": RyuConnectionError,
    # A path id refused before any request (``path_segment`` / ``RyuPathIdError``).
    "invalid_id": RyuInvalidRequestError,
    "invalid_response": RyuResponseValidationError,
    "timeout": RyuTimeoutError,
}

#: Every error class, by name (the errors page and the vectors test read it).
ERROR_CLASSES: dict[str, type[RyuError]] = {
    cls.__name__: cls
    for cls in (
        RyuError,
        RyuConfigurationError,
        RyuConnectionError,
        RyuTimeoutError,
        RyuAbortError,
        RyuRedirectError,
        RyuInvalidRequestError,
        RyuAuthenticationError,
        RyuPaymentRequiredError,
        RyuPermissionError,
        RyuNotFoundError,
        RyuConflictError,
        RyuRateLimitError,
        RyuQuotaExceededError,
        RyuUnavailableError,
        RyuServerError,
        RyuResponseValidationError,
        RyuWebhookVerificationError,
    )
}


def error_class_for(status: int, code: str) -> type[RyuError]:
    """The subclass the TypeScript ``createRyuError`` would pick for ``status`` and ``code``."""
    if status == 0:
        return _STATUS_ZERO_CLASSES.get(code, RyuError)
    if 300 <= status < 400 or code == "redirect_refused":
        return RyuRedirectError
    if code == "quota_exceeded":
        return RyuQuotaExceededError
    if code in AVAILABILITY_CODES:
        return RyuUnavailableError
    by_status = _STATUS_CLASSES.get(status)
    if by_status is not None:
        return by_status
    if status in _INVALID_REQUEST_STATUSES:
        return RyuInvalidRequestError
    return RyuServerError if status >= 500 else RyuError


def create_ryu_error(message: str, *, service: str, status: int, code: str, **fields: Any) -> RyuError:
    """Builds the RyuError subclass that matches ``status`` and ``code``."""
    cls = error_class_for(status, code)
    return cls(message, service=service, status=status, code=code, **fields)


def _overrides_for(error: RyuError, overrides: dict[str, Any]) -> dict[str, Any]:
    """``overrides`` with a ``message`` equal to the error's own (hinted) message unhinted.

    So a copy that also replaces ``hint`` does not carry both hints.
    """
    if overrides.get("message") == error.message:
        return {**overrides, "message": message_without_hint(error)}
    return overrides


def copy_ryu_error(error: RyuError, **overrides: Any) -> RyuError:
    """The same error with some fields replaced; the subclass is chosen again from status and code."""
    fields = error._fields()
    fields.update(_overrides_for(error, overrides))
    message = fields.pop("message", None) or message_without_hint(error)
    status = fields.pop("status")
    code = fields.pop("code")
    service = fields.pop("service")
    copied = create_ryu_error(message, service=service, status=status, code=code, **fields)
    copied.__cause__ = error.__cause__
    return copied


def with_ryu_error_fields(error: RyuError, **overrides: Any) -> RyuError:
    """The same error with some fields replaced, keeping its subclass."""
    fields = error._fields()
    fields.update(_overrides_for(error, overrides))
    message = fields.pop("message", None) or message_without_hint(error)
    copied = type(error)(message, **fields)
    copied.__cause__ = error.__cause__
    return copied


def is_ryu_error(value: Any) -> bool:
    """Whether ``value`` is a :class:`RyuError`."""
    return isinstance(value, RyuError)


# ── Response parsing ──────────────────────────────────────────────────────────

#: Error bodies are read once and capped here.
MAX_ERROR_BODY_BYTES = 64 * 1024
_TEXT_MESSAGE_CHARS = 512
_ERROR_TOKEN = re.compile(r"^[a-z][a-z0-9_]*$")


def _str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value != "" else None


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, int):
        # An int past float range is Infinity once JSON.parse reads it in the TS SDK, which drops
        # non-finite numbers; drop it here too. ``float()`` rounds like JSON.parse (an int just past
        # DBL_MAX still reads as DBL_MAX) and raises only where that read gives Infinity.
        try:
            float(value)
        except OverflowError:
            return None
        return value
    if math.isnan(value) or math.isinf(value):
        return None
    return int(value) if value.is_integer() else value


def _first(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def _is_problem(body: Mapping[str, Any], content_type: str) -> bool:
    return "problem+json" in content_type or (
        isinstance(body.get("type"), str)
        and isinstance(body.get("title"), str)
        and isinstance(body.get("status"), (int, float))
        and not isinstance(body.get("status"), bool)
    )


def _rest(body: Mapping[str, Any], drop: tuple[str, ...]) -> Optional[dict[str, Any]]:
    rest = {key: value for key, value in body.items() if key not in drop}
    return rest or None


def _problem_fields(body: Mapping[str, Any], status_code: str) -> dict[str, Any]:
    nested = body.get("error") if isinstance(body.get("error"), dict) else None
    details = _first(nested.get("details") if nested else None, body.get("details"))
    if details is None and nested is not None and nested.get("fields") is not None:
        details = {"fields": nested["fields"]}
    return {
        "code": _first(_str(body.get("code")), _str(nested.get("code")) if nested else None, status_code),
        "details": details,
        "docs": _first(_str(body.get("docs")), _str(body.get("type"))),
        "envelope": "problem+json",
        "hint": _str(body.get("hint")),
        "message": _first(
            _str(body.get("detail")),
            _str(nested.get("message")) if nested else None,
            _str(body.get("title")),
            status_code,
        ),
        "request_id": _first(_str(body.get("requestId")), _str(nested.get("requestId")) if nested else None),
        "retry_after_seconds": _first(
            _num(body.get("retryAfterSeconds")), _num(nested.get("retry_after")) if nested else None
        ),
        "title": _str(body.get("title")),
        "type": _str(body.get("type")),
    }


def _nested_error_fields(body: Mapping[str, Any], error: Mapping[str, Any], status_code: str) -> dict[str, Any]:
    envelope = "nested-error"
    if isinstance(body.get("type"), str) and body["type"].endswith(".error"):
        envelope = "ryu-service"
    elif isinstance(error.get("type"), str):
        envelope = "openai"
    details = error.get("details")
    if details is None and error.get("fields") is not None:
        details = {"fields": error["fields"]}
    return {
        "code": _first(_str(error.get("code")), _str(body.get("code")), _str(error.get("type")), status_code),
        "details": details,
        "envelope": envelope,
        "message": _first(_str(error.get("message")), _str(body.get("message")), status_code),
        "request_id": _first(_str(error.get("requestId")), _str(body.get("requestId"))),
        "retry_after_seconds": _first(_num(error.get("retry_after")), _num(body.get("retryAfterSeconds"))),
        "type": _str(body.get("type")) if envelope == "ryu-service" else None,
    }


def _string_error_fields(service: str, body: Mapping[str, Any], error: str, status_code: str) -> dict[str, Any]:
    retry_after = _num(body.get("retryAfterSeconds"))
    code = _str(body.get("code"))
    if code:
        return {
            "code": code,
            "details": _rest(body, ("code", "error", "message", "ok", "retryAfterSeconds")),
            "envelope": "code-error",
            "message": _first(_str(body.get("message")), error),
            "retry_after_seconds": retry_after,
        }
    message = _str(body.get("message"))
    # `{error:"<code>", message}`. Passport's `error` is always prose, so it is never read as a code.
    if message and _ERROR_TOKEN.match(error) and service != "passport":
        return {
            "code": error,
            "details": _rest(body, ("error", "message")),
            "envelope": "messaging",
            "message": message,
            "retry_after_seconds": retry_after,
        }
    return {"code": status_code, "envelope": "error-string", "message": error, "retry_after_seconds": retry_after}


def _object_body_fields(
    service: str, body: Mapping[str, Any], content_type: str, status_code: str
) -> Optional[dict[str, Any]]:
    if _is_problem(body, content_type):
        return _problem_fields(body, status_code)
    error = body.get("error")
    if isinstance(error, dict):
        return _nested_error_fields(body, error, status_code)
    if isinstance(error, str):
        return _string_error_fields(service, body, error, status_code)
    code = _str(body.get("code"))
    if code:
        return {
            "code": code,
            "details": _rest(body, ("code", "error", "message", "ok", "retryAfterSeconds")),
            "envelope": "code-error",
            "message": _first(_str(body.get("message")), code),
            "retry_after_seconds": _num(body.get("retryAfterSeconds")),
        }
    message = _str(body.get("message"))
    if message:
        return {"code": status_code, "envelope": "error-message", "message": message}
    return None


def body_fields(service: str, text: str, content_type: str, status: int) -> dict[str, Any]:
    """The fields an error body contributes, before headers are applied.

    Detection order: problem+json, an object ``error``, a string ``error``, a
    bare ``code``, a bare ``message``, text, then empty.
    """
    status_code, status_title = describe_status(status)
    if text.strip() == "":
        return {"code": status_code, "envelope": "empty", "message": status_title}
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        fields = _object_body_fields(service, parsed, content_type, status_code)
        if fields is not None:
            return fields
    return {"code": status_code, "envelope": "text", "message": text.strip()[:_TEXT_MESSAGE_CHARS]}


_STANDALONE_DOCS_URL = "https://docs.ryuhq.com/docs/standalone"


def known_server_hint(
    service: str,
    status: int,
    message: str,
    problem: Optional[Mapping[str, Optional[str]]] = None,
) -> Optional[dict[str, str]]:
    """A next step for a server error whose body carries none, or ``None``.

    Mirrors ``knownServerHint`` in ``@ryuhq/services``. ``problem`` carries the
    body's ``code``, ``docs`` and ``type``. An error whose ``type`` (then
    ``docs``) names another service's standalone API page means the URL
    setting points at that service, and the hint says so. Connect's 503s for
    a lane the operator has not configured name that lane, and its 403s for a
    tool, toolkit or connection the operator has not granted say that a
    different key will not help. The self-hosted
    Mail server's bare ``email transport is not configured`` gains a hint
    naming the ``RYU_SMTP_*`` settings and a docs link, and a 429 after failed
    authentication (Notify's per-address backoff) says a correct key is
    refused until the block ends.
    """
    problem = problem or {}
    other = _other_service_named(service, problem)
    if other is not None:
        url_env = _SERVICE_URL_ENV[service]
        title = SERVICE_TITLES[service]
        return {
            "hint": (
                f"{url_env} points at {SERVICE_TITLES[other]}, not {title}: the error came from the other"
                f" service. Set {url_env} to the {title} server's URL."
            ),
            "docs": f"{_STANDALONE_DOCS_URL}/sdk/errors#default-hints",
        }
    code = problem.get("code")
    if service == "connect" and status == 503 and code:
        lane = _CONNECT_UNCONFIGURED_LANES.get(code)
        if lane is not None:
            return {
                "hint": (
                    f"This Connect has no {lane} configured. The operator sets it where Connect runs;"
                    " a different key or URL, or a retry, will not help."
                ),
                "docs": f"{_STANDALONE_DOCS_URL}/sdk/errors#default-hints",
            }
    if service == "connect" and status == 403 and code:
        grant = _CONNECT_DENIED_GRANTS.get(code)
        if grant is not None:
            return {
                "hint": (
                    f"This Connect has not granted {grant} to your tenant; Connect's tool search lists what it"
                    " grants. The operator sets grants where Connect runs (allowedTools in RYU_CONNECT_MCP_SERVERS,"
                    " or RYU_CONNECT_COMPOSIO_BINDINGS); a different key will not help."
                ),
                "docs": f"{_STANDALONE_DOCS_URL}/sdk/errors#default-hints",
            }
    if service == "mail" and status == 400 and "email transport is not configured" in message:
        return {
            "hint": (
                "The Mail server has no outbound email transport. Set RYU_SMTP_HOST and "
                "RYU_SMTP_PASSWORD (plus RYU_SMTP_PORT, RYU_SMTP_USERNAME and RYU_SMTP_FROM "
                "as needed) where the Mail server runs, restart it, and check that Mail status "
                "reports sendConfigured: true."
            ),
            "docs": f"{_STANDALONE_DOCS_URL}/mail#start-the-standalone-service",
        }
    if status == 429 and _FAILED_AUTHENTICATION.search(message):
        return {
            "hint": (
                "The service blocks an address for a while after repeated failed authentication, and refuses even a correct key"
                " until the block ends. Wait for the Retry-After delay, then fix the key before you retry, or the block starts again."
            ),
            "docs": f"{_STANDALONE_DOCS_URL}/sdk/errors#default-hints",
        }
    return None


#: The service each standalone API reference page documents. A standalone
#: server's problem ``type`` and ``docs`` link to its own page, so a page for a
#: different service means the URL setting points at that service.
_SERVICE_API_PAGES: dict[str, str] = {
    "box-api": "box",
    "connect-api": "connect",
    "gateway-api": "gateway",
    "mail-api": "mail",
    "managed-agents-api": "managedAgents",
    "messaging-api": "messaging",
    "notify-api": "notify",
    "passport-api": "passport",
    "passport-fetch-api": "passport",
    "passport-mcp-api": "passport",
    "sites-api": "sites",
}

#: Services the control-plane host serves together; one naming another's page is not a wrong URL.
_CONTROL_PLANE_SERVICES = frozenset({"managedAgents", "messaging", "mail"})

#: The env var holding each service's base URL (kept in lockstep with config.ENV_VARS).
_SERVICE_URL_ENV: dict[str, str] = {
    "box": "RYU_BOX_URL",
    "connect": "RYU_CONNECT_URL",
    "gateway": "RYU_GATEWAY_URL",
    "mail": "RYU_MAIL_URL",
    "managedAgents": "RYU_API_URL",
    "messaging": "RYU_API_URL",
    "notify": "RYU_NOTIFY_URL",
    "passport": "RYU_PASSPORT_URL",
    "sites": "RYU_SITES_URL",
}

_STANDALONE_API_PAGE_RE = re.compile(r"^https://docs\.ryuhq\.com/docs/standalone/([a-z-]+-api)(?:[#?/]|$)")


def _other_service_named(service: str, problem: Mapping[str, Optional[str]]) -> Optional[str]:
    """The other service whose API page the error's ``type`` (then ``docs``) names, or ``None``."""
    for url in (problem.get("type"), problem.get("docs")):
        match = _STANDALONE_API_PAGE_RE.match(url) if url else None
        named = _SERVICE_API_PAGES.get(match.group(1)) if match else None
        if named is None:
            continue
        same_host = named == service or (named in _CONTROL_PLANE_SERVICES and service in _CONTROL_PLANE_SERVICES)
        return None if same_host else named
    return None


#: Connect's 403 codes for a tool, toolkit or connection the operator has not
#: granted the tenant, and what each names. Connect runtime keys carry no
#: scopes, so another key cannot fix them.
_CONNECT_DENIED_GRANTS: dict[str, str] = {
    "connection_denied": "that Composio connection",
    "tool_denied": "that tool (or its account)",
    "toolkit_denied": "that toolkit",
}


#: Connect's 503 codes for a lane the operator has not configured, and the
#: lane each names. Retrying, or another key or URL, cannot fix them.
_CONNECT_UNCONFIGURED_LANES: dict[str, str] = {
    "upstream_unconfigured": (
        "tool lane (native: RYU_CONNECT_MCP_SERVERS or RYU_CONNECT_COMPOSIO_BINDINGS; single-tenant compatibility"
        " mode: RYU_CONNECT_CORE_URL for search, RYU_CONNECT_GATEWAY_URL for execution)"
    ),
    "upstream_invalid": "valid upstream URL (RYU_CONNECT_CORE_URL, RYU_CONNECT_GATEWAY_URL or RYU_CONNECT_MCP_UPSTREAM)",
    "mcp_unconfigured": "MCP upstream (RYU_CONNECT_MCP_UPSTREAM)",
    "native_composio_unavailable": (
        "Composio lane (RYU_CONNECT_COMPOSIO_BINDINGS, or RYU_CONNECT_GATEWAY_URL in proxy mode)"
    ),
    "skills_unavailable": "skill catalog (RYU_CONNECT_SKILLS_DIR)",
}


#: A 429 whose message says it follows failed authentication (Notify's address backoff).
_FAILED_AUTHENTICATION = re.compile(r"failed authentication", re.IGNORECASE)


def parse_error_response(
    service: str,
    status: int,
    headers: Mapping[str, str],
    body: Union[bytes, str],
    method: str,
    url: str,
    *,
    attempts: int = 1,
    idempotency_key: Optional[str] = None,
) -> RyuError:
    """Reads a non-2xx response into the matching :class:`RyuError` subclass.

    The body is read at most once and capped at 64 KiB. Headers supply the
    request id, ``Retry-After``, RateLimit, deprecation and
    ``WWW-Authenticate``. ``headers`` is any case-insensitive mapping (an
    ``httpx.Headers``) or a plain dict.
    """
    if isinstance(body, bytes):
        text = body[:MAX_ERROR_BODY_BYTES].decode("utf-8", errors="replace")
    else:
        text = body[:MAX_ERROR_BODY_BYTES]
    lookup = _HeaderLookup(headers)
    fields = body_fields(service, text, lookup.get("content-type") or "", status)
    retry_after = parse_retry_after(lookup.get("retry-after"))
    # A wrong-service hint replaces the other service's own hint, which names
    # that service's settings.
    problem = {"code": fields.get("code"), "docs": fields.get("docs"), "type": fields.get("type")}
    wrong_service = _other_service_named(service, problem) is not None
    known = (
        None
        if fields.get("hint") and not wrong_service
        else known_server_hint(service, status, fields["message"], problem)
    )
    return create_ryu_error(
        fields["message"],
        service=service,
        status=status,
        code=fields["code"],
        title=fields.get("title") or describe_status(status)[1],
        type=fields.get("type"),
        request_id=lookup.get("x-request-id") or fields.get("request_id"),
        retry_after_seconds=retry_after if retry_after is not None else fields.get("retry_after_seconds"),
        rate_limit=read_rate_limit(lookup.get("ratelimit"), lookup.get("ratelimit-policy")),
        deprecation=parse_deprecation(lookup.get("deprecation"), lookup.get("sunset"), lookup.get("link")),
        details=fields.get("details"),
        docs=(known["docs"] if known else None)
        if wrong_service
        else fields.get("docs") or (known["docs"] if known else None),
        hint=(known["hint"] if known else None)
        if wrong_service
        else fields.get("hint") or (known["hint"] if known else None),
        auth_challenge=lookup.get("www-authenticate"),
        envelope=fields["envelope"],
        method=method.upper(),
        url=url,
        idempotency_key=idempotency_key,
        attempts=attempts,
    )


class _HeaderLookup:
    """Case-insensitive reads over an ``httpx.Headers`` or a plain mapping."""

    def __init__(self, headers: Mapping[str, str]) -> None:
        self._headers = headers
        self._lower: Optional[dict[str, str]] = None

    def get(self, name: str) -> Optional[str]:
        getter = getattr(self._headers, "get_list", None)
        if getter is not None:
            values = getter(name)
            return ", ".join(values) if values else None
        if self._lower is None:
            self._lower = {str(key).lower(): value for key, value in self._headers.items()}
        return self._lower.get(name.lower())
