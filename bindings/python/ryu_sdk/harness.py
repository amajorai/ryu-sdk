"""Clients for Core's durable agent-harness API.

Mirrors ``packages/client/src/harness.ts``: sessions and runs are JSON control
operations under ``/api/harness``, and a run's typed events are a cursorable
SSE stream (``GET /api/harness/runs/:id/events?after=<seq>``). The same run can
be driven by a UI, CLI, channel, or this client.

The event iterators resume on their own: they remember the last ``seq``
received, and when the connection drops before a terminal event they reconnect
with ``after=<last seq>`` and drop any replayed event. Pass ``after`` yourself
to continue a stream from an earlier process.

:class:`HarnessClient` is synchronous; :class:`AsyncHarnessClient` has the same
methods as coroutines and async iterators.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncGenerator, Callable, Dict, Iterator, List, Mapping, Optional, Union

import httpx

from ._transport import (
    RequestSpec,
    RyuAPIError,
    execute_async,
    execute_sync,
    iter_sse_async,
    iter_sse_sync,
    join_url,
    raise_for_status,
)
from .gateway import resolve_core_token, resolve_core_url
from .services._base import segment

HarnessEvent = Dict[str, Any]
UserJwt = Union[None, str, Callable[[], Optional[str]]]

#: Event types that end a run's stream.
TERMINAL_EVENT_TYPES = frozenset({"run_completed", "run_failed", "run_canceled", "run_interrupted"})
#: Run statuses Core reports.
RUN_STATUSES = ("pending", "running", "awaiting_approval", "completed", "failed", "canceled", "interrupted")
#: Run statuses after which Core appends no more events.
TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "canceled", "interrupted"})

DEFAULT_EXECUTION_PROFILE: Dict[str, Any] = {
    "approval": "inherit",
    "kind": "local",
    "network": "inherit",
    "sandbox": "inherit",
    "worktreeIsolation": False,
}

_RECONNECT_BACKOFF_S = 0.25
_RECONNECT_MAX_S = 2.0
_MAX_IDLE_RECONNECTS = 5


def _segment(value: str) -> str:
    """One path id; ``""``, ``.`` and ``..`` would resolve onto another Core route, so they raise ``invalid_id``."""
    return segment("Core harness", value, "id")


def normalize_profile(profile: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """Fill an execution profile's omitted fields with Core's defaults."""
    return {**DEFAULT_EXECUTION_PROFILE, **(profile or {})}


def _require(key: str, path: str) -> Callable[[Any], Any]:
    def decode(value: Any) -> Any:
        if not isinstance(value, dict) or key not in value:
            raise ValueError(f"{path}: response has no {key!r}")
        return value[key]

    return decode


def _start_reply(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("run"), dict):
        raise ValueError("start run: response has no run")
    return value


class EventCursor:
    """The resume state of one run's event stream."""

    def __init__(self, after: int = 0) -> None:
        self.last_seq = after
        self.finished = False

    def accept(self, data: str) -> Optional[HarnessEvent]:
        """Decode one SSE data payload; ``None`` for a duplicate or malformed frame."""
        if data.strip() == "[DONE]":
            return None
        try:
            event = json.loads(data)
        except ValueError:
            return None
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            return None
        seq = event.get("seq")
        if isinstance(seq, (int, float)) and not isinstance(seq, bool):
            if seq <= self.last_seq:
                return None
            self.last_seq = int(seq)
        if event["type"] in TERMINAL_EVENT_TYPES:
            self.finished = True
        return event


class _HarnessRequests:
    """Request specs shared by the sync and async clients.

    Each method returns ``self._execute(spec)``: a value on the sync client and
    an awaitable on the async one.
    """

    def _execute(self, spec: RequestSpec) -> Any:  # pragma: no cover - overridden
        raise NotImplementedError

    def create_session(
        self,
        runnable_id: str,
        runnable_kind: str,
        *,
        agent_id: Optional[str] = None,
        title: Optional[str] = None,
        parent_session_id: Optional[str] = None,
        execution_profile: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        """Create a durable session for a runnable (``POST /api/harness/sessions``)."""
        body: Dict[str, Any] = {"runnableId": runnable_id, "runnableKind": runnable_kind}
        if agent_id:
            body["agentId"] = agent_id
        if title:
            body["title"] = title
        if parent_session_id:
            body["parentSessionId"] = parent_session_id
        body["executionProfile"] = normalize_profile(execution_profile)
        path = "/api/harness/sessions"
        return self._execute(RequestSpec("POST", path, json_body=body, decode=_require("session", path)))

    def get_session(self, session_id: str) -> Any:
        path = f"/api/harness/sessions/{_segment(session_id)}"
        return self._execute(RequestSpec("GET", path, decode=_require("session", path)))

    def list_children(self, session_id: str) -> Any:
        path = f"/api/harness/sessions/{_segment(session_id)}/children"

        def decode(value: Any) -> List[Dict[str, Any]]:
            sessions = value.get("sessions") if isinstance(value, dict) else None
            return list(sessions or [])

        return self._execute(RequestSpec("GET", path, decode=decode))

    def bind_native_session(self, session_id: str, native_session_id: str) -> Any:
        path = f"/api/harness/sessions/{_segment(session_id)}/native"
        return self._execute(
            RequestSpec(
                "PUT",
                path,
                json_body={"nativeSessionId": native_session_id},
                decode=_require("session", path),
            )
        )

    def list_runs(self, session_id: str) -> Any:
        path = f"/api/harness/sessions/{_segment(session_id)}/runs"
        return self._execute(RequestSpec("GET", path, decode=_require("runs", path)))

    def start_run(
        self,
        session_id: str,
        input: Any,
        *,
        idempotency_key: Optional[str] = None,
        resume_run_id: Optional[str] = None,
        execution_profile: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        """Start (or idempotently re-join) a run; returns ``{created, eventsUrl, run, ...}``."""
        body: Dict[str, Any] = {"input": input}
        if idempotency_key:
            body["idempotencyKey"] = idempotency_key
        if resume_run_id:
            body["resumeRunId"] = resume_run_id
        if execution_profile:
            body["executionProfile"] = normalize_profile(execution_profile)
        path = f"/api/harness/sessions/{_segment(session_id)}/runs"
        return self._execute(RequestSpec("POST", path, json_body=body, decode=_start_reply))

    def get_run(self, run_id: str) -> Any:
        path = f"/api/harness/runs/{_segment(run_id)}"
        return self._execute(RequestSpec("GET", path, decode=_require("run", path)))

    def cancel(self, run_id: str) -> Any:
        path = f"/api/harness/runs/{_segment(run_id)}/cancel"
        return self._execute(
            RequestSpec(
                "POST",
                path,
                decode=lambda value: isinstance(value, dict) and value.get("cancelled") is True,
            )
        )

    def resolve_permission(self, request_id: str, option_id: Optional[str] = None) -> Any:
        """Resolve the ACP permission request surfaced by an ``approval_requested`` event."""
        body: Dict[str, Any] = {"request_id": request_id}
        if option_id:
            body["option_id"] = option_id
        return self._execute(
            RequestSpec(
                "POST",
                "/api/chat/permission",
                json_body=body,
                decode=lambda value: isinstance(value, dict) and value.get("resolved") is True,
            )
        )


class _Base(_HarnessRequests):
    def __init__(
        self,
        base_url: Optional[str],
        token: Optional[str],
        user_jwt: UserJwt,
        reconnect: bool,
    ) -> None:
        self.base_url = (base_url or resolve_core_url()).rstrip("/")
        self.token = token if token is not None else resolve_core_token()
        self.user_jwt = user_jwt
        self.reconnect = reconnect

    def _headers(self, accept: str = "application/json") -> Dict[str, str]:
        headers = {"accept": accept, "content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        jwt = self.user_jwt() if callable(self.user_jwt) else self.user_jwt
        if jwt:
            headers["x-ryu-user-jwt"] = jwt
        return headers

    def _events_url(self, run_id: str, after: int) -> str:
        return join_url(self.base_url, f"/api/harness/runs/{_segment(run_id)}/events?after={after}")


class HarnessClient(_Base):
    """Synchronous client for Core's harness API."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        token: Optional[str] = None,
        user_jwt: UserJwt = None,
        transport: Optional[httpx.BaseTransport] = None,
        http_client: Optional[httpx.Client] = None,
        timeout: Optional[float] = 60.0,
        reconnect: bool = True,
    ) -> None:
        super().__init__(base_url, token, user_jwt, reconnect)
        self._client = http_client or httpx.Client(transport=transport, timeout=timeout)

    def _execute(self, spec: RequestSpec) -> Any:
        return execute_sync(self._client, self.base_url, spec, self._headers())

    def events(self, run_id: str, after: int = 0) -> Iterator[HarnessEvent]:
        """Yield a run's events after the exclusive ``after`` cursor, resuming on drops."""
        cursor = EventCursor(after)
        idle = 0
        while True:
            received = False
            dropped = False
            path = f"/api/harness/runs/{run_id}/events"
            try:
                with self._client.stream(
                    "GET", self._events_url(run_id, cursor.last_seq), headers=self._headers("text/event-stream")
                ) as response:
                    if not response.is_success:
                        response.read()
                        raise_for_status(response, "GET", path, response.text)
                    for frame in iter_sse_sync(response):
                        received = True
                        event = cursor.accept(frame.data)
                        if event is not None:
                            yield event
                        if cursor.finished:
                            return
            except httpx.TransportError:
                if not self.reconnect:
                    raise
                dropped = True
            if not self.reconnect:
                return
            # Core closes the stream at once, cleanly and empty, for a finished run
            # with nothing after the cursor (e.g. `after` already past the
            # terminal event): stop instead of reconnecting to an empty stream.
            if not (received or dropped) and self._run_finished(run_id):
                return
            idle = 0 if received else idle + 1
            if idle > _MAX_IDLE_RECONNECTS:
                raise ConnectionError(f"event stream for run {run_id} closed {idle} times without new events")
            time.sleep(min(_RECONNECT_MAX_S, _RECONNECT_BACKOFF_S * (2 ** max(0, idle - 1))) if idle else 0)

    def _run_finished(self, run_id: str) -> bool:
        try:
            run = self.get_run(run_id)
        except (RyuAPIError, httpx.TransportError, ValueError):
            return False
        return isinstance(run, dict) and run.get("status") in TERMINAL_RUN_STATUSES

    def run(self, session_id: str, input: Any, **options: Any) -> Iterator[HarnessEvent]:
        """Start a run and stream its durable typed events."""
        started = self.start_run(session_id, input, **options)
        yield from self.events(started["run"]["id"], 0)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HarnessClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class AsyncHarnessClient(_Base):
    """Async client for Core's harness API."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        token: Optional[str] = None,
        user_jwt: UserJwt = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        timeout: Optional[float] = 60.0,
        reconnect: bool = True,
    ) -> None:
        super().__init__(base_url, token, user_jwt, reconnect)
        self._client = http_client or httpx.AsyncClient(transport=transport, timeout=timeout)

    def _execute(self, spec: RequestSpec) -> Any:
        return execute_async(self._client, self.base_url, spec, self._headers())

    async def events(self, run_id: str, after: int = 0) -> AsyncGenerator[HarnessEvent, None]:
        cursor = EventCursor(after)
        idle = 0
        while True:
            received = False
            dropped = False
            path = f"/api/harness/runs/{run_id}/events"
            try:
                async with self._client.stream(
                    "GET", self._events_url(run_id, cursor.last_seq), headers=self._headers("text/event-stream")
                ) as response:
                    if not response.is_success:
                        await response.aread()
                        raise_for_status(response, "GET", path, response.text)
                    async for frame in iter_sse_async(response):
                        received = True
                        event = cursor.accept(frame.data)
                        if event is not None:
                            yield event
                        if cursor.finished:
                            return
            except httpx.TransportError:
                if not self.reconnect:
                    raise
                dropped = True
            if not self.reconnect:
                return
            if not (received or dropped) and await self._run_finished(run_id):
                return
            idle = 0 if received else idle + 1
            if idle > _MAX_IDLE_RECONNECTS:
                raise ConnectionError(f"event stream for run {run_id} closed {idle} times without new events")
            if idle:
                await asyncio.sleep(min(_RECONNECT_MAX_S, _RECONNECT_BACKOFF_S * (2 ** (idle - 1))))

    async def _run_finished(self, run_id: str) -> bool:
        try:
            run = await self.get_run(run_id)
        except (RyuAPIError, httpx.TransportError, ValueError):
            return False
        return isinstance(run, dict) and run.get("status") in TERMINAL_RUN_STATUSES

    async def run(self, session_id: str, input: Any, **options: Any) -> AsyncGenerator[HarnessEvent, None]:
        started = await self.start_run(session_id, input, **options)
        async for event in self.events(started["run"]["id"], 0):
            yield event

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncHarnessClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
