"""Managed Agents client tests: headers, errors, redirects, and the resumable stream."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from helpers import Router, sse

from ryu_sdk.managed_agents import (
    MANAGED_AGENTS_REDIRECT_ERROR_CODE,
    MANAGED_AGENTS_UNKNOWN_ERROR_CODE,
    AsyncManagedAgentsClient,
    ManagedAgentsClient,
    ManagedAgentsError,
    StreamProtocolError,
    parse_retry_after,
)

BASE = "https://api.ryu.test"
PREFIX = "/api/v1/managed-agents"
AGENT = {"id": "magent_1", "version": 1, "name": "Helper"}


def client(router: Router) -> ManagedAgentsClient:
    return ManagedAgentsClient("sk-test", BASE, organization_id="org_1", transport=router.transport())


def test_resources_send_api_key_org_and_idempotency_headers():
    router = (
        Router()
        .add("POST", f"{PREFIX}/agents", httpx.Response(201, json=AGENT))
        .add("GET", f"{PREFIX}/agents", httpx.Response(200, json={"data": [AGENT], "nextCursor": None}))
        .add("PATCH", f"{PREFIX}/agents/magent_1", httpx.Response(200, json=AGENT))
        .add("GET", f"{PREFIX}/agents/magent_1/versions/2", httpx.Response(200, json=AGENT))
        .add("POST", f"{PREFIX}/sessions/msess_1/events", httpx.Response(202, json={"data": [
            {"id": "mevt_1", "seq": 1, "sessionId": "msess_1", "createdAt": "t", "type": "user.message", "content": []},
            {"id": "mevt_2", "seq": 2, "sessionId": "msess_1", "createdAt": "t", "type": "user.future"},
        ]}))
        .add("POST", f"{PREFIX}/sessions/msess_1/cancel", httpx.Response(200, json={"id": "msess_1"}))
        .add("DELETE", f"{PREFIX}/sessions/msess_1", httpx.Response(204))
        .add("GET", f"{PREFIX}/credentials", httpx.Response(200, json={"data": [], "nextCursor": None}))
    )
    with client(router) as api:
        assert api.agents.create({"name": "Helper"}, idempotency_key="idem-1") == AGENT
        assert api.agents.list(include_archived=True, limit=5)["data"] == [AGENT]
        api.agents.update("magent_1", {"name": "H2"})
        api.agents.get_version("magent_1", 2)
        appended = api.sessions.send_message("msess_1", "hello", idempotency_key="idem-2")
        assert [item["seq"] for item in appended] == [1]
        api.sessions.cancel("msess_1", "done")
        assert api.sessions.delete("msess_1") is None
        api.credentials.list(include_revoked=False)

    create = router.calls("POST", f"{PREFIX}/agents")[0]
    assert create.headers["x-api-key"] == "sk-test"
    assert create.headers["x-ryu-organization"] == "org_1"
    assert create.headers["idempotency-key"] == "idem-1"
    assert "sk-test" not in str(create.url)
    listing = router.calls("GET", f"{PREFIX}/agents")[0]
    assert dict(listing.url.params) == {"includeArchived": "true", "limit": "5"}
    assert router.bodies("POST", f"{PREFIX}/sessions/msess_1/events") == [
        {"events": [{"type": "user.message", "content": [{"type": "text", "text": "hello"}]}]}
    ]
    assert router.bodies("POST", f"{PREFIX}/sessions/msess_1/cancel") == [{"reason": "done"}]
    assert dict(router.calls("GET", f"{PREFIX}/credentials")[0].url.params) == {"includeRevoked": "false"}


@pytest.mark.parametrize("bad_id", ["", ".", ".."])
def test_dot_and_empty_path_ids_are_refused_before_any_request(bad_id):
    router = Router()
    with client(router) as api:
        for call in (
            lambda: api.sessions.delete(bad_id),
            lambda: api.agents.get(bad_id),
            lambda: api.agents.get_version("magent_1", bad_id),
            lambda: list(api.sessions.stream(bad_id)),
        ):
            with pytest.raises(ManagedAgentsError) as raised:
                call()
            assert raised.value.code == "invalid_id"
            assert raised.value.status == 0
    assert router.requests == []


def test_async_stream_refuses_a_dot_session_id_without_reconnecting():
    router = Router()

    async def go():
        async with AsyncManagedAgentsClient("sk", BASE, transport=router.transport()) as api:
            return [item async for item in api.sessions.stream("..")]

    with pytest.raises(ManagedAgentsError) as raised:
        asyncio.run(go())
    assert raised.value.code == "invalid_id"
    assert router.requests == []


def test_error_envelope_and_fallback():
    router = (
        Router()
        .add("GET", f"{PREFIX}/agents/missing", httpx.Response(
            404,
            headers={"Retry-After": "7"},
            json={"error": {"code": "not_found", "message": "agent not found", "requestId": "req_1", "details": {"id": "missing"}}},
        ))
        .add("GET", f"{PREFIX}/agents/proxy", httpx.Response(502, headers={"X-Request-ID": "req_2"}, text="<html>bad gateway</html>"))
    )
    api = client(router)
    with pytest.raises(ManagedAgentsError) as caught:
        api.agents.get("missing")
    error = caught.value
    assert (error.code, error.status, error.request_id, error.retry_after_seconds) == ("not_found", 404, "req_1", 7)
    assert error.details == {"id": "missing"}
    with pytest.raises(ManagedAgentsError) as caught:
        api.agents.get("proxy")
    assert caught.value.code == MANAGED_AGENTS_UNKNOWN_ERROR_CODE
    assert caught.value.request_id == "req_2"
    assert "bad gateway" in str(caught.value)


def test_redirects_are_refused_without_leaking_the_path():
    router = Router().add(
        "GET",
        f"{PREFIX}/agents/a",
        httpx.Response(302, headers={"Location": "https://evil.test/login?token=x"}),
    )
    with pytest.raises(ManagedAgentsError) as caught:
        client(router).agents.get("a")
    assert caught.value.code == MANAGED_AGENTS_REDIRECT_ERROR_CODE
    assert caught.value.details == {"location": "https://evil.test"}
    assert len(router.requests) == 1


def test_retry_after_parsing():
    assert parse_retry_after("12") == 12
    assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0
    assert parse_retry_after("soon") is None
    assert parse_retry_after(None) is None


def log_event(seq: int, kind: str, **fields) -> tuple:
    payload = {"id": f"mevt_{seq}", "seq": seq, "sessionId": "msess_1", "createdAt": "t", "type": kind, **fields}
    return ("message", str(seq), payload)


def stream_response(*frames) -> httpx.Response:
    return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=sse(*frames))


def stream_router() -> Router:
    first = stream_response(
        log_event(1, "agent.message", content=[{"type": "text", "text": "hi"}]),
        ("message", None, {"type": "control"}),
        log_event(2, "agent.future_type"),
    )
    second = stream_response(
        log_event(2, "agent.future_type"),
        log_event(3, "session.status", status="idle", stopReason="end_turn"),
        log_event(4, "session.status", status="completed"),
        log_event(5, "agent.message", content=[]),
    )
    return Router().add("GET", f"{PREFIX}/sessions/msess_1/stream", first, second)


def test_stream_resumes_with_last_event_id_and_stops_on_terminal_status():
    router = stream_router()
    events = list(client(router).sessions.stream("msess_1"))
    assert [item["seq"] for item in events] == [1, 3, 4]
    first, second = router.calls("GET", f"{PREFIX}/sessions/msess_1/stream")
    assert "last-event-id" not in first.headers
    assert second.headers["last-event-id"] == "2"
    assert first.headers["accept"] == "text/event-stream"


def test_stream_end_frame_and_protocol_errors():
    router = Router().add(
        "GET",
        f"{PREFIX}/sessions/msess_1/stream",
        stream_response(log_event(6, "agent.message", content=[]), ("end", None, {"headSeq": 6, "reason": "terminal", "sessionId": "msess_1", "status": "completed"})),
    )
    events = list(client(router).sessions.stream("msess_1", after=5))
    assert [item["seq"] for item in events] == [6]
    assert router.requests[0].url.params["after"] == "5"

    bad = Router().add("GET", f"{PREFIX}/sessions/msess_1/stream", stream_response(("message", "1", {"nope": True})))
    with pytest.raises(StreamProtocolError):
        list(client(bad).sessions.stream("msess_1"))

    wrong_type = Router().add("GET", f"{PREFIX}/sessions/msess_1/stream", httpx.Response(200, json={}))
    with pytest.raises(ManagedAgentsError, match="did not return an event stream"):
        list(client(wrong_type).sessions.stream("msess_1"))


def test_async_client_streams_and_lists():
    router = stream_router().add("GET", f"{PREFIX}/sessions", httpx.Response(200, json={"data": [], "nextCursor": None}))

    async def go():
        async with AsyncManagedAgentsClient("sk", BASE, transport=router.transport()) as api:
            page = await api.sessions.list(status="idle")
            events = [item async for item in api.sessions.stream("msess_1")]
            return page, events

    page, events = asyncio.run(go())
    assert page["data"] == []
    assert [item["seq"] for item in events] == [1, 3, 4]
    assert router.calls("GET", f"{PREFIX}/sessions")[0].url.params["status"] == "idle"


APPROVAL = {
    "id": "mevt_9",
    "seq": 9,
    "sessionId": "msess_1",
    "createdAt": "t",
    "type": "user.tool_approval",
    "toolUseId": "toolu_1",
    "decision": "deny",
    "message": "Not now",
}


def test_respond_to_approval_appends_one_answer_and_returns_it():
    router = Router().add("POST", f"{PREFIX}/sessions/msess_1/events", httpx.Response(202, json={"data": [APPROVAL]}))
    with client(router) as api:
        answer = api.sessions.respond_to_approval(
            "msess_1", "toolu_1", "deny", message="Not now", idempotency_key="idem-approval-1"
        )
    assert answer == APPROVAL
    request = router.calls("POST", f"{PREFIX}/sessions/msess_1/events")[0]
    assert request.headers["idempotency-key"] == "idem-approval-1"
    assert router.bodies("POST", f"{PREFIX}/sessions/msess_1/events")[0] == {
        "events": [{"type": "user.tool_approval", "toolUseId": "toolu_1", "decision": "deny", "message": "Not now"}]
    }


def test_async_respond_to_approval_and_approval_events_survive_the_stream_filter():
    router = Router().add("POST", f"{PREFIX}/sessions/msess_1/events", httpx.Response(202, json={"data": [APPROVAL]}))

    async def main():
        async with AsyncManagedAgentsClient("sk-test", BASE, transport=router.transport()) as api:
            return await api.sessions.respond_to_approval("msess_1", "toolu_1", "allow")

    assert asyncio.run(main()) == APPROVAL
    assert router.bodies("POST", f"{PREFIX}/sessions/msess_1/events")[0]["events"][0]["message"] is None
