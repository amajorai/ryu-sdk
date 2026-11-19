"""In-process middleware for the SDK agent loop.

Mirrors ``packages/sdk/src/agent/middleware.ts``. Core runs plugin turn hooks
for Core-owned chat and harness runs, but an :class:`~ryu_sdk.agent.Agent`
without a ``session_id`` runs its loop in the caller's process, so these hooks
give it the same seams as ordinary Python callables:

- ``wrap_model_call(request, next)`` rewrites the outbound messages, swaps the
  model, or answers without calling the model (return a result instead of
  calling ``next``).
- ``wrap_tool_call(request, next)`` denies a call (return an error output
  without calling ``next``) or transforms the output before the model sees it.
- ``after_turn(summary)`` returns a follow-up user message to run another turn
  (still bounded by ``max_steps``), or ``None`` to finish.

Middleware composes onion-style in list order: the first entry is outermost.
With :meth:`Agent.generate` every hook must be synchronous; with
:meth:`Agent.agenerate` / :meth:`Agent.stream` hooks may be ``async def`` and
``next`` must be awaited.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

Message = Dict[str, Any]


@dataclass
class ModelUsage:
    """Token usage as reported by the gateway."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def __add__(self, other: "ModelUsage") -> "ModelUsage":
        return ModelUsage(
            self.prompt_tokens + other.prompt_tokens,
            self.completion_tokens + other.completion_tokens,
            self.total_tokens + other.total_tokens,
        )


@dataclass
class ModelCallResult:
    """One gateway completion: the assistant message (OpenAI wire shape)."""

    message: Message
    finish_reason: Optional[str] = None
    usage: Optional[ModelUsage] = None

    @property
    def content(self) -> Optional[str]:
        return self.message.get("content")

    @property
    def tool_calls(self) -> List[Dict[str, Any]]:
        return list(self.message.get("tool_calls") or [])


@dataclass
class ModelCallRequest:
    """The request one model round sends to the gateway.

    ``messages`` is a copy; return a new request (``dataclasses.replace``)
    rather than mutating it in place.
    """

    messages: List[Message]
    model: str
    step: int
    tools: Optional[List[Dict[str, Any]]] = None

    def replace(self, **changes: Any) -> "ModelCallRequest":
        return replace(self, **changes)


@dataclass
class ToolCallRequest:
    """One tool call the model requested."""

    id: str
    name: str
    input: Any
    step: int

    def replace(self, **changes: Any) -> "ToolCallRequest":
        return replace(self, **changes)


@dataclass
class ToolCallResult:
    """What a tool call reports back to the model."""

    output: Any


@dataclass
class TurnSummary:
    """The state of a run when the model stops calling tools."""

    messages: Sequence[Message]
    step: int
    text: str


class Middleware:
    """A set of optional phase handlers that customize an SDK agent run.

    Pass callables to the constructor, or subclass and define
    ``wrap_model_call`` / ``wrap_tool_call`` / ``after_turn`` methods.
    """

    def __init__(
        self,
        name: Optional[str] = None,
        *,
        wrap_model_call: Optional[Callable[..., Any]] = None,
        wrap_tool_call: Optional[Callable[..., Any]] = None,
        after_turn: Optional[Callable[[TurnSummary], Any]] = None,
    ) -> None:
        self.name = name or type(self).__name__
        # Only set what was passed so a subclass's methods are not shadowed.
        if wrap_model_call is not None:
            self.wrap_model_call = wrap_model_call
        if wrap_tool_call is not None:
            self.wrap_tool_call = wrap_tool_call
        if after_turn is not None:
            self.after_turn = after_turn

    def __repr__(self) -> str:
        return f"Middleware(name={self.name!r})"


def _handlers(middleware: Sequence[Any], attribute: str) -> List[Callable[..., Any]]:
    out = []
    for entry in middleware:
        handler = getattr(entry, attribute, None)
        if callable(handler):
            out.append(handler)
    return out


def _sync_value(value: Any, where: str) -> Any:
    if inspect.isawaitable(value):
        if hasattr(value, "close"):
            value.close()
        raise TypeError(f"{where} returned an awaitable; use Agent.agenerate() or Agent.stream() for async middleware")
    return value


def compose_sync(middleware: Sequence[Any], attribute: str, inner: Callable[[Any], Any]) -> Callable[[Any], Any]:
    """Chain synchronous wrappers around ``inner``, first entry outermost."""
    call = inner
    for handler in reversed(_handlers(middleware, attribute)):
        downstream = call

        def wrapped(request: Any, _handler: Callable[..., Any] = handler, _next: Callable[[Any], Any] = downstream) -> Any:
            return _sync_value(_handler(request, _next), attribute)

        call = wrapped
    return call


def compose_async(
    middleware: Sequence[Any], attribute: str, inner: Callable[[Any], Awaitable[Any]]
) -> Callable[[Any], Awaitable[Any]]:
    """Chain sync-or-async wrappers around an async ``inner``, first entry outermost."""
    call = inner
    for handler in reversed(_handlers(middleware, attribute)):
        downstream = call

        async def wrapped(
            request: Any,
            _handler: Callable[..., Any] = handler,
            _next: Callable[[Any], Awaitable[Any]] = downstream,
        ) -> Any:
            value = _handler(request, _next)
            if inspect.isawaitable(value):
                value = await value
            return value

        call = wrapped
    return call


def _continue_text(directive: Any) -> Optional[str]:
    if directive is None:
        return None
    text: Any
    if isinstance(directive, str):
        text = directive
    elif isinstance(directive, dict):
        text = directive.get("continue")
    else:
        text = getattr(directive, "continue_", None)
    if isinstance(text, str) and text.strip():
        return text
    return None


def run_after_turn_sync(middleware: Sequence[Any], summary: TurnSummary) -> Optional[str]:
    """Run ``after_turn`` handlers in order; the first non-empty continuation wins."""
    for handler in _handlers(middleware, "after_turn"):
        text = _continue_text(_sync_value(handler(summary), "after_turn"))
        if text is not None:
            return text
    return None


async def run_after_turn_async(middleware: Sequence[Any], summary: TurnSummary) -> Optional[str]:
    for handler in _handlers(middleware, "after_turn"):
        value = handler(summary)
        if inspect.isawaitable(value):
            value = await value
        text = _continue_text(value)
        if text is not None:
            return text
    return None
