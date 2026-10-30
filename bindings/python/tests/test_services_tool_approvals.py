"""Managed Agents interactive tool approvals through ryu_sdk.services (parity with @ryuhq/services)."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

import httpx
import pytest
from test_services_namespaces import MA, MA_ENV, Router, ma_stream

from ryu_sdk import managed_agents as low_level
from ryu_sdk.services import AsyncRyu, RyuConfigurationError, RyuConflictError, RyuError, ToolApprovalContext

TOOL_USE = {"seq": 3, "type": "agent.tool_use", "toolUseId": "toolu_0123456789", "name": "bash", "input": {"cmd": "ls"}}
REQUEST = {
    "seq": 4,
    "type": "agent.tool_approval_request",
    "toolUseId": "toolu_0123456789",
    "name": "bash",
    "expiresAt": "2026-10-22T12:10:00Z",
}
WAITING = {
    "seq": 5,
    "type": "session.status",
    "status": "idle",
    "inputSeq": 2,
    "stopReason": "requires_action",
    "pendingToolUseIds": ["toolu_0123456789"],
}
PROVISIONED = {"seq": 1, "type": "session.status", "status": "idle", "detail": "provisioned"}
MESSAGE = {"seq": 2, "type": "user.message", "content": [{"type": "text", "text": "List files"}]}
ANSWER = {"seq": 6, "type": "user.tool_approval", "toolUseId": "toolu_0123456789", "decision": "allow"}
AFTER_ANSWER = (
    ANSWER,
    {"seq": 7, "type": "agent.tool_result", "toolUseId": "toolu_0123456789", "content": []},
    {"seq": 8, "type": "agent.message", "content": [{"type": "text", "text": "Two files."}]},
    {"seq": 9, "type": "session.status", "status": "idle", "inputSeq": 6, "stopReason": "end_turn"},
)
FIRST_TURN = (PROVISIONED, MESSAGE, TOOL_USE, REQUEST, WAITING)


def conflict(code: str) -> httpx.Response:
    return httpx.Response(409, json={"error": {"code": code, "message": code, "requestId": "req_1"}})


def run_routes(answer: Any, *, second_stream: bool = True) -> Router:
    streams = [ma_stream(*FIRST_TURN)]
    if second_stream:
        streams.append(ma_stream(*FIRST_TURN, *AFTER_ANSWER))
    return Router(
        {
            f"POST {MA}/sessions": httpx.Response(201, json={"id": "s_1", "headSeq": 2}),
            f"GET {MA}/sessions/s_1/stream": streams,
            f"POST {MA}/sessions/s_1/events": answer,
            f"GET {MA}/sessions/s_1": httpx.Response(200, json={"id": "s_1", "status": "idle"}),
        }
    )


RUN_INPUT = {"agentId": "magt_1", "environmentId": "menv_1", "message": "List files"}


# ── answers ──────────────────────────────────────────────────────────────────


def test_a_message_is_part_of_the_derived_key():
    router = Router({f"POST {MA}/sessions/s_1/events": httpx.Response(200, json={"data": [ANSWER]})})
    router.ryu(MA_ENV).managed_agents.sessions.deny_tool("s_1", "toolu_0123456789", message="Not now")
    assert router.requests[0].headers["idempotency-key"] == "tool-approval-deny-toolu_0123456789-m2c3d6fce"
    assert json.loads(router.requests[0].content)["events"][0] == {
        "type": "user.tool_approval",
        "toolUseId": "toolu_0123456789",
        "decision": "deny",
        "message": "Not now",
    }


def test_respond_to_approval_uses_the_derived_key_and_returns_the_answer():
    router = Router({f"POST {MA}/sessions/s_1/events": httpx.Response(200, json={"data": [ANSWER]})})
    answer = router.ryu(MA_ENV).managed_agents.sessions.respond_to_approval("s_1", "toolu_0123456789", "allow")
    assert answer == ANSWER
    assert router.requests[0].headers["idempotency-key"] == "tool-approval-allow-toolu_0123456789"


def test_a_derived_key_is_retried_once_with_a_fresh_key_on_unknown_tool_use():
    router = Router(
        {
            f"POST {MA}/sessions/s_1/events": [
                conflict("unknown_tool_use"),
                httpx.Response(200, json={"data": [ANSWER]}),
            ]
        }
    )
    assert router.ryu(MA_ENV).managed_agents.sessions.approve_tool("s_1", "toolu_0123456789") == ANSWER
    keys = [request.headers["idempotency-key"] for request in router.requests]
    assert keys[0] == "tool-approval-allow-toolu_0123456789"
    assert len(keys) == 2 and keys[1] != keys[0]


def test_a_second_unknown_tool_use_is_raised():
    router = Router({f"POST {MA}/sessions/s_1/events": conflict("unknown_tool_use")})
    with pytest.raises(RyuConflictError) as raised:
        router.ryu(MA_ENV).managed_agents.sessions.approve_tool("s_1", "toolu_0123456789")
    assert raised.value.code == "unknown_tool_use"
    assert len(router.requests) == 2


@pytest.mark.parametrize("bound", [False, True])
def test_a_caller_key_is_never_retried(bound: bool):
    router = Router({f"POST {MA}/sessions/s_1/events": conflict("unknown_tool_use")})
    ryu = router.ryu(MA_ENV)
    with pytest.raises(RyuConflictError):
        if bound:
            ryu.managed_agents.with_options(idempotency_key="my-approval-key-1").sessions.approve_tool(
                "s_1", "toolu_0123456789"
            )
        else:
            ryu.managed_agents.sessions.approve_tool("s_1", "toolu_0123456789", idempotency_key="my-approval-key-1")
    assert [request.headers["idempotency-key"] for request in router.requests] == ["my-approval-key-1"]


def test_other_conflicts_are_not_retried():
    router = Router({f"POST {MA}/sessions/s_1/events": conflict("tool_result_already_submitted")})
    with pytest.raises(RyuConflictError):
        router.ryu(MA_ENV).managed_agents.sessions.deny_tool("s_1", "toolu_0123456789")
    assert len(router.requests) == 1


def test_a_reply_without_the_answer_is_a_validation_error():
    router = Router({f"POST {MA}/sessions/s_1/events": httpx.Response(200, json={"data": []})})
    with pytest.raises(RyuError) as raised:
        router.ryu(MA_ENV).managed_agents.sessions.approve_tool("s_1", "toolu_0123456789")
    assert raised.value.code == "invalid_response"


# ── run / follow ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("until", ["turn", "terminal"])
def test_without_a_handler_run_stops_at_the_requires_action_idle(until: str):
    router = run_routes(httpx.Response(500), second_stream=False)
    data = router.ryu(MA_ENV).managed_agents.sessions.run(RUN_INPUT, until=until)
    assert [event["seq"] for event in data["events"]] == [1, 2, 3, 4, 5]
    assert data["pendingApprovals"] == [REQUEST]
    # Nothing was answered on the caller's behalf.
    assert router.bodies(f"POST {MA}/sessions/s_1/events") == []


def test_a_handler_allows_once_and_the_run_reads_the_rest_of_the_turn():
    router = run_routes(httpx.Response(200, json={"data": [ANSWER]}))
    calls: list[ToolApprovalContext] = []

    def decide(context: ToolApprovalContext) -> str:
        calls.append(context)
        return "allow"

    data = router.ryu(MA_ENV).managed_agents.sessions.run(RUN_INPUT, on_tool_approval=decide)
    assert len(calls) == 1
    assert calls[0].session_id == "s_1"
    assert calls[0].request == REQUEST
    assert calls[0].tool_use == TOOL_USE
    assert data["text"] == "Two files."
    assert data["pendingApprovals"] == []
    assert data["events"][-1]["stopReason"] == "end_turn"
    answers = [request for request in router.requests if request.method == "POST" and "events" in request.url.path]
    assert len(answers) == 1
    assert answers[0].headers["idempotency-key"] == "tool-approval-allow-toolu_0123456789"


def test_a_handler_may_deny_with_a_message():
    router = run_routes(httpx.Response(200, json={"data": [{**ANSWER, "decision": "deny"}]}))
    router.ryu(MA_ENV).managed_agents.sessions.run(
        RUN_INPUT, on_tool_approval=lambda _context: {"decision": "deny", "message": "Not on prod"}
    )
    sent = router.bodies(f"POST {MA}/sessions/s_1/events")[0]["events"][0]
    assert sent["decision"] == "deny" and sent["message"] == "Not on prod"


def test_a_handler_returning_none_leaves_the_request_open():
    router = run_routes(httpx.Response(500), second_stream=False)
    data = router.ryu(MA_ENV).managed_agents.sessions.run(RUN_INPUT, on_tool_approval=lambda _context: None)
    assert data["pendingApprovals"] == [REQUEST]
    assert router.bodies(f"POST {MA}/sessions/s_1/events") == []


def test_a_handler_that_raises_stops_with_tool_approval_handler_failed():
    router = run_routes(httpx.Response(500), second_stream=False)

    def decide(_context: ToolApprovalContext) -> str:
        raise ValueError("policy service down")

    with pytest.raises(RyuError) as raised:
        router.ryu(MA_ENV).managed_agents.sessions.run(RUN_INPUT, on_tool_approval=decide)
    assert raised.value.code == "tool_approval_handler_failed"
    assert isinstance(raised.value.__cause__, ValueError)
    assert router.bodies(f"POST {MA}/sessions/s_1/events") == []


def test_an_invalid_decision_is_a_configuration_error():
    router = run_routes(httpx.Response(500), second_stream=False)
    with pytest.raises(RyuConfigurationError) as raised:
        router.ryu(MA_ENV).managed_agents.sessions.run(RUN_INPUT, on_tool_approval=lambda _context: "yes")
    assert raised.value.code == "invalid_tool_approval_decision"


@pytest.mark.parametrize("code", ["tool_result_already_submitted", "unknown_tool_use", "idempotency_key_reused"])
def test_an_already_settled_request_is_not_an_error(code: str):
    router = run_routes(conflict(code))
    data = router.ryu(MA_ENV).managed_agents.sessions.run(RUN_INPUT, on_tool_approval=lambda _context: "allow")
    assert data["text"] == "Two files."


def test_follow_after_a_request_seeds_it_and_answers_it():
    router = Router(
        {
            f"GET {MA}/sessions/s_1/events": [
                # The types-filtered seed read, then the head read.
                httpx.Response(200, json={"data": [TOOL_USE, REQUEST, WAITING], "hasMore": False, "nextAfter": 5}),
                httpx.Response(200, json={"data": [], "headSeq": 5}),
            ],
            f"POST {MA}/sessions/s_1/events": httpx.Response(200, json={"data": [ANSWER]}),
            f"GET {MA}/sessions/s_1/stream": ma_stream(*AFTER_ANSWER),
        }
    )
    seen: list[ToolApprovalContext] = []
    events = list(
        router.ryu(MA_ENV).managed_agents.sessions.follow(
            "s_1", after=5, on_tool_approval=lambda context: seen.append(context) or "allow"
        )
    )
    assert [event["seq"] for event in events] == [6, 7, 8, 9]
    assert [context.tool_use for context in seen] == [TOOL_USE]
    seed = router.requests[0]
    assert (
        seed.url.params["types"]
        == "agent.tool_use,agent.tool_approval_request,user.tool_approval,user.interrupt,session.status"
    )
    assert seed.url.params["after"] == "0"


def test_follow_after_a_request_without_a_handler_stops_before_streaming():
    router = Router(
        {
            f"GET {MA}/sessions/s_1/events": [
                httpx.Response(200, json={"data": [REQUEST, WAITING], "hasMore": False, "nextAfter": 5}),
                httpx.Response(200, json={"data": [], "headSeq": 5}),
            ],
        }
    )
    assert list(router.ryu(MA_ENV).managed_agents.sessions.follow("s_1", after=5)) == []
    assert not any(request.url.path.endswith("/stream") for request in router.requests)


def test_stream_is_the_raw_log_and_does_not_stop_at_an_approval():
    router = Router(
        {
            f"GET {MA}/sessions/s_1/stream": ma_stream(
                *FIRST_TURN, {"seq": 6, "type": "session.status", "status": "canceled"}
            )
        }
    )
    events = list(router.ryu(MA_ENV).managed_agents.sessions.stream("s_1"))
    assert [event["seq"] for event in events] == [1, 2, 3, 4, 5, 6]


def test_an_async_handler_on_async_ryu():
    router = run_routes(httpx.Response(200, json={"data": [ANSWER]}))

    async def decide(context: ToolApprovalContext) -> dict[str, Optional[str]]:
        await asyncio.sleep(0)
        return {"decision": "allow", "message": None}

    async def main() -> Any:
        async with AsyncRyu(env=MA_ENV, transport=httpx.MockTransport(router)) as ryu:
            return await ryu.managed_agents.sessions.run(RUN_INPUT, on_tool_approval=decide)

    data = asyncio.run(main())
    assert data["text"] == "Two files."
    assert data["pendingApprovals"] == []


# ── the low-level client ─────────────────────────────────────────────────────


def test_the_low_level_client_keeps_approval_events():
    assert {"user.tool_approval", "agent.tool_approval_request"} <= low_level.MANAGED_AGENT_EVENT_TYPES
    cursor = low_level.StreamCursor()
    event, stop = cursor.read("message", "4", json.dumps(REQUEST))
    assert event == REQUEST and stop is False
