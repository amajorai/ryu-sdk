"""Webhook verification for Ryu Mail, Ryu Messaging and Ryu Notify.

Mirrors ``packages/services/src/webhooks/*.ts``; the vectors test runs the same
deliveries through both verifiers.

- :func:`verify_standard_webhook`: Standard Webhooks (``webhook-id``,
  ``webhook-timestamp``, ``webhook-signature``, repeated as ``svix-*``), signed
  content ``{id}.{timestamp}.{raw body}``, HMAC-SHA256, base64; the key is the
  base64 decode of the part after ``whsec_``. ``scheme="legacy"`` reads
  ``svix-*`` first and keys ``svix-signature`` on the raw secret (Mail webhooks
  created before Standard Webhooks signing).
- :func:`verify_mail_webhook` and :func:`verify_messaging_webhook` add the event
  envelope check (``{type:"event", event_type, event_id, data}``).
- :func:`verify_notify_webhook`: a destination delivery (Standard Webhooks
  headers keyed on the raw secret, else the legacy body-only
  ``x-ryu-notify-signature: sha256=<hex>`` with **no replay protection**) or an
  approval callback (``x-ryu-notify-timestamp``).

Every signature comparison is constant time (:func:`hmac.compare_digest`) and
every ``v1`` entry is compared, with no early exit. The timestamp is checked
against ``tolerance_seconds`` (default 300, at most 86 400) before the
signature. Pass the raw body exactly as received (``await request.body()``),
never re-serialized JSON. Failures raise
:class:`~ryu_sdk.services.errors.RyuWebhookVerificationError`; answer them with
401 and do not process the delivery.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import re
import sys
import time
import warnings
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Optional, Union, cast, overload

from ._service_titles import service_title
from .errors import RyuConfigurationError, RyuWebhookVerificationError
from .shapes import KnownMailWebhookEvent, KnownMessagingWebhookEvent, MailWebhookEvent, MessagingWebhookEvent

if sys.version_info >= (3, 10):
    from typing import TypeGuard
elif TYPE_CHECKING:
    from typing_extensions import TypeGuard
else:  # pragma: no cover - Python 3.9; typing_extensions is not a runtime dependency
    try:
        from typing_extensions import TypeGuard
    except ImportError:

        class TypeGuard:
            """Runtime stand-in so ``TypeGuard[X]`` still evaluates (to ``bool``) for introspection."""

            def __class_getitem__(cls, _item: Any) -> Any:
                return bool


WEBHOOKS_DOCS_URL = "https://docs.ryuhq.com/docs/standalone/sdk/webhooks"
DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300
MAX_WEBHOOK_TOLERANCE_SECONDS = 86_400

MAIL_EVENT_TYPES = (
    "message.received",
    "message.received.spam",
    "message.received.blocked",
    "message.received.unauthenticated",
    "message.sent",
    "message.delivered",
    "message.bounced",
    "message.complained",
    "message.rejected",
    "message.opened",
    "domain.verified",
)

MESSAGING_EVENT_TYPES = (
    "message.received",
    "message.delivered",
    "message.failed",
    "number.suspended",
    "number.released",
)
_MESSAGING_MESSAGE_EVENTS = frozenset({"message.received", "message.delivered", "message.failed"})

_SECRET_PREFIX = "whsec_"
_UNIX_SECONDS = re.compile(r"^\d{1,12}$")
_STRICT_BASE64 = re.compile(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")

Payload = Union[str, bytes, bytearray]
#: Which Notify request is verified: a destination delivery or an approval callback.
NotifyWebhookKind = Literal["destination", "callback"]
#: ``"standard"`` (whsec_ base64 key) or ``"legacy"`` (svix-* signed with the raw secret string).
WebhookScheme = Literal["standard", "legacy"]
_NOTIFY_KINDS = ("destination", "callback")
_SCHEMES = ("standard", "legacy")
#: A plain mapping (a dict, Starlette/Django headers) or a list of ``(name, value)`` pairs.
Headers = Union[Mapping[str, Any], Sequence[Any]]


def _check_option(service: str, name: str, value: Any, allowed: Sequence[str]) -> None:
    """Refuses a value outside ``allowed`` (the TypeScript literal types reject it at compile
    time): a mis-cased ``kind`` must not skip the ``require_timestamp`` downgrade check."""
    if value not in allowed:
        raise RyuConfigurationError(
            f"Ryu webhooks: {name} must be {' or '.join(repr(item) for item in allowed)} (got {value!r}).",
            service=service,
            code="invalid_option",
            docs=WEBHOOKS_DOCS_URL,
        )


def _error(service: str, code: str, message: str) -> RyuWebhookVerificationError:
    return RyuWebhookVerificationError(
        f"{service_title(service)} webhook: {message}", service=service, code=code, docs=WEBHOOKS_DOCS_URL
    )


def resolve_tolerance_seconds(service: str, value: Optional[float]) -> float:
    """``tolerance_seconds`` checked: ``None`` gives the default; anything else must be 0 to 86 400."""
    if value is None:
        return DEFAULT_WEBHOOK_TOLERANCE_SECONDS
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        # An int past float range is checked before isfinite, which would raise OverflowError.
        or (isinstance(value, int) and abs(value) > MAX_WEBHOOK_TOLERANCE_SECONDS)
        or not math.isfinite(value)
        or value < 0
        or value > MAX_WEBHOOK_TOLERANCE_SECONDS
    ):
        raise RyuConfigurationError(
            f"{service_title(service)} webhook: tolerance_seconds must be a number from 0 to {MAX_WEBHOOK_TOLERANCE_SECONDS} "
            f"(got {value!r}).",
            service=service,
            code="invalid_tolerance",
            docs=WEBHOOKS_DOCS_URL,
        )
    return value


def read_header(headers: Headers, name: str, separator: str = ", ") -> Optional[str]:
    """Reads one header case-insensitively; repeated values are joined with ``separator``."""
    wanted = name.lower()
    get_list = getattr(headers, "get_list", None) or getattr(headers, "getlist", None)
    if get_list is not None:
        values = [value for value in get_list(name) if value is not None]
        joined = separator.join(values)
        return joined or None
    items = headers.items() if isinstance(headers, Mapping) else headers
    found: list[str] = []
    for key, value in items:
        if str(key).lower() != wanted or value is None:
            continue
        if isinstance(value, (list, tuple)):
            found.extend(str(item) for item in value)
        else:
            found.append(value.decode("latin-1") if isinstance(value, bytes) else str(value))
    joined = separator.join(found)
    return joined or None


def _now_seconds(now: Optional[Union[datetime, float]]) -> float:
    if now is None:
        return time.time()
    if isinstance(now, datetime):
        return now.timestamp()
    try:
        return float(now)
    except OverflowError:
        # An int past float range reads as Infinity in TypeScript, so the timestamp check refuses
        # the delivery with a typed error rather than this raising OverflowError.
        return math.inf if now > 0 else -math.inf


def _check_timestamp(service: str, raw: str, now: float, tolerance: float) -> None:
    trimmed = raw.strip()
    if not _UNIX_SECONDS.match(trimmed):
        raise _error(service, "webhook_timestamp_out_of_range", "the timestamp header is not unix seconds.")
    skew = abs(now - int(trimmed))
    # Written as "not within" so a NaN skew (a NaN ``now``) fails closed, as in TypeScript.
    if not skew <= tolerance:
        # ``Math.round`` keeps Infinity and NaN in TypeScript; ``round()`` raises on both.
        shown = round(skew) if math.isfinite(skew) else ("NaN" if math.isnan(skew) else "Infinity")
        raise _error(
            service,
            "webhook_timestamp_out_of_range",
            f"the timestamp is {shown}s from now, outside the {tolerance:g}s tolerance.",
        )


def _bytes(payload: Payload) -> bytes:
    return payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)


def _text(payload: Payload) -> str:
    return payload if isinstance(payload, str) else bytes(payload).decode("utf-8", errors="replace")


def _parse_json(service: str, payload: Payload) -> Any:
    try:
        return json.loads(_text(payload))
    except ValueError as error:
        raise _error(service, "webhook_payload_invalid", "the verified payload is not JSON.") from error


def _hmac_b64(key: bytes, content: bytes) -> str:
    return base64.b64encode(hmac.new(key, content, hashlib.sha256).digest()).decode("ascii")


def _signing_key(secret: str, kind: str) -> Optional[bytes]:
    if kind == "raw":
        return secret.encode("utf-8")
    encoded = secret.removeprefix(_SECRET_PREFIX)
    if not encoded or not _STRICT_BASE64.match(encoded):
        return None
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return None


def _v1_signatures(signature_list: str) -> list[str]:
    signatures = []
    for raw in signature_list.split():
        entry = raw.rstrip(",")
        comma = entry.find(",")
        if comma > 0 and entry[:comma] == "v1":
            signatures.append(entry[comma + 1 :])
    return signatures


def _matches_any(candidates: Sequence[str], expected: str) -> bool:
    matched = False
    for candidate in candidates:
        # No early exit: every entry is compared.
        matched = hmac.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8")) or matched
    return matched


_FAMILIES = {
    "standard": (("webhook", "standard"), ("svix", "standard")),
    "legacy": (("svix", "raw"), ("webhook", "standard")),
}


def _assert_secret(service: str, secret: object) -> None:
    """Raises ``webhook_invalid_secret`` when ``secret`` is not a non-empty string.

    An unset environment variable gives ``None``, which would otherwise fail
    later with an ``AttributeError`` and answer 500, so the sender retries
    instead of seeing a 401. Checked before the headers, as in TypeScript.
    """
    if not isinstance(secret, str) or secret == "":
        raise _error(service, "webhook_invalid_secret", "the signing secret is empty.")


def verify_standard_webhook(
    *,
    payload: Payload,
    headers: Headers,
    secret: str,
    scheme: WebhookScheme = "standard",
    service: str = "mail",
    tolerance_seconds: Optional[float] = None,
    now: Optional[Union[datetime, float]] = None,
) -> Any:
    """Verifies a Standard Webhooks delivery and returns its parsed JSON body."""
    _check_option(service, "scheme", scheme, _SCHEMES)
    tolerance = resolve_tolerance_seconds(service, tolerance_seconds)
    _assert_secret(service, secret)
    found = None
    for family, key_kind in _FAMILIES[scheme]:
        delivery_id = read_header(headers, f"{family}-id")
        timestamp = read_header(headers, f"{family}-timestamp")
        signature = read_header(headers, f"{family}-signature", " ")
        if delivery_id and timestamp and signature:
            found = (delivery_id, timestamp, signature, key_kind)
            break
    if found is None:
        raise _error(
            service,
            "webhook_missing_headers",
            "expected webhook-id, webhook-timestamp and webhook-signature (or their svix-* aliases).",
        )
    delivery_id, timestamp, signature, key_kind = found
    key = _signing_key(secret, key_kind)
    if not key:
        raise _error(service, "webhook_invalid_secret", "the signing secret must be whsec_ followed by base64.")
    _check_timestamp(service, timestamp, _now_seconds(now), tolerance)
    expected = _hmac_b64(key, f"{delivery_id}.{timestamp}.".encode() + _bytes(payload))
    if not _matches_any(_v1_signatures(signature), expected):
        raise _error(service, "webhook_invalid_signature", "no v1 signature matches the payload and secret.")
    return _parse_json(service, payload)


def _envelope(service: str, body: Any) -> dict[str, Any]:
    if not (
        isinstance(body, dict)
        and body.get("type") == "event"
        and isinstance(body.get("event_id"), str)
        and isinstance(body.get("event_type"), str)
        and isinstance(body.get("data"), dict)
    ):
        raise _error(service, "webhook_payload_invalid", 'expected {type:"event", event_type, event_id, data}.')
    return body


def parse_mail_webhook_event(body: Any) -> MailWebhookEvent:
    """Narrows a parsed body to a Mail event envelope (an unknown ``event_type`` is accepted)."""
    return cast(MailWebhookEvent, _envelope("mail", body))


def is_known_mail_webhook_event(event: Mapping[str, Any]) -> TypeGuard[KnownMailWebhookEvent]:
    """True when ``event_type`` is one of ``MAIL_EVENT_TYPES``; narrows to ``KnownMailWebhookEvent``."""
    return event.get("event_type") in MAIL_EVENT_TYPES


def verify_mail_webhook(
    *,
    payload: Payload,
    headers: Headers,
    secret: str,
    scheme: WebhookScheme = "standard",
    tolerance_seconds: Optional[float] = None,
    now: Optional[Union[datetime, float]] = None,
) -> MailWebhookEvent:
    """Verifies a Mail webhook delivery and returns the event. Dedupe on ``event_id`` (deliveries are retried)."""
    body = verify_standard_webhook(
        payload=payload,
        headers=headers,
        secret=secret,
        scheme=scheme,
        service="mail",
        tolerance_seconds=tolerance_seconds,
        now=now,
    )
    return parse_mail_webhook_event(body)


def parse_messaging_webhook_event(body: Any) -> MessagingWebhookEvent:
    """Narrows a parsed body to a Messaging event envelope; a known type must carry its resource."""
    event = cast(MessagingWebhookEvent, _envelope("messaging", body))
    event_type = event["event_type"]
    if event_type not in MESSAGING_EVENT_TYPES:
        return event
    resource_field = "message" if event_type in _MESSAGING_MESSAGE_EVENTS else "number"
    resource = event["data"].get(resource_field)
    if not (isinstance(resource, dict) and isinstance(resource.get("id"), str)):
        raise _error(
            "messaging", "webhook_payload_invalid", f"the {event_type} event has no data.{resource_field} object."
        )
    return event


def is_known_messaging_webhook_event(event: Mapping[str, Any]) -> TypeGuard[KnownMessagingWebhookEvent]:
    """True when ``event_type`` is one of ``MESSAGING_EVENT_TYPES``; narrows to ``KnownMessagingWebhookEvent``."""
    return event.get("event_type") in MESSAGING_EVENT_TYPES


def verify_messaging_webhook(
    *,
    payload: Payload,
    headers: Headers,
    secret: str,
    tolerance_seconds: Optional[float] = None,
    now: Optional[Union[datetime, float]] = None,
) -> MessagingWebhookEvent:
    """Verifies a Ryu Messaging delivery (Standard Webhooks, ``whsec_`` secret) and returns the event."""
    body = verify_standard_webhook(
        payload=payload,
        headers=headers,
        secret=secret,
        scheme="standard",
        service="messaging",
        tolerance_seconds=tolerance_seconds,
        now=now,
    )
    return parse_messaging_webhook_event(body)


@dataclass(frozen=True)
class NotifyWebhookDelivery:
    """A verified Notify request.

    ``delivery_id`` (destination only) is the signed ``webhook-id`` or the
    signed body's ``deliveryId``: dedupe on it. ``replay_protected`` is false
    for a body-only destination signature, which carries no timestamp.
    """

    kind: str
    body: Any
    delivery_id: Optional[str]
    event_id: Optional[str]
    replay_protected: bool


def _string_field(value: Any, key: str) -> Optional[str]:
    if not isinstance(value, dict):
        return None
    item = value.get(key)
    return item if isinstance(item, str) else None


def _destination_body(payload: Payload) -> Any:
    text = _text(payload)
    try:
        return json.loads(text)
    except ValueError:
        return text


def _signed_ids(kind: str, body: Any, headers: Headers, signed_delivery_id: Optional[str]) -> dict[str, Optional[str]]:
    body_delivery_id = None if kind == "callback" else _string_field(body, "deliveryId")
    if signed_delivery_id is not None and body_delivery_id is not None and body_delivery_id != signed_delivery_id:
        raise _error("notify", "webhook_invalid_signature", "webhook-id does not match the signed body's deliveryId.")
    if kind == "callback":
        ids = {"delivery_id": None, "event_id": _string_field(body, "eventId")}
    else:
        event = body.get("event") if isinstance(body, dict) else None
        ids = {
            "delivery_id": signed_delivery_id if signed_delivery_id is not None else body_delivery_id,
            "event_id": _string_field(event, "id"),
        }
    for header, signed in (("x-ryu-notify-event", ids["event_id"]), ("x-ryu-notify-delivery", ids["delivery_id"])):
        sent = read_header(headers, header)
        if sent is not None and signed is not None and sent.strip() != signed:
            raise _error("notify", "webhook_invalid_signature", f"{header} does not match the signed body.")
    return ids


def _body_only_allowed(require_timestamp: Optional[bool], allow_body_only_signature: bool) -> bool:
    """Whether a destination delivery without ``webhook-*`` headers may verify on the replayable body-only
    signature: only on an explicit opt-in, and never when ``require_timestamp`` is true."""
    if require_timestamp is True:
        return False
    return allow_body_only_signature is True or require_timestamp is False


def verify_notify_webhook(
    *,
    payload: Payload,
    headers: Headers,
    secret: str,
    kind: NotifyWebhookKind = "destination",
    require_timestamp: Optional[bool] = None,
    allow_body_only_signature: bool = False,
    tolerance_seconds: Optional[float] = None,
    now: Optional[Union[datetime, float]] = None,
) -> NotifyWebhookDelivery:
    """Verifies a request Notify signed: a ``destination`` delivery or an approval ``callback``.

    A destination delivery must carry the Standard Webhooks ``webhook-*`` headers. Without them it is
    refused (``webhook_missing_headers``) because the older body-only ``x-ryu-notify-signature`` has no
    timestamp, so a captured delivery with the ``webhook-*`` headers dropped could be replayed forever.
    ``allow_body_only_signature=True`` (or ``require_timestamp=False``) is the explicit opt-in to that
    signature (``replay_protected`` is then false: dedupe on ``delivery_id``); ``require_timestamp=True``
    refuses it even when allowed.

    ``kind`` other than those two raises ``RyuConfigurationError`` (``invalid_option``)."""
    _check_option("notify", "kind", kind, _NOTIFY_KINDS)
    tolerance = resolve_tolerance_seconds("notify", tolerance_seconds)
    _assert_secret("notify", secret)
    standard = None
    if kind == "destination":
        delivery_id = read_header(headers, "webhook-id")
        timestamp = read_header(headers, "webhook-timestamp")
        signature = read_header(headers, "webhook-signature", " ")
        if delivery_id and timestamp and signature:
            standard = (delivery_id.strip(), timestamp.strip(), signature)
        elif delivery_id or timestamp or signature:
            raise _error(
                "notify",
                "webhook_missing_headers",
                "expected all of webhook-id, webhook-timestamp and webhook-signature; the delivery carries only some "
                "of them.",
            )
    if standard is not None:
        delivery_id, timestamp, signature = standard
        _check_timestamp("notify", timestamp, _now_seconds(now), tolerance)
        expected = _hmac_b64(secret.encode("utf-8"), f"{delivery_id}.{timestamp}.".encode() + _bytes(payload))
        if not _matches_any(_v1_signatures(signature), expected):
            raise _error(
                "notify",
                "webhook_invalid_signature",
                "no v1 entry in webhook-signature matches the payload and secret.",
            )
        body = _destination_body(payload)
        ids = _signed_ids(kind, body, headers, delivery_id)
        return NotifyWebhookDelivery(kind, body, ids["delivery_id"], ids["event_id"], True)

    legacy_signature = read_header(headers, "x-ryu-notify-signature")
    timestamp_header = read_header(headers, "x-ryu-notify-timestamp") if kind == "callback" else None
    if kind == "destination" and not _body_only_allowed(require_timestamp, allow_body_only_signature):
        raise _error(
            "notify",
            "webhook_missing_headers",
            "expected webhook-id, webhook-timestamp and webhook-signature (require_timestamp is set)."
            if require_timestamp is True
            else "expected webhook-id, webhook-timestamp and webhook-signature; a body-only signature is replayable, "
            "so it is refused unless allow_body_only_signature is set.",
        )
    if not legacy_signature or (kind == "callback" and not timestamp_header):
        raise _error(
            "notify",
            "webhook_missing_headers",
            "expected x-ryu-notify-signature and x-ryu-notify-timestamp."
            if kind == "callback"
            else "expected webhook-id, webhook-timestamp and webhook-signature, or x-ryu-notify-signature.",
        )
    if timestamp_header:
        _check_timestamp("notify", timestamp_header, _now_seconds(now), tolerance)
    signed = f"{timestamp_header}.".encode() + _bytes(payload) if timestamp_header else _bytes(payload)
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(legacy_signature.strip().lower().encode("utf-8"), expected.encode("utf-8")):
        raise _error(
            "notify", "webhook_invalid_signature", "x-ryu-notify-signature does not match the payload and secret."
        )
    body = _parse_json("notify", payload) if kind == "callback" else _destination_body(payload)
    ids = _signed_ids(kind, body, headers, None)
    return NotifyWebhookDelivery(kind, body, ids["delivery_id"], ids["event_id"], timestamp_header is not None)


@overload
def verify_webhook(
    *,
    service: Literal["mail"],
    payload: Payload,
    headers: Headers,
    secret: str,
    kind: NotifyWebhookKind = ...,
    scheme: WebhookScheme = ...,
    require_timestamp: Optional[bool] = ...,
    allow_body_only_signature: bool = ...,
    tolerance_seconds: Optional[float] = ...,
    now: Optional[Union[datetime, float]] = ...,
) -> MailWebhookEvent: ...


@overload
def verify_webhook(
    *,
    service: Literal["messaging"],
    payload: Payload,
    headers: Headers,
    secret: str,
    kind: NotifyWebhookKind = ...,
    scheme: WebhookScheme = ...,
    require_timestamp: Optional[bool] = ...,
    allow_body_only_signature: bool = ...,
    tolerance_seconds: Optional[float] = ...,
    now: Optional[Union[datetime, float]] = ...,
) -> MessagingWebhookEvent: ...


@overload
def verify_webhook(
    *,
    service: Literal["notify"],
    payload: Payload,
    headers: Headers,
    secret: str,
    kind: NotifyWebhookKind = ...,
    scheme: WebhookScheme = ...,
    require_timestamp: Optional[bool] = ...,
    allow_body_only_signature: bool = ...,
    tolerance_seconds: Optional[float] = ...,
    now: Optional[Union[datetime, float]] = ...,
) -> NotifyWebhookDelivery: ...


@overload
def verify_webhook(
    *,
    service: str,
    payload: Payload,
    headers: Headers,
    secret: str,
    kind: NotifyWebhookKind = ...,
    scheme: WebhookScheme = ...,
    require_timestamp: Optional[bool] = ...,
    allow_body_only_signature: bool = ...,
    tolerance_seconds: Optional[float] = ...,
    now: Optional[Union[datetime, float]] = ...,
) -> Union[MailWebhookEvent, MessagingWebhookEvent, NotifyWebhookDelivery]: ...


def verify_webhook(
    *,
    service: str,
    payload: Payload,
    headers: Headers,
    secret: str,
    kind: NotifyWebhookKind = "destination",
    scheme: WebhookScheme = "standard",
    require_timestamp: Optional[bool] = None,
    allow_body_only_signature: bool = False,
    tolerance_seconds: Optional[float] = None,
    now: Optional[Union[datetime, float]] = None,
) -> Union[MailWebhookEvent, MessagingWebhookEvent, NotifyWebhookDelivery]:
    """Verifies a delivery from ``service`` (``"mail"``, ``"messaging"`` or ``"notify"``); the
    return type follows a literal ``service``."""
    if service == "messaging":
        return verify_messaging_webhook(
            payload=payload, headers=headers, secret=secret, tolerance_seconds=tolerance_seconds, now=now
        )
    if service == "mail":
        return verify_mail_webhook(
            payload=payload, headers=headers, secret=secret, scheme=scheme, tolerance_seconds=tolerance_seconds, now=now
        )
    if service == "notify":
        return verify_notify_webhook(
            payload=payload,
            headers=headers,
            secret=secret,
            kind=kind,
            require_timestamp=require_timestamp,
            allow_body_only_signature=allow_body_only_signature,
            tolerance_seconds=tolerance_seconds,
            now=now,
        )
    raise RyuConfigurationError(
        f"Ryu webhooks: unknown service {service!r}; expected mail, messaging or notify.",
        service="notify",
        code="invalid_service",
        docs=WEBHOOKS_DOCS_URL,
    )


class Webhooks:
    """``ryu.webhooks``: ``verify(service=..., ...)``, as in the TypeScript SDK.

    On ``Ryu(result="object")`` it returns ``Result(data, error, meta)`` instead of
    raising, as ``ryu.webhooks.verify()`` does in the TypeScript SDK; the
    module-level verifiers (``verify_mail_webhook`` and the rest) always raise.
    ``verify_mail``, ``verify_messaging`` and ``verify_notify`` are deprecated
    aliases of ``verify(service=...)`` that TypeScript never had.
    """

    def __init__(self, object_mode: bool = False) -> None:
        self._object_mode = object_mode

    def _run(self, verifier: Any, **options: Any) -> Any:
        if not self._object_mode:
            return verifier(**options)
        from .result import EMPTY_META, Result

        try:
            return Result(verifier(**options), None, EMPTY_META)
        except RyuWebhookVerificationError as error:
            return Result(None, error, None)
        except RyuConfigurationError as error:
            return Result(None, error, None)

    def verify(self, **options: Any) -> Any:
        """Verifies a delivery from ``service`` (``"mail"``, ``"messaging"`` or ``"notify"``)."""
        return self._run(verify_webhook, **options)

    def _deprecated(self, service: str, verifier: Any, **options: Any) -> Any:
        warnings.warn(
            f'ryu.webhooks.verify_{service}(...) is deprecated; use ryu.webhooks.verify(service="{service}", ...).',
            DeprecationWarning,
            stacklevel=3,
        )
        return self._run(verifier, **options)

    def verify_mail(self, **options: Any) -> Any:
        """Deprecated: ``verify(service="mail", ...)``."""
        return self._deprecated("mail", verify_mail_webhook, **options)

    def verify_messaging(self, **options: Any) -> Any:
        """Deprecated: ``verify(service="messaging", ...)``."""
        return self._deprecated("messaging", verify_messaging_webhook, **options)

    def verify_notify(self, **options: Any) -> Any:
        """Deprecated: ``verify(service="notify", ...)``."""
        return self._deprecated("notify", verify_notify_webhook, **options)
