"""What a namespace calls: runs its operations in the instance's mode (sync/async, throw/object)."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any, Callable, Optional

from ..config import ResolvedConfig
from ..errors import RyuError
from ..result import EMPTY_META, Result
from .client_core import ClientCore
from .drivers import AsyncDriver, SyncDriver, _as_generator
from .engine import Engine
from .steps import CallContext, CallOptions

OpFactory = Callable[[ResolvedConfig], Any]


class Binding:
    """Runs a namespace's operations in the instance's mode (sync/async, throw/object)."""

    def __init__(
        self,
        core: ClientCore,
        service: str,
        mode: str,
        options: Optional[CallOptions] = None,
        bound_key: Optional[dict[str, bool]] = None,
    ) -> None:
        self.core = core
        self.service = service
        self.mode = mode
        self.options = options or CallOptions()
        self.bound_key = bound_key

    @property
    def is_async(self) -> bool:
        return self.core.is_async

    def with_options(
        self,
        *,
        idempotency_key: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Binding:
        merged = CallOptions(
            idempotency_key=idempotency_key if idempotency_key is not None else self.options.idempotency_key,
            headers={**self.options.headers, **dict(headers or {})},
            timeout=timeout if timeout is not None else self.options.timeout,
        )
        bound = {"spent": False} if idempotency_key is not None else self.bound_key
        return Binding(self.core, self.service, self.mode, merged, bound)

    def in_mode(self, mode: str) -> Binding:
        return Binding(self.core, self.service, mode, self.options, self.bound_key)

    def config(self) -> ResolvedConfig:
        """The resolved service config (raises RyuConfigurationError)."""
        return self.core.engine(self.service).config

    def _context(self, extra: Optional[CallOptions]) -> CallContext:
        options = self.options
        if extra is not None:
            options = CallOptions(
                idempotency_key=extra.idempotency_key or options.idempotency_key,
                headers={**options.headers, **extra.headers},
                timeout=extra.timeout if extra.timeout is not None else options.timeout,
            )
        bound = self.bound_key if options.idempotency_key == self.options.idempotency_key else None
        return CallContext(options=options, bound_key=bound)

    def call(
        self,
        factory: OpFactory,
        options: Optional[CallOptions] = None,
        *,
        method: Optional[str] = None,
    ) -> Any:
        """Runs one operation: returns the value (throw mode) or a :class:`Result` (object mode);
        a coroutine of either on ``AsyncRyu``. ``method`` names the dotted method, for services
        that list credential-free methods."""
        if self.is_async:
            return self._call_async(factory, options, method)
        ctx = self._context(options)
        engine: Optional[Engine] = None
        driver: Optional[SyncDriver] = None
        try:
            engine = self.core.call_engine(self.service, method)
            driver = SyncDriver(engine, ctx)
            value = driver.run(_as_generator(factory(engine.config)))
        except RyuError as error:
            return self._fail(engine, error, ctx)
        finally:
            if driver is not None:
                driver.close()
        return self._succeed(value, ctx)

    async def _call_async(self, factory: OpFactory, options: Optional[CallOptions], method: Optional[str]) -> Any:
        ctx = self._context(options)
        engine: Optional[Engine] = None
        driver: Optional[AsyncDriver] = None
        try:
            engine = self.core.call_engine(self.service, method)
            driver = AsyncDriver(engine, ctx)
            value = await driver.run(_as_generator(factory(engine.config)))
        except RyuError as error:
            return self._fail(engine, error, ctx)
        finally:
            if driver is not None:
                await driver.close()
        return self._succeed(value, ctx)

    def _succeed(self, value: Any, ctx: CallContext) -> Any:
        if self.mode == "object":
            return Result(value, None, ctx.meta or EMPTY_META)
        return value

    def _fail(self, engine: Optional[Engine], error: RyuError, ctx: CallContext) -> Any:
        decorated = engine.decorate(error, ctx) if engine is not None else error
        if self.mode == "object":
            return Result(None, decorated, ctx.meta)
        if decorated is error:
            raise error
        raise decorated from error.__cause__

    def sync_value(self, factory: OpFactory) -> Any:
        """A method that makes no request (``gateway.openai_compatible()``): config errors raise in both modes."""
        return factory(self.core.engine(self.service).config)

    def stream(self, factory: OpFactory) -> Any:
        """An iterator over an operation that emits items. Raises RyuError in both modes."""
        if self.is_async:
            return self._stream_async(factory)
        return self._stream_sync(factory)

    def _stream_sync(self, factory: OpFactory) -> Iterator[Any]:
        ctx = self._context(None)
        engine: Optional[Engine] = None
        driver: Optional[SyncDriver] = None
        try:
            engine = self.core.engine(self.service)
            driver = SyncDriver(engine, ctx)
            yield from driver.iterate(_as_generator(factory(engine.config)))
        except RyuError as error:
            decorated = engine.decorate(error, ctx) if engine is not None else error
            raise decorated from error.__cause__
        finally:
            if driver is not None:
                driver.close()

    async def _stream_async(self, factory: OpFactory) -> Any:
        ctx = self._context(None)
        engine: Optional[Engine] = None
        driver: Optional[AsyncDriver] = None
        try:
            engine = self.core.engine(self.service)
            driver = AsyncDriver(engine, ctx)
            async for item in driver.iterate(_as_generator(factory(engine.config))):
                yield item
        except RyuError as error:
            decorated = engine.decorate(error, ctx) if engine is not None else error
            raise decorated from error.__cause__
        finally:
            if driver is not None:
                await driver.close()
