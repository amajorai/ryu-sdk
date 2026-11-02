"""``ryu.gateway``: a self-hosted Ryu Gateway (default ``http://127.0.0.1:7981``).

``health()``, ``auth.status()``, ``models.list()``, ``chat.completions.create()``
(``stream=True`` returns an iterator of chunks), ``chat.completions.stream()``,
``embeddings.create()`` and ``openai_compatible()``, the ``base_url`` and
``api_key`` for the official ``openai`` Python SDK. No Gateway route
deduplicates writes, so no POST is retried on a 5xx.

An upstream provider failure arrives as ``502 provider_error`` with the
provider's own status in ``error.upstream_status``; :func:`refine_gateway_error`
copies it to ``details["upstreamStatus"]`` and makes an upstream 4xx final
(``retryable=False``), except the transient 408, 425 and 429.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Optional, cast

from ._base import Namespace, Resource
from ._runtime import Defer, Emit, NextFrame, OpenStream, Request
from .errors import RyuError, create_ryu_error, with_ryu_error_fields
from .shapes import GatewayOpenAICompatibleConfig

_DONE = "[DONE]"

#: Upstream 4xx statuses that are transient: the provider may accept the same request later.
TRANSIENT_UPSTREAM_STATUSES = frozenset({408, 425, 429})


def gateway_upstream_status(body: Any) -> Optional[int]:
    """``error.upstream_status`` from a Gateway error body, when it is an HTTP error status."""
    error = body.get("error") if isinstance(body, dict) else None
    status = error.get("upstream_status") if isinstance(error, dict) else None
    if isinstance(status, bool) or not isinstance(status, (int, float)):
        return None
    if isinstance(status, float) and not status.is_integer():
        return None
    value = int(status)
    return value if 400 <= value <= 599 else None


def refine_gateway_error(error: RyuError, body: Any) -> RyuError:
    """Adds ``details["upstreamStatus"]`` from the Gateway's ``error.upstream_status`` and makes an
    upstream 4xx final (``retryable=False``), except 408, 425 and 429. Any other error is unchanged."""
    upstream = gateway_upstream_status(body)
    if upstream is None:
        return error
    details = dict(error.details) if isinstance(error.details, dict) else {}
    details["upstreamStatus"] = upstream
    if upstream < 500 and upstream not in TRANSIENT_UPSTREAM_STATUSES:
        return with_ryu_error_fields(error, details=details, retryable=False)
    return with_ryu_error_fields(error, details=details)


def _stream_error(error: Mapping[str, Any]) -> Exception:
    code = error.get("code") if isinstance(error.get("code"), str) and error.get("code") else None
    code = code or (error.get("type") if isinstance(error.get("type"), str) and error.get("type") else None)
    message = error.get("message")
    return create_ryu_error(
        message if isinstance(message, str) else "The Gateway reported an error inside the stream.",
        service="gateway",
        status=0,
        code=code or "stream_error",
        envelope="openai",
        retryable=False,
    )


def _chat_stream(params: Mapping[str, Any]) -> Any:
    stream = yield OpenStream(
        Request(
            "POST",
            "/v1/chat/completions",
            json=dict(params, stream=True),
            headers={"accept": "text/event-stream"},
        )
    )
    yield Defer(stream.close)
    while True:
        frame = yield NextFrame(stream)
        if frame is None or frame.data.strip() == _DONE:
            return
        chunk = json.loads(frame.data)
        if isinstance(chunk, dict) and isinstance(chunk.get("error"), dict):
            raise _stream_error(chunk["error"])
        yield Emit(chunk)


class ChatCompletions(Resource):
    def create(self, params: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> Any:
        """``POST /v1/chat/completions``. With ``stream=True`` returns an iterator of chunks
        (which raises RyuError in both result modes); otherwise the completion."""
        body: dict[str, Any] = {**dict(params or {}), **kwargs}
        if body.get("stream") is True:
            return self._b.stream(lambda _c: _chat_stream(body))
        return self._b.call(lambda _c: Request("POST", "/v1/chat/completions", json=dict(body, stream=False)))

    def stream(self, params: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> Any:
        """The streamed form of ``create``: an iterator of chunks."""
        body: dict[str, Any] = {**dict(params or {}), **kwargs}
        return self._b.stream(lambda _c: _chat_stream(body))


class Chat(Resource):
    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.completions = ChatCompletions(binding)


class Embeddings(Resource):
    def create(self, params: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> Any:
        body = {**dict(params or {}), **kwargs}
        return self._b.call(lambda _c: Request("POST", "/v1/embeddings", json=body))


class Models(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/models"))


class Auth(Resource):
    def status(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/auth/status"))


class GatewayNamespace(Namespace):
    """``ryu.gateway``."""

    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.chat = Chat(binding)
        self.embeddings = Embeddings(binding)
        self.models = Models(binding)
        self.auth = Auth(binding)

    def health(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/health"))

    def openai_compatible(self) -> GatewayOpenAICompatibleConfig:
        """``{"base_url", "api_key"}`` for ``openai.OpenAI(**ryu.gateway.openai_compatible())``.

        Makes no request; a configuration error raises in both result modes.
        """
        return cast(
            GatewayOpenAICompatibleConfig,
            self._b.sync_value(
                lambda config: {"base_url": f"{config.base_url.rstrip('/')}/v1", "api_key": config.api_key or ""}
            ),
        )
