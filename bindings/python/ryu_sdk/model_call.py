"""Native tool-calling model calls against the Ryu Gateway.

Mirrors ``packages/sdk/src/agent/model-call.ts``: a streamed
``POST /v1/chat/completions`` with the caller's own ``tools`` and optional
``response_format``. Tool-call deltas are assembled into one assistant
message; a gateway that answers with JSON instead of SSE is accepted as a
single final result. ``x-ryu-raw-tools: on`` is always sent so a
Composio-enabled node returns the caller's ``tool_calls`` verbatim instead of
running Core's own tool loop. The egress rule runs before every request.
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator, Dict, Iterator, List, Literal, Optional, Tuple, Union
from urllib.parse import urlsplit

import httpx

from ._transport import SseParser, error_detail
from .gateway import assert_allowed_egress
from .middleware import ModelCallResult, ModelUsage

CHAT_COMPLETIONS_PATH = "/v1/chat/completions"


class GatewayError(RuntimeError):
    """The gateway answered with a non-2xx status."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


def gateway_origin(url: str) -> str:
    """Scheme, host and port of ``url``: never userinfo, path or query, which can hold a credential.

    Mirrors ``gatewayOrigin`` in ``packages/sdk/src/agent/model-call.ts``.
    """
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return "the configured gateway URL"
    if not parts.scheme or not host:
        return "the configured gateway URL"
    shown = f"[{host}]" if ":" in host else host
    return f"{parts.scheme}://{shown}{f':{port}' if port is not None else ''}"


def request_body(
    model: str,
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    response_format: Optional[Dict[str, Any]] = None,
    stream: bool = True,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {"model": model, "messages": messages, "stream": stream}
    if tools:
        body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice
    if response_format is not None:
        body["response_format"] = response_format
    return body


def request_headers(token: Optional[str]) -> Dict[str, str]:
    headers = {"content-type": "application/json", "x-ryu-raw-tools": "on"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers


def _usage(raw: Any) -> Optional[ModelUsage]:
    if not isinstance(raw, dict):
        return None
    return ModelUsage(
        prompt_tokens=int(raw.get("prompt_tokens") or 0),
        completion_tokens=int(raw.get("completion_tokens") or 0),
        total_tokens=int(raw.get("total_tokens") or 0),
    )


def parse_completion(payload: Any) -> ModelCallResult:
    """Read the first choice of a non-streaming completion."""
    if not isinstance(payload, dict):
        raise GatewayError("gateway returned a non-object completion", 200)
    choices = payload.get("choices") or []
    choice: Dict[str, Any] = choices[0] if choices and isinstance(choices[0], dict) else {}
    raw_message = choice.get("message")
    raw: Dict[str, Any] = raw_message if isinstance(raw_message, dict) else {}
    message: Dict[str, Any] = {"role": "assistant", "content": raw.get("content")}
    if raw.get("tool_calls"):
        message["tool_calls"] = [
            {
                "id": call.get("id", f"call_{index}"),
                "type": "function",
                "function": {
                    "name": (call.get("function") or {}).get("name", ""),
                    "arguments": (call.get("function") or {}).get("arguments") or "",
                },
            }
            for index, call in enumerate(raw["tool_calls"])
        ]
    return ModelCallResult(
        message=message, finish_reason=choice.get("finish_reason"), usage=_usage(payload.get("usage"))
    )


class StreamAssembler:
    """Fold OpenAI streaming chunks into text deltas and a final result."""

    def __init__(self) -> None:
        self.content = ""
        self.finish_reason: Optional[str] = None
        self.usage: Optional[ModelUsage] = None
        self._tool_calls: Dict[int, Dict[str, str]] = {}
        self._parser = SseParser()

    def feed(self, text: str) -> List[str]:
        """Consume decoded SSE text; return the text deltas it carried."""
        deltas: List[str] = []
        for frame in self._parser.feed(text):
            deltas.extend(self._frame(frame.data))
        return deltas

    def flush(self) -> List[str]:
        deltas: List[str] = []
        for frame in self._parser.flush():
            deltas.extend(self._frame(frame.data))
        return deltas

    def _frame(self, data: str) -> List[str]:
        if data.strip() == "[DONE]":
            return []
        chunk = json.loads(data)
        if not isinstance(chunk, dict):
            return []
        if chunk.get("usage"):
            self.usage = _usage(chunk["usage"])
        choices = chunk.get("choices") or []
        if not choices:
            return []
        choice = choices[0]
        self.finish_reason = choice.get("finish_reason") or self.finish_reason
        delta = choice.get("delta") or {}
        out: List[str] = []
        if delta.get("content"):
            self.content += delta["content"]
            out.append(delta["content"])
        for fallback_index, call in enumerate(delta.get("tool_calls") or []):
            index = call.get("index")
            if not isinstance(index, int):
                index = fallback_index
            function = call.get("function") or {}
            current = self._tool_calls.setdefault(
                index,
                {"id": call.get("id") or f"call_{index}", "name": function.get("name") or "", "arguments": ""},
            )
            if call.get("id"):
                current["id"] = call["id"]
            if function.get("name"):
                current["name"] = function["name"]
            current["arguments"] += function.get("arguments") or ""
        return out

    def result(self) -> ModelCallResult:
        message: Dict[str, Any] = {"role": "assistant", "content": self.content or None}
        if self._tool_calls:
            message["tool_calls"] = [
                {
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["name"], "arguments": call["arguments"]},
                }
                for _, call in sorted(self._tool_calls.items())
            ]
        return ModelCallResult(message=message, finish_reason=self.finish_reason, usage=self.usage)


def _prepare(base_url: str, token: Optional[str], body: Dict[str, Any]) -> Tuple[str, Dict[str, str], bytes]:
    base = base_url.rstrip("/")
    assert_allowed_egress(base)
    return f"{base}{CHAT_COMPLETIONS_PATH}", request_headers(token), json.dumps(body).encode("utf-8")


def _fail(response: httpx.Response, url: str, text: str) -> GatewayError:
    """A non-2xx gateway answer: the origin only (a base path or userinfo can hold a
    credential), and on 401/403 the token settings that fix it. Mirrors
    ``gatewayStatusError`` in ``packages/sdk/src/agent/model-call.ts``."""
    status = response.status_code
    auth = "; check RYU_GATEWAY_TOKEN (or gateway_token=)" if status in (401, 403) else ""
    return GatewayError(
        f"[ryu-sdk] gateway {status} at {gateway_origin(url)}{auth}: {error_detail(response, text)}",
        status,
    )


# Tagged so a check on ``event[0]`` narrows ``event[1]`` without a cast.
StreamEvent = Union[Tuple[Literal["text"], str], Tuple[Literal["done"], ModelCallResult]]


def stream_model_sync(
    client: httpx.Client, base_url: str, token: Optional[str], body: Dict[str, Any]
) -> Iterator[StreamEvent]:
    """Yield ``("text", delta)`` events then one ``("done", result)``."""
    url, headers, content = _prepare(base_url, token, body)
    with client.stream("POST", url, headers=headers, content=content) as response:
        if not response.is_success:
            response.read()
            raise _fail(response, url, response.text)
        if "text/event-stream" not in response.headers.get("content-type", ""):
            response.read()
            yield ("done", parse_completion(response.json()))
            return
        assembler = StreamAssembler()
        for chunk in response.iter_text():
            for delta in assembler.feed(chunk):
                yield ("text", delta)
        for delta in assembler.flush():
            yield ("text", delta)
        yield ("done", assembler.result())


async def stream_model_async(
    client: httpx.AsyncClient, base_url: str, token: Optional[str], body: Dict[str, Any]
) -> AsyncGenerator[StreamEvent, None]:
    url, headers, content = _prepare(base_url, token, body)
    async with client.stream("POST", url, headers=headers, content=content) as response:
        if not response.is_success:
            await response.aread()
            raise _fail(response, url, response.text)
        if "text/event-stream" not in response.headers.get("content-type", ""):
            await response.aread()
            yield ("done", parse_completion(response.json()))
            return
        assembler = StreamAssembler()
        async for chunk in response.aiter_text():
            for delta in assembler.feed(chunk):
                yield ("text", delta)
        for delta in assembler.flush():
            yield ("text", delta)
        yield ("done", assembler.result())
