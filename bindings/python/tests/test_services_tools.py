"""ryu_sdk.services.tools: selection, the adapters, and each tool body against a stub transport."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Iterator
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest
from helpers import CHAT, GATEWAY, completion, tool_call
from helpers import Router as HttpRouter

from ryu_sdk import Agent, Tool
from ryu_sdk.services import AsyncRyu, Ryu, RyuConfigurationError, RyuNotFoundError
from ryu_sdk.services.managed_agents import SessionsResource
from ryu_sdk.services.tools import (
    RYU_TOOLS,
    RyuFunctionTools,
    RyuServiceTool,
    arun_ryu_tool,
    default_needs_approval,
    default_notify_usage_window,
    get_ryu_tool,
    run_ryu_tool,
    select_ryu_tools,
    to_anthropic_tools,
    to_openai_tools,
    to_ryu_agent_tools,
    to_tool_result_json,
)
from ryu_sdk.services.tools._bodies import Collect, default_tool_box_name
from ryu_sdk.services.tools._run import _collect_async, _collect_sync
from ryu_sdk.services.tools._validate import _pattern

NOTIFY_ENV = {"RYU_NOTIFY_API_KEY": "n"}
BOX_ENV = {"RYU_BOX_API_KEY": "b"}
MAIL_ENV = {"RYU_MAIL_GATEWAY_KEY": "gw"}
MA_ENV = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}
PASSPORT_ENV = {"RYU_PASSPORT_URL": "https://passport.example.com", "RYU_PASSPORT_API_KEY": "admin"}
SITES_ENV = {"RYU_SITES_URL": "http://localhost:8090", "RYU_SITES_API_KEY": "s"}
MA = "/api/v1/managed-agents"


def json_response(body: Any, status: int = 200, **headers: str) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


def make_ryu(router: HttpRouter, env: dict[str, str], **options: Any) -> Ryu:
    ryu = Ryu(env=env, transport=router.transport(), max_retries=0, **options)
    clock = {"now": 1_000_000.0}

    def sleep(seconds: float) -> None:
        clock["now"] += seconds

    ryu._core.sleep = sleep  # type: ignore[assignment]
    ryu._core.wall_clock = lambda: clock["now"]
    return ryu


# ── Selection ────────────────────────────────────────────────────────────────


def test_default_selection_is_read_only_and_limited_to_configured_services():
    ryu = Ryu(env={**NOTIFY_ENV, **BOX_ENV})
    selected = select_ryu_tools(ryu)
    assert {tool.service for tool in selected} == {"notify", "box"}
    assert all(tool.annotations.read_only_hint for tool in selected)
    assert [tool.name for tool in selected] == [
        "notify_list_events",
        "notify_get_event",
        "notify_usage",
        "box_list",
        "box_get",
        "box_read_file",
    ]


def test_writes_need_read_only_false_and_filters_apply_in_registry_order():
    ryu = Ryu(env={**NOTIFY_ENV, **BOX_ENV})
    names = [
        tool.name for tool in select_ryu_tools(ryu, read_only=False, services=["notify"], exclude=["notify_usage"])
    ]
    assert names == [
        "notify_publish",
        "notify_request_approval",
        "notify_list_events",
        "notify_get_event",
        "notify_ack_event",
    ]
    included = select_ryu_tools(ryu, read_only=False, include=["box_delete", "notify_publish"])
    assert [tool.name for tool in included] == ["notify_publish", "box_delete"]


@pytest.mark.parametrize(
    ("options", "fragment"),
    [
        ({"include": ["box_delete"]}, "pass read_only=False"),
        ({"include": ["box_nuke"]}, "Unknown tool name in include: box_nuke"),
        ({"exclude": ["nope"]}, "Unknown tool name in exclude: nope"),
        ({"services": ["inbox"]}, "Unknown service in services: inbox"),
        ({"services": ["connect"]}, "Connect has no tools"),
        ({"services": ["mail"]}, "Not configured: mail"),
    ],
)
def test_a_wrong_option_is_a_configuration_error(options: dict[str, Any], fragment: str):
    with pytest.raises(RyuConfigurationError) as raised:
        select_ryu_tools(Ryu(env=NOTIFY_ENV), **options)
    assert fragment in raised.value.message


def test_an_unconfigured_listed_service_names_its_variables_not_a_node_cli():
    with pytest.raises(RyuConfigurationError) as raised:
        to_ryu_agent_tools(Ryu(env=NOTIFY_ENV), services=["mail", "notify"], read_only=False, exclude=["mail_send"])
    message = raised.value.message
    assert message.startswith("Not configured: mail.")
    assert "RYU_MAIL_GATEWAY_KEY" in message and "RYU_MAIL_URL" in message and "mail.api_key" in message
    assert "doctor" not in message and "Every service in services= must be configured" in message
    assert raised.value.details["missing"] == ["mail"]
    # Gateway resolves from its built-in URL alone, so its hint lists the variables that configure it.
    with pytest.raises(RyuConfigurationError) as gateway:
        select_ryu_tools(Ryu(env=NOTIFY_ENV), services=["gateway"])
    assert "RYU_GATEWAY_URL or RYU_GATEWAY_TOKEN" in gateway.value.message
    assert "gateway.api_key" in gateway.value.message


def test_services_accepts_python_names_and_object_mode_clients_are_refused():
    ryu = Ryu(env=MA_ENV)
    assert {tool.service for tool in select_ryu_tools(ryu, services=["managed_agents"])} == {"managedAgents"}
    with pytest.raises(RyuConfigurationError, match='result="object"'):
        to_openai_tools(Ryu(env=NOTIFY_ENV, result="object"))
    failed = run_ryu_tool(Ryu(env=NOTIFY_ENV, result="object"), "notify_list_events", {})
    assert failed.error is not None and failed.error.code == "configuration_error"


def test_default_needs_approval_covers_writes_and_open_world_reads():
    asks = {tool.name for tool in RYU_TOOLS if default_needs_approval(tool)}
    assert "passport_fetch" in asks  # read-only but open-world
    assert "notify_list_events" not in asks
    assert {tool.name for tool in RYU_TOOLS if not tool.annotations.read_only_hint} <= asks


# ── ryu_sdk Agent tools ──────────────────────────────────────────────────────


def test_agent_tools_are_ryu_sdk_tools_with_the_registry_schema():
    tools = to_ryu_agent_tools(Ryu(env=NOTIFY_ENV), read_only=False)
    publish = tools["notify_publish"]
    assert isinstance(publish, Tool) and isinstance(publish, RyuServiceTool)
    assert publish.needs_approval is True and tools["notify_get_event"].needs_approval is False
    assert publish.title == "Publish a Notify event"
    spec = get_ryu_tool("notify_publish")
    assert spec is not None
    assert publish.definition() == {
        "type": "function",
        "function": {"name": "notify_publish", "description": spec.description, "parameters": spec.input_schema},
    }
    assert to_ryu_agent_tools(Ryu(env=NOTIFY_ENV), needs_approval=True)["notify_usage"].needs_approval is True
    custom = to_ryu_agent_tools(Ryu(env=NOTIFY_ENV), needs_approval=lambda tool: tool.name == "notify_usage")
    assert custom["notify_usage"].needs_approval and not custom["notify_get_event"].needs_approval


def test_agent_tool_returns_data_and_meta_and_reports_bad_arguments_as_data():
    router = HttpRouter().add(
        "GET",
        "/v1/events",
        json_response({"events": [{"id": "evt_1"}], "nextCursor": None}, **{"x-request-id": "req_1"}),
    )
    tool = to_ryu_agent_tools(make_ryu(router, NOTIFY_ENV))["notify_list_events"]
    assert tool.invoke({"limit": 5, "level": "error"}) == {
        "data": {"events": [{"id": "evt_1"}], "nextCursor": None},
        "error": None,
        "meta": {"requestId": "req_1"},
    }
    assert router.requests[-1].url.params["limit"] == "5"
    sent = len(router.requests)
    rejected = tool.invoke({"limit": 500})
    assert rejected["data"] is None and rejected["error"]["code"] == "invalid_arguments"
    assert rejected["error"]["details"]["issues"] == [
        {"code": "too_big", "path": "limit", "message": "Too big: expected a number <= 100."}
    ]
    assert rejected["error"]["status"] == 0 and rejected["error"]["retryable"] is False
    assert len(router.requests) == sent


def test_a_service_error_becomes_compact_error_json():
    router = HttpRouter().add(
        "GET",
        "/v1/events/evt_9",
        json_response({"code": "not_found", "message": "No such event"}, 404, **{"x-request-id": "req_9"}),
    )
    result = run_ryu_tool(make_ryu(router, NOTIFY_ENV), "notify_get_event", {"eventId": "evt_9"})
    payload = to_tool_result_json(result)
    assert payload["data"] is None
    error = payload["error"]
    assert error is not None
    assert error["code"] == "not_found" and error["status"] == 404 and error["service"] == "notify"
    assert error["requestId"] == "req_9"
    assert set(error) <= {
        "code",
        "message",
        "service",
        "status",
        "retryable",
        "hint",
        "details",
        "requestId",
        "retryAfterSeconds",
    }
    assert payload["meta"] == {"requestId": "req_9"}


def test_agent_runs_a_service_tool_through_the_loop():
    services = HttpRouter().add(
        "GET", "/v1/events/evt_1", json_response({"event": {"id": "evt_1", "title": "Deployed"}})
    )
    gateway = HttpRouter().add(
        "POST",
        CHAT,
        completion(tool_calls=[tool_call("call_1", "notify_get_event", {"eventId": "evt_1"})]),
        completion("It says Deployed."),
    )
    agent = Agent(
        "ops",
        model="m",
        gateway_url=GATEWAY,
        gateway_token="t",
        transport=gateway.transport(),
        tools=to_ryu_agent_tools(make_ryu(services, NOTIFY_ENV)),
    )
    result = agent.generate("What did evt_1 say?")
    assert result.text == "It says Deployed."
    second = gateway.bodies("POST", CHAT)[1]
    tool_message = next(message for message in second["messages"] if message["role"] == "tool")
    assert json.loads(tool_message["content"]) == {
        "data": {"id": "evt_1", "title": "Deployed"},
        "error": None,
        "meta": {},
    }
    assert [tool["function"]["name"] for tool in second["tools"]] == [
        "notify_list_events",
        "notify_get_event",
        "notify_usage",
    ]


def test_agent_tools_on_async_ryu_need_the_async_loop():
    tool = to_ryu_agent_tools(AsyncRyu(env=NOTIFY_ENV))["notify_usage"]
    assert tool.is_async is True
    with pytest.raises(TypeError, match="AsyncRyu"):
        tool.invoke({})


# ── Function-calling adapters ────────────────────────────────────────────────


def test_openai_definitions_for_both_apis_and_anthropic_definitions():
    ryu = Ryu(env=NOTIFY_ENV)
    chat = to_openai_tools(ryu)
    assert isinstance(chat, RyuFunctionTools) and isinstance(chat, list)
    assert chat.names == ["notify_list_events", "notify_get_event", "notify_usage"]
    spec = get_ryu_tool("notify_usage")
    assert spec is not None
    assert chat[2] == {
        "type": "function",
        "function": {"name": "notify_usage", "description": spec.description, "parameters": spec.input_schema},
    }
    responses = to_openai_tools(ryu, api="responses")
    assert responses[2] == {
        "type": "function",
        "name": "notify_usage",
        "description": spec.description,
        "parameters": spec.input_schema,
    }
    anthropic = to_anthropic_tools(ryu)
    assert anthropic[2] == {"name": "notify_usage", "description": spec.description, "input_schema": spec.input_schema}
    json.dumps(chat)  # the list serializes as plain JSON
    with pytest.raises(ValueError, match="api must be"):
        to_openai_tools(ryu, api="assistants")  # type: ignore[arg-type]


def test_execute_takes_a_json_string_and_refuses_tools_outside_the_selection():
    router = HttpRouter().add(
        "POST", "/v1/events/evt_1/ack", json_response({"event": {"id": "evt_1", "acknowledged": True}})
    )
    ryu = make_ryu(router, NOTIFY_ENV)
    read_only = to_openai_tools(ryu)
    refused = read_only.execute("notify_ack_event", '{"eventId": "evt_1"}')
    assert refused["error"] is not None and refused["error"]["code"] == "unknown_tool"
    assert router.requests == []
    writes = to_anthropic_tools(ryu, read_only=False, include=["notify_ack_event"])
    assert writes.needs_approval("notify_ack_event") is True
    done = writes.execute("notify_ack_event", '{"eventId": "evt_1"}', approved=True)
    assert done == {"data": {"id": "evt_1", "acknowledged": True}, "error": None, "meta": {}}
    broken = writes.execute("notify_ack_event", "{not json", approved=True)
    assert broken["error"] is not None and broken["error"]["code"] == "invalid_arguments"
    assert broken["error"]["details"]["issues"][0]["code"] == "invalid_json"


def test_aexecute_runs_on_async_ryu_and_on_a_sync_ryu_in_a_thread():
    router = HttpRouter().add("GET", "/v1/events/evt_1", json_response({"event": {"id": "evt_1"}}))
    async_tools = to_openai_tools(AsyncRyu(env=NOTIFY_ENV, transport=router.transport()))
    sync_tools = to_openai_tools(make_ryu(router, NOTIFY_ENV))

    async def run() -> list[Any]:
        return [
            await async_tools.aexecute("notify_get_event", {"eventId": "evt_1"}),
            await sync_tools.aexecute("notify_get_event", {"eventId": "evt_1"}),
        ]

    first, second = asyncio.run(run())
    assert first == second == {"data": {"id": "evt_1"}, "error": None, "meta": {}}
    with pytest.raises(TypeError, match="aexecute"):
        async_tools.execute("notify_get_event", {"eventId": "evt_1"})


# ── Tool bodies ──────────────────────────────────────────────────────────────


def test_mail_send_passes_the_model_key_and_reports_it_in_meta():
    router = HttpRouter()
    router.add(
        "GET", "/api/mail/inboxes", json_response({"inboxes": [{"id": "ibx_1", "address": "agent@acme.example"}]})
    )
    router.add("POST", "/api/mail/inboxes/ibx_1/send", json_response({"message": {"id": "msg_1"}}))
    tools = to_openai_tools(make_ryu(router, MAIL_ENV), read_only=False)
    out = tools.execute(
        "mail_send",
        {
            "from": "agent@acme.example",
            "to": ["p@example.com"],
            "subject": "Hi",
            "text": "Hello",
            "idempotencyKey": "welcome-42",
        },
        approved=True,
    )
    assert out["error"] is None and out["meta"]["idempotencyKey"] == "welcome-42"
    sent = router.calls("POST", "/api/mail/inboxes/ibx_1/send")[0]
    assert sent.headers["idempotency-key"] == "welcome-42"
    assert "idempotencyKey" not in json.loads(sent.content)
    both = tools.execute(
        "mail_send", {"from": "ibx_1", "to": ["p@example.com"], "subject": "Hi", "idempotencyKey": "k"}, approved=True
    )
    assert (
        both["error"] is not None
        and both["error"]["details"]["issues"][0]["message"] == "Give exactly one of text or html."
    )


def test_mail_create_inbox_posts_the_inbox_and_returns_it_normalized():
    router = HttpRouter()
    router.add(
        "POST",
        "/api/mail/inboxes",
        json_response(
            {"id": "ibx_2", "address": "support@acme.example", "name": "Support", "clientId": "support-inbox"}, 201
        ),
    )
    ryu = make_ryu(router, MAIL_ENV)
    assert "mail_create_inbox" not in to_openai_tools(ryu).names
    tools = to_openai_tools(ryu, read_only=False)
    assert tools.needs_approval("mail_create_inbox") is True
    out = tools.execute(
        "mail_create_inbox", {"name": "Support", "clientId": "support-inbox", "localPart": "support"}, approved=True
    )
    assert out["error"] is None
    assert out["data"]["id"] == "ibx_2" and out["data"]["clientId"] == "support-inbox"
    assert out["data"]["agentId"] is None and out["data"]["metadata"] == {}
    posted = router.calls("POST", "/api/mail/inboxes")
    assert [json.loads(call.content) for call in posted] == [
        {"name": "Support", "clientId": "support-inbox", "localPart": "support"}
    ]
    for arguments in (
        {"name": "Support", "clientId": "  "},
        {"name": "Support", "clientId": " support-inbox"},
        {"name": "\u00a0", "clientId": "k"},
        {"name": "\ufeff", "clientId": "k"},
    ):
        refused = tools.execute("mail_create_inbox", arguments, approved=True)
        assert refused["error"] is not None and refused["error"]["code"] == "invalid_arguments"
    assert len(router.calls("POST", "/api/mail/inboxes")) == 1


@pytest.mark.parametrize(
    ("source", "value", "matches"),
    [
        ("\\S", "\u00a0", False),
        ("\\S", "\ufeff \u3000\u2028", False),
        ("\\S", "\u0085", True),
        ("\\S", "\x1c", True),
        ("\\s", "\u2003", True),
        ("^[\\s\\d]+$", "1\u00a02", True),
        ("^[\\s\\d]+$", "1x2", False),
        ("^a\\\\s$", "a\\s", True),
    ],
)
def test_patterns_use_javascript_whitespace(source: str, value: str, matches: bool):
    assert (_pattern(source).search(value) is not None) is matches


def test_a_negated_whitespace_escape_inside_a_class_is_refused():
    with pytest.raises(ValueError, match="character class"):
        _pattern("[\\S]")


def test_box_tools_name_new_boxes_cut_long_files_and_time_out_after_the_command():
    router = HttpRouter()
    router.add(
        "POST", "/v1/boxes", lambda request: json_response({"box": {"id": "bx_1", **json.loads(request.content)}})
    )
    router.add("GET", "/v1/boxes/bx_1/files/content", httpx.Response(200, content=b"abcdefghij"))
    timeouts: list[Any] = []

    def command(request: httpx.Request) -> httpx.Response:
        timeouts.append(request.extensions["timeout"]["read"])
        return json_response({"result": {"exitCode": 0, "stdout": "ok", "stderr": ""}})

    router.add("POST", "/v1/boxes/bx_1/commands", command)
    ryu = make_ryu(router, BOX_ENV)
    created = run_ryu_tool(ryu, "box_create", {"size": "small", "idempotencyKey": "box-key-1"})
    assert created.error is None and created.data["name"] == default_tool_box_name("box-key-1")
    assert created.meta is not None and created.meta.idempotency_key == "box-key-1"
    read = run_ryu_tool(ryu, "box_read_file", {"boxId": "bx_1", "path": "a.txt", "maxChars": 4})
    assert read.data == {"path": "a.txt", "content": "abcd", "truncated": True, "totalChars": 10}
    assert read.meta is not None and read.meta.status == 200
    executed = run_ryu_tool(ryu, "box_exec", {"boxId": "bx_1", "command": "ls", "timeoutSecs": 10})
    assert executed.data == {"exitCode": 0, "stdout": "ok", "stderr": ""}
    assert timeouts == [40]  # the command's own 10 s plus the 30 s margin
    assert json.loads(router.calls("POST", "/v1/boxes/bx_1/commands")[0].content) == {
        "command": "ls",
        "timeoutSecs": 10,
    }


def test_a_retried_box_create_with_one_key_and_no_name_sends_a_byte_identical_body():
    # Box hashes the create body under the Idempotency-Key, so a random default name would
    # turn a host's retry into 409 idempotency_conflict. Shared golden with behaviour.test.ts.
    router = HttpRouter()
    router.add("POST", "/v1/boxes", lambda request: json_response({"box": {"id": "bx_1"}}))
    ryu = make_ryu(router, BOX_ENV)
    for _ in range(2):
        result = run_ryu_tool(ryu, "box_create", {"size": "small", "idempotencyKey": "retry-safe-key-0001"})
        assert result.error is None
    first, second = router.calls("POST", "/v1/boxes")
    assert first.content == second.content
    assert json.loads(first.content) == {"size": "small", "name": "mcp-b4771560cb3e"}
    assert first.headers["idempotency-key"] == "retry-safe-key-0001"
    unkeyed = {default_tool_box_name(None), default_tool_box_name(None)}
    assert len(unkeyed) == 2 and all(re.fullmatch(r"mcp-[0-9a-f]{12}", name) for name in unkeyed)


def test_box_get_reads_one_box_and_box_resume_restarts_a_stopped_one():
    router = HttpRouter()
    router.add("GET", "/v1/boxes/bx_1", json_response({"box": {"id": "bx_1", "status": "stopped"}}))
    router.add("POST", "/v1/boxes/bx_1/resume", json_response({"box": {"id": "bx_1", "status": "ready"}}))
    ryu = make_ryu(router, BOX_ENV)
    got = run_ryu_tool(ryu, "box_get", {"boxId": "bx_1"})
    assert got.error is None and got.data == {"id": "bx_1", "status": "stopped"}
    resumed = run_ryu_tool(ryu, "box_resume", {"boxId": "bx_1"})
    assert resumed.error is None and resumed.data == {"id": "bx_1", "status": "ready"}
    assert len(router.calls("POST", "/v1/boxes/bx_1/resume")) == 1
    tools = {tool.name: tool for tool in select_ryu_tools(ryu, read_only=False)}
    assert tools["box_get"].annotations.read_only_hint
    resume = tools["box_resume"].annotations
    assert not resume.read_only_hint and not resume.destructive_hint and resume.idempotent_hint


def test_sites_list_all_merges_owned_and_shared_and_deploy_sends_the_revision():
    def projects(request: httpx.Request) -> httpx.Response:
        scope = request.url.params["scope"]
        return json_response([{"id": f"{scope}_1"}])

    router = HttpRouter().add("GET", "/api/sites/projects", projects)
    ryu = make_ryu(router, SITES_ENV)
    listed = run_ryu_tool(ryu, "sites_list", {})
    assert listed.data == [{"id": "owned_1"}, {"id": "shared_1"}]
    assert listed.meta is not None and listed.meta.request_id is None
    from ryu_sdk.services.tools import sites_deploy_body

    assert sites_deploy_body({"siteId": "s", "versionId": "v", "expectedRevision": 2}) == {
        "projectId": "s",
        "versionId": "v",
        "expectedRevision": 2,
    }
    assert sites_deploy_body({"siteId": "s", "html": "<!doctype html>", "message": "m", "expectedRevision": 2}) == {
        "projectId": "s",
        "html": "<!doctype html>",
        "message": "m",
        "expectedRevision": 2,
    }


def test_sites_create_posts_the_trimmed_name_and_the_description_as_the_brief():
    router = HttpRouter().add("POST", "/api/sites/projects", json_response({"id": "site_new", "revision": 0}, 201))
    ryu = make_ryu(router, SITES_ENV)
    created = run_ryu_tool(
        ryu,
        "sites_create",
        {"name": " Launch ", "slug": "launch-notes", "template": "website", "description": "Release notes"},
    )
    assert created.error is None and created.data == {"id": "site_new", "revision": 0}
    assert json.loads(router.calls("POST", "/api/sites/projects")[0].content) == {
        "name": "Launch",
        "slug": "launch-notes",
        "template": "website",
        "prompt": "Release notes",
    }
    blank = run_ryu_tool(ryu, "sites_create", {"name": "   ", "slug": "launch-notes"})
    assert blank.error is not None and blank.error.code == "invalid_arguments"
    assert len(router.calls("POST", "/api/sites/projects")) == 1


def test_sites_update_settings_keeps_other_settings_and_sends_the_revision():
    current = {"audience": "private", "viewers": [], "workspaceId": "ws_1", "extensions": {"mcp": False}}
    router = HttpRouter()
    router.add("GET", "/api/sites/projects/s_1", json_response({"id": "s_1", "revision": 7, "settings": current}))
    router.add("PUT", "/api/sites/projects/s_1/settings", json_response({"id": "s_1", "revision": 3}))
    ryu = make_ryu(router, SITES_ENV)
    updated = run_ryu_tool(
        ryu,
        "sites_update_settings",
        {"siteId": "s_1", "audience": "public", "workspaceId": None, "expectedRevision": 2},
    )
    assert updated.error is None and updated.data == {"id": "s_1", "revision": 3}
    assert json.loads(router.calls("PUT", "/api/sites/projects/s_1/settings")[0].content) == {
        "expectedRevision": 2,
        "settings": {**current, "audience": "public", "workspaceId": None},
    }
    nothing = run_ryu_tool(ryu, "sites_update_settings", {"siteId": "s_1", "expectedRevision": 2})
    assert nothing.error is not None and nothing.error.code == "invalid_arguments"
    assert len(router.calls("PUT", "/api/sites/projects/s_1/settings")) == 1
    tool = next(item for item in RYU_TOOLS if item.name == "sites_update_settings")
    assert tool.annotations.read_only_hint is False and tool.annotations.destructive_hint is False


def test_sites_tools_hint_at_the_id_when_a_slug_shaped_site_id_is_not_found() -> None:
    not_found = json_response({"error": {"code": "not_found", "message": "Site not found"}}, 404)
    router = HttpRouter()
    # Deploy reads the runtime status first; it only needs the Site URL fields here.
    status = {"apiVersion": "v1", "mode": "standalone", "visitorPort": 8022, "baseDomain": "localhost"}
    router.add("GET", "/api/sites/status", json_response(status))
    router.add("GET", "/api/sites/projects/launch-notes", not_found)
    router.add("POST", "/api/sites/projects/launch-notes/versions", not_found)
    router.add("PUT", "/api/sites/projects/launch-notes/settings", not_found)
    router.add("GET", "/api/sites/projects/site_1", not_found)
    router.add("GET", "/api/sites/projects/0b6f1c3e-9a7d-4c2b-8e1f-2d3c4b5a6f70", not_found)
    ryu = make_ryu(router, SITES_ENV)
    for name, extra in [
        ("sites_get", {}),
        ("sites_deploy", {"html": "<!doctype html><p>hi</p>", "expectedRevision": 1}),
        ("sites_update_settings", {"audience": "public", "expectedRevision": 1}),
    ]:
        result = run_ryu_tool(ryu, name, {"siteId": "launch-notes", **extra})
        assert result.error is not None and result.error.status == 404, name
        assert result.error.code == "not_found"
        assert isinstance(result.error, RyuNotFoundError)
        assert result.error.hint is not None
        assert result.error.hint.startswith("siteId takes the Site id from sites_list or sites_get, not its slug")
        projected = to_tool_result_json(result)["error"]
        assert projected is not None
        assert projected["message"] == "Site not found"
        assert '"launch-notes"' in projected["hint"]
    for site_id in ["site_1", "0b6f1c3e-9a7d-4c2b-8e1f-2d3c4b5a6f70"]:
        plain = run_ryu_tool(ryu, "sites_get", {"siteId": site_id})
        assert plain.error is not None and plain.error.status == 404 and plain.error.hint is None
    unrouted = make_ryu(HttpRouter(), SITES_ENV)
    wrong_url = run_ryu_tool(
        unrouted, "sites_deploy", {"siteId": "launch-notes", "html": "<!doctype html>", "expectedRevision": 1}
    )
    assert wrong_url.error is not None and "siteId takes" not in (wrong_url.error.hint or "")


def test_managed_agents_list_environments_is_a_read_only_page():
    router = HttpRouter().add("GET", f"{MA}/environments", json_response({"data": [], "nextCursor": None}))
    ryu = make_ryu(router, MA_ENV)
    listed = run_ryu_tool(ryu, "managed_agents_list_environments", {"limit": 5, "includeArchived": True})
    assert listed.error is None and listed.data == {"data": [], "nextCursor": None}
    params = router.calls("GET", f"{MA}/environments")[0].url.params
    assert params["limit"] == "5" and params["includeArchived"] == "true"
    tool = next(item for item in RYU_TOOLS if item.name == "managed_agents_list_environments")
    assert tool.annotations.read_only_hint is True


def _passport_connection(connection_id: str) -> dict[str, Any]:
    """Every field ``passportConnectionSchema`` requires (list replies are validated)."""
    return {
        "created_at": 1_760_000_000,
        "domain": "api.github.com",
        "flow_status": "DONE",
        "id": connection_id,
        "last_checked": 0,
        "profile_id": "work",
        "source": "manual",
        "status": "AUTHENTICATED",
        "updated_at": 1_760_000_000,
    }


def test_passport_tools_use_the_runtime_grant_when_one_is_set():
    router = HttpRouter()
    router.add("GET", "/v1/connections", json_response({"connections": [_passport_connection("conn_admin")]}))
    router.add("GET", "/v1/runtime/connections", json_response({"connections": [_passport_connection("conn_rt")]}))
    admin = run_ryu_tool(make_ryu(router, PASSPORT_ENV), "passport_list_connections", {})
    runtime = run_ryu_tool(
        make_ryu(router, {**PASSPORT_ENV, "RYU_PASSPORT_RUNTIME_KEY": "rt"}), "passport_list_connections", {}
    )
    assert admin.error is None and runtime.error is None
    assert [request.url.path for request in router.requests] == ["/v1/connections", "/v1/runtime/connections"]
    assert router.requests[1].headers["authorization"] == "Bearer rt"


def test_notify_request_approval_maps_the_answer_to_the_typescript_keys():
    def publish(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["response"]["type"] == "yes_no" and body["response"]["prompt"] == "Ship?"
        return json_response({"event": {"id": "evt_1", "response": {"status": "yes"}}})

    router = HttpRouter().add("POST", "/v1/events", publish)
    result = run_ryu_tool(
        make_ryu(router, NOTIFY_ENV),
        "notify_request_approval",
        {"title": "Ship", "prompt": "Ship?", "responseType": "yes_no", "idempotencyKey": "approval-1"},
    )
    assert result.error is None
    assert result.data["status"] == "yes" and result.data["approved"] is True and result.data["timedOut"] is False
    assert result.meta is not None and result.meta.idempotency_key == "approval-1"


def test_a_keyed_notify_request_approval_retry_conflict_says_to_poll_the_first_event():
    conflict = {"code": "idempotency_conflict", "message": "Idempotency-Key was used with a different request body."}
    router = HttpRouter().add("POST", "/v1/events", json_response({**conflict, "error": conflict}, 409))
    ryu = make_ryu(router, NOTIFY_ENV)
    keyed = run_ryu_tool(
        ryu, "notify_request_approval", {"title": "Ship build 184?", "idempotencyKey": "approval-for-build-184"}
    )
    assert router.requests[0].headers["idempotency-key"] == "approval-for-build-184"
    assert keyed.error is not None and keyed.error.code == "idempotency_conflict"
    # Shared golden with behaviour.test.ts.
    assert keyed.error.hint == (
        "An approval request was already published under this idempotencyKey, and a retry cannot replay it "
        "because each call sets a new deadline. Poll notify_get_event with the event.id from the first call "
        "(or find the event with notify_list_events) instead of calling notify_request_approval again; "
        "use a new key only to ask again."
    )
    assert to_tool_result_json(keyed)["error"]["hint"] == keyed.error.hint
    unkeyed = run_ryu_tool(ryu, "notify_request_approval", {"title": "Ship build 184?"})
    assert unkeyed.error is not None and unkeyed.error.code == "idempotency_conflict" and unkeyed.error.hint is None
    description = next(tool for tool in RYU_TOOLS if tool.name == "notify_request_approval").input_schema["properties"][
        "idempotencyKey"
    ]["description"]
    assert "the server answers from the first attempt" not in description and "notify_get_event" in description


def test_notify_usage_defaults_to_the_last_24_whole_hours():
    assert default_notify_usage_window(datetime(2026, 3, 1, 10, 15, tzinfo=timezone.utc)) == {
        "from": "2026-02-28T11:00:00.000Z",
        "to": "2026-03-01T11:00:00.000Z",
    }
    assert (
        default_notify_usage_window(datetime(2026, 3, 1, 10, 0, tzinfo=timezone.utc))["to"]
        == "2026-03-01T11:00:00.000Z"
    )
    router = HttpRouter().add("GET", "/v1/usage", json_response({"accepted": 3}))
    assert run_ryu_tool(make_ryu(router, NOTIFY_ENV), "notify_usage", {}).data == {"accepted": 3}
    params = router.requests[0].url.params
    assert params["from"].endswith(":00:00.000Z") and params["to"].endswith(":00:00.000Z")


def test_managed_agents_pending_approvals_join_the_tool_input_and_answers_are_sent():
    router = HttpRouter()
    router.add(
        "GET",
        f"{MA}/sessions/msess_1",
        json_response(
            {"id": "msess_1", "status": "idle", "stopReason": "requires_action", "pendingToolUseIds": ["mtool_1"]}
        ),
    )
    router.add(
        "GET",
        f"{MA}/sessions/msess_1/events",
        json_response(
            {
                "data": [
                    {
                        "seq": 1,
                        "type": "agent.tool_use",
                        "toolUseId": "mtool_1",
                        "name": "bash",
                        "input": {"cmd": "ls"},
                    },
                    {
                        "seq": 2,
                        "type": "agent.tool_approval_request",
                        "toolUseId": "mtool_1",
                        "name": "bash",
                        "source": "builtin",
                        "server": None,
                        "expiresAt": "2000-01-01T00:00:00Z",
                    },
                ],
                "hasMore": False,
                "nextAfter": 2,
            }
        ),
    )
    router.add(
        "POST",
        f"{MA}/sessions/msess_1/events",
        lambda request: json_response({"data": [{"seq": 3, **json.loads(request.content)["events"][0]}]}),
    )
    ryu = make_ryu(router, MA_ENV)
    pending = run_ryu_tool(ryu, "managed_agents_list_pending_approvals", {"sessionId": "msess_1"})
    assert pending.error is None
    assert pending.data["answerWith"] == "managed_agents_answer_approval" and pending.data["complete"] is True
    assert pending.data["data"] == [
        {
            "toolUseId": "mtool_1",
            "name": "bash",
            "source": "builtin",
            "server": None,
            "expiresAt": "2000-01-01T00:00:00Z",
            "requestSeq": 2,
            "input": {"cmd": "ls"},
            "inputTruncated": False,
        }
    ]
    page = router.calls("GET", f"{MA}/sessions/msess_1/events")[0].url
    assert "agent.tool_approval_request" in str(page) and page.params["limit"] == "500"
    answered = run_ryu_tool(
        ryu,
        "managed_agents_answer_approval",
        {"sessionId": "msess_1", "toolUseId": "mtool_1", "decision": "deny", "message": "No"},
    )
    assert answered.error is None and answered.data["decision"] == "deny" and answered.data["message"] == "No"


def test_managed_agents_list_events_pages_or_waits_and_flags_an_approval_stop(monkeypatch: pytest.MonkeyPatch):
    router = HttpRouter().add(
        "GET", f"{MA}/sessions/msess_1/events", json_response({"data": [], "hasMore": False, "nextAfter": 0})
    )
    ryu = make_ryu(router, MA_ENV)
    paged = run_ryu_tool(ryu, "managed_agents_list_events", {"sessionId": "msess_1"})
    assert paged.error is None and router.requests[0].url.params["limit"] == "50"

    followed: list[Any] = []

    def follow(self: Any, session_id: str, *, after: int = 0, **_: Any) -> Iterator[dict[str, Any]]:
        followed.append((session_id, after))
        yield {"seq": 4, "type": "agent.message"}
        yield {"seq": 5, "type": "session.status", "stopReason": "requires_action", "pendingToolUseIds": ["mtool_2"]}

    monkeypatch.setattr(SessionsResource, "follow", follow)
    waited = run_ryu_tool(ryu, "managed_agents_list_events", {"sessionId": "msess_1", "after": 3, "wait": True})
    assert followed == [("msess_1", 3)]
    assert waited.data == {
        "data": [
            {"seq": 4, "type": "agent.message"},
            {"seq": 5, "type": "session.status", "stopReason": "requires_action", "pendingToolUseIds": ["mtool_2"]},
        ],
        "turnEnded": True,
        "timedOut": False,
        "requiresAction": True,
        "pendingToolUseIds": ["mtool_2"],
        "next": "managed_agents_list_pending_approvals",
    }
    capped = run_ryu_tool(ryu, "managed_agents_list_events", {"sessionId": "msess_1", "wait": True, "maxEvents": 1})
    assert capped.data == {"data": [{"seq": 4, "type": "agent.message"}], "turnEnded": False, "timedOut": False}


def test_collect_is_bounded_by_time_on_both_clients():
    import threading

    release = threading.Event()

    def slow() -> Iterator[int]:
        yield 1
        release.wait(5)
        yield 2

    collected = _collect_sync(Collect(slow, max_events=10, timeout=0.05))
    release.set()
    assert collected.events == [1] and collected.timed_out and not collected.done

    def broken() -> Iterator[int]:
        raise RuntimeError("stream failed")
        yield 0  # pragma: no cover

    with pytest.raises(RuntimeError, match="stream failed"):
        _collect_sync(Collect(broken, max_events=1, timeout=1))

    async def slow_async() -> AsyncIterator[int]:
        yield 1
        await asyncio.sleep(5)
        yield 2  # pragma: no cover

    async def run() -> Any:
        return await _collect_async(Collect(slow_async, max_events=10, timeout=0.05))

    collected_async = asyncio.run(run())
    assert collected_async.events == [1] and collected_async.timed_out and not collected_async.done


def test_an_unexpected_exception_in_a_body_becomes_a_client_error():
    ryu = Ryu(env={"RYU_PASSPORT_URL": "https://passport.example.com"})
    result = run_ryu_tool(ryu, "passport_list_connections", {})
    assert result.error is not None and result.error.service == "passport"
    unknown = run_ryu_tool(ryu, "passport_teleport", {})
    assert unknown.error is not None and unknown.error.code == "unknown_tool"

    async def run() -> Any:
        return await arun_ryu_tool(AsyncRyu(env=NOTIFY_ENV, result="object"), "notify_usage", {})

    refused = asyncio.run(run())
    assert refused.error is not None and refused.error.code == "configuration_error"
