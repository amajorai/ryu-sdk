"""The sync and async drivers that run an operation's steps."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
from collections.abc import Iterator
from typing import Any, Callable, Optional

import httpx

from ..._transport import SseFrame, SseParser
from .._service_titles import service_title
from ..errors import RyuConnectionError, RyuError
from .engine import Engine
from .steps import (
    END,
    Await,
    CallContext,
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
    single,
)
from .wire import _scrub, aread_error_body, read_error_body


def _as_generator(op: Any) -> Any:
    if inspect.isgenerator(op):
        return op
    return single(op)


class _SyncStream:
    def __init__(self, response: httpx.Response, engine: Engine) -> None:
        self.response = response
        self.engine = engine
        self._frames = self._iter()

    def _iter(self) -> Iterator[SseFrame]:
        parser = SseParser()
        for chunk in self.response.iter_text():
            yield from parser.feed(chunk)
        yield from parser.flush()

    def next(self) -> Optional[SseFrame]:
        try:
            return next(self._frames, None)
        except httpx.RequestError as error:  # TransportError, and DecodingError on a bad body
            raise _stream_error(self.engine, self.response, error) from error

    def close(self) -> None:
        self.response.close()


class _AsyncStream:
    def __init__(self, response: httpx.Response, engine: Engine) -> None:
        self.response = response
        self.engine = engine
        self._parser = SseParser()
        self._pending: list[SseFrame] = []
        self._chunks = response.aiter_text()
        self._done = False

    async def next(self) -> Optional[SseFrame]:
        while not self._pending:
            if self._done:
                return None
            try:
                chunk = await self._chunks.__anext__()
            except StopAsyncIteration:
                self._done = True
                self._pending.extend(self._parser.flush())
                continue
            except httpx.RequestError as error:  # TransportError, and DecodingError on a bad body
                raise _stream_error(self.engine, self.response, error) from error
            self._pending.extend(self._parser.feed(chunk))
        return self._pending.pop(0)

    async def close(self) -> None:
        await self.response.aclose()


def _stream_error(engine: Engine, response: httpx.Response, error: BaseException) -> RyuError:
    url = str(response.request.url)
    return RyuConnectionError(
        f"{service_title(engine.service)}: the event stream was cut off: {_scrub(str(error), url, engine.config.api_key)}",
        service=engine.service,
        method=response.request.method,
        url=url,
    )


class SyncDriver:
    def __init__(self, engine: Engine, ctx: CallContext) -> None:
        self.engine = engine
        self.ctx = ctx
        self.cleanups: list[Callable[[], Any]] = []

    def close(self) -> None:
        while self.cleanups:
            # Cleanup must not mask the call's outcome.
            with contextlib.suppress(Exception):
                self.cleanups.pop()()

    def run(self, gen: Any) -> Any:
        value: Any = None
        error: Optional[BaseException] = None
        while True:
            try:
                step = gen.throw(error) if error is not None else gen.send(value)
            except StopIteration as stop:
                return stop.value
            value, error = None, None
            try:
                value = self.step(step)
            except Exception as exc:  # noqa: BLE001 - handed back to the operation
                error = exc

    def iterate(self, gen: Any) -> Iterator[Any]:
        value: Any = None
        error: Optional[BaseException] = None
        try:
            while True:
                try:
                    step = gen.throw(error) if error is not None else gen.send(value)
                except StopIteration:
                    return
                value, error = None, None
                if isinstance(step, Emit):
                    yield step.item
                    continue
                try:
                    value = self.step(step)
                except Exception as exc:  # noqa: BLE001 - handed back to the operation
                    error = exc
        finally:
            gen.close()

    def step(self, step: Any) -> Any:
        engine = self.engine
        if isinstance(step, Request):
            return self.run(engine.http(step, self.ctx))
        if isinstance(step, _Send):
            client = engine.owner.http
            try:
                response = client.send(step.request, stream=True, follow_redirects=False)
            except httpx.TimeoutException as error:
                return _Outcome(error=error, kind="timeout")
            except httpx.RequestError as error:  # TransportError, and DecodingError on a bad body
                return _Outcome(error=error, kind="connection")
            if not (step.stream and response.is_success):
                try:
                    if response.is_success:
                        response.read()
                    else:
                        read_error_body(response)
                except httpx.TimeoutException as error:
                    response.close()
                    return _Outcome(error=error, kind="timeout")
                except httpx.RequestError as error:  # TransportError, and DecodingError on a bad body
                    response.close()
                    return _Outcome(error=error, kind="connection")
                finally:
                    response.close()
            return _Outcome(response=response)
        if isinstance(step, _SharedProbe):
            return self.run(step.gen)
        if isinstance(step, Sleep):
            engine.owner.sleep(step.seconds)
            return None
        if isinstance(step, Now):
            return engine.owner.wall_clock()
        if isinstance(step, IterNext):
            return next(step.source, END)
        if isinstance(step, Await):
            return step.fn()
        if isinstance(step, Defer):
            self.cleanups.append(step.fn)
            return None
        if isinstance(step, CurrentCall):
            return engine, self.ctx
        if isinstance(step, OpenStream):
            response = self.run(engine.http(step.request, self.ctx, stream=True))
            return _SyncStream(response, engine)
        if isinstance(step, NextFrame):
            return step.stream.next()
        if isinstance(step, CloseStream):
            step.stream.close()
            return None
        raise TypeError(f"unknown step {step!r}")


class AsyncDriver:
    def __init__(self, engine: Engine, ctx: CallContext) -> None:
        self.engine = engine
        self.ctx = ctx
        self.cleanups: list[Callable[[], Any]] = []

    async def close(self) -> None:
        while self.cleanups:
            # Cleanup must not mask the call's outcome.
            with contextlib.suppress(Exception):
                result = self.cleanups.pop()()
                if inspect.isawaitable(result):
                    await result

    async def run(self, gen: Any) -> Any:
        value: Any = None
        error: Optional[BaseException] = None
        while True:
            try:
                step = gen.throw(error) if error is not None else gen.send(value)
            except StopIteration as stop:
                return stop.value
            value, error = None, None
            try:
                value = await self.step(step)
            except Exception as exc:  # noqa: BLE001 - handed back to the operation
                error = exc

    async def iterate(self, gen: Any) -> Any:
        value: Any = None
        error: Optional[BaseException] = None
        try:
            while True:
                try:
                    step = gen.throw(error) if error is not None else gen.send(value)
                except StopIteration:
                    return
                value, error = None, None
                if isinstance(step, Emit):
                    yield step.item
                    continue
                try:
                    value = await self.step(step)
                except Exception as exc:  # noqa: BLE001 - handed back to the operation
                    error = exc
        finally:
            gen.close()

    async def step(self, step: Any) -> Any:
        engine = self.engine
        if isinstance(step, Request):
            return await self.run(engine.http(step, self.ctx))
        if isinstance(step, _Send):
            client = engine.owner.http
            try:
                response = await client.send(step.request, stream=True, follow_redirects=False)
            except httpx.TimeoutException as error:
                return _Outcome(error=error, kind="timeout")
            except httpx.RequestError as error:  # TransportError, and DecodingError on a bad body
                return _Outcome(error=error, kind="connection")
            if not (step.stream and response.is_success):
                try:
                    if response.is_success:
                        await response.aread()
                    else:
                        await aread_error_body(response)
                except httpx.TimeoutException as error:
                    await response.aclose()
                    return _Outcome(error=error, kind="timeout")
                except httpx.RequestError as error:  # TransportError, and DecodingError on a bad body
                    await response.aclose()
                    return _Outcome(error=error, kind="connection")
                finally:
                    await response.aclose()
            return _Outcome(response=response)
        if isinstance(step, _SharedProbe):
            return await self._shared_probe(step)
        if isinstance(step, Sleep):
            await engine.owner.sleep(step.seconds)
            return None
        if isinstance(step, Now):
            return engine.owner.wall_clock()
        if isinstance(step, IterNext):
            try:
                return await step.source.__anext__()
            except StopAsyncIteration:
                return END
        if isinstance(step, Await):
            result = step.fn()
            return await result if inspect.isawaitable(result) else result
        if isinstance(step, Defer):
            self.cleanups.append(step.fn)
            return None
        if isinstance(step, CurrentCall):
            return engine, self.ctx
        if isinstance(step, OpenStream):
            response = await self.run(engine.http(step.request, self.ctx, stream=True))
            return _AsyncStream(response, engine)
        if isinstance(step, NextFrame):
            return await step.stream.next()
        if isinstance(step, CloseStream):
            await step.stream.close()
            return None
        raise TypeError(f"unknown step {step!r}")

    async def _shared_probe(self, step: _SharedProbe) -> Any:
        """One in-flight capability read per key: later callers await the leader's answer.

        A follower's cancellation never cancels the shared read (``shield``). When the
        leader fails or is cancelled, followers get ``(None, None)``: no features and no
        caching, so each fails closed for this call and a later call probes again.
        """
        pending_reads = self.engine.owner.capability_pending
        loop = asyncio.get_running_loop()
        pending = pending_reads.get(step.key)
        if pending is not None and pending.get_loop() is loop:
            step.gen.close()
            return await asyncio.shield(pending)
        future: asyncio.Future[Any] = loop.create_future()
        pending_reads[step.key] = future
        answer: Any = (None, None)
        try:
            answer = await self.run(step.gen)
            return answer
        finally:
            if pending_reads.get(step.key) is future:
                del pending_reads[step.key]
            future.set_result(answer)
