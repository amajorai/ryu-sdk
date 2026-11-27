"""Shared fakes for the pure-Python SDK tests: an httpx MockTransport router."""

from __future__ import annotations

import json
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

Handler = Callable[[httpx.Request], httpx.Response]


def sse(*frames: Any, event_ids: bool = False) -> bytes:
    """Encode frames as SSE. A frame is a JSON-able value or ``(event, id, data)``."""
    out = []
    for frame in frames:
        if isinstance(frame, tuple):
            event, frame_id, data = frame
            lines = []
            if event:
                lines.append(f"event: {event}")
            if frame_id is not None:
                lines.append(f"id: {frame_id}")
            lines.append(f"data: {data if isinstance(data, str) else json.dumps(data)}")
            out.append("\n".join(lines))
        else:
            out.append(f"data: {frame if isinstance(frame, str) else json.dumps(frame)}")
    return ("\n\n".join(out) + "\n\n").encode("utf-8")


def sse_response(*frames: Any) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse(*frames))


def completion(content: Optional[str] = None, tool_calls: Optional[List[Dict[str, Any]]] = None, usage: Optional[Dict[str, int]] = None) -> httpx.Response:
    """A non-streaming chat completion (the gateway's JSON fallback)."""
    message: Dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    body: Dict[str, Any] = {"choices": [{"message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}]}
    if usage:
        body["usage"] = usage
    return httpx.Response(200, json=body)


def tool_call(call_id: str, name: str, arguments: Any) -> Dict[str, Any]:
    args = arguments if isinstance(arguments, str) else json.dumps(arguments)
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": args}}


def streamed_completion(*deltas: Dict[str, Any], usage: Optional[Dict[str, int]] = None) -> httpx.Response:
    """A streamed completion: each delta becomes one chunk."""
    chunks: List[Any] = [{"choices": [{"delta": delta, "finish_reason": None}]} for delta in deltas]
    if usage:
        chunks.append({"choices": [], "usage": usage})
    chunks.append("[DONE]")
    return sse_response(*chunks)


class Router:
    """Route requests by ``(METHOD, path)`` to queued responses or handlers.

    Every request is recorded (with its decoded JSON body) for assertions.
    """

    def __init__(self) -> None:
        self.routes: Dict[Tuple[str, str], List[Any]] = {}
        self.requests: List[httpx.Request] = []
        self._lock = threading.Lock()

    def add(self, method: str, path: str, *responses: Any) -> "Router":
        self.routes.setdefault((method, path), []).extend(responses)
        return self

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.requests.append(request)
            queue = self.routes.get((request.method, request.url.path))
            if not queue:
                return httpx.Response(404, json={"error": f"no route for {request.method} {request.url.path}"})
            entry = queue[0] if len(queue) == 1 else queue.pop(0)
        if callable(entry):
            return entry(request)
        # A Response's stream is single-use; hand out a fresh copy each time.
        return httpx.Response(entry.status_code, headers=entry.headers, content=entry.content)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def bodies(self, method: str, path: str) -> List[Any]:
        return [
            json.loads(request.content) if request.content else None
            for request in self.requests
            if request.method == method and request.url.path == path
        ]

    def calls(self, method: str, path: str) -> List[httpx.Request]:
        return [request for request in self.requests if request.method == method and request.url.path == path]


GATEWAY = "http://gateway.test"
CORE = "http://core.test"
CHAT = "/v1/chat/completions"
