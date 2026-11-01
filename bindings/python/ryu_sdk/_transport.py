"""Shared HTTP plumbing for the pure-Python Ryu clients.

Every client in this package (agent loop, harness, managed agents, workflows)
speaks JSON over httpx and, for event streams, Server-Sent Events. This module
keeps the pieces they share in one place: base-URL joining, the error raised for
a non-2xx reply, an incremental SSE frame parser that works for both the sync
and async byte iterators, and the "request spec" pattern that lets one method
body serve a sync client (returns the value) and an async client (returns an
awaitable).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Callable, Dict, Iterator, List, Mapping, Optional

import httpx

#: Default Core base URL (Ryu port scheme: Core 7980, Gateway 7981).
DEFAULT_CORE_URL = "http://127.0.0.1:7980"

ERROR_TEXT_CHARS = 512


class RyuAPIError(Exception):
    """A non-2xx reply from Core, the Gateway, or the control plane."""

    def __init__(self, message: str, status: int, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def join_url(base_url: str, path: str) -> str:
    """Join a base URL and a path without doubling or dropping slashes."""
    base = base_url.rstrip("/")
    suffix = path if path.startswith("/") else f"/{path}"
    return f"{base}{suffix}"


def parse_json_text(text: str) -> Any:
    """Decode a JSON body, returning ``None`` for an empty or non-JSON body."""
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def error_detail(response: httpx.Response, text: str) -> str:
    """The most useful one-line description of an error reply."""
    parsed = parse_json_text(text)
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            nested = error.get("message")
            if isinstance(nested, str):
                return nested
        message = parsed.get("message")
        if isinstance(message, str):
            return message
    excerpt = text.strip()[:ERROR_TEXT_CHARS]
    return excerpt or response.reason_phrase or str(response.status_code)


def raise_for_status(response: httpx.Response, method: str, path: str, text: str) -> None:
    """Raise :class:`RyuAPIError` for a non-2xx reply."""
    if response.is_success:
        return
    raise RyuAPIError(
        f"{method} {path} failed ({response.status_code}): {error_detail(response, text)}",
        response.status_code,
        parse_json_text(text),
    )


# ── Request specs ─────────────────────────────────────────────────────────────


@dataclass
class RequestSpec:
    """One JSON request: what to send and how to decode the reply."""

    method: str
    path: str
    json_body: Any = None
    params: Optional[Mapping[str, Any]] = None
    headers: Dict[str, str] = field(default_factory=dict)
    decode: Callable[[Any], Any] = lambda value: value
    #: Send ``json_body`` even when it is ``None`` (as JSON ``null``) when True.
    has_body: bool = False


def clean_params(params: Optional[Mapping[str, Any]]) -> Optional[Dict[str, str]]:
    """Drop ``None`` query values and stringify booleans the way JS does."""
    if not params:
        return None
    out: Dict[str, str] = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            out[key] = "true" if value else "false"
        else:
            out[key] = str(value)
    return out or None


def build_request(
    client: httpx.Client | httpx.AsyncClient,
    base_url: str,
    spec: RequestSpec,
    default_headers: Mapping[str, str],
) -> httpx.Request:
    headers = dict(default_headers)
    headers.update(spec.headers)
    content: Optional[bytes] = None
    if spec.json_body is not None or spec.has_body:
        headers.setdefault("content-type", "application/json")
        content = json.dumps(spec.json_body).encode("utf-8")
    return client.build_request(
        spec.method,
        join_url(base_url, spec.path),
        params=clean_params(spec.params),
        headers=headers,
        content=content,
    )


def decode_reply(response: httpx.Response, spec: RequestSpec) -> Any:
    text = response.text
    raise_for_status(response, spec.method, spec.path, text)
    return spec.decode(parse_json_text(text))


def execute_sync(
    client: httpx.Client,
    base_url: str,
    spec: RequestSpec,
    default_headers: Mapping[str, str],
) -> Any:
    response = client.send(build_request(client, base_url, spec, default_headers))
    return decode_reply(response, spec)


async def execute_async(
    client: httpx.AsyncClient,
    base_url: str,
    spec: RequestSpec,
    default_headers: Mapping[str, str],
) -> Any:
    response = await client.send(build_request(client, base_url, spec, default_headers))
    await response.aread()
    return decode_reply(response, spec)


# ── Server-Sent Events ────────────────────────────────────────────────────────


@dataclass
class SseFrame:
    """One parsed SSE frame."""

    data: str
    event: str = "message"
    id: Optional[str] = None


class SseParser:
    """Incremental SSE parser: feed decoded text, collect complete frames.

    Frames are separated by a blank line (``\\n\\n`` or ``\\r\\n\\r\\n``).
    ``data:`` lines are joined with ``\\n``; comment lines (``:``) and frames
    without data are dropped, matching the TypeScript clients.
    """

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, text: str) -> List[SseFrame]:
        self._buffer += text.replace("\r\n", "\n")
        frames: List[SseFrame] = []
        while "\n\n" in self._buffer:
            raw, self._buffer = self._buffer.split("\n\n", 1)
            frame = self._parse(raw)
            if frame is not None:
                frames.append(frame)
        return frames

    def flush(self) -> List[SseFrame]:
        """Parse whatever remains after the stream closed."""
        raw, self._buffer = self._buffer, ""
        frame = self._parse(raw) if raw.strip() else None
        return [frame] if frame is not None else []

    @staticmethod
    def _parse(raw: str) -> Optional[SseFrame]:
        event = "message"
        frame_id: Optional[str] = None
        data: List[str] = []
        for line in raw.split("\n"):
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("id:"):
                frame_id = line[3:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
        if not data:
            return None
        return SseFrame(data="\n".join(data), event=event, id=frame_id)


def iter_sse_sync(response: httpx.Response) -> Iterator[SseFrame]:
    """Yield SSE frames from a streaming sync response."""
    parser = SseParser()
    for chunk in response.iter_text():
        yield from parser.feed(chunk)
    yield from parser.flush()


async def iter_sse_async(response: httpx.Response) -> AsyncGenerator[SseFrame, None]:
    """Yield SSE frames from a streaming async response."""
    parser = SseParser()
    async for chunk in response.aiter_text():
        for frame in parser.feed(chunk):
            yield frame
    for frame in parser.flush():
        yield frame


def bearer_headers(token: Optional[str], user_jwt: Optional[str] = None) -> Dict[str, str]:
    """Core auth headers: the node bearer token plus an optional end-user JWT."""
    headers: Dict[str, str] = {}
    bearer = token or user_jwt
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"
    if user_jwt:
        headers["x-ryu-user-jwt"] = user_jwt
    return headers
