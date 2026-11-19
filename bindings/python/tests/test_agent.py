"""Agent loop tests against a mocked gateway and Core (httpx.MockTransport)."""

from __future__ import annotations

import asyncio
import json
from typing import Any, List

import httpx
import pydantic
import pytest
from helpers import CHAT, CORE, GATEWAY, Router, completion, sse_response, streamed_completion, tool_call

from ryu_sdk import (
    Agent,
    AgentError,
    Middleware,
    ModelCallResult,
    StructuredOutputError,
    ToolCallResult,
    ryu_tool,
    tool,
)
from ryu_sdk.agent import ApprovalRequestedEvent, ResultEvent, TextEvent, ToolCallEvent, ToolResultEvent
from ryu_sdk.gateway import EgressNotAllowedError


def make_agent(router: Router, **options: Any) -> Agent:
    options.setdefault("model", "gemma4")
    return Agent(
        "test",
        gateway_url=GATEWAY,
        gateway_token="gw-token",
        core_url=CORE,
        core_token="core-token",
        transport=router.transport(),
        **options,
    )


def collect(agent: Agent, prompt: str) -> List[Any]:
    async def run() -> List[Any]:
        return [event async for event in agent.stream(prompt)]

    return asyncio.run(run())


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


def test_plain_reply_uses_gateway_with_raw_tools_header():
    router = Router().add(
        "POST", CHAT, completion("hello", usage={"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5})
    )
    agent = make_agent(router, instructions="Be brief.")
    result = agent.generate("hi")
    assert result.text == "hello"
    assert result.steps == 1
    assert result.usage is not None and result.usage.total_tokens == 5
    request = router.calls("POST", CHAT)[0]
    assert request.headers["x-ryu-raw-tools"] == "on"
    assert request.headers["authorization"] == "Bearer gw-token"
    body = json.loads(request.content)
    assert body["model"] == "gemma4"
    assert body["stream"] is True
    assert body["messages"] == [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"}]
    assert "tools" not in body


def test_streamed_tool_call_runs_local_tool_and_feeds_result_back():
    router = Router().add(
        "POST",
        CHAT,
        streamed_completion(
            {"content": "Let me add. "},
            {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "add", "arguments": '{"a": 2'}}]},
            {"tool_calls": [{"index": 0, "function": {"arguments": ', "b": 3}'}}]},
        ),
        streamed_completion(
            {"content": "The sum "},
            {"content": "is 5."},
            usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        ),
    )
    agent = make_agent(router, tools=[add])
    events = collect(agent, "2+3?")
    kinds = [event.type for event in events]
    assert kinds == ["text", "tool_call", "tool_result", "text", "text", "result"]
    call = next(event for event in events if isinstance(event, ToolCallEvent))
    assert call.input == {"a": 2, "b": 3}
    assert next(event for event in events if isinstance(event, ToolResultEvent)).output == 5
    result = events[-1]
    assert isinstance(result, ResultEvent) and result.text == "The sum is 5." and result.steps == 2

    first, second = router.bodies("POST", CHAT)
    assert first["tool_choice"] == "auto"
    assert first["tools"][0]["function"]["name"] == "add"
    assert first["tools"][0]["function"]["parameters"]["required"] == ["a", "b"]
    assert second["messages"][-2]["tool_calls"][0]["function"]["arguments"] == '{"a": 2, "b": 3}'
    assert second["messages"][-1] == {"role": "tool", "tool_call_id": "c1", "content": "5"}


def test_sync_generate_matches_async_stream():
    router = Router().add(
        "POST",
        CHAT,
        completion(None, [tool_call("c1", "add", {"a": 1, "b": 1})]),
        completion("two"),
    )
    result = make_agent(router, tools={"add": add}).generate("1+1")
    assert result.text == "two" and result.steps == 2


def test_tool_errors_are_fed_back_to_the_model():
    @tool
    def explode() -> str:
        """Always fails."""
        raise RuntimeError("boom")

    router = Router().add(
        "POST",
        CHAT,
        completion(
            None, [tool_call("c1", "explode", {}), tool_call("c2", "missing", {}), tool_call("c3", "add", "{bad")]
        ),
        completion("recovered"),
    )
    agent = make_agent(router, tools=[explode, add])
    events = collect(agent, "go")
    outputs = [event.output for event in events if isinstance(event, ToolResultEvent)]
    assert outputs[0] == {"error": "boom"}
    assert "unknown tool" in outputs[1]["error"]
    assert "not valid JSON" in outputs[2]["error"]
    assert events[-1].type == "result"


def test_invalid_arguments_report_schema_issues():
    router = Router().add("POST", CHAT, completion(None, [tool_call("c1", "add", {"a": "x"})]), completion("ok"))
    events = collect(make_agent(router, tools=[add]), "go")
    error = next(event for event in events if isinstance(event, ToolResultEvent)).output["error"]
    assert "at a: expected integer" in error
    assert "at b: required property is missing" in error


def test_max_steps_returns_last_text():
    router = Router().add("POST", CHAT, completion("thinking", [tool_call("c", "add", {"a": 1, "b": 2})]))
    result = make_agent(router, tools=[add], max_steps=2).generate("loop")
    assert result.steps == 2 and result.text == "thinking"
    assert len(router.calls("POST", CHAT)) == 2


class Answer(pydantic.BaseModel):
    city: str
    temperature: float


def test_structured_output_repairs_then_validates_into_a_model():
    router = Router().add(
        "POST",
        CHAT,
        completion('{"city": "Oslo"}'),
        completion('Sure: ```json\n{"city": "Oslo", "temperature": 3.5}\n```'),
    )
    agent = make_agent(router, output_schema=Answer)
    events = collect(agent, "weather?")
    repair = next(event for event in events if event.type == "output_repair")
    assert repair.attempt == 1 and repair.issues[0].path == ("temperature",)
    result = events[-1]
    assert isinstance(result.output, Answer) and result.output.temperature == 3.5
    first, second = router.bodies("POST", CHAT)
    assert first["response_format"]["type"] == "json_schema"
    assert first["response_format"]["json_schema"]["name"] == "ryu_output"
    assert first["response_format"]["json_schema"]["strict"] is False
    assert second["messages"][-1]["role"] == "user"
    assert second["messages"][-1]["content"].startswith(
        "Your previous reply did not satisfy the required output schema."
    )
    assert "- at temperature:" in second["messages"][-1]["content"]


def test_structured_output_failure_raises_typed_error():
    schema = {
        "type": "object",
        "properties": {"ok": {"type": "boolean"}},
        "required": ["ok"],
        "additionalProperties": False,
    }
    router = Router().add("POST", CHAT, completion("not json"))
    agent = make_agent(router, output_schema=schema, max_repair_attempts=1)
    with pytest.raises(StructuredOutputError) as caught:
        agent.generate("?")
    assert caught.value.attempts == 2
    assert caught.value.code == "structured_output_invalid"
    assert caught.value.text == "not json"
    assert router.bodies("POST", CHAT)[0]["response_format"]["json_schema"]["strict"] is True


def test_approval_pause_deny_and_allow():
    @tool(needs_approval=True)
    def delete_file(path: str) -> str:
        """Delete a file."""
        return f"deleted {path}"

    def responses() -> Router:
        return Router().add(
            "POST", CHAT, completion(None, [tool_call("c1", "delete_file", {"path": "/tmp/x"})]), completion("done")
        )

    paused = make_agent(responses(), tools=[delete_file]).generate("rm")
    assert isinstance(paused.approval_required, ApprovalRequestedEvent)
    assert paused.approval_required.name == "delete_file"

    seen = []
    denied_router = responses()
    make_agent(
        denied_router, tools=[delete_file], approval_handler=lambda request: seen.append(request) or False
    ).generate("rm")
    assert seen[0].input == {"path": "/tmp/x"}
    assert (
        denied_router.bodies("POST", CHAT)[1]["messages"][-1]["content"]
        == '{"error": "tool execution was not approved"}'
    )

    allowed_router = responses()

    async def approve(_request: Any) -> bool:
        return True

    events = collect(make_agent(allowed_router, tools=[delete_file], approval_handler=approve), "rm")
    assert [event.output for event in events if isinstance(event, ToolResultEvent)] == ["deleted /tmp/x"]


def test_remote_tool_describes_and_calls_core_with_agent_id():
    router = (
        Router()
        .add("GET", "/api/tools/describe", httpx.Response(200, json={"description": "Search Gmail"}))
        .add("POST", "/api/mcp/tools/call", httpx.Response(200, json={"ok": True, "output": {"hits": 2}}))
        .add("POST", CHAT, completion(None, [tool_call("c1", "gmail", {"query": "x"})]), completion("2 hits"))
    )
    agent = make_agent(
        router, tools={"gmail": ryu_tool("composio.GMAIL_SEARCH_EMAILS")}, agent_id="agent-1", user_id="u1"
    )
    assert agent.generate("mail").text == "2 hits"
    describe = router.calls("GET", "/api/tools/describe")[0]
    assert describe.url.params["id"] == "composio.GMAIL_SEARCH_EMAILS"
    assert describe.headers["authorization"] == "Bearer core-token"
    assert router.bodies("POST", "/api/mcp/tools/call") == [
        {"tool": "composio.GMAIL_SEARCH_EMAILS", "arguments": {"query": "x"}, "agent_id": "agent-1", "user_id": "u1"}
    ]
    definition = router.bodies("POST", CHAT)[0]["tools"][0]["function"]
    assert definition["description"] == "Search Gmail"
    assert definition["parameters"] == {"type": "object", "additionalProperties": True}


def test_remote_tool_without_agent_id_and_elicitation():
    router = Router().add("POST", CHAT, completion(None, [tool_call("c1", "gmail", {})]), completion("ok"))
    events = collect(make_agent(router, tools={"gmail": ryu_tool("composio.X", description="d")}), "go")
    assert "requires an agent_id" in next(e for e in events if isinstance(e, ToolResultEvent)).output["error"]

    elicit = (
        Router()
        .add(
            "POST",
            "/api/mcp/tools/call",
            httpx.Response(
                200,
                json={
                    "ok": True,
                    "output": {"__ryu_elicitation__": {"url": "https://connect", "message": "Connect Gmail"}},
                },
            ),
        )
        .add("POST", CHAT, completion(None, [tool_call("c1", "gmail", {})]))
    )
    result = make_agent(elicit, tools={"gmail": ryu_tool("composio.X", description="d")}, agent_id="a").generate("go")
    assert result.auth_required is not None
    assert result.auth_required.url == "https://connect" and result.auth_required.tool == "gmail"


def test_middleware_wraps_model_and_tool_calls_and_continues_turns():
    calls: List[str] = []

    def wrap_model(request, next_call):
        calls.append(f"model:{request.step}")
        return next_call(request.replace(model="routed-model"))

    def deny_tool(request, next_call):
        if request.name == "add" and request.input.get("a") == 13:
            return ToolCallResult(output={"error": "unlucky"})
        return next_call(request)

    turns = []

    def after_turn(summary):
        turns.append(summary.text)
        return {"continue": "Double-check."} if len(turns) == 1 else None

    router = Router().add(
        "POST",
        CHAT,
        completion(None, [tool_call("c1", "add", {"a": 13, "b": 1})]),
        completion("14"),
        completion("Checked: 14"),
    )
    middleware = [Middleware("route", wrap_model_call=wrap_model, wrap_tool_call=deny_tool, after_turn=after_turn)]
    result = make_agent(router, tools=[add], middleware=middleware).generate("13+1")
    assert result.text == "Checked: 14"
    assert calls == ["model:1", "model:2", "model:3"]
    bodies = router.bodies("POST", CHAT)
    assert all(body["model"] == "routed-model" for body in bodies)
    assert bodies[1]["messages"][-1]["content"] == '{"error": "unlucky"}'
    assert bodies[2]["messages"][-1] == {"role": "user", "content": "Double-check."}


def test_middleware_can_answer_without_the_gateway_and_subclass_hooks():
    class Cached(Middleware):
        def wrap_model_call(self, request, next_call):
            return ModelCallResult(message={"role": "assistant", "content": "cached"})

    router = Router()
    assert make_agent(router, middleware=[Cached()]).generate("x").text == "cached"
    assert router.requests == []


def test_async_middleware_requires_async_api():
    async def wrap(request, next_call):
        return await next_call(request)

    router = Router().add("POST", CHAT, completion("hi"))
    agent = make_agent(router, middleware=[Middleware(wrap_model_call=wrap)])
    with pytest.raises(AgentError, match="async middleware"):
        agent.generate("x")
    assert asyncio.run(agent.agenerate("x")).text == "hi"


def test_gateway_errors_and_egress_rule():
    router = Router().add("POST", CHAT, httpx.Response(503, json={"error": "overloaded"}))
    with pytest.raises(AgentError, match="gateway 503"):
        make_agent(router).generate("x")
    with pytest.raises(EgressNotAllowedError):
        Agent("bad", model="gpt", gateway_url="https://api.openai.com/v1")


def test_gateway_status_error_names_the_origin_only_and_the_token_setting():
    def unauthorized(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad token"})

    agent = Agent(
        "test",
        model="m",
        gateway_url="http://user:secret@127.0.0.1:7979/x?token=leak",
        gateway_token="gw-secret-token",
        transport=httpx.MockTransport(unauthorized),
    )
    for run in (lambda: agent.generate("x"), lambda: asyncio.run(agent.agenerate("x"))):
        with pytest.raises(AgentError) as caught:
            run()
        message = str(caught.value)
        assert "gateway 401 at http://127.0.0.1:7979; check RYU_GATEWAY_TOKEN (or gateway_token=): " in message
        for secret in ("secret", "leak", "gw-secret-token", "/x", "/v1"):
            assert secret not in message


def test_gateway_server_error_has_no_token_hint():
    router = Router().add("POST", CHAT, httpx.Response(503, json={"error": "overloaded"}))
    with pytest.raises(AgentError) as caught:
        make_agent(router).generate("x")
    assert "gateway 503 at " in str(caught.value)
    assert "RYU_GATEWAY_TOKEN" not in str(caught.value)
    assert "/v1/chat/completions" not in str(caught.value)


def test_gateway_connection_refused_names_the_origin_and_settings():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("[Errno 111] Connection refused", request=request)

    agent = Agent(
        "test",
        model="m",
        gateway_url="http://user:secret@127.0.0.1:7979/v1?token=leak",
        gateway_token="gw-secret-token",
        transport=httpx.MockTransport(refuse),
    )
    for run in (lambda: agent.generate("x"), lambda: asyncio.run(agent.agenerate("x"))):
        with pytest.raises(AgentError) as caught:
            run()
        message = str(caught.value)
        assert message.startswith('[ryu-sdk] agent "test": could not reach the Ryu Gateway at http://127.0.0.1:7979 ')
        assert "Connection refused" in message
        assert "RYU_GATEWAY_URL" in message and "RYU_GATEWAY_TOKEN" in message
        for secret in ("secret", "leak", "gw-secret-token", "/v1"):
            assert secret not in message


def test_gateway_read_timeout_names_the_origin_and_settings():
    def stall(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    agent = Agent(
        "test",
        model="m",
        gateway_url="http://user:secret@127.0.0.1:7979/v1?token=leak",
        gateway_token="gw-secret-token",
        transport=httpx.MockTransport(stall),
    )
    for run in (lambda: agent.generate("x"), lambda: asyncio.run(agent.agenerate("x"))):
        with pytest.raises(AgentError) as caught:
            run()
        message = str(caught.value)
        assert message.startswith(
            '[ryu-sdk] agent "test": the Ryu Gateway at http://127.0.0.1:7979 did not respond in time (timed out). '
        )
        assert "RYU_GATEWAY_URL" in message and "RYU_GATEWAY_TOKEN" in message
        for secret in ("secret", "leak", "gw-secret-token", "/v1"):
            assert secret not in message


def test_session_agent_runs_on_core_harness_with_approvals():
    run = {"id": "run-1"}
    events = [
        {"type": "text_delta", "delta": "Work", "seq": 1, "runId": "run-1"},
        {
            "type": "approval_requested",
            "approvalId": "perm-1",
            "summary": "Run shell?",
            "seq": 2,
            "options": [
                {"optionId": "deny", "kind": "reject_once", "name": "Deny"},
                {"optionId": "ok", "kind": "allow_once", "name": "Allow"},
            ],
        },
        {"type": "tool_call_started", "toolCallId": "t1", "name": "shell", "seq": 3},
        {"type": "tool_call_completed", "toolCallId": "t1", "name": "shell", "ok": True, "seq": 4},
        {"type": "text_delta", "delta": " done", "seq": 5},
        {"type": "run_completed", "seq": 6},
    ]
    router = (
        Router()
        .add(
            "POST",
            "/api/harness/sessions/sess-1/runs",
            httpx.Response(200, json={"created": True, "eventsUrl": "/x", "protocolVersion": "1", "run": run}),
        )
        .add("GET", "/api/harness/runs/run-1/events", sse_response(*events))
        .add("POST", "/api/chat/permission", httpx.Response(200, json={"resolved": True}))
    )
    agent = make_agent(router, session_id="sess-1", approval_handler=lambda request: True)
    result = agent.generate("do it")
    assert result.text == "Work done" and result.steps == 1
    assert router.bodies("POST", "/api/harness/sessions/sess-1/runs") == [{"input": {"prompt": "do it"}}]
    assert router.bodies("POST", "/api/chat/permission") == [{"request_id": "perm-1", "option_id": "ok"}]

    async_events = collect(make_agent(router, session_id="sess-1"), "again")
    assert isinstance(async_events[-1], ApprovalRequestedEvent)
    assert [e.content for e in async_events if isinstance(e, TextEvent)] == ["Work"]


def test_session_agent_rejects_middleware():
    agent = make_agent(Router(), session_id="s", middleware=[Middleware()])
    with pytest.raises(AgentError, match="SDK-owned loop"):
        agent.generate("x")


def test_invalid_json_arguments_still_pass_through_wrap_tool_call():
    seen: List[str] = []

    def guard(request, next_call):
        seen.append(request.name)
        return next_call(request)

    router = Router().add(
        "POST", CHAT, completion(tool_calls=[tool_call("c1", "add", "{not json")]), completion("gave up")
    )
    events = list(make_agent(router, tools=[add], middleware=[Middleware(wrap_tool_call=guard)]).stream_sync("x"))
    assert seen == ["add"]
    result = next(e for e in events if isinstance(e, ToolResultEvent))
    assert "not valid JSON" in result.output["error"]


def test_unknown_tool_error_and_agent_name_in_errors():
    router = Router().add("POST", CHAT, completion(tool_calls=[tool_call("c1", "nope", {})]), completion("ok"))
    events = list(make_agent(router, tools=[add]).stream_sync("x"))
    result = next(e for e in events if isinstance(e, ToolResultEvent))
    assert result.output == {"error": '[ryu-sdk] model called unknown tool "nope"'}

    failing = Router().add("POST", CHAT, httpx.Response(500, json={"error": "boom"}))
    with pytest.raises(AgentError, match=r'^\[ryu-sdk\] agent "test": .*boom'):
        make_agent(failing).generate("x")


def harness_events(run_id: str, *events: dict) -> httpx.Response:
    return sse_response(*[{"runId": run_id, **event} for event in events])


def test_session_agent_resume_and_stream_run():
    run = {"id": "run-2"}
    router = (
        Router()
        .add(
            "POST",
            "/api/harness/sessions/sess-1/runs",
            httpx.Response(200, json={"created": True, "eventsUrl": "/x", "protocolVersion": "1", "run": run}),
        )
        .add(
            "GET",
            "/api/harness/runs/run-2/events",
            harness_events(
                "run-2", {"type": "text_delta", "delta": "again", "seq": 1}, {"type": "run_completed", "seq": 2}
            ),
        )
        .add("POST", "/api/chat/permission", httpx.Response(200, json={"resolved": True}))
    )
    agent = make_agent(router, session_id="sess-1")
    events = list(agent.resume_sync("run-1", "retry"))
    assert [e.type for e in events] == ["text", "result"]
    assert router.bodies("POST", "/api/harness/sessions/sess-1/runs") == [
        {"input": {"prompt": "retry"}, "resumeRunId": "run-1"}
    ]

    async def go():
        resumed = [e async for e in agent.resume("run-1", "again")]
        attached = [e async for e in agent.stream_run("run-2", after=1)]
        return resumed, attached, await agent.aresolve_permission("perm-9", "ok")

    resumed, attached, resolved = asyncio.run(go())
    assert resumed[-1].type == "result" and resumed[-1].text == "again"
    assert [e.type for e in attached] == ["result"]
    assert router.calls("GET", "/api/harness/runs/run-2/events")[-1].url.params["after"] == "1"
    assert resolved is True and agent.resolve_permission("perm-9") is True
    assert router.bodies("POST", "/api/chat/permission") == [
        {"request_id": "perm-9", "option_id": "ok"},
        {"request_id": "perm-9"},
    ]

    plain = make_agent(Router())
    assert [e.message for e in plain.resume_sync("run-1", "x")] == ["resuming a durable run requires session_id"]


def test_cancelling_a_session_stream_cancels_the_core_run():
    gate = {"started": None}

    async def go():
        gate["started"] = asyncio.Event()

        async def slow_events(request: httpx.Request) -> httpx.Response:
            gate["started"].set()
            await asyncio.sleep(30)
            return sse_response()

        router = (
            Router()
            .add(
                "POST",
                "/api/harness/sessions/sess-1/runs",
                httpx.Response(
                    200, json={"created": True, "eventsUrl": "/x", "protocolVersion": "1", "run": {"id": "run-3"}}
                ),
            )
            .add("POST", "/api/harness/runs/run-3/cancel", httpx.Response(200, json={"cancelled": True}))
        )

        def route(request: httpx.Request):
            if request.url.path == "/api/harness/runs/run-3/events":
                return slow_events(request)
            return router(request)

        class AsyncRouter(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                response = route(request)
                return await response if asyncio.iscoroutine(response) else response

        agent = Agent(
            "test", model="m", gateway_url=GATEWAY, core_url=CORE, session_id="sess-1", transport=AsyncRouter()
        )

        async def consume():
            return [event async for event in agent.stream("go")]

        task = asyncio.ensure_future(consume())
        await gate["started"].wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return router

    router = asyncio.run(go())
    assert len(router.calls("POST", "/api/harness/runs/run-3/cancel")) == 1


def test_sync_stream_relays_text_deltas_while_the_round_streams():
    produced: List[str] = []

    def chunks():
        for delta in ("Hel", "lo"):
            produced.append(delta)
            payload = {"choices": [{"delta": {"content": delta}, "finish_reason": None}]}
            yield f"data: {json.dumps(payload)}\n\n".encode()
        produced.append("[DONE]")
        yield b"data: [DONE]\n\n"

    def gateway(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=chunks())

    agent = Agent("test", model="m", gateway_url=GATEWAY, transport=httpx.MockTransport(gateway))
    stream = agent.stream_sync("hi")
    first = next(stream)
    assert first == TextEvent(content="Hel")
    assert "[DONE]" not in produced  # the round is still streaming
    rest = list(stream)
    assert [e.content for e in rest if isinstance(e, TextEvent)] == ["lo"]
    assert rest[-1].type == "result" and rest[-1].text == "Hello"

    # A synchronous wrap_model_call returns the whole round, so its text follows it.
    wrapped = Agent(
        "test",
        model="m",
        gateway_url=GATEWAY,
        transport=httpx.MockTransport(gateway),
        middleware=[Middleware(wrap_model_call=lambda request, next_call: next_call(request))],
    )
    events = list(wrapped.stream_sync("hi"))
    assert [e.content for e in events if isinstance(e, TextEvent)] == ["Hel", "lo"]
