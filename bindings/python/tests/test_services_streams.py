"""Timeouts and the Managed Agents event stream under the services transport rules."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from ryu_sdk import managed_agents as wrapped_managed_agents
from ryu_sdk.services import AsyncRyu, Ryu, RyuTimeoutError
from ryu_sdk.services._runtime import normalize_timeout

MA_ENV = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}
STREAM_PATH = "/api/v1/managed-agents/sessions/s_1/stream"
EVENT = {"event": {"id": "evt_1", "title": "Deployed"}}


def stream_response() -> httpx.Response:
    frames = [
        {"seq": 1, "type": "agent.message", "content": []},
        {"seq": 2, "type": "session.status", "status": "completed"},
    ]
    body = "".join(f"id: {frame['seq']}\nevent: message\ndata: {json.dumps(frame)}\n\n" for frame in frames)
    return httpx.Response(
        200,
        content=body.encode("utf-8"),
        headers={"content-type": "text/event-stream", "x-request-id": "req_stream"},
    )


def timeout_of(request: httpx.Request) -> dict[str, Any]:
    return request.extensions["timeout"]


# ── timeouts ─────────────────────────────────────────────────────────────────


def test_every_request_carries_the_per_attempt_timeout():
    requests: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json=EVENT)

    transport = httpx.MockTransport(answer)
    Ryu(env={"RYU_NOTIFY_API_KEY": "n"}, transport=transport).notify.publish({"title": "x"})
    Ryu(env={"RYU_NOTIFY_API_KEY": "n"}, transport=transport, timeout=7).notify.publish({"title": "x"})
    ryu = Ryu(env={"RYU_NOTIFY_API_KEY": "n"}, transport=transport)
    ryu.notify.with_options(timeout=3).publish({"title": "x"})
    assert [timeout_of(request)["connect"] for request in requests] == [60.0, 7.0, 3.0]
    assert timeout_of(requests[0])["read"] == 60.0


@pytest.mark.parametrize("value", [None, 0, -1, float("inf"), 10**400, -(10**400)])
def test_zero_negative_infinite_or_none_timeout_disables_it(value):
    assert normalize_timeout(value) is None
    requests: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json=EVENT)

    Ryu(env={"RYU_NOTIFY_API_KEY": "n"}, transport=httpx.MockTransport(answer), timeout=value).notify.publish(
        {"title": "x"}
    )
    assert timeout_of(requests[0]) == {"connect": None, "read": None, "write": None, "pool": None}


# ── the Managed Agents stream ────────────────────────────────────────────────


def test_the_stream_goes_through_the_callers_http_client_and_the_services_rules():
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return stream_response()

    # A mounted transport stands in for a proxy: the stream must use this client, not a copy.
    http_client = httpx.Client(mounts={"https://": httpx.MockTransport(answer)}, headers={"x-proxy-tag": "p1"})
    events: dict[str, list[dict[str, Any]]] = {"on_request": [], "on_response": []}
    ryu = Ryu(
        env=MA_ENV,
        http_client=http_client,
        user_agent="my-app/1.0",
        timeout=9,
        hooks={"on_request": events["on_request"].append, "on_response": events["on_response"].append},
    )
    traced = ryu.managed_agents.with_options(headers={"X-Trace": "t1"})
    assert [event["seq"] for event in traced.sessions.stream("s_1")] == [1, 2]

    request = seen[0]
    assert request.url.path == STREAM_PATH
    assert request.headers["accept"] == "text/event-stream"
    assert request.headers["x-api-key"] == "ryu_key"
    assert request.headers["x-ryu-organization"] == "org_1"
    assert request.headers["user-agent"].startswith("ryu-services-python/")
    assert request.headers["user-agent"].endswith(" my-app/1.0")
    assert request.headers["x-trace"] == "t1"
    assert request.headers["x-proxy-tag"] == "p1"
    # Headers must arrive within the per-attempt timeout; events may then be minutes apart.
    assert timeout_of(request)["connect"] == 9.0 and timeout_of(request)["read"] is None
    assert events["on_request"][0]["url"].endswith(STREAM_PATH)
    assert events["on_response"][0]["status"] == 200
    assert events["on_response"][0]["request_id"] == "req_stream"
    # The caller's client stays open: Ryu never closes a client it was given.
    assert not http_client.is_closed
    http_client.close()


def test_a_stalled_stream_connect_raises_a_timeout(monkeypatch):
    monkeypatch.setattr(wrapped_managed_agents.time, "sleep", lambda _seconds: None)
    attempts: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        raise httpx.ConnectTimeout("timed out", request=request)

    ryu = Ryu(env=MA_ENV, transport=httpx.MockTransport(answer), timeout=2)
    with pytest.raises(RyuTimeoutError) as raised:
        list(ryu.managed_agents.sessions.stream("s_1"))
    assert raised.value.code == "timeout" and raised.value.service == "managedAgents"
    # The wrapped stream loop reconnects before it gives up.
    assert len(attempts) == wrapped_managed_agents._STREAM_MAX_CONSECUTIVE_FAILURES + 1


def test_the_async_stream_uses_the_instance_client_and_aclosing_releases_it():
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return stream_response()

    async def main() -> list[int]:
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def closing(iterator: Any):
            try:
                yield iterator
            finally:
                await iterator.aclose()

        async with AsyncRyu(env=MA_ENV, transport=httpx.MockTransport(answer)) as ryu:
            seqs: list[int] = []
            async with closing(ryu.managed_agents.sessions.stream("s_1")) as events:
                async for event in events:
                    seqs.append(event["seq"])
                    break
            return seqs

    assert asyncio.run(main()) == [1]
    assert seen[0].headers["user-agent"].startswith("ryu-services-python/")
    assert timeout_of(seen[0])["read"] is None
