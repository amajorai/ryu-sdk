"""The steps an operation ``yield``s to a driver, and the per-call state."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import httpx

from ..errors import RyuError
from ..result import ResponseMeta
from .constants import _NO_BODY

# ── Steps ─────────────────────────────────────────────────────────────────────


class Request:
    """One HTTP request an operation wants to make."""

    __slots__ = (
        "auth",
        "content",
        "decode",
        "headers",
        "json",
        "method",
        "params",
        "path",
        "raw",
        "url",
    )

    def __init__(
        self,
        method: str,
        path: str = "",
        *,
        url: Optional[str] = None,
        json: Any = _NO_BODY,
        content: Optional[bytes] = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        decode: Optional[Callable[[Any], Any]] = None,
        raw: Any = False,
        auth: Optional[str] = None,
    ) -> None:
        self.method = method.upper()
        self.path = path
        self.url = url
        self.json = json
        self.content = content
        self.params = params
        self.headers = {key.lower(): value for key, value in (headers or {}).items()}
        self.decode = decode
        self.raw = raw
        #: A bearer key that replaces the service key for this request (Passport runtime).
        self.auth = auth


@dataclass
class Sleep:
    seconds: float


@dataclass
class OpenStream:
    """Send ``request`` and return a stream of SSE frames (no retries, as in TypeScript)."""

    request: Request


@dataclass
class NextFrame:
    """The next SSE frame of an open stream, or ``None`` at its end."""

    stream: Any


@dataclass
class CloseStream:
    stream: Any


@dataclass
class Emit:
    """Hand one item to the caller of an iterator."""

    item: Any


@dataclass
class Now:
    """The engine's wall clock, in seconds (injectable in tests)."""


#: What :class:`IterNext` returns at the end of the source.
END = object()


@dataclass
class IterNext:
    """The next item of a sync iterator (``Ryu``) or async iterator (``AsyncRyu``), or :data:`END`."""

    source: Any


@dataclass
class Defer:
    """Register ``fn`` to run (and on ``AsyncRyu`` be awaited) when the call or iteration ends."""

    fn: Callable[[], Any]


@dataclass
class CurrentCall:
    """The running call's ``(engine, context)``, for operations that send outside :class:`Request`."""


@dataclass
class Await:
    """Call ``fn()``; on ``AsyncRyu`` an awaitable result is awaited."""

    fn: Callable[[], Any]


@dataclass
class _Send:
    request: httpx.Request
    stream: bool
    timeout: httpx.Timeout


@dataclass
class _SharedProbe:
    """Run the capability read ``gen`` once per ``key`` while it is in flight.

    ``AsyncRyu`` hands concurrent callers the leader's ``(features, ttl)``, as TypeScript's
    shared pending ``cachedCapabilities`` read does; ``Ryu`` runs it inline.
    """

    key: str
    gen: Any


@dataclass
class _Outcome:
    response: Optional[httpx.Response] = None
    error: Optional[BaseException] = None
    kind: str = ""


def normalize_timeout(value: Optional[float]) -> Optional[float]:
    """Seconds per attempt, or ``None`` for no timeout: ``None``, ``0``, a negative value and
    ``inf`` all disable it, as ``timeoutMs`` 0 or ``Infinity`` do in TypeScript."""
    if value is None or value <= 0:
        return None
    try:
        seconds = float(value)
    except OverflowError:  # an int past float range is ``Infinity``: no timeout, as in TypeScript
        return None
    return None if math.isinf(seconds) else seconds


def single(step: Any) -> Any:
    """A generator that runs one step and returns its result."""
    return (yield step)


# ── Call state ────────────────────────────────────────────────────────────────


@dataclass
class CallOptions:
    """Options that apply to calls made through one (possibly bound) namespace."""

    idempotency_key: Optional[str] = None
    headers: dict[str, str] = field(default_factory=dict)
    #: Seconds; overrides the instance ``timeout``.
    timeout: Optional[float] = None


@dataclass
class CallContext:
    options: CallOptions
    #: Shared by every call through one ``with_options(idempotency_key=...)`` namespace.
    bound_key: Optional[dict[str, bool]] = None
    caller_key_used: bool = False
    meta: Optional[ResponseMeta] = None
    last_failure: Optional[RyuError] = None
