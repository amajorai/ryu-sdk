"""The request engine behind every service namespace.

One body of logic serves the sync :class:`~ryu_sdk.services.Ryu` and the async
:class:`~ryu_sdk.services.AsyncRyu`: operations are written as generators that
``yield`` steps (an HTTP :class:`Request`, a :class:`Sleep`, a stream frame)
and receive the step's result, and a small sync or async driver runs them.
The HTTP step itself is such a generator, so the transport rules (in the
order of ``packages/services/src/transport/fetch-shim.ts``) live in one place:

1. origin scoping: a request to another origin (a signed attachment URL) is
   sent bare, with every credential stripped and none of the rules below;
2. auth per service and mode (``Authorization: Bearer``, ``x-api-key`` plus
   ``X-Ryu-Organization``, or ``x-gateway-key``), dropping every other
   credential header;
3. ``Accept``, the SDK ``User-Agent``, and per-call headers;
4. redirects are never followed (``RyuRedirectError``), so keys never change origin;
5. ``Idempotency-Key`` on the service's idempotent routes, fixed before the
   first attempt and reused on every retry (on a capability-gated route the
   SDK generates a key, and counts the request as keyed for replay, only once
   the server advertised the capability; a caller-supplied key is always
   forwarded);
6. a per-attempt timeout until response headers arrive (``None``/``0`` disables it);
7. replay-safe retries honouring ``Retry-After``, RateLimit and body hints
   (never a network/5xx replay of a route the table lists as non-replay-safe,
   and never an error a service refiner marked ``retryable=False``);
8. typed errors, response metadata and the deprecation hook.

An error response's body is read only up to :data:`~ryu_sdk.services.errors.MAX_ERROR_BODY_BYTES`
plus one chunk and the rest is discarded unread (``readCappedText`` in TypeScript), so a
misbehaving upstream that streams an endless 4xx/5xx body is never buffered. Header values
follow ``fetch``: Latin-1 text is sent as its Latin-1 bytes, and a value ``fetch`` refuses
(a character outside Latin-1, CR, LF or NUL) fails as ``invalid_request_header``.

The engine is split by responsibility: :mod:`.constants` (the SDK version and default
headers), :mod:`.steps` (the steps and per-call state), :mod:`.wire` (header encoding and
capped error-body reads), :mod:`.engine_base` / :mod:`.engine_responses` / :mod:`.engine`
(the transport rules), :mod:`.client_state` / :mod:`.client_core` (the per-instance state and
engine cache), :mod:`.drivers` (the sync and async drivers), :mod:`.binding` (what a
namespace calls) and :mod:`.pagination`.
This module re-exports every name, so ``ryu_sdk.services._runtime`` stays the import path.
"""

from __future__ import annotations

from .binding import Binding, OpFactory
from .client_core import ClientCore
from .client_state import ClientState
from .constants import (
    _CREDENTIAL_HEADERS,
    _DEPRECATION_SEEN_LIMIT,
    _NO_BODY,
    CAPABILITY_AUTH_FAILURE_TTL_S,
    CAPABILITY_PROBE_TIMEOUT_S,
    CAPABILITY_TTL_S,
    DEFAULT_ACCEPT,
    MAX_REFINE_BODY_BYTES,
    SDK_VERSION,
    default_user_agent,
)
from .drivers import (
    AsyncDriver,
    SyncDriver,
    _as_generator,
    _AsyncStream,
    _stream_error,
    _SyncStream,
)
from .engine import Engine
from .pagination import Paginated, next_cursor_field
from .steps import (
    END,
    Await,
    CallContext,
    CallOptions,
    CloseStream,
    CurrentCall,
    Defer,
    Emit,
    IterNext,
    NextFrame,
    Now,
    OpenStream,
    Request,
    Sleep,
    _Outcome,
    _Send,
    _SharedProbe,
    normalize_timeout,
    single,
)
from .wire import (
    _HEADER_TOKEN,
    _joined,
    _json_body,
    _json_default,
    _keep_error_body,
    _location_origin,
    _scrub,
    aread_error_body,
    read_error_body,
    wire_header_name,
    wire_header_value,
)

__all__ = [
    "CAPABILITY_AUTH_FAILURE_TTL_S",
    "CAPABILITY_PROBE_TIMEOUT_S",
    "CAPABILITY_TTL_S",
    "DEFAULT_ACCEPT",
    "END",
    "MAX_REFINE_BODY_BYTES",
    "SDK_VERSION",
    "_CREDENTIAL_HEADERS",
    "_DEPRECATION_SEEN_LIMIT",
    "_HEADER_TOKEN",
    "_NO_BODY",
    "AsyncDriver",
    "Await",
    "Binding",
    "CallContext",
    "CallOptions",
    "ClientCore",
    "ClientState",
    "CloseStream",
    "CurrentCall",
    "Defer",
    "Emit",
    "Engine",
    "IterNext",
    "NextFrame",
    "Now",
    "OpFactory",
    "OpenStream",
    "Paginated",
    "Request",
    "Sleep",
    "SyncDriver",
    "_AsyncStream",
    "_Outcome",
    "_Send",
    "_SharedProbe",
    "_SyncStream",
    "_as_generator",
    "_joined",
    "_json_body",
    "_json_default",
    "_keep_error_body",
    "_location_origin",
    "_scrub",
    "_stream_error",
    "aread_error_body",
    "default_user_agent",
    "next_cursor_field",
    "normalize_timeout",
    "read_error_body",
    "single",
    "wire_header_name",
    "wire_header_value",
]
