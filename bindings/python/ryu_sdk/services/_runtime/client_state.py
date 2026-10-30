"""The per-instance state engines read: settings, hooks, caches and the HTTP client."""

from __future__ import annotations

import asyncio
import random as _random
import time
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Callable, Optional, Union

import httpx

from ..config import ResolvedConfig, Settings
from ..errors import RyuError
from .constants import default_user_agent
from .steps import Request

if TYPE_CHECKING:  # only the engine cache's annotation; engines import this module.
    from .engine import Engine


class ClientState:
    """What every engine of one instance shares; :class:`~ryu_sdk.services._runtime.client_core.ClientCore`
    adds the per-service engine cache on top."""

    def __init__(
        self,
        settings: Settings,
        *,
        is_async: bool,
        transport: Any,
        http_client: Any,
        timeout: Optional[float],
        max_retries: int,
        max_retry_delay: float,
        auto_idempotency: bool,
        hooks: Mapping[str, Callable[[dict[str, Any]], None]],
        user_agent: Any,
    ) -> None:
        self.settings = settings
        self.is_async = is_async
        self.timeout = timeout
        self.max_retries = max_retries
        self.max_retry_delay = max_retry_delay
        self.auto_idempotency = auto_idempotency
        self.hooks = dict(hooks)
        if user_agent is False:
            self.user_agent: Optional[str] = None
        else:
            self.user_agent = default_user_agent(user_agent if isinstance(user_agent, str) else None)
        self._transport = transport
        self._http_client = http_client
        self._owns_client = http_client is None
        self._engines: dict[str, Engine] = {}
        self.deprecation_seen: list[str] = []
        self.decorators: dict[str, Callable[[RyuError], RyuError]] = {}
        self.refiners: dict[str, Callable[[int, str], Optional[str]]] = {}
        #: service -> (parsed error, raw JSON body or None) -> the error used for the retry decision.
        self.error_refiners: dict[str, Callable[[RyuError, Any], RyuError]] = {}
        #: service -> config -> the capability read (``Request`` whose ``decode`` returns ``features``),
        #: or ``None`` when it cannot be made.
        self.capability_probes: dict[str, Callable[[ResolvedConfig], Optional[Request]]] = {}
        #: "<service> <base url>" -> (monotonic expiry, features or None).
        self.capability_cache: dict[str, tuple[float, Optional[dict[str, Any]]]] = {}
        #: "<service> <base url>" -> the in-flight ``(features, ttl)`` probe (``AsyncRyu`` only).
        self.capability_pending: dict[str, asyncio.Future[Any]] = {}
        #: service -> dotted method names that need no credential (Messaging ``status``).
        self.credential_free: dict[str, tuple[str, ...]] = {}
        #: service -> (generic failure, failed response, config) -> the error to raise.
        self.response_errors: dict[str, Callable[[RyuError, httpx.Response, ResolvedConfig], RyuError]] = {}
        self.caches: dict[str, dict[str, str]] = {}
        # Injectable for tests.
        self.sleep: Callable[[float], Any] = asyncio.sleep if is_async else time.sleep
        self.now: Callable[[], float] = time.monotonic
        self.wall_clock: Callable[[], float] = time.time
        self.random: Callable[[], float] = _random.random

    @property
    def http(self) -> Any:
        if self._http_client is None:
            cls = httpx.AsyncClient if self.is_async else httpx.Client
            self._http_client = cls(transport=self._transport, follow_redirects=False)
        return self._http_client

    def build_request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, Union[str, bytes]],
        content: Optional[bytes],
        timeout: Optional[httpx.Timeout] = None,
    ) -> httpx.Request:
        """A request on the instance's client; ``timeout`` (per attempt) overrides that client's own."""
        if timeout is None:
            built: httpx.Request = self.http.build_request(method, url, headers=headers, content=content)
            return built
        timed: httpx.Request = self.http.build_request(method, url, headers=headers, content=content, timeout=timeout)
        return timed

    def close_sync(self) -> None:
        if self._owns_client and self._http_client is not None:
            self._http_client.close()
            self._http_client = None

    async def close_async(self) -> None:
        if self._owns_client and self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None
