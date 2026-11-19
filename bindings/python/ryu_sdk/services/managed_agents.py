"""``ryu.managed_agents``: the hosted Managed Agents API, through the services transport.

This wraps :mod:`ryu_sdk.managed_agents` rather than duplicating it: every
request (path, query, body, ``Idempotency-Key`` and reply decoding) is built by
that module's resource classes, then sent through the services transport so it
gets the shared rules (retries on replay-safe requests, automatic idempotency
keys on the seven idempotent routes, typed :class:`RyuError`, object mode,
``with_options``). A failed reply becomes the RyuError the TypeScript facade
builds for it (``fromManagedAgentsError``). The resumable event stream is that
module's own ``sessions.stream`` (``Last-Event-ID`` resume, ``seq`` dedupe),
sent through the instance's HTTP client with the services headers, timeout
and hooks, with its errors converted to :class:`RyuError`.

On top it adds what ``@ryuhq/services`` adds: ``agents.iterate``,
``environments.iterate``, ``sessions.iterate``, ``sessions.follow`` (stop at the
end of the turn), ``sessions.run`` (create, follow, re-read) and
``sessions.approve_tool`` / ``deny_tool`` / ``respond_to_approval``, and an
``on_tool_approval`` handler on ``follow`` / ``run``.

Configuration: ``RYU_API_KEY`` (sent as ``x-api-key``), ``RYU_ORGANIZATION_ID``
(sent as ``X-Ryu-Organization``) and ``RYU_API_URL`` (default
``https://api.ryuhq.com``). ``ryu_sdk.managed_agents`` reads no environment
variables, so these are the only names.

Interactive tool approvals follow the TypeScript facade's rules:

- every answer path (``approve_tool``, ``deny_tool``, ``respond_to_approval``)
  sends one ``user.tool_approval`` with the derived Idempotency-Key
  ``tool-approval-<decision>-<toolUseId>[-m<fnv1a32(message)>]``, and retries
  once with a fresh key when that derived key gets ``409 unknown_tool_use``
  (the server replays a stored 4xx for 24 hours);
- ``on_tool_approval`` decides each open request once, after the follow has
  caught up with the log's head (requests at or before ``after`` are read
  first). Without it, or when it returns ``None``, nothing is answered and the
  follow stops at the ``requires_action`` idle, with ``until="terminal"`` too;
  the SDK never allows a call on its own;
- a request is abandoned by the ``interrupted`` idle with no pending ids that
  answers a ``user.interrupt``, not by the interrupt itself.
"""

from __future__ import annotations

import functools
import json
import re
import time
from collections.abc import Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Optional, TypedDict, Union

import httpx

from .. import managed_agents as _ma
from .._transport import ERROR_TEXT_CHARS, join_url
from ._base import Namespace, Resource
from ._runtime import (
    _NO_BODY,
    END,
    Await,
    Binding,
    CurrentCall,
    Defer,
    Emit,
    IterNext,
    Paginated,
    Request,
    aread_error_body,
    next_cursor_field,
    read_error_body,
)
from .errors import (
    RyuConfigurationError,
    RyuConnectionError,
    RyuError,
    RyuInvalidRequestError,
    RyuResponseValidationError,
    RyuTimeoutError,
    copy_ryu_error,
    create_ryu_error,
    describe_status,
)
from .transport import new_idempotency_key

MOUNT = _ma.MANAGED_AGENTS_PATH

#: The public page that explains how the Managed Agents preview is turned on.
PREVIEW_DOCS = "https://docs.ryuhq.com/docs/standalone/managed-agents"

#: Codes that mean the preview is off, with the hint the SDK attaches.
PREVIEW_HINTS: dict[str, str] = {
    "managed_agents_disabled": f"This Ryu deployment does not offer the Managed Agents preview. See {PREVIEW_DOCS}",
    "feature_disabled": (
        "Managed Agents is a preview that is off until an organization owner or feature manager turns it on in "
        f"Organization > Features (and for the member making the request). See {PREVIEW_DOCS}"
    ),
}


class ManagedAgentsRunResult(TypedDict):
    """What ``sessions.run()`` returns (inside ``Result.data`` in object mode; a coroutine of it
    on ``AsyncRyu``). Keys match the TypeScript facade, like the camelCase wire data inside."""

    events: list[dict[str, Any]]
    pendingApprovals: list[dict[str, Any]]
    session: dict[str, Any]
    text: str


TERMINAL_STATUSES = frozenset({"completed", "failed", "canceled"})
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_FNV_OFFSET = 0x811C9DC5
_FNV_PRIME = 0x01000193

#: The event types that decide which approval requests are open.
TOOL_APPROVAL_EVENT_TYPES = (
    "agent.tool_use",
    "agent.tool_approval_request",
    "user.tool_approval",
    "user.interrupt",
    "session.status",
)

#: Codes that mean an approval request is already settled: answered (by another client or by
#: Ryu's timeout denial), abandoned, or answered under the same key with another body.
SETTLED_ANSWER_CODES = frozenset({"unknown_tool_use", "tool_result_already_submitted", "idempotency_key_reused"})

_APPROVAL_SEED_MAX_PAGES = 20
_APPROVAL_SEED_PAGE_LIMIT = 500


@dataclass(frozen=True)
class ToolApprovalContext:
    """What an ``on_tool_approval`` handler is called with."""

    #: The open ``agent.tool_approval_request`` event.
    request: dict[str, Any]
    session_id: str
    #: The matching ``agent.tool_use`` event (with the call's input), or ``None`` when it was not seen.
    tool_use: Optional[dict[str, Any]]


#: What an ``on_tool_approval`` handler returns: ``"allow"``, ``"deny"``,
#: ``{"decision": ..., "message": ...}``, or ``None`` to leave the request open.
ToolApprovalDecision = Union[str, Mapping[str, Any], None]
#: Decides one open approval request (may be ``async`` on ``AsyncRyu``).
ToolApprovalHandler = Callable[[ToolApprovalContext], Any]


def _message_digest(text: str) -> str:
    """FNV-1a (32-bit) of the UTF-8 bytes of ``text``, as 8 hex digits. Not a security hash."""
    value = _FNV_OFFSET
    for byte in text.encode("utf-8"):
        value = ((value ^ byte) * _FNV_PRIME) & 0xFFFFFFFF
    return f"{value:08x}"


def tool_approval_idempotency_key(tool_use_id: str, decision: str, message: Optional[str] = None) -> Optional[str]:
    """``tool-approval-<decision>-<toolUseId>``, plus ``-m<fnv1a32(message)>`` when a message is sent.

    ``None`` when that is not a valid key (the SDK then adds a random one). The
    message is part of the key so a second answer with another message is a
    different answer (``409 tool_result_already_submitted``), not a key reuse.
    """
    suffix = "" if message is None else f"-m{_message_digest(message)}"
    key = f"tool-approval-{decision}-{tool_use_id}{suffix}"
    return key if _IDEMPOTENCY_KEY.match(key) else None


def _seq(event: Mapping[str, Any]) -> int:
    value = event.get("seq")
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


class _ApprovalLedger:
    """The open approval requests of a log, kept the way the server derives its pending set."""

    def __init__(self) -> None:
        self.open: dict[str, dict[str, Any]] = {}
        self.tool_uses: dict[str, dict[str, Any]] = {}
        #: The pending ids of the latest ``requires_action`` status, until another status replaces it.
        self.waiting: list[str] = []
        self._interrupts: set[int] = set()

    def waits_on_approval(self, answered: set[str]) -> bool:
        """Whether the session waits on an open approval request that ``answered`` does not cover."""
        return any(item in self.open and item not in answered for item in self.waiting)

    def observe(self, event: Mapping[str, Any]) -> None:
        kind = event.get("type")
        if kind == "session.status":
            pending = event.get("pendingToolUseIds")
            self.waiting = (
                [str(item) for item in pending]
                if event.get("stopReason") == "requires_action" and isinstance(pending, list)
                else []
            )
        if kind == "agent.tool_use":
            self.tool_uses[str(event.get("toolUseId"))] = dict(event)
        elif kind == "agent.tool_approval_request":
            self.open[str(event.get("toolUseId"))] = dict(event)
        elif kind == "user.tool_approval":
            self.open.pop(str(event.get("toolUseId")), None)
        elif kind == "user.interrupt":
            self._interrupts.add(_seq(event))
        elif self._is_abandon_status(event):
            self.open.clear()

    def _is_abandon_status(self, event: Mapping[str, Any]) -> bool:
        if (
            event.get("type") != "session.status"
            or event.get("status") != "idle"
            or event.get("stopReason") != "interrupted"
            or event.get("pendingToolUseIds")
        ):
            return False
        input_seq = event.get("inputSeq")
        if isinstance(input_seq, int) and not isinstance(input_seq, bool):
            return input_seq in self._interrupts
        return bool(self._interrupts)

    def sorted_open(self) -> list[dict[str, Any]]:
        return sorted(self.open.values(), key=_seq)


def pending_tool_approvals(events: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The ``agent.tool_approval_request`` events still open at the end, in log order.

    A request closes when a ``user.tool_approval`` answers it; every open request
    is abandoned by the ``idle`` / ``interrupted`` status with no pending ids whose
    ``inputSeq`` is a ``user.interrupt`` seen earlier (not by the interrupt itself).
    """
    ledger = _ApprovalLedger()
    for event in events:
        ledger.observe(event)
    return ledger.sorted_open()


def _normalize_decision(value: Any) -> Optional[dict[str, Any]]:
    if value is None:
        return None
    if value in ("allow", "deny"):
        return {"decision": value, "message": None}
    if isinstance(value, Mapping) and value.get("decision") in ("allow", "deny"):
        message = value.get("message")
        if message is None or isinstance(message, str):
            return {"decision": value["decision"], "message": message}
    raise RyuConfigurationError(
        'Ryu Managed Agents: on_tool_approval must return "allow", "deny", {"decision": ..., "message": ...} '
        "or None (leave the request open).",
        service="managedAgents",
        code="invalid_tool_approval_decision",
    )


def _handler_failed(error: BaseException) -> RyuError:
    failure = RyuError(
        f"Ryu Managed Agents: your on_tool_approval handler raised: {error}. Nothing was answered; the request "
        "stays open until Ryu denies it at its expiresAt.",
        service="managedAgents",
        code="tool_approval_handler_failed",
    )
    failure.__cause__ = error
    return failure


class _ApprovalTracker:
    """The ``on_tool_approval`` state of one follow."""

    def __init__(self, handler: ToolApprovalHandler) -> None:
        self.handler = handler
        #: Requests this follow answered (or found already settled).
        self.answered: set[str] = set()
        #: Requests the handler was called for, so it is asked once per request.
        self.asked: set[str] = set()

    def covers_requires_action(self, event: Mapping[str, Any]) -> bool:
        """Whether ``event`` is a ``requires_action`` idle whose pending ids this follow all answered."""
        pending = event.get("pendingToolUseIds")
        return (
            event.get("type") == "session.status"
            and event.get("stopReason") == "requires_action"
            and isinstance(pending, list)
            and len(pending) > 0
            and all(str(item) in self.answered for item in pending)
        )


def decorate_managed_agents_error(error: RyuError) -> RyuError:
    """Adds the preview hint to ``managed_agents_disabled`` and ``feature_disabled``."""
    if error.envelope != "managed-agents" or error.hint is not None:
        return error
    hint = PREVIEW_HINTS.get(error.code)
    return error if hint is None else copy_ryu_error(error, docs=PREVIEW_DOCS, hint=hint)


def from_managed_agents_error(error: _ma.ManagedAgentsError) -> RyuError:
    """Converts a :class:`ryu_sdk.managed_agents.ManagedAgentsError` to the matching RyuError."""
    code = describe_status(error.status)[0] if error.code == _ma.MANAGED_AGENTS_UNKNOWN_ERROR_CODE else error.code
    converted = create_ryu_error(
        str(error),
        service="managedAgents",
        status=error.status,
        code=code,
        title=describe_status(error.status)[1] if error.status > 0 else None,
        request_id=error.request_id,
        retry_after_seconds=error.retry_after_seconds,
        details=error.details,
        envelope="managed-agents",
    )
    converted.__cause__ = error
    return decorate_managed_agents_error(converted)


def _is_error_envelope(body: Any) -> bool:
    """The section 4.1 envelope ``{"error": {code, message, requestId, details?}}``, as
    ``managedAgentsErrorBodySchema`` in ``@ryuhq/client`` accepts it."""
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return False
    if not all(isinstance(error.get(name), str) for name in ("code", "message", "requestId")):
        return False
    return error.get("details") is None or isinstance(error.get("details"), dict)


def managed_agents_response_error(generic: RyuError, response: httpx.Response, config: Any) -> RyuError:
    """The RyuError for a failed Managed Agents reply, built the way the TypeScript facade
    builds it (``@ryuhq/client``'s ``ManagedAgentsError``, then ``fromManagedAgentsError``):
    the envelope's ``code``, ``message`` and ``requestId`` when the body is the section 4.1
    envelope, otherwise the status code, a ``Ryu Managed Agents: <METHOD> <path> failed
    (<status>)`` message and the ``X-Request-ID`` header. ``retry_after_seconds`` comes from
    ``Retry-After`` only. Rate limit, deprecation and the auth challenge carry over."""
    status = response.status_code
    request = response.request
    text = response.text
    try:
        body = json.loads(text) if text.strip() else None
    except ValueError:
        body = None
    if body is not None and _is_error_envelope(body):
        envelope = body["error"]
        code = envelope["code"]
        message = envelope["message"]
        request_id: Optional[str] = envelope["requestId"]
        details = envelope.get("details")
    else:
        prefix = join_url(config.base_url, MOUNT)
        full = str(request.url)
        path = full[len(prefix) :] if full.startswith(prefix) else request.url.raw_path.decode("ascii", "replace")
        excerpt = text.strip()[:ERROR_TEXT_CHARS]
        code = describe_status(status)[0]
        message = f"Ryu Managed Agents: {request.method} {path} failed ({status}){': ' + excerpt if excerpt else ''}"
        request_id = response.headers.get("x-request-id")
        details = None
    converted = create_ryu_error(
        message,
        service="managedAgents",
        status=status,
        code=code,
        title=describe_status(status)[1],
        request_id=request_id,
        retry_after_seconds=_ma.parse_retry_after(response.headers.get("retry-after")),
        details=details,
        envelope="managed-agents",
        method=generic.method,
        url=generic.url,
        idempotency_key=generic.idempotency_key,
        attempts=generic.attempts,
        rate_limit=generic.rate_limit,
        deprecation=generic.deprecation,
        auth_challenge=generic.auth_challenge,
    )
    converted.__cause__ = generic.__cause__
    return converted


# A capturing executor: #792's resources return their RequestSpec instead of sending it.
def _capture(spec: Any) -> Any:
    return spec


class _CheckedRequests:
    """One of #792's capturing resources, with its pre-send ``invalid_id`` refusal (an empty, ``.``
    or ``..`` path id, raised by ``ryu_sdk.managed_agents._segment`` as a ``ManagedAgentsError``)
    raised as this package's ``RyuInvalidRequestError``, like every other services id check."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        method = getattr(self._inner, name)
        if not callable(method):
            return method

        def checked(*args: Any, **kwargs: Any) -> Any:
            try:
                return method(*args, **kwargs)
            except _ma.ManagedAgentsError as error:
                if error.code != "invalid_id" or error.status != 0:
                    raise
                raise RyuInvalidRequestError(
                    'Ryu Managed Agents: every path id must be non-empty and other than "." or "..".',
                    service="managedAgents",
                    code="invalid_id",
                    retryable=False,
                ) from None

        return checked


_AGENTS = _CheckedRequests(_ma.AgentsAPI(_capture))
_ENVIRONMENTS = _CheckedRequests(_ma.EnvironmentsAPI(_capture))
_CREDENTIALS = _CheckedRequests(_ma.CredentialsAPI(_capture))
_SESSIONS = _CheckedRequests(_ma._SessionRequests(_capture))


def _request(spec: Any) -> Request:
    """A captured ``ryu_sdk.managed_agents`` RequestSpec as a services Request.

    Every id it put in the path is checked as ``pathSegment`` does: an empty, ``.`` or ``..``
    segment raises ``invalid_id`` instead of letting the URL collapse onto another route
    (``sessions.delete("..")`` would otherwise address ``/sessions``)."""
    if any(part in ("", ".", "..") for part in spec.path.split("/")[1:]):
        raise RyuInvalidRequestError(
            f'Ryu Managed Agents: every id in {spec.method} {spec.path!r} must be non-empty and other than "." or "..".',
            service="managedAgents",
            code="invalid_id",
            retryable=False,
        )
    body = spec.json_body if (spec.json_body is not None or spec.has_body) else _NO_BODY
    return Request(
        spec.method,
        f"{MOUNT}{spec.path}",
        json=body,
        params=spec.params,
        headers=spec.headers,
        decode=spec.decode,
    )


def is_turn_end_event(event: Mapping[str, Any], last_input_seq: int) -> bool:
    """Whether ``event`` is the ``idle`` status that ends the turn for the user events seen so far."""
    if event.get("type") != "session.status" or event.get("status") != "idle":
        return False
    if last_input_seq == 0:
        return True
    if event.get("detail") == "provisioned":
        return False
    input_seq = event.get("inputSeq")
    if isinstance(input_seq, int) and not isinstance(input_seq, bool):
        return input_seq >= last_input_seq
    return event.get("stopReason") is not None


def is_terminal_status_event(event: Mapping[str, Any]) -> bool:
    return event.get("type") == "session.status" and event.get("status") in TERMINAL_STATUSES


def agent_text(events: Sequence[Mapping[str, Any]]) -> str:
    """The text blocks of every ``agent.message`` event, joined with blank lines."""
    parts: list[str] = []
    for event in events:
        if event.get("type") != "agent.message":
            continue
        for block in event.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
    return "\n\n".join(parts)


class AgentsResource(Resource):
    """Versioned agent definitions."""

    def create(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        return self._b.call(lambda _c: _request(_AGENTS.create(input, idempotency_key=idempotency_key)))

    def list(
        self, *, cursor: Optional[str] = None, include_archived: Optional[bool] = None, limit: Optional[int] = None
    ) -> Any:
        return self._b.call(
            lambda _c: _request(_AGENTS.list(cursor=cursor, include_archived=include_archived, limit=limit))
        )

    def iterate(
        self, *, include_archived: Optional[bool] = None, limit: Optional[int] = None, max_items: Optional[int] = None
    ) -> Paginated:
        """Every agent, newest first, across pages."""
        return Paginated(
            self._b,
            lambda _c, cursor: _request(_AGENTS.list(cursor=cursor, include_archived=include_archived, limit=limit)),
            lambda page: page["data"],
            next_cursor_field,
            max_items=max_items,
        )

    def get(self, agent_id: str) -> Any:
        return self._b.call(lambda _c: _request(_AGENTS.get(agent_id)))

    def update(self, agent_id: str, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        return self._b.call(lambda _c: _request(_AGENTS.update(agent_id, input, idempotency_key=idempotency_key)))

    def archive(self, agent_id: str) -> Any:
        return self._b.call(lambda _c: _request(_AGENTS.archive(agent_id)))

    def list_versions(self, agent_id: str, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> Any:
        return self._b.call(lambda _c: _request(_AGENTS.list_versions(agent_id, cursor=cursor, limit=limit)))

    def get_version(self, agent_id: str, version: int) -> Any:
        return self._b.call(lambda _c: _request(_AGENTS.get_version(agent_id, version)))


class EnvironmentsResource(Resource):
    """Execution environments. Writes need a personal API key."""

    def create(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        return self._b.call(lambda _c: _request(_ENVIRONMENTS.create(input, idempotency_key=idempotency_key)))

    def list(
        self, *, cursor: Optional[str] = None, include_archived: Optional[bool] = None, limit: Optional[int] = None
    ) -> Any:
        return self._b.call(
            lambda _c: _request(_ENVIRONMENTS.list(cursor=cursor, include_archived=include_archived, limit=limit))
        )

    def iterate(
        self, *, include_archived: Optional[bool] = None, limit: Optional[int] = None, max_items: Optional[int] = None
    ) -> Paginated:
        """Every environment, newest first, across pages."""
        return Paginated(
            self._b,
            lambda _c, cursor: _request(
                _ENVIRONMENTS.list(cursor=cursor, include_archived=include_archived, limit=limit)
            ),
            lambda page: page["data"],
            next_cursor_field,
            max_items=max_items,
        )

    def get(self, environment_id: str) -> Any:
        return self._b.call(lambda _c: _request(_ENVIRONMENTS.get(environment_id)))

    def update(self, environment_id: str, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        return self._b.call(
            lambda _c: _request(_ENVIRONMENTS.update(environment_id, input, idempotency_key=idempotency_key))
        )

    def archive(self, environment_id: str) -> Any:
        return self._b.call(lambda _c: _request(_ENVIRONMENTS.archive(environment_id)))


class CredentialsResource(Resource):
    """BYOK vendor credentials (read-only for key-based clients)."""

    def list(
        self, *, cursor: Optional[str] = None, include_revoked: Optional[bool] = None, limit: Optional[int] = None
    ) -> Any:
        return self._b.call(
            lambda _c: _request(_CREDENTIALS.list(cursor=cursor, include_revoked=include_revoked, limit=limit))
        )

    def get(self, credential_id: str) -> Any:
        return self._b.call(lambda _c: _request(_CREDENTIALS.get(credential_id)))


class SessionsResource(Resource):
    """Sessions, their append-only event log, and its resumable stream."""

    def create(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        return self._b.call(lambda _c: _request(_SESSIONS.create(input, idempotency_key=idempotency_key)))

    def list(
        self,
        *,
        agent_id: Optional[str] = None,
        environment_id: Optional[str] = None,
        status: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Any:
        return self._b.call(
            lambda _c: _request(
                _SESSIONS.list(
                    agent_id=agent_id, environment_id=environment_id, status=status, cursor=cursor, limit=limit
                )
            )
        )

    def iterate(
        self,
        *,
        agent_id: Optional[str] = None,
        environment_id: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
        max_items: Optional[int] = None,
    ) -> Paginated:
        """Every session visible to the caller, newest first, across pages."""
        return Paginated(
            self._b,
            lambda _c, cursor: _request(
                _SESSIONS.list(
                    agent_id=agent_id, environment_id=environment_id, status=status, cursor=cursor, limit=limit
                )
            ),
            lambda page: page["data"],
            next_cursor_field,
            max_items=max_items,
        )

    def get(self, session_id: str) -> Any:
        return self._b.call(lambda _c: _request(_SESSIONS.get(session_id)))

    def update(self, session_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(lambda _c: _request(_SESSIONS.update(session_id, input)))

    def send(
        self, session_id: str, events: Sequence[Mapping[str, Any]], *, idempotency_key: Optional[str] = None
    ) -> Any:
        """Append 1 to 8 user events; returns the appended events."""
        return self._b.call(lambda _c: _request(_SESSIONS.send(session_id, events, idempotency_key=idempotency_key)))

    def send_message(self, session_id: str, text: str, *, idempotency_key: Optional[str] = None) -> Any:
        """Append one ``user.message`` with a single text block."""
        return self._b.call(
            lambda _c: _request(_SESSIONS.send_message(session_id, text, idempotency_key=idempotency_key))
        )

    def respond_to_approval(
        self,
        session_id: str,
        tool_use_id: str,
        decision: str,
        *,
        message: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        """Answer an ``agent.tool_approval_request``: ``"allow"`` runs the call, ``"deny"`` refuses it.

        Same as ``approve_tool`` / ``deny_tool`` by ``decision`` (and the same derived
        ``Idempotency-Key``); returns the appended ``user.tool_approval`` event.
        """
        return self._answer(session_id, tool_use_id, decision, message, idempotency_key)

    def approve_tool(
        self, session_id: str, tool_use_id: str, *, message: Optional[str] = None, idempotency_key: Optional[str] = None
    ) -> Any:
        """Allows the tool call of an open ``agent.tool_approval_request`` (appends ``user.tool_approval``).

        The default ``Idempotency-Key`` is derived from the decision, ``tool_use_id``
        and ``message`` (see :func:`tool_approval_idempotency_key`), so a retry of the
        same answer replays the first one; a retry must reuse the same message. A
        derived key that gets ``409 unknown_tool_use`` is retried once with a fresh
        key. Errors: ``409 tool_result_already_submitted`` when the request already
        has an answer, ``409 unknown_tool_use`` when the id is not pending and was
        never answered.
        """
        return self._answer(session_id, tool_use_id, "allow", message, idempotency_key)

    def deny_tool(
        self, session_id: str, tool_use_id: str, *, message: Optional[str] = None, idempotency_key: Optional[str] = None
    ) -> Any:
        """Denies the tool call of an open ``agent.tool_approval_request``; the model sees ``message``."""
        return self._answer(session_id, tool_use_id, "deny", message, idempotency_key)

    def _answer(
        self, session_id: str, tool_use_id: str, decision: str, message: Optional[str], idempotency_key: Optional[str]
    ) -> Any:
        return self._b.call(lambda _c: self._answer_op(session_id, tool_use_id, decision, message, idempotency_key))

    def _answer_op(
        self, session_id: str, tool_use_id: str, decision: str, message: Optional[str], idempotency_key: Optional[str]
    ) -> Any:
        _engine, ctx = yield CurrentCall()
        derived = (
            tool_approval_idempotency_key(tool_use_id, decision, message)
            if idempotency_key is None and not ctx.options.idempotency_key
            else None
        )
        event = {"type": "user.tool_approval", "toolUseId": tool_use_id, "decision": decision, "message": message}
        try:
            appended = yield self._answer_request(session_id, event, idempotency_key or derived)
        except RyuError as error:
            # The server stores a 4xx under the key for 24 hours and replays it, so a derived-key
            # answer that raced ahead of its request would stay unknown_tool_use forever. One retry
            # with a fresh key asks again; the server still records at most one answer per id.
            if derived is None or error.code != "unknown_tool_use":
                raise
            appended = yield self._answer_request(session_id, event, new_idempotency_key())
        for item in appended:
            if isinstance(item, dict) and item.get("type") == "user.tool_approval":
                return item
        raise RyuResponseValidationError(
            "Ryu Managed Agents: the server accepted the tool approval but returned no user.tool_approval event.",
            service="managedAgents",
        )

    @staticmethod
    def _answer_request(session_id: str, event: dict[str, Any], key: Optional[str]) -> Request:
        return _request(_SESSIONS.send(session_id, [event], idempotency_key=key))

    def events(
        self,
        session_id: str,
        *,
        after: Optional[int] = None,
        limit: Optional[int] = None,
        types: Optional[Sequence[str]] = None,
    ) -> Any:
        """One page of the event log after ``after``."""
        return self._b.call(lambda _c: _request(_SESSIONS.events(session_id, after=after, limit=limit, types=types)))

    def cancel(self, session_id: str, reason: Optional[str] = None) -> Any:
        return self._b.call(lambda _c: _request(_SESSIONS.cancel(session_id, reason)))

    def complete(self, session_id: str) -> Any:
        """Close an ``idle`` session as ``completed``."""
        return self._b.call(lambda _c: _request(_SESSIONS.complete(session_id)))

    def delete(self, session_id: str) -> Any:
        """Delete a terminal session and its log."""
        return self._b.call(lambda _c: _request(_SESSIONS.delete(session_id)))

    # ── streams ──

    def stream(self, session_id: str, *, after: int = 0) -> Any:
        """The resumable event stream until a terminal status (``ryu_sdk.managed_agents`` semantics)."""
        return self._b.stream(lambda config: self._follow_op(config, session_id, after, "terminal", None, None, True))

    def follow(
        self,
        session_id: str,
        *,
        after: int = 0,
        until: str = "turn",
        head_seq: Optional[int] = None,
        on_tool_approval: Optional[ToolApprovalHandler] = None,
    ) -> Any:
        """Streams ``session_id`` until the turn ends (``until="turn"``, default) or the session ends.

        ``"turn"`` stops when the latest turn has ended: at the head of the log
        when its last turn is already answered, otherwise at the next ``idle``
        status that answers the last user event, or at a terminal status. Pass
        ``head_seq`` from a session you just created or read to skip the
        ``GET /events?limit=1`` that reads it.

        ``on_tool_approval`` decides each open ``agent.tool_approval_request``
        once the follow has caught up with the log's head, including requests at
        or before ``after``. It gets a :class:`ToolApprovalContext` and returns
        ``"allow"``, ``"deny"``, ``{"decision": ..., "message": ...}`` or ``None``
        (leave it open); the answer is sent like ``approve_tool`` / ``deny_tool``.
        A raise stops the follow with RyuError ``tool_approval_handler_failed``.
        Without it, or on ``None``, the follow stops at the ``requires_action``
        idle, with ``until="terminal"`` too.
        """
        return self._b.stream(
            lambda config: self._follow_op(config, session_id, after, until, head_seq, on_tool_approval, False)
        )

    def run(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        on_event: Optional[Callable[[dict[str, Any]], None]] = None,
        on_tool_approval: Optional[ToolApprovalHandler] = None,
        until: str = "turn",
    ) -> Any:
        """Create a session, follow it until the turn (or session) ends, then re-read it.

        ``input`` is the ``sessions.create()`` body plus an optional ``message``
        (sent as a ``user.message`` after any ``initialEvents``). Returns a
        :class:`ManagedAgentsRunResult` dict with the TypeScript facade's keys:
        ``events`` (every event followed), ``pendingApprovals`` (the
        ``agent.tool_approval_request`` events still open when the run stopped;
        answer each with ``approve_tool`` / ``deny_tool`` before its
        ``expiresAt``), ``session`` (re-read after the follow) and ``text`` (the
        agent's text blocks). ``on_tool_approval`` works as on :meth:`follow`.
        """
        return self._b.call(
            lambda config: self._run_op(config, dict(input), idempotency_key, on_event, on_tool_approval, until)
        )

    def _run_op(
        self,
        config: Any,
        body: dict[str, Any],
        idempotency_key: Optional[str],
        on_event: Any,
        on_tool_approval: Optional[ToolApprovalHandler],
        until: str,
    ) -> Any:
        message = body.pop("message", None)
        if message is not None:
            body["initialEvents"] = [
                *(body.get("initialEvents") or []),
                {"type": "user.message", "content": [{"type": "text", "text": message}]},
            ]
        created = yield _request(_SESSIONS.create(body, idempotency_key=idempotency_key))
        events: list[dict[str, Any]] = []
        follow = self._follow_op(config, created["id"], 0, until, created.get("headSeq"), on_tool_approval, False)
        value: Any = None
        error: Optional[BaseException] = None
        while True:
            try:
                step = follow.throw(error) if error is not None else follow.send(value)
            except StopIteration:
                break
            value, error = None, None
            if isinstance(step, Emit):
                events.append(step.item)
                if on_event is not None:
                    on_event(step.item)
                continue
            try:
                value = yield step
            except Exception as exc:  # noqa: BLE001 - handed back to the follow, as the driver does
                error = exc
        session = yield _request(_SESSIONS.get(created["id"]))
        return {
            "events": events,
            "pendingApprovals": pending_tool_approvals(events),
            "session": session,
            "text": agent_text(events),
        }

    def _seed_op(self, session_id: str, after: int, ledger: _ApprovalLedger) -> Any:
        """Reads the approval-related events up to and including ``after`` into ``ledger``."""
        cursor = 0
        for _page in range(_APPROVAL_SEED_MAX_PAGES):
            result = yield _request(
                _SESSIONS.events(
                    session_id, after=cursor, limit=_APPROVAL_SEED_PAGE_LIMIT, types=TOOL_APPROVAL_EVENT_TYPES
                )
            )
            for event in result.get("data") or []:
                if _seq(event) > after:
                    return
                ledger.observe(event)
            next_after = result.get("nextAfter")
            if (
                not result.get("hasMore")
                or not isinstance(next_after, int)
                or next_after <= cursor
                or next_after >= after
            ):
                return
            cursor = next_after

    def _answer_open_op(self, session_id: str, ledger: _ApprovalLedger, tracker: _ApprovalTracker) -> Any:
        """Asks the handler about every open request not asked about yet and sends each decision.

        Returns the highest seq it appended, or ``None``. ``expiresAt`` is not compared with the
        local clock: a request Ryu already denied has its denial in the log and is no longer open.
        """
        highest: Optional[int] = None
        for request in ledger.sorted_open():
            tool_use_id = str(request.get("toolUseId"))
            if tool_use_id in tracker.asked:
                continue
            tracker.asked.add(tool_use_id)
            context = ToolApprovalContext(
                request=request, session_id=session_id, tool_use=ledger.tool_uses.get(tool_use_id)
            )
            try:
                raw = yield Await(functools.partial(tracker.handler, context))
            except Exception as error:
                raise _handler_failed(error) from error
            decision = _normalize_decision(raw)
            if decision is None:
                continue
            try:
                answer = yield from self._answer_op(
                    session_id, tool_use_id, decision["decision"], decision["message"], None
                )
                highest = max(highest or 0, _seq(answer))
            except RyuError as error:
                if error.code not in SETTLED_ANSWER_CODES:
                    raise
            tracker.answered.add(tool_use_id)
        return highest

    def _follow_op(
        self,
        config: Any,
        session_id: str,
        after: int,
        until: str,
        head_seq: Optional[int],
        on_tool_approval: Optional[ToolApprovalHandler],
        raw: bool,
    ) -> Any:
        ledger = _ApprovalLedger()
        tracker = None if on_tool_approval is None else _ApprovalTracker(on_tool_approval)
        answered: set[str] = tracker.answered if tracker is not None else set()
        head = 0
        last_input_seq = 0
        turn_ended = False
        if not raw:
            if after > 0:
                yield from self._seed_op(session_id, after, ledger)
            if head_seq is None:
                page = yield _request(_SESSIONS.events(session_id, after=after, limit=1))
                head = int(page.get("headSeq") or 0)
            else:
                head = head_seq
            if after > 0 and after >= head:
                # Already caught up: answer (or stop at) requests the seed read found.
                answered_seq = None
                if tracker is not None:
                    answered_seq = yield from self._answer_open_op(session_id, ledger, tracker)
                if ledger.waits_on_approval(answered):
                    return
                last_input_seq = answered_seq or 0
        engine, ctx = yield CurrentCall()
        client = self._stream_client(engine, ctx)
        source = client.sessions.stream(session_id, after=after)
        yield Defer(source.aclose if self._b.is_async else source.close)
        while True:
            try:
                event = yield IterNext(source)
            except _ma.ManagedAgentsError as error:
                raise from_managed_agents_error(error) from error
            except _ma.StreamProtocolError as error:
                raise RyuResponseValidationError(
                    f"The managedAgents stream did not match the v1 contract: {error}",
                    service="managedAgents",
                ) from error
            except httpx.TimeoutException as error:
                raise RyuTimeoutError(
                    "Ryu Managed Agents: the session stream got no response headers within "
                    f"{engine.timeout_seconds(ctx)} s on every reconnect.",
                    service="managedAgents",
                    method="GET",
                ) from error
            except httpx.RequestError as error:
                raise RyuConnectionError(
                    f"Ryu Managed Agents: the session stream kept failing: {type(error).__name__}",
                    service="managedAgents",
                ) from error
            if event is END:
                return
            yield Emit(event)
            if is_terminal_status_event(event):
                return
            if raw:
                continue
            ledger.observe(event)
            is_user = str(event.get("type", "")).startswith("user.")
            if is_user:
                last_input_seq = max(last_input_seq, _seq(event))
                turn_ended = False
            caught_up = _seq(event) >= head
            if tracker is not None and caught_up:
                answered_seq = yield from self._answer_open_op(session_id, ledger, tracker)
                if answered_seq is not None:
                    last_input_seq = max(last_input_seq, answered_seq)
                    turn_ended = False
            if caught_up and ledger.waits_on_approval(answered):
                # Nobody will answer: stop instead of waiting for the timeout denial.
                return
            if until != "turn":
                continue
            if (
                not is_user
                and is_turn_end_event(event, last_input_seq)
                and not (tracker is not None and tracker.covers_requires_action(event))
            ):
                turn_ended = True
            if turn_ended and caught_up:
                return

    def _stream_client(self, engine: Any, ctx: Any) -> Any:
        """``ryu_sdk.managed_agents``' client, for its resumable stream, whose HTTP goes through
        the instance's own client (the ``transport`` or ``http_client`` you passed, with its
        proxies, mounts and default headers) under the services rules: the SDK User-Agent,
        ``with_options(headers=...)``, the per-attempt timeout until headers arrive (no read
        timeout between events), the ``on_request`` / ``on_response`` hooks and response meta."""
        config = engine.config
        cls = _ma.AsyncManagedAgentsClient if self._b.is_async else _ma.ManagedAgentsClient
        client = cls(config.api_key, config.base_url, organization_id=config.organization_id)
        # The client it built has sent nothing and holds no connection; replace it.
        replaced: Any = client
        if self._b.is_async:
            replaced._client = _AsyncStreamHttp(engine, ctx)
        else:
            replaced._client.close()
            replaced._client = _SyncStreamHttp(engine, ctx)
        return replaced


class _StreamHttp:
    """Stands in for the ``httpx`` client of ``ryu_sdk.managed_agents``' stream loop."""

    def __init__(self, engine: Any, ctx: Any) -> None:
        self.engine = engine
        self.ctx = ctx
        self.attempt = 0

    def build_request(self, method: str, url: str, *, headers: Optional[Mapping[str, str]] = None) -> httpx.Request:
        request: httpx.Request = self.engine.stream_request(method, url, dict(headers or {}), self.ctx)
        return request

    def _started(self, request: httpx.Request) -> dict[str, Any]:
        self.attempt += 1
        event: dict[str, Any] = self.engine.stream_started(request, self.attempt)
        return event

    def _finished(self, request: httpx.Request, response: httpx.Response, event: dict[str, Any]) -> None:
        self.engine.stream_finished(request, response, event, self.attempt, self.ctx)


#: A ``time.monotonic()`` deadline for the sync session stream's reads in the current context. A
#: bounded collector that drains ``sessions.follow()`` on a worker thread (the
#: ``managed_agents_list_events`` tool with ``wait: true``) sets it there, so a read that would block
#: past the deadline times out and the worker releases its connection instead of waiting for an event
#: that may never come. Unset (the default), stream reads have no read timeout.
STREAM_READ_DEADLINE: ContextVar[Optional[float]] = ContextVar("ryu_services_stream_read_deadline", default=None)


class StreamDeadlineExceeded(Exception):
    """The session stream was (re)opened after :data:`STREAM_READ_DEADLINE` passed."""


def _bound_reads(request: httpx.Request) -> None:
    deadline = STREAM_READ_DEADLINE.get()
    if deadline is None:
        return
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        # Raised outside httpx's TransportError, so the stream does not reconnect again.
        raise StreamDeadlineExceeded("the session stream's read deadline passed")
    timeout = dict(request.extensions.get("timeout") or {})
    timeout["read"] = remaining
    request.extensions["timeout"] = timeout


class _SyncStreamHttp(_StreamHttp):
    def send(self, request: httpx.Request, *, stream: bool = False) -> httpx.Response:
        _bound_reads(request)
        event = self._started(request)
        response: httpx.Response = self.engine.owner.http.send(request, stream=stream, follow_redirects=False)
        self._finished(request, response, event)
        if stream and not response.is_success:
            # The stream loop reads an error response in full; cap it first, as every other call does.
            read_error_body(response)
        return response

    def close(self) -> None:
        """The instance's client outlives the stream; ``Ryu.close()`` closes it."""


class _AsyncStreamHttp(_StreamHttp):
    async def send(self, request: httpx.Request, *, stream: bool = False) -> httpx.Response:
        event = self._started(request)
        response: httpx.Response = await self.engine.owner.http.send(request, stream=stream, follow_redirects=False)
        self._finished(request, response, event)
        if stream and not response.is_success:
            await aread_error_body(response)
        return response

    async def aclose(self) -> None:
        """The instance's client outlives the stream; ``AsyncRyu.aclose()`` closes it."""


class ManagedAgentsNamespace(Namespace):
    """``ryu.managed_agents``: ``agents``, ``environments``, ``credentials`` and ``sessions``."""

    def __init__(self, binding: Binding) -> None:
        super().__init__(binding)
        self.agents = AgentsResource(binding)
        self.environments = EnvironmentsResource(binding)
        self.credentials = CredentialsResource(binding)
        self.sessions = SessionsResource(binding)
