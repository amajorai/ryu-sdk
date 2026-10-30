"""AsyncRyu: the same operations as Ryu, with coroutines and async iterators."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from ryu_sdk.services import AsyncRyu, Ryu, RyuInvalidRequestError, RyuNotFoundError, RyuRateLimitError


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def sse(*frames: str) -> bytes:
    return "".join(f"{frame}\n\n" for frame in frames).encode("utf-8")


def client(handler: Any, env: dict[str, str], **options: Any) -> AsyncRyu:
    ryu = AsyncRyu(env=env, transport=httpx.MockTransport(handler), **options)
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    ryu._core.sleep = sleep  # type: ignore[assignment]
    ryu.sleeps = sleeps  # type: ignore[attr-defined]
    return ryu


def test_publish_retries_and_returns_results():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(503, text="")
        return httpx.Response(201, json={"event": {"id": "evt_1"}, "idempotent": False})

    async def main() -> Any:
        async with client(handler, {"RYU_NOTIFY_API_KEY": "n"}, result="object") as ryu:
            return await ryu.notify.publish({"title": "x"}), ryu.sleeps

    (data, error, meta), sleeps = run(main())
    assert error is None and data == {"id": "evt_1"}
    assert meta.attempts == 2 and len(sleeps) == 1
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]


def test_request_approval_refuses_typescript_option_keys_before_publishing():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(500, text="")

    async def main() -> Any:
        async with client(handler, {"RYU_NOTIFY_API_KEY": "n"}, result="object") as ryu:
            return await ryu.notify.request_approval({"title": "x", "prompt": "y", "timeoutMs": 1000})

    _data, error, _meta = run(main())
    assert isinstance(error, RyuInvalidRequestError)
    assert error.code == "invalid_request" and "timeout=" in error.message
    assert requests == []


def test_errors_raise_in_throw_mode():
    async def main() -> None:
        ryu = client(
            lambda _r: httpx.Response(404, json={"code": "not_found", "message": "no"}), {"RYU_NOTIFY_API_KEY": "n"}
        )
        await ryu.notify.events.get("evt_1")

    with pytest.raises(RyuNotFoundError):
        run(main())


def test_async_iteration_and_collect():
    pages = [
        httpx.Response(200, json={"events": [{"id": "e2"}], "nextCursor": "c"}),
        httpx.Response(200, json={"events": [{"id": "e1"}], "nextCursor": None}),
    ]

    async def main() -> Any:
        ryu = client(lambda _r: pages.pop(0), {"RYU_NOTIFY_API_KEY": "n"})
        return [event["id"] async for event in ryu.notify.events.iterate()]

    assert run(main()) == ["e2", "e1"]

    async def collect() -> Any:
        ryu = client(
            lambda _r: httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}], "nextCursor": None}),
            {"RYU_API_KEY": "k"},
        )
        return await ryu.managed_agents.agents.iterate().collect(1)

    assert run(collect()) == [{"id": "a"}]


def test_sync_iteration_on_async_client_is_refused():
    ryu = AsyncRyu(env={"RYU_NOTIFY_API_KEY": "n"})
    with pytest.raises(TypeError):
        iter(ryu.notify.events.iterate())
    with pytest.raises(TypeError):
        Ryu(env={"RYU_NOTIFY_API_KEY": "n"}).notify.events.iterate().__aiter__()


def test_async_streams_box_exec_and_gateway():
    exec_body = sse('event: stdout\nid: 1\ndata: {"data": "ok"}', 'event: exit\ndata: {"exitCode": 0}')
    chat_body = sse('data: {"choices": [{"delta": {"content": "hi"}}]}', "data: [DONE]")

    def handler(request: httpx.Request) -> httpx.Response:
        body = exec_body if request.url.path.endswith("/commands") else chat_body
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    async def main() -> Any:
        ryu = client(handler, {"RYU_BOX_API_KEY": "b"})
        box_events = [event async for event in ryu.box.exec_stream("box_1", {"command": "ls"})]
        chunks = [
            chunk async for chunk in ryu.gateway.chat.completions.create({"model": "m", "messages": [], "stream": True})
        ]
        return box_events, chunks

    box_events, chunks = run(main())
    assert [event["type"] for event in box_events] == ["stdout", "exit"]
    assert chunks == [{"choices": [{"delta": {"content": "hi"}}]}]


def test_async_managed_agents_run_uses_the_async_stream():
    events = [
        {"seq": 1, "type": "user.message", "content": []},
        {"seq": 2, "type": "agent.message", "content": [{"type": "text", "text": "Hi"}]},
        {"seq": 3, "type": "session.status", "status": "idle", "inputSeq": 1, "stopReason": "end_turn"},
    ]
    stream = sse(*[f"id: {event['seq']}\ndata: {json.dumps(event)}" for event in events])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(201, json={"id": "s_1", "headSeq": 1})
        if request.url.path.endswith("/stream"):
            return httpx.Response(200, content=stream, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"id": "s_1", "status": "idle"})

    async def main() -> Any:
        ryu = client(handler, {"RYU_API_KEY": "k"})
        return await ryu.managed_agents.sessions.run({"agentId": "a", "environmentId": "e", "message": "Hello"})

    result = run(main())
    assert result["text"] == "Hi" and result["session"]["status"] == "idle"
    assert [event["seq"] for event in result["events"]] == [1, 2, 3]


def test_async_rate_limit_without_hint_is_not_retried():
    calls: list[int] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(429, json={"code": "rate_limited", "message": "slow"})

    async def main() -> None:
        await client(handler, {"RYU_NOTIFY_API_KEY": "n"}).notify.events.get("e")

    with pytest.raises(RyuRateLimitError):
        run(main())
    assert len(calls) == 1
