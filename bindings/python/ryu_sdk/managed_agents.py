"""Client for the hosted Ryu Managed Agents API (``/api/v1/managed-agents``).

Mirrors ``packages/client/src/managed-agents.ts``:

- ``agents``: versioned agent definitions (create, list, get, update, archive,
  versions);
- ``environments``: execution environments (personal API keys only for writes);
- ``credentials``: read-only BYOK vendor credentials;
- ``sessions``: sessions, their append-only event log, and a resumable SSE
  stream.

Requests carry ``x-api-key`` (never in a URL) and an optional
``X-Ryu-Organization``. Redirects are refused, because following one would
resend the API key to whatever origin ``Location`` names. Non-2xx replies raise
:class:`ManagedAgentsError` with the stable ``code`` from the error envelope.

:meth:`SessionsAPI.stream` replays the log after ``after`` and then tails it.
A dropped connection is resumed with ``Last-Event-ID`` set to the last ``seq``
received, replayed events are dropped on ``seq``, and iteration ends at the
server's ``end`` frame or after a terminal ``session.status`` event.

:class:`ManagedAgentsClient` is synchronous; :class:`AsyncManagedAgentsClient`
has the same resources with coroutine methods and an async ``stream``.
"""

from __future__ import annotations

import asyncio
import email.utils
import json
import time
from typing import Any, AsyncGenerator, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import quote, urlsplit

import httpx

from ._transport import ERROR_TEXT_CHARS, RequestSpec, build_request, iter_sse_async, iter_sse_sync, parse_json_text

MANAGED_AGENTS_PROTOCOL_VERSION = "ryu.managed-agents.v1"
MANAGED_AGENTS_PATH = "/api/v1/managed-agents"
#: ``code`` of an error built from a reply without the error envelope.
MANAGED_AGENTS_UNKNOWN_ERROR_CODE = "unknown_error"
#: ``code`` of an error for a redirect reply (the client never follows one).
MANAGED_AGENTS_REDIRECT_ERROR_CODE = "redirect_refused"

#: Every event type declared in v1 (``agent.message.delta`` is reserved).
MANAGED_AGENT_EVENT_TYPES = frozenset(
    {
        "user.message",
        "user.interrupt",
        "user.custom_tool_result",
        "user.tool_approval",
        "agent.message",
        "agent.message.delta",
        "agent.tool_use",
        "agent.tool_result",
        "agent.custom_tool_use",
        "agent.tool_approval_request",
        "session.status",
        "session.error",
        "session.usage",
    }
)
TERMINAL_SESSION_STATUSES = frozenset({"completed", "failed", "canceled"})

_STREAM_RETRY_S = 2.0
_STREAM_FAILURE_BACKOFF_S = 0.25
_STREAM_MAX_CONSECUTIVE_FAILURES = 5

ManagedAgentEvent = Dict[str, Any]


class ManagedAgentsError(Exception):
    """A non-2xx (or redirect) reply from the Managed Agents API."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int,
        details: Any = None,
        request_id: Optional[str] = None,
        retry_after_seconds: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds


class StreamProtocolError(ValueError):
    """A stream frame did not match the v1 contract (not retried)."""


def _segment(value: Any) -> str:
    """``value`` as one encoded path segment. ``quote`` leaves ``.`` and ``..`` as they are, and a URL
    parser resolves those as dot segments (``/sessions/..`` becomes ``/``), so they and an empty value
    raise ``ManagedAgentsError(code="invalid_id", status=0)`` before any request."""
    text = str(value)
    if text in ("", ".", ".."):
        raise ManagedAgentsError(
            'Ryu Managed Agents: a path id must be a non-empty id other than "." or "..".',
            code="invalid_id",
            status=0,
        )
    return quote(text, safe="")


def parse_retry_after(value: Optional[str]) -> Optional[int]:
    """``Retry-After`` as seconds: an integer, or an HTTP date relative to now."""
    if value is None:
        return None
    trimmed = value.strip()
    if trimmed.isdigit():
        return int(trimmed)
    try:
        moment = email.utils.parsedate_to_datetime(trimmed)
    except (TypeError, ValueError):
        return None
    if moment is None:
        return None
    return max(0, int(-(-(moment.timestamp() - time.time()) // 1)))


def _error_from_response(response: httpx.Response, method: str, path: str) -> ManagedAgentsError:
    text = response.text
    retry_after = parse_retry_after(response.headers.get("Retry-After"))
    envelope = parse_json_text(text)
    error = envelope.get("error") if isinstance(envelope, dict) else None
    if (
        isinstance(error, dict)
        and isinstance(error.get("code"), str)
        and isinstance(error.get("message"), str)
    ):
        request_id = error.get("requestId")
        return ManagedAgentsError(
            error["message"],
            code=error["code"],
            status=response.status_code,
            details=error.get("details"),
            request_id=request_id if isinstance(request_id, str) else None,
            retry_after_seconds=retry_after,
        )
    excerpt = text.strip()[:ERROR_TEXT_CHARS]
    suffix = f": {excerpt}" if excerpt else ""
    return ManagedAgentsError(
        f"Ryu Managed Agents: {method} {path} failed ({response.status_code}){suffix}",
        code=MANAGED_AGENTS_UNKNOWN_ERROR_CODE,
        status=response.status_code,
        request_id=response.headers.get("X-Request-ID"),
        retry_after_seconds=retry_after,
    )


def _redirect_origin(location: Optional[str], url: str) -> Optional[str]:
    if not location:
        return None
    try:
        target = urlsplit(str(httpx.URL(url).join(location)))
    except (httpx.InvalidURL, ValueError):
        return None
    if not (target.scheme and target.netloc):
        return None
    return f"{target.scheme}://{target.netloc}"


def _redirect_error(response: httpx.Response, method: str, path: str) -> ManagedAgentsError:
    return ManagedAgentsError(
        f"Ryu Managed Agents: {method} {path} was redirected ({response.status_code}); "
        "the client does not follow redirects, so check base_url",
        code=MANAGED_AGENTS_REDIRECT_ERROR_CODE,
        status=response.status_code,
        details={"location": _redirect_origin(response.headers.get("Location"), str(response.request.url))},
        request_id=response.headers.get("X-Request-ID"),
    )


def _check(response: httpx.Response, method: str, path: str) -> None:
    if 300 <= response.status_code < 400:
        raise _redirect_error(response, method, path)
    if not response.is_success:
        raise _error_from_response(response, method, path)


def _known(events: Sequence[Any]) -> List[ManagedAgentEvent]:
    return [event for event in events if isinstance(event, dict) and event.get("type") in MANAGED_AGENT_EVENT_TYPES]


def _list_page(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("data"), list):
        raise ValueError("Managed Agents list reply has no data array")
    return value


def _object(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Managed Agents reply is not an object")
    return value


class StreamCursor:
    """Resume state for a session stream: the last ``seq`` received."""

    def __init__(self, after: int = 0) -> None:
        self.last_seq = after

    def read(self, event: str, frame_id: Optional[str], data: str) -> Tuple[Optional[ManagedAgentEvent], bool]:
        """Return ``(event_or_None, stop)`` for one SSE frame."""
        try:
            payload = json.loads(data)
        except ValueError as error:
            raise StreamProtocolError(f"stream frame is not JSON: {data[:80]}") from error
        if event == "end":
            if not isinstance(payload, dict) or "headSeq" not in payload:
                raise StreamProtocolError("stream end frame is malformed")
            return None, True
        if frame_id is None:
            # Every log event carries `id:`; an id-less frame is a control frame from a newer server.
            return None, False
        if not isinstance(payload, dict) or not isinstance(payload.get("seq"), int) or not isinstance(payload.get("type"), str):
            raise StreamProtocolError("stream event has no seq/type")
        if payload["seq"] <= self.last_seq:
            return None, False
        self.last_seq = payload["seq"]
        if payload["type"] not in MANAGED_AGENT_EVENT_TYPES:
            return None, False
        stop = payload["type"] == "session.status" and payload.get("status") in TERMINAL_SESSION_STATUSES
        return payload, stop


def _reconnect_delay(kind: str, received: bool, failures: int) -> float:
    if kind == "failed":
        backoff: float = _STREAM_FAILURE_BACKOFF_S * (2 ** max(0, failures - 1))
        return min(_STREAM_RETRY_S, backoff)
    return 0.0 if received else _STREAM_RETRY_S


# ── Resources (shared request specs) ──────────────────────────────────────────


class _Resource:
    def __init__(self, execute: Callable[[RequestSpec], Any]) -> None:
        self._execute = execute

    def _json(
        self,
        method: str,
        path: str,
        decode: Callable[[Any], Any] = _object,
        *,
        body: Any = None,
        params: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key is not None else {}
        return self._execute(
            RequestSpec(method, path, json_body=body, params=params, headers=headers, decode=decode)
        )


class AgentsAPI(_Resource):
    """Versioned agent definitions."""

    def create(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """Create version 1."""
        return self._json("POST", "/agents", body=dict(input), idempotency_key=idempotency_key)

    def list(self, *, cursor: Optional[str] = None, include_archived: Optional[bool] = None, limit: Optional[int] = None) -> Any:
        params = {"cursor": cursor, "includeArchived": include_archived, "limit": limit}
        return self._json("GET", "/agents", _list_page, params=params)

    def get(self, agent_id: str) -> Any:
        """The latest version's fields."""
        return self._json("GET", f"/agents/{_segment(agent_id)}")

    def update(self, agent_id: str, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """A change inserts version N+1; an unchanged config returns the latest version."""
        return self._json("PATCH", f"/agents/{_segment(agent_id)}", body=dict(input), idempotency_key=idempotency_key)

    def archive(self, agent_id: str) -> Any:
        return self._json("POST", f"/agents/{_segment(agent_id)}/archive")

    def list_versions(self, agent_id: str, *, cursor: Optional[str] = None, limit: Optional[int] = None) -> Any:
        return self._json(
            "GET", f"/agents/{_segment(agent_id)}/versions", _list_page, params={"cursor": cursor, "limit": limit}
        )

    def get_version(self, agent_id: str, version: int) -> Any:
        return self._json("GET", f"/agents/{_segment(agent_id)}/versions/{_segment(version)}")


class EnvironmentsAPI(_Resource):
    """Execution environments. Writes need a personal API key."""

    def create(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        return self._json("POST", "/environments", body=dict(input), idempotency_key=idempotency_key)

    def list(self, *, cursor: Optional[str] = None, include_archived: Optional[bool] = None, limit: Optional[int] = None) -> Any:
        params = {"cursor": cursor, "includeArchived": include_archived, "limit": limit}
        return self._json("GET", "/environments", _list_page, params=params)

    def get(self, environment_id: str) -> Any:
        return self._json("GET", f"/environments/{_segment(environment_id)}")

    def update(self, environment_id: str, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """An accepted change increments ``revision`` and affects only new sessions."""
        return self._json(
            "PATCH", f"/environments/{_segment(environment_id)}", body=dict(input), idempotency_key=idempotency_key
        )

    def archive(self, environment_id: str) -> Any:
        return self._json("POST", f"/environments/{_segment(environment_id)}/archive")


class CredentialsAPI(_Resource):
    """BYOK vendor credentials (read-only for key-based clients)."""

    def list(self, *, cursor: Optional[str] = None, include_revoked: Optional[bool] = None, limit: Optional[int] = None) -> Any:
        params = {"cursor": cursor, "includeRevoked": include_revoked, "limit": limit}
        return self._json("GET", "/credentials", _list_page, params=params)

    def get(self, credential_id: str) -> Any:
        return self._json("GET", f"/credentials/{_segment(credential_id)}")


def _appended(value: Any) -> List[ManagedAgentEvent]:
    return _known(_list_page(value)["data"])


def _first_appended(value: Any) -> Optional[ManagedAgentEvent]:
    appended = _appended(value)
    return appended[0] if appended else None


def _event_page(value: Any) -> Dict[str, Any]:
    page = _list_page(value)
    return {**page, "data": _known(page["data"])}


class _SessionRequests(_Resource):
    def create(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """Start a session of a pinned agent version in an environment."""
        return self._json("POST", "/sessions", body=dict(input), idempotency_key=idempotency_key)

    def list(
        self,
        *,
        agent_id: Optional[str] = None,
        environment_id: Optional[str] = None,
        status: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Any:
        params = {
            "agentId": agent_id,
            "cursor": cursor,
            "environmentId": environment_id,
            "limit": limit,
            "status": status,
        }
        return self._json("GET", "/sessions", _list_page, params=params)

    def get(self, session_id: str) -> Any:
        return self._json("GET", f"/sessions/{_segment(session_id)}")

    def update(self, session_id: str, input: Mapping[str, Any]) -> Any:
        """Ryu-only title and metadata; nothing is sent to the vendor."""
        return self._json("PATCH", f"/sessions/{_segment(session_id)}", body=dict(input))

    def send(self, session_id: str, events: Sequence[Mapping[str, Any]], *, idempotency_key: Optional[str] = None) -> Any:
        """Append 1 to 8 user events; returns the appended events."""
        return self._json(
            "POST",
            f"/sessions/{_segment(session_id)}/events",
            _appended,
            body={"events": [dict(event) for event in events]},
            idempotency_key=idempotency_key,
        )

    def send_message(self, session_id: str, text: str, *, idempotency_key: Optional[str] = None) -> Any:
        """Append one ``user.message`` with a single text block."""
        event = {"type": "user.message", "content": [{"type": "text", "text": text}]}
        return self.send(session_id, [event], idempotency_key=idempotency_key)

    def respond_to_approval(
        self,
        session_id: str,
        tool_use_id: str,
        decision: str,
        *,
        message: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        """Answer an ``agent.tool_approval_request`` (``decision`` is ``"allow"`` or ``"deny"``).

        Appends one ``user.tool_approval`` and returns it (``None`` if the reply has none),
        like ``@ryuhq/client``'s ``respondToApproval``. ``message`` is shown to the model with
        a denial. No key is derived here; ``ryu_sdk.services`` derives one per answer.
        """
        event = {"type": "user.tool_approval", "toolUseId": tool_use_id, "decision": decision, "message": message}
        return self._json(
            "POST",
            f"/sessions/{_segment(session_id)}/events",
            _first_appended,
            body={"events": [event]},
            idempotency_key=idempotency_key,
        )

    def events(
        self,
        session_id: str,
        *,
        after: Optional[int] = None,
        limit: Optional[int] = None,
        types: Optional[Sequence[str]] = None,
    ) -> Any:
        """One page of the event log after ``after`` (unknown event types removed)."""
        params = {"after": after, "limit": limit, "types": ",".join(types) if types else None}
        return self._json("GET", f"/sessions/{_segment(session_id)}/events", _event_page, params=params)

    def cancel(self, session_id: str, reason: Optional[str] = None) -> Any:
        body = {} if reason is None else {"reason": reason}
        return self._json("POST", f"/sessions/{_segment(session_id)}/cancel", body=body)

    def complete(self, session_id: str) -> Any:
        """Close an ``idle`` session as ``completed``."""
        return self._json("POST", f"/sessions/{_segment(session_id)}/complete")

    def delete(self, session_id: str) -> Any:
        """Delete a terminal session and its log."""
        return self._json("DELETE", f"/sessions/{_segment(session_id)}", lambda _value: None)

    @staticmethod
    def _stream_path(session_id: str, after: Optional[int]) -> str:
        path = f"/sessions/{_segment(session_id)}/stream"
        return f"{path}?after={after}" if after is not None else path


class _Base:
    def __init__(self, api_key: str, base_url: str, organization_id: Optional[str]) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.base_url = f"{base_url.rstrip('/')}{MANAGED_AGENTS_PATH}"
        self.organization_id = organization_id

    def _headers(self, accept: str = "application/json") -> Dict[str, str]:
        headers = {"Accept": accept, "x-api-key": self.api_key}
        if self.organization_id:
            headers["X-Ryu-Organization"] = self.organization_id
        return headers


class SessionsAPI(_SessionRequests):
    """Sessions, their event log, and its resumable stream (sync)."""

    def __init__(self, execute: Callable[[RequestSpec], Any], owner: "ManagedAgentsClient") -> None:
        super().__init__(execute)
        self._owner = owner

    def stream(self, session_id: str, *, after: int = 0) -> Iterator[ManagedAgentEvent]:
        cursor = StreamCursor(after)
        path = self._stream_path(session_id, after if after else None)
        failures = 0
        reconnect = False
        while True:
            kind, received, error = "closed", False, None
            try:
                for event, stop, got in self._connection(path, cursor, reconnect):
                    received = received or got
                    if event is not None:
                        yield event
                    if stop:
                        return
            except (ManagedAgentsError, StreamProtocolError):
                raise
            except httpx.TransportError as transport_error:
                kind, error = "failed", transport_error
            if received:
                failures = 0
            if kind == "failed":
                failures += 1
                if failures > _STREAM_MAX_CONSECUTIVE_FAILURES:
                    raise error  # type: ignore[misc]
            reconnect = True
            time.sleep(_reconnect_delay(kind, received, failures))

    def _connection(
        self, path: str, cursor: StreamCursor, reconnect: bool
    ) -> Iterator[Tuple[Optional[ManagedAgentEvent], bool, bool]]:
        owner = self._owner
        headers = owner._headers("text/event-stream")
        if reconnect:
            headers["Last-Event-ID"] = str(cursor.last_seq)
        request = owner._client.build_request("GET", f"{owner.base_url}{path}", headers=headers)
        response = owner._client.send(request, stream=True)
        try:
            if not (300 <= response.status_code < 400) and not response.is_success:
                response.read()
            _check(response, "GET", path)
            content_type = response.headers.get("Content-Type", "")
            if not content_type.startswith("text/event-stream"):
                raise ManagedAgentsError(
                    f"Ryu Managed Agents: GET {path} did not return an event stream ({content_type or 'no content type'})",
                    code=MANAGED_AGENTS_UNKNOWN_ERROR_CODE,
                    status=response.status_code,
                    request_id=response.headers.get("X-Request-ID"),
                )
            for frame in iter_sse_sync(response):
                event, stop = cursor.read(frame.event, frame.id, frame.data)
                yield event, stop, True
                if stop:
                    return
        finally:
            response.close()


class AsyncSessionsAPI(_SessionRequests):
    """Sessions, their event log, and its resumable stream (async)."""

    def __init__(self, execute: Callable[[RequestSpec], Any], owner: "AsyncManagedAgentsClient") -> None:
        super().__init__(execute)
        self._owner = owner

    async def stream(self, session_id: str, *, after: int = 0) -> AsyncGenerator[ManagedAgentEvent, None]:
        cursor = StreamCursor(after)
        path = self._stream_path(session_id, after if after else None)
        failures = 0
        reconnect = False
        while True:
            kind, received, error = "closed", False, None
            try:
                async for event, stop in self._connection(path, cursor, reconnect):
                    received = True
                    if event is not None:
                        yield event
                    if stop:
                        return
            except (ManagedAgentsError, StreamProtocolError):
                raise
            except httpx.TransportError as transport_error:
                kind, error = "failed", transport_error
            if received:
                failures = 0
            if kind == "failed":
                failures += 1
                if failures > _STREAM_MAX_CONSECUTIVE_FAILURES:
                    raise error  # type: ignore[misc]
            reconnect = True
            await asyncio.sleep(_reconnect_delay(kind, received, failures))

    async def _connection(
        self, path: str, cursor: StreamCursor, reconnect: bool
    ) -> AsyncGenerator[Tuple[Optional[ManagedAgentEvent], bool], None]:
        owner = self._owner
        headers = owner._headers("text/event-stream")
        if reconnect:
            headers["Last-Event-ID"] = str(cursor.last_seq)
        request = owner._client.build_request("GET", f"{owner.base_url}{path}", headers=headers)
        response = await owner._client.send(request, stream=True)
        try:
            if not (300 <= response.status_code < 400) and not response.is_success:
                await response.aread()
            _check(response, "GET", path)
            content_type = response.headers.get("Content-Type", "")
            if not content_type.startswith("text/event-stream"):
                raise ManagedAgentsError(
                    f"Ryu Managed Agents: GET {path} did not return an event stream ({content_type or 'no content type'})",
                    code=MANAGED_AGENTS_UNKNOWN_ERROR_CODE,
                    status=response.status_code,
                    request_id=response.headers.get("X-Request-ID"),
                )
            async for frame in iter_sse_async(response):
                event, stop = cursor.read(frame.event, frame.id, frame.data)
                yield event, stop
                if stop:
                    return
        finally:
            await response.aclose()


class ManagedAgentsClient(_Base):
    """Synchronous Managed Agents client."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        organization_id: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
        timeout: Optional[float] = 60.0,
    ) -> None:
        super().__init__(api_key, base_url, organization_id)
        self._client = httpx.Client(transport=transport, timeout=timeout, follow_redirects=False)
        self.agents = AgentsAPI(self._execute)
        self.environments = EnvironmentsAPI(self._execute)
        self.credentials = CredentialsAPI(self._execute)
        self.sessions = SessionsAPI(self._execute, self)

    def _execute(self, spec: RequestSpec) -> Any:
        request = build_request(self._client, self.base_url, spec, self._headers())
        response = self._client.send(request)
        _check(response, spec.method, spec.path)
        return spec.decode(parse_json_text(response.text))

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "ManagedAgentsClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class AsyncManagedAgentsClient(_Base):
    """Async Managed Agents client."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        organization_id: Optional[str] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        timeout: Optional[float] = 60.0,
    ) -> None:
        super().__init__(api_key, base_url, organization_id)
        self._client = httpx.AsyncClient(transport=transport, timeout=timeout, follow_redirects=False)
        self.agents = AgentsAPI(self._execute)
        self.environments = EnvironmentsAPI(self._execute)
        self.credentials = CredentialsAPI(self._execute)
        self.sessions = AsyncSessionsAPI(self._execute, self)

    async def _execute(self, spec: RequestSpec) -> Any:
        request = build_request(self._client, self.base_url, spec, self._headers())
        response = await self._client.send(request)
        await response.aread()
        _check(response, spec.method, spec.path)
        return spec.decode(parse_json_text(response.text))

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncManagedAgentsClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
