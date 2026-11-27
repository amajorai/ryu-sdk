"""Core harness client tests, including SSE resume cursors."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from helpers import CORE, Router, sse_response

from ryu_sdk._transport import RyuAPIError
from ryu_sdk.harness import AsyncHarnessClient, HarnessClient
from ryu_sdk.services import RyuInvalidRequestError

SESSION = {"id": "s1", "status": "pending"}
RUN = {"id": "r1", "status": "running", "eventCursor": 0}


def client(router: Router, **options) -> HarnessClient:
    return HarnessClient(CORE, token="t0k", transport=router.transport(), **options)


def test_session_and_run_control_requests():
    router = (
        Router()
        .add("POST", "/api/harness/sessions", httpx.Response(200, json={"protocolVersion": "1", "session": SESSION}))
        .add("GET", "/api/harness/sessions/s1", httpx.Response(200, json={"protocolVersion": "1", "session": SESSION}))
        .add("GET", "/api/harness/sessions/s1/children", httpx.Response(200, json={"sessions": None}))
        .add("PUT", "/api/harness/sessions/s1/native", httpx.Response(200, json={"protocolVersion": "1", "session": SESSION}))
        .add("GET", "/api/harness/sessions/s1/runs", httpx.Response(200, json={"protocolVersion": "1", "runs": [RUN]}))
        .add("POST", "/api/harness/sessions/s1/runs", httpx.Response(200, json={"created": True, "eventsUrl": "/e", "protocolVersion": "1", "run": RUN}))
        .add("GET", "/api/harness/runs/r1", httpx.Response(200, json={"protocolVersion": "1", "run": RUN}))
        .add("POST", "/api/harness/runs/r1/cancel", httpx.Response(200, json={"cancelled": True}))
        .add("POST", "/api/chat/permission", httpx.Response(200, json={"resolved": False}))
    )
    with client(router, user_jwt=lambda: "jwt-1") as harness:
        assert harness.create_session("agent-x", "agent", title="T", execution_profile={"kind": "worktree"}) == SESSION
        assert harness.get_session("s1") == SESSION
        assert harness.list_children("s1") == []
        assert harness.bind_native_session("s1", "native-9") == SESSION
        assert harness.list_runs("s1") == [RUN]
        started = harness.start_run("s1", {"prompt": "hi"}, idempotency_key="k1", resume_run_id="r0")
        assert started["created"] is True
        assert harness.get_run("r1") == RUN
        assert harness.cancel("r1") is True
        assert harness.resolve_permission("p1") is False

    create = router.bodies("POST", "/api/harness/sessions")[0]
    assert create == {
        "runnableId": "agent-x",
        "runnableKind": "agent",
        "title": "T",
        "executionProfile": {
            "approval": "inherit",
            "kind": "worktree",
            "network": "inherit",
            "sandbox": "inherit",
            "worktreeIsolation": False,
        },
    }
    assert router.bodies("PUT", "/api/harness/sessions/s1/native") == [{"nativeSessionId": "native-9"}]
    assert router.bodies("POST", "/api/harness/sessions/s1/runs") == [
        {"input": {"prompt": "hi"}, "idempotencyKey": "k1", "resumeRunId": "r0"}
    ]
    assert router.bodies("POST", "/api/chat/permission") == [{"request_id": "p1"}]
    request = router.requests[0]
    assert request.headers["authorization"] == "Bearer t0k"
    assert request.headers["x-ryu-user-jwt"] == "jwt-1"


def test_errors_raise_with_status():
    router = Router().add("GET", "/api/harness/runs/nope", httpx.Response(404, json={"error": "run not found"}))
    with pytest.raises(RyuAPIError) as caught:
        client(router).get_run("nope")
    assert caught.value.status == 404
    assert "run not found" in str(caught.value)


def event(seq: int, kind: str, **fields) -> dict:
    return {"id": f"e{seq}", "seq": seq, "runId": "r1", "sessionId": "s1", "protocolVersion": "1", "type": kind, **fields}


def resume_router() -> Router:
    first = sse_response(event(1, "run_started"), "not json", event(2, "text_delta", delta="a"))
    second = sse_response(event(2, "text_delta", delta="a"), event(3, "text_delta", delta="b"), event(4, "run_completed"), event(5, "text_delta", delta="never"))
    return Router().add("GET", "/api/harness/runs/r1/events", first, second)


def test_events_resume_from_the_last_seq_and_dedupe():
    router = resume_router()
    seen = list(client(router).events("r1"))
    assert [item["seq"] for item in seen] == [1, 2, 3, 4]
    cursors = [request.url.params["after"] for request in router.calls("GET", "/api/harness/runs/r1/events")]
    assert cursors == ["0", "2"]
    assert router.calls("GET", "/api/harness/runs/r1/events")[0].headers["accept"] == "text/event-stream"


def test_events_without_reconnect_stop_at_close_and_explicit_cursor():
    router = resume_router()
    seen = list(client(router, reconnect=False).events("r1", after=1))
    assert [item["seq"] for item in seen] == [2]
    assert router.calls("GET", "/api/harness/runs/r1/events")[0].url.params["after"] == "1"


def test_async_run_starts_and_streams():
    router = resume_router().add(
        "POST", "/api/harness/sessions/s1/runs", httpx.Response(200, json={"created": True, "eventsUrl": "/e", "protocolVersion": "1", "run": RUN})
    )

    async def go():
        async with AsyncHarnessClient(CORE, transport=router.transport()) as harness:
            assert await harness.cancel("r1") is False
            return [item async for item in harness.run("s1", "hello")]

    router.add("POST", "/api/harness/runs/r1/cancel", httpx.Response(200, json={}))
    seen = asyncio.run(go())
    assert [item["type"] for item in seen] == ["run_started", "text_delta", "text_delta", "run_completed"]
    assert json.loads(router.calls("POST", "/api/harness/sessions/s1/runs")[0].content) == {"input": "hello"}


def test_events_after_a_finished_run_end_without_reconnect_loop():
    # Core answers a finished run with nothing past the cursor with an empty,
    # cleanly closed stream; the client checks the run once and stops.
    router = (
        Router()
        .add("GET", "/api/harness/runs/r1/events", sse_response())
        .add("GET", "/api/harness/runs/r1", httpx.Response(200, json={"protocolVersion": "1", "run": {**RUN, "status": "completed"}}))
    )
    assert list(client(router).events("r1", after=4)) == []
    assert len(router.calls("GET", "/api/harness/runs/r1/events")) == 1

    async def go():
        async with AsyncHarnessClient(CORE, transport=router.transport()) as harness:
            return [item async for item in harness.events("r1", after=4)]

    assert asyncio.run(go()) == []
    assert len(router.calls("GET", "/api/harness/runs/r1/events")) == 2


def test_events_reconnect_after_an_empty_close_while_the_run_is_live():
    live = httpx.Response(200, json={"protocolVersion": "1", "run": RUN})
    router = (
        Router()
        .add("GET", "/api/harness/runs/r1/events", sse_response(), sse_response(event(5, "run_completed")))
        .add("GET", "/api/harness/runs/r1", live)
    )
    seen = list(client(router).events("r1", after=4))
    assert [item["type"] for item in seen] == ["run_completed"]
    assert len(router.calls("GET", "/api/harness/runs/r1")) == 1


def test_events_dropped_connection_never_ends_on_run_status():
    # A transport drop may hide events still past the cursor, so the client
    # reconnects instead of trusting the run's terminal status.
    attempts = {"count": 0}

    def flaky(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise httpx.ReadError("connection reset", request=request)
        return sse_response(event(5, "text_delta", delta="z"), event(6, "run_completed"))

    router = (
        Router()
        .add("GET", "/api/harness/runs/r1/events", flaky)
        .add("GET", "/api/harness/runs/r1", httpx.Response(200, json={"protocolVersion": "1", "run": {**RUN, "status": "completed"}}))
    )
    seen = list(client(router).events("r1", after=4))
    assert [item["seq"] for item in seen] == [5, 6]
    assert router.calls("GET", "/api/harness/runs/r1") == []


@pytest.mark.parametrize("bad", ["", ".", ".."])
def test_dot_and_empty_ids_raise_invalid_id_and_send_nothing(bad: str):
    router = Router()
    with client(router) as harness:
        for call in (
            lambda: harness.get_session(bad),
            lambda: harness.list_children(bad),
            lambda: harness.bind_native_session(bad, "n"),
            lambda: harness.list_runs(bad),
            lambda: harness.start_run(bad, {"prompt": "hi"}),
            lambda: harness.get_run(bad),
            lambda: harness.cancel(bad),
            lambda: list(harness.events(bad)),
        ):
            with pytest.raises(RyuInvalidRequestError) as raised:
                call()
            assert raised.value.code == "invalid_id"
            assert raised.value.service == "Core harness"
    assert router.requests == []
