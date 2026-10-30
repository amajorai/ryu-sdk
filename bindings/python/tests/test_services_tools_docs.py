"""The Python samples on the public "Services as agent tools" page run here.

Each ``# docs:start <id>`` ... ``# docs:end <id>`` region below is one of the
``python`` code blocks of
``apps/fumadocs/content/docs/standalone/sdk/agent-tools.mdx``, in order; the
first test fails when a block and its region differ. ``# docs:show <text>``
lines render as ``<text>`` and do not run (the ``openai`` client, which this
package does not depend on). Every HTTP request goes to a stub router, so the
Agent, the Notify calls and the dispatcher run for real.
"""

from __future__ import annotations

import json
import re
import textwrap
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from helpers import CHAT, completion, tool_call
from helpers import Router as HttpRouter

if TYPE_CHECKING:
    # The OpenAI sample's annotations; `openai` is not a dependency, so it is never imported at run time.
    from openai.types.chat import ChatCompletionAssistantMessageParam, ChatCompletionMessageParam

PAGE = Path(__file__).resolve().parents[3] / "apps/fumadocs/content/docs/standalone/sdk/agent-tools.mdx"
ENV = {
    "RYU_NOTIFY_API_KEY": "n",
    "RYU_MAIL_GATEWAY_KEY": "gw",
    "RYU_GATEWAY_URL": "http://gateway.test",
    "RYU_GATEWAY_TOKEN": "t",
}
EVENTS = {"events": [{"id": "evt_1", "title": "Deploy finished"}], "nextCursor": None}


def _regions(source: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    inside = False
    for line in source.split("\n"):
        if re.match(r"^\s*# docs:start \S+\s*$", line):
            inside, current = True, []
        elif re.match(r"^\s*# docs:end \S+\s*$", line):
            inside = False
            blocks.append(textwrap.dedent("\n".join(current)).strip("\n"))
        elif inside:
            show = re.match(r"^(\s*)# docs:show(?: (.*))?$", line)
            current.append(f"{show.group(1)}{show.group(2) or ''}" if show else line)
    return [re.sub(r"[ \t]+$", "", block, flags=re.MULTILINE) for block in blocks]


def _page_blocks() -> list[str]:
    content = PAGE.read_text()
    return [
        match.group(1).strip("\n")
        for match in re.finditer(r"^```python[^\n]*\n(.*?)^```\s*$", content, re.MULTILINE | re.DOTALL)
    ]


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch) -> HttpRouter:
    router = HttpRouter()
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)

    def handle(_transport: Any, request: httpx.Request) -> httpx.Response:
        response = router(request)
        return httpx.Response(response.status_code, headers=response.headers, content=response.read())

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", handle)
    return router


def test_the_page_shows_exactly_these_regions():
    if not PAGE.exists():
        pytest.skip("the fumadocs content is not in this checkout")
    assert _page_blocks() == _regions(Path(__file__).read_text())


def test_agent_sample(stub: HttpRouter):
    stub.add("GET", "/v1/events", httpx.Response(200, json=EVENTS))
    stub.add(
        "POST",
        CHAT,
        completion(tool_calls=[tool_call("call_1", "notify_list_events", {"limit": 1})]),
        completion("The last event says the deploy finished."),
    )
    # docs:start python-agent
    from ryu_sdk import Agent
    from ryu_sdk.services import Ryu
    from ryu_sdk.services.tools import to_ryu_agent_tools

    # Reads each service's variables, such as RYU_NOTIFY_API_KEY, from the environment.
    ryu = Ryu()

    agent = Agent(
        "ops",
        model="openai/gpt-4o-mini",
        instructions="Answer questions about recent Notify events.",
        # The read-only tools of every service `ryu` is configured for.
        tools=to_ryu_agent_tools(ryu),
    )

    result = agent.generate("What was the last event about?")
    # docs:end python-agent
    assert result.text == "The last event says the deploy finished."
    assert stub.calls("GET", "/v1/events")[0].url.params["limit"] == "1"


def test_options_sample(stub: HttpRouter):
    from ryu_sdk.services import Ryu
    from ryu_sdk.services.tools import to_ryu_agent_tools

    ryu = Ryu()
    # docs:start python-options
    tools = to_ryu_agent_tools(
        ryu,
        services=["mail", "notify"],
        read_only=False,  # also expose tools that send, charge, run or delete
        exclude=["mail_send"],
        # Ask the Agent's approval_handler before anything that leaves Ryu.
        needs_approval=lambda tool: tool.annotations.open_world_hint,
    )
    # docs:end python-options
    assert "mail_send" not in tools and "notify_ack_event" in tools
    assert tools["notify_publish"].needs_approval and not tools["notify_ack_event"].needs_approval


@pytest.mark.parametrize("calls_a_tool", [True, False], ids=["tool-call", "text-only"])
def test_openai_sample(stub: HttpRouter, monkeypatch: pytest.MonkeyPatch, calls_a_tool: bool):
    asked: list[str] = []
    monkeypatch.setattr("builtins.input", lambda prompt: asked.append(prompt) or "n")
    stub.add("GET", "/v1/events", httpx.Response(200, json=EVENTS))
    sent: dict[str, Any] = {}

    def create(**options: Any) -> Any:
        sent.update(options)
        call = SimpleNamespace(
            id="call_1",
            type="function",
            function=SimpleNamespace(name="notify_list_events", arguments='{"acknowledged": false}'),
        )
        custom = SimpleNamespace(id="call_2", type="custom", custom=SimpleNamespace(name="x", input=""))
        if not calls_a_tool:
            reply = SimpleNamespace(role="assistant", content="No events.", tool_calls=None)
            return SimpleNamespace(choices=[SimpleNamespace(message=reply)])
        message = SimpleNamespace(role="assistant", content=None, tool_calls=[call, custom])
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    # docs:start python-openai
    import json

    # docs:show from openai import OpenAI
    # docs:show from openai.types.chat import ChatCompletionAssistantMessageParam, ChatCompletionMessageParam
    from ryu_sdk.services import Ryu
    from ryu_sdk.services.tools import to_openai_tools

    # docs:show client = OpenAI()
    ryu = Ryu()
    tools = to_openai_tools(ryu, services=["notify"])

    def ask_user(name: str, arguments: str) -> bool:
        return input(f"Run {name} with {arguments}? [y/N] ").strip().lower() == "y"

    messages: list[ChatCompletionMessageParam] = [
        {"role": "user", "content": "Summarize the unacknowledged Notify events."}
    ]
    response = client.chat.completions.create(model="gpt-4o-mini", messages=messages, tools=tools)
    message = response.choices[0].message
    # The tools are function tools, so the model's calls are function calls.
    calls = [call for call in message.tool_calls or [] if call.type == "function"]
    assistant: ChatCompletionAssistantMessageParam = {"role": "assistant", "content": message.content}
    # The API rejects an empty tool_calls list, so add it only when the model called a tool.
    if calls:
        assistant["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.function.name, "arguments": call.function.arguments},
            }
            for call in calls
        ]
    messages.append(assistant)
    for call in calls:
        name, arguments = call.function.name, call.function.arguments
        # A tool that needs approval runs only with approved=True; otherwise the model gets approval_required.
        approved = tools.needs_approval(name) and ask_user(name, arguments)
        result = tools.execute(name, arguments, approved=approved)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})
    # docs:end python-openai
    assert [tool["function"]["name"] for tool in sent["tools"]] == [
        "notify_list_events",
        "notify_get_event",
        "notify_usage",
    ]
    if not calls_a_tool:
        # A text-only reply adds no `tool_calls` key: the API rejects an empty list.
        assert messages[1] == {"role": "assistant", "content": "No events."}
        assert len(messages) == 2 and not stub.calls("GET", "/v1/events")
        return
    assert json.loads(messages[-1]["content"]) == {"data": EVENTS, "error": None, "meta": {}}
    # The assistant turn carries only the function call; the custom call is skipped.
    assert [call["id"] for call in messages[1]["tool_calls"]] == ["call_1"]
    assert len(messages) == 3
    assert stub.calls("GET", "/v1/events")[0].url.params["acknowledged"] == "false"
    assert asked == []  # a read-only tool runs without asking
    assert not tools.needs_approval("notify_list_events")


def test_the_openai_loop_asks_before_an_approval_required_tool(stub: HttpRouter, monkeypatch: pytest.MonkeyPatch):
    from ryu_sdk.services import Ryu
    from ryu_sdk.services.tools import to_openai_tools

    stub.add("POST", "/v1/events/evt_1/ack", httpx.Response(200, json={"event": {"id": "evt_1"}}))
    answers = iter(["n", "y"])
    monkeypatch.setattr("builtins.input", lambda _prompt: next(answers))
    tools = to_openai_tools(Ryu(), services=["notify"], read_only=False, include=["notify_ack_event"])

    def ask_user(name: str, arguments: str) -> bool:
        return input(f"Run {name} with {arguments}? [y/N] ").strip().lower() == "y"

    results = []
    for _ in range(2):
        name, arguments = "notify_ack_event", '{"eventId": "evt_1"}'
        approved = tools.needs_approval(name) and ask_user(name, arguments)
        results.append(tools.execute(name, arguments, approved=approved))
    assert results[0]["error"] is not None and results[0]["error"]["code"] == "approval_required"
    assert results[1]["error"] is None and len(stub.calls("POST", "/v1/events/evt_1/ack")) == 1


def test_anthropic_sample(stub: HttpRouter):
    stub.add("GET", "/v1/events/evt_1", httpx.Response(200, json={"event": {"id": "evt_1"}}))
    block = SimpleNamespace(type="tool_use", id="toolu_1", name="notify_get_event", input={"eventId": "evt_1"})
    # docs:start python-anthropic
    # docs:show import json
    # docs:show from typing import Any

    from ryu_sdk.services import Ryu
    from ryu_sdk.services.tools import to_anthropic_tools

    ryu = Ryu()
    tools = to_anthropic_tools(ryu, services=["notify"])

    # Pass `tools` to client.messages.create(); then run each tool_use block in the reply.
    def tool_result(block: Any) -> dict[str, str]:
        result = tools.execute(block.name, block.input)
        return {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(result)}

    # docs:end python-anthropic
    reply = tool_result(block)
    assert tools[1] == {
        "name": "notify_get_event",
        "description": tools.tool("notify_get_event").description,  # type: ignore[union-attr]
        "input_schema": tools.tool("notify_get_event").input_schema,  # type: ignore[union-attr]
    }
    assert json.loads(reply["content"])["data"] == {"id": "evt_1"}
