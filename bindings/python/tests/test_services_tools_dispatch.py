"""ryu_sdk.services.tools: approval enforcement in the function-calling dispatcher, name filters,
tools that survive a rename, the request each remaining tool body sends, the TypeScript-shaped
results, and the bounded session-stream wait releasing its connection."""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from helpers import Router as HttpRouter

from ryu_sdk.services import AsyncRyu, Ryu
from ryu_sdk.services import tools as services_tools
from ryu_sdk.services.managed_agents import STREAM_READ_DEADLINE
from ryu_sdk.services.tools import (
    RyuServiceTool,
    credential_free_ryu_tools,
    get_ryu_tool,
    run_ryu_tool,
    select_ryu_tools,
    to_anthropic_tools,
    to_openai_tools,
    to_ryu_agent_tools,
)
from ryu_sdk.services.tools._bodies import utf16_length, utf16_slice
from ryu_sdk.services.tools._run import ryu_tool_passes_filter
from ryu_sdk.tools import normalize_tools

NOTIFY_ENV = {"RYU_NOTIFY_API_KEY": "n"}
BOX_ENV = {"RYU_BOX_API_KEY": "b"}
MA_ENV = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}
GATEWAY_ENV = {"RYU_GATEWAY_URL": "http://gateway.test", "RYU_GATEWAY_API_KEY": "g"}
PASSPORT_ENV = {"RYU_PASSPORT_URL": "https://passport.example.com", "RYU_PASSPORT_API_KEY": "admin"}
MA = "/api/v1/managed-agents"
MESSAGING = "/api/messaging/orgs/org_1"


def json_response(body: Any, status: int = 200, **headers: str) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


def make_ryu(router: HttpRouter, env: dict[str, str]) -> Ryu:
    return Ryu(env=env, transport=router.transport(), max_retries=0)


# ── Approval in execute / aexecute ────────────────────────────────────────────


def _passport_router() -> HttpRouter:
    return HttpRouter().add(
        "POST",
        "/v1/connections/conn_1/fetch",
        json_response({"authenticated": True, "content": "{}", "status": 200, "truncated": False}),
    )


def test_default_dispatcher_refuses_an_approval_required_tool_until_approved():
    router = _passport_router()
    tools = to_openai_tools(make_ryu(router, PASSPORT_ENV))
    assert "passport_fetch" in tools.names and tools.needs_approval("passport_fetch") is True
    arguments = {"connectionId": "conn_1", "url": "https://api.github.com/user"}
    refused = tools.execute("passport_fetch", arguments)
    assert refused["data"] is None and refused["error"] is not None
    assert refused["error"]["code"] == "approval_required" and refused["error"]["status"] == 0
    assert refused["error"]["retryable"] is False and refused["error"]["details"] == {"tool": "passport_fetch"}
    assert "approved=True" in refused["error"]["hint"]
    assert router.requests == []  # nothing reached the transport
    allowed = tools.execute("passport_fetch", arguments, approved=True)
    assert allowed["error"] is None
    assert [request.url.path for request in router.requests] == ["/v1/connections/conn_1/fetch"]


def test_a_read_tool_without_approval_runs_directly():
    router = HttpRouter().add("GET", "/v1/events/evt_1", json_response({"event": {"id": "evt_1"}}))
    tools = to_anthropic_tools(make_ryu(router, NOTIFY_ENV))
    assert tools.needs_approval("notify_get_event") is False
    assert tools.execute("notify_get_event", {"eventId": "evt_1"})["error"] is None


def test_the_approve_callback_decides_and_sees_the_parsed_arguments():
    router = _passport_router()
    seen: list[Any] = []

    def approve(tool: Any, arguments: Any) -> bool:
        seen.append((tool.name, arguments))
        return arguments.get("url", "").startswith("https://api.github.com/")

    tools = to_openai_tools(make_ryu(router, PASSPORT_ENV), approve=approve)
    denied = tools.execute("passport_fetch", '{"connectionId": "conn_1", "url": "https://evil.example/"}')
    assert denied["error"] is not None and denied["error"]["code"] == "approval_required"
    assert router.requests == []
    done = tools.execute("passport_fetch", {"connectionId": "conn_1", "url": "https://api.github.com/user"})
    assert done["error"] is None and len(router.requests) == 1
    assert seen == [
        ("passport_fetch", {"connectionId": "conn_1", "url": "https://evil.example/"}),
        ("passport_fetch", {"connectionId": "conn_1", "url": "https://api.github.com/user"}),
    ]


def test_needs_approval_false_turns_the_gate_off_and_truthy_non_true_answers_do_not_approve():
    router = _passport_router()
    ungated = to_openai_tools(make_ryu(router, PASSPORT_ENV), needs_approval=False)
    assert ungated.execute("passport_fetch", {"connectionId": "conn_1", "url": "https://x.example"})["error"] is None
    vague = to_openai_tools(make_ryu(router, PASSPORT_ENV), approve=lambda _tool, _args: "yes")  # type: ignore[arg-type,return-value]
    refused = vague.execute("passport_fetch", {"connectionId": "conn_1", "url": "https://x.example"})
    assert refused["error"] is not None and refused["error"]["code"] == "approval_required"


def test_a_name_that_is_not_offered_needs_no_approval_and_execute_refuses_it_as_unknown():
    asked: list[str] = []

    def approve(tool: Any, _arguments: Any) -> bool:
        asked.append(tool.name)
        return True

    # read_only=True (the default) leaves the write tool notify_publish out.
    tools = to_openai_tools(make_ryu(HttpRouter(), NOTIFY_ENV), services=["notify"], approve=approve)
    for name in ("notify_publish", "made_up"):
        assert name not in tools.names
        assert tools.needs_approval(name) is False
        refused = tools.execute(name, {}, approved=tools.needs_approval(name))
        assert refused["error"] is not None and refused["error"]["code"] == "unknown_tool"
    assert asked == []
    # An offered write tool still asks.
    writable = to_openai_tools(make_ryu(HttpRouter(), NOTIFY_ENV), services=["notify"], read_only=False)
    assert writable.needs_approval("notify_publish") is True


def test_aexecute_gates_too_and_awaits_an_async_approve_callback():
    router = _passport_router()
    arguments = {"connectionId": "conn_1", "url": "https://x.example"}

    async def approve(_tool: Any, _arguments: Any) -> bool:
        return True

    gated = to_openai_tools(AsyncRyu(env=PASSPORT_ENV, transport=router.transport(), max_retries=0))
    approving = to_openai_tools(
        AsyncRyu(env=PASSPORT_ENV, transport=router.transport(), max_retries=0), approve=approve
    )

    async def run() -> list[Any]:
        return [
            await gated.aexecute("passport_fetch", arguments),
            await gated.aexecute("passport_fetch", arguments, approved=True),
            await approving.aexecute("passport_fetch", arguments),
        ]

    refused, approved, by_callback = asyncio.run(run())
    assert refused["error"] is not None and refused["error"]["code"] == "approval_required"
    assert approved["error"] is None and by_callback["error"] is None
    assert len(router.requests) == 2
    sync_tools = to_openai_tools(make_ryu(router, PASSPORT_ENV), approve=approve)
    with pytest.raises(TypeError, match="aexecute"):
        sync_tools.execute("passport_fetch", arguments)


# ── Name filters ──────────────────────────────────────────────────────────────


def test_include_and_exclude_take_one_name_as_a_string():
    ryu = Ryu(env=NOTIFY_ENV)
    only = to_openai_tools(ryu, include="notify_get_event")
    assert only.names == ["notify_get_event"]
    without = to_openai_tools(ryu, exclude="notify_get_event")
    assert "notify_get_event" not in without.names and "notify_list_events" in without.names
    assert [tool.name for tool in select_ryu_tools(ryu, include="notify_usage")] == ["notify_usage"]
    tool = get_ryu_tool("notify_get_event")
    assert tool is not None
    # A string is one name, never a substring test.
    assert ryu_tool_passes_filter(tool, read_only=True, include="notify_get_event_x") is False
    assert ryu_tool_passes_filter(tool, read_only=True, exclude="notify_get_event_x") is True
    assert ryu_tool_passes_filter(tool, read_only=True, include="notify_get_event") is True


# ── A renamed tool keeps working ──────────────────────────────────────────────


def test_a_tool_renamed_by_normalize_tools_still_validates_as_data_on_sync_ryu():
    router = HttpRouter().add("GET", "/v1/events/evt_1", json_response({"event": {"id": "evt_1"}}))
    original = to_ryu_agent_tools(make_ryu(router, NOTIFY_ENV))["notify_get_event"]
    renamed = normalize_tools({"get_event": original})["get_event"]
    assert renamed.name == "get_event" and not isinstance(renamed, RyuServiceTool)
    assert renamed.is_async is False
    assert renamed.invoke({"eventId": "evt_1"}) == {"data": {"id": "evt_1"}, "error": None, "meta": {}}
    bad = renamed.invoke({})  # no ToolArgumentsError: the registry reports the issue as data
    assert bad["error"]["code"] == "invalid_arguments"
    assert asyncio.run(renamed.ainvoke({"eventId": "evt_1"}))["data"] == {"id": "evt_1"}


def test_a_tool_renamed_by_normalize_tools_still_runs_on_async_ryu():
    router = HttpRouter().add("GET", "/v1/events/evt_1", json_response({"event": {"id": "evt_1"}}))
    ryu = AsyncRyu(env=NOTIFY_ENV, transport=router.transport(), max_retries=0)
    original = to_ryu_agent_tools(ryu)["notify_get_event"]
    assert original.is_async is True
    renamed = normalize_tools({"get_event": original})["get_event"]
    assert renamed.is_async is True

    async def run() -> list[Any]:
        return [await renamed.ainvoke({"eventId": "evt_1"}), await renamed.ainvoke({"eventId": 3})]

    done, bad = asyncio.run(run())
    assert done == {"data": {"id": "evt_1"}, "error": None, "meta": {}}
    assert bad["error"]["code"] == "invalid_arguments"
    with pytest.raises(TypeError, match="AsyncRyu"):
        original.invoke({"eventId": "evt_1"})


def test_the_agent_tools_merge_with_other_tools_through_values():
    def mine() -> str:
        """My own tool."""
        return "ok"

    from ryu_sdk.tools import tool

    my_tool = tool(mine)
    service_tools = to_ryu_agent_tools(Ryu(env=NOTIFY_ENV))
    merged = normalize_tools([my_tool, *service_tools.values()])
    assert set(merged) == {"mine", *service_tools}
    assert set(normalize_tools({**service_tools, "mine": my_tool})) == set(merged)


# ── Request each body sends ───────────────────────────────────────────────────


def test_messaging_bodies_send_the_typescript_requests():
    message = {"id": "msg_1", "status": "queued"}
    router = HttpRouter()
    router.add("GET", f"{MESSAGING}/quote", json_response({"holdMicroUsd": 7000, "segments": 1}))
    router.add("POST", f"{MESSAGING}/sms", json_response({"message": message}))
    router.add("GET", f"{MESSAGING}/messages", json_response({"data": [message], "nextCursor": None}))
    router.add("GET", f"{MESSAGING}/messages/msg_1", json_response({"message": message}))
    router.add("GET", f"{MESSAGING}/numbers", json_response({"data": [{"id": "num_1"}]}))
    ryu = make_ryu(router, MA_ENV)

    quote = run_ryu_tool(ryu, "messaging_quote", {"to": "+6591234567", "body": "hi"})
    assert quote.error is None
    assert dict(router.requests[-1].url.params) == {"channel": "sms", "to": "+6591234567", "body": "hi"}

    sent = run_ryu_tool(
        ryu,
        "messaging_send_sms",
        {"from": "num_1", "to": "+6591234567", "body": "hi", "metadata": {"k": "v"}, "idempotencyKey": "sms-1"},
    )
    assert sent.error is None and sent.meta is not None and sent.meta.idempotency_key == "sms-1"
    request = router.calls("POST", f"{MESSAGING}/sms")[0]
    assert request.headers["idempotency-key"] == "sms-1"
    assert json.loads(request.content) == {"from": "num_1", "to": "+6591234567", "body": "hi", "metadata": {"k": "v"}}

    listed = run_ryu_tool(ryu, "messaging_list_messages", {"limit": 5, "direction": "outbound"})
    assert listed.error is None
    assert dict(router.requests[-1].url.params) == {"limit": "5", "direction": "outbound"}

    got = run_ryu_tool(ryu, "messaging_get_message", {"messageId": "msg_1"})
    assert got.error is None and router.requests[-1].url.path == f"{MESSAGING}/messages/msg_1"

    run_ryu_tool(ryu, "messaging_list_numbers", {})
    assert "status" not in router.requests[-1].url.params
    run_ryu_tool(ryu, "messaging_list_numbers", {"all": True})
    assert router.requests[-1].url.params["status"] == "all"
    run_ryu_tool(ryu, "messaging_list_numbers", {"includeReleased": True})
    assert router.requests[-1].url.params["status"] == "all"
    run_ryu_tool(ryu, "messaging_list_numbers", {"includeReleased": False})
    assert "status" not in router.requests[-1].url.params


_KEY_HEADERS = ("authorization", "x-api-key", "x-gateway-key", "x-ryu-organization")


def test_status_tools_run_without_credentials_and_send_none():
    router = HttpRouter()
    router.add(
        "GET",
        "/api/messaging/status",
        json_response({"apiVersion": "v1", "configured": True, "channels": {"sms": True}}),
    )
    router.add(
        "GET",
        "/api/mail/status",
        json_response({"apiVersion": "v1", "configured": True, "domainMode": "managed", "sendConfigured": True}),
    )
    # A ryu_ key without its organization configures neither Messaging nor Mail sends; the
    # status tools still run and send no key.
    for env in ({}, {"RYU_API_KEY": "ryu_never_sent"}):
        ryu = make_ryu(router, env)
        messaging = run_ryu_tool(ryu, "messaging_status", {})
        assert messaging.error is None and messaging.data["configured"] is True
        assert str(router.requests[-1].url) == "https://api.ryuhq.com/api/messaging/status"
        assert not any(header in router.requests[-1].headers for header in _KEY_HEADERS)
    anonymous = make_ryu(router, {})
    mail = run_ryu_tool(anonymous, "mail_status", {})
    assert mail.error is None and mail.data["sendConfigured"] is True
    assert str(router.requests[-1].url) == "https://api.ryuhq.com/api/mail/status"
    assert not any(header in router.requests[-1].headers for header in _KEY_HEADERS)
    assert get_ryu_tool("mail_status") is not None
    assert [tool.name for tool in select_ryu_tools(anonymous)] == []
    free = [tool.name for tool in select_ryu_tools(Ryu(env=MA_ENV)) if tool.spec.credential_free]
    assert free == ["messaging_status", "mail_status"]


def test_credential_free_ryu_tools_apply_only_to_unconfigured_services_whose_url_resolves():
    # Mirrors tools.test.ts "credentialFreeRyuTools applies only to unconfigured services whose
    # URL resolves".
    anonymous = Ryu(env={})
    assert [tool.name for tool in credential_free_ryu_tools(anonymous, "messaging")] == ["messaging_status"]
    assert [tool.name for tool in credential_free_ryu_tools(anonymous, "mail")] == ["mail_status"]
    assert credential_free_ryu_tools(anonymous, "notify") == []
    # Configured: every tool applies, so there is no fallback list.
    configured = Ryu(env=MA_ENV)
    assert credential_free_ryu_tools(configured, "messaging") == []
    assert credential_free_ryu_tools(configured, "mail") == []
    # Self-hosted Mail guards its status route.
    assert credential_free_ryu_tools(Ryu(env={"RYU_MAIL_URL": "http://127.0.0.1:7996"}), "mail") == []
    # A control-plane RYU_MAIL_URL is hosted Mail: its status stays credential-free.
    control_plane = Ryu(env={"RYU_MAIL_URL": "https://api.ryuhq.com"})
    assert [tool.name for tool in credential_free_ryu_tools(control_plane, "mail")] == ["mail_status"]
    # AsyncRyu answers the same probe.
    assert [tool.name for tool in credential_free_ryu_tools(AsyncRyu(env={}), "mail")] == ["mail_status"]
    # Credential-free tools are read-only by rule, and they are exactly the two status tools.
    free = [tool for tool in services_tools.RYU_TOOLS if tool.credential_free]
    assert [tool.name for tool in free] == ["messaging_status", "mail_status"]
    assert all(tool.annotations.read_only_hint for tool in free)


_REGISTRY_TS = Path(__file__).resolve().parents[3] / "packages/services/src/tools/index.ts"


def _snake(name: str) -> str:
    return name if name.isupper() else re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


@pytest.mark.skipif(not _REGISTRY_TS.exists(), reason="TypeScript sources are not in this checkout")
def test_registry_exports_match_the_typescript_registry():
    # Every value export of @ryuhq/services/tools' registry module has a snake_case twin here.
    source = _REGISTRY_TS.read_text(encoding="utf-8")
    block = re.search(r'export \{([^}]*)\} from "\./registry\.ts";', source)
    assert block is not None
    names = [part.strip() for part in block.group(1).split(",") if part.strip()]
    values = [name for name in names if not name.startswith("type ")]
    assert "credentialFreeRyuTools" in values
    missing = [_snake(name) for name in values if _snake(name) not in services_tools.__all__]
    assert missing == []


def test_gateway_chat_sends_one_non_streamed_completion():
    completion = {"id": "c", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}]}
    router = HttpRouter().add("POST", "/v1/chat/completions", json_response(completion))
    result = run_ryu_tool(
        make_ryu(router, GATEWAY_ENV),
        "gateway_chat",
        {"model": "openai/gpt-4o-mini", "prompt": "Say hi", "system": "Be brief", "maxTokens": 16, "temperature": 0},
    )
    assert result.error is None and result.data == completion
    assert json.loads(router.requests[0].content) == {
        "messages": [{"content": "Be brief", "role": "system"}, {"content": "Say hi", "role": "user"}],
        "model": "openai/gpt-4o-mini",
        "max_tokens": 16,
        "temperature": 0,
        "stream": False,
    }


def test_notify_publish_moves_the_key_to_the_header():
    router = HttpRouter().add("POST", "/v1/events", json_response({"event": {"id": "evt_1"}}))
    ryu = make_ryu(router, NOTIFY_ENV)
    result = run_ryu_tool(ryu, "notify_publish", {"title": "Deployed", "level": "success", "idempotencyKey": "pub-1"})
    assert result.error is None and result.meta is not None and result.meta.idempotency_key == "pub-1"
    assert router.requests[0].headers["idempotency-key"] == "pub-1"
    assert json.loads(router.requests[0].content) == {"title": "Deployed", "level": "success"}
    # Without a model key the SDK still sends one, so a retried request is not published twice.
    run_ryu_tool(ryu, "notify_publish", {"title": "Again"})
    assert router.requests[1].headers.get("idempotency-key")


def test_managed_agents_create_session_and_send_message_wrap_the_text_in_user_messages():
    router = HttpRouter()
    router.add("POST", f"{MA}/sessions", json_response({"id": "msess_1", "status": "idle"}, 201))
    router.add("POST", f"{MA}/sessions/msess_1/events", json_response({"data": [{"seq": 2, "type": "user.message"}]}))
    ryu = make_ryu(router, MA_ENV)
    created = run_ryu_tool(
        ryu,
        "managed_agents_create_session",
        {"agentId": "magt_1", "environmentId": "menv_1", "message": "Go", "idempotencyKey": "session-key-000001"},
    )
    assert created.error is None and created.meta is not None
    assert created.meta.idempotency_key == "session-key-000001"
    request = router.calls("POST", f"{MA}/sessions")[0]
    assert request.headers["idempotency-key"] == "session-key-000001"
    assert json.loads(request.content) == {
        "agentId": "magt_1",
        "environmentId": "menv_1",
        "initialEvents": [{"type": "user.message", "content": [{"type": "text", "text": "Go"}]}],
    }
    run_ryu_tool(ryu, "managed_agents_create_session", {"agentId": "magt_1", "environmentId": "menv_1"})
    assert "initialEvents" not in json.loads(router.calls("POST", f"{MA}/sessions")[1].content)

    sent = run_ryu_tool(
        ryu,
        "managed_agents_send_message",
        {"sessionId": "msess_1", "text": "More", "idempotencyKey": "message-key-000001"},
    )
    assert sent.error is None and sent.meta is not None and sent.meta.idempotency_key == "message-key-000001"
    request = router.calls("POST", f"{MA}/sessions/msess_1/events")[0]
    assert request.headers["idempotency-key"] == "message-key-000001"
    assert json.loads(request.content) == {
        "events": [{"type": "user.message", "content": [{"type": "text", "text": "More"}]}]
    }


def test_tool_meta_reports_the_idempotency_key_through_execute():
    router = HttpRouter().add("POST", "/v1/events", json_response({"event": {"id": "evt_1"}}))
    tools = to_openai_tools(make_ryu(router, NOTIFY_ENV), read_only=False, include=["notify_publish"])
    out = tools.execute("notify_publish", {"title": "t", "idempotencyKey": "pub-2"}, approved=True)
    assert out["error"] is None and out["meta"]["idempotencyKey"] == "pub-2"


# ── TypeScript-shaped results ─────────────────────────────────────────────────


def test_box_read_file_counts_and_cuts_utf16_units_like_javascript():
    assert utf16_length("a😀b") == 4 and utf16_slice("a😀b", 3) == "a😀" and utf16_slice("abc", 10) == "abc"
    assert utf16_slice("a😀b", 2) == "a\ud83d"  # JavaScript keeps the lone high surrogate
    router = HttpRouter().add("GET", "/v1/boxes/bx_1/files/content", httpx.Response(200, content="😀😀x".encode()))
    ryu = make_ryu(router, BOX_ENV)
    cut = run_ryu_tool(ryu, "box_read_file", {"boxId": "bx_1", "path": "e.txt", "maxChars": 4})
    assert cut.data == {"path": "e.txt", "content": "😀😀", "truncated": True, "totalChars": 5}
    whole = run_ryu_tool(ryu, "box_read_file", {"boxId": "bx_1", "path": "e.txt", "maxChars": 5})
    assert whole.data == {"path": "e.txt", "content": "😀😀x", "truncated": False, "totalChars": 5}


def test_notify_request_approval_sets_value_to_null_when_unset():
    responses = iter(
        [
            {"event": {"id": "evt_1", "response": {"status": "approved"}}},
            {"event": {"id": "evt_2", "response": {"status": "yes", "value": "Tuesday"}}},
        ]
    )
    router = HttpRouter().add("POST", "/v1/events", lambda _request: json_response(next(responses)))
    ryu = make_ryu(router, NOTIFY_ENV)
    approved = run_ryu_tool(ryu, "notify_request_approval", {"title": "Ship?"})
    # As in TypeScript, where NotifyApprovalResult.value is `string | null` and always set.
    assert approved.error is None and approved.data["value"] is None
    assert sorted(approved.data) == ["approved", "event", "status", "timedOut", "value"]
    replied = run_ryu_tool(ryu, "notify_request_approval", {"title": "Tuesday?", "responseType": "yes_no"})
    assert replied.error is None and replied.data["value"] == "Tuesday"


# ── The bounded wait releases its stream ──────────────────────────────────────


class _SilentStream(httpx.SyncByteStream):
    """An event stream that never sends an event: a read blocks until the request's read timeout
    (as a socket read would) or until the stream is closed."""

    def __init__(self, read_timeout: Any) -> None:
        self.read_timeout = read_timeout
        self.closed = threading.Event()

    def __iter__(self) -> Iterator[bytes]:
        if not self.closed.wait(self.read_timeout if self.read_timeout is not None else 10):
            raise httpx.ReadTimeout("no event before the read timeout")
        return iter(())

    def close(self) -> None:
        self.closed.set()


def test_a_timed_out_wait_ends_its_worker_and_closes_the_silent_stream():
    streams: list[_SilentStream] = []

    def stream(request: httpx.Request) -> httpx.Response:
        silent = _SilentStream(request.extensions["timeout"]["read"])
        streams.append(silent)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=silent)

    router = HttpRouter()
    router.add("GET", f"{MA}/sessions/msess_1/events", json_response({"data": [], "headSeq": 3}))
    router.add("GET", f"{MA}/sessions/msess_1/stream", stream)
    ryu = make_ryu(router, MA_ENV)
    started = time.monotonic()
    waited = run_ryu_tool(
        ryu, "managed_agents_list_events", {"sessionId": "msess_1", "after": 0, "wait": True, "timeoutMs": 300}
    )
    assert time.monotonic() - started < 2
    assert waited.error is None and waited.data == {"data": [], "turnEnded": False, "timedOut": True}
    assert len(streams) == 1 and 0 < streams[0].read_timeout <= 0.3
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and any(t.name == "ryu-tool-collect" for t in threading.enumerate()):
        time.sleep(0.02)
    assert not any(thread.name == "ryu-tool-collect" for thread in threading.enumerate())
    assert streams[0].closed.is_set()
    # The stream reconnected once the deadline passed? No: the worker stopped instead.
    assert len(router.calls("GET", f"{MA}/sessions/msess_1/stream")) == 1
    assert STREAM_READ_DEADLINE.get() is None  # the deadline never leaks into the caller's context


def test_without_a_deadline_the_stream_keeps_no_read_timeout():
    seen: list[Any] = []

    def stream(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions["timeout"]["read"])
        body = 'id: 4\nevent: message\ndata: {"seq": 4, "type": "session.status", "status": "completed"}\n\n'
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())

    router = HttpRouter()
    router.add("GET", f"{MA}/sessions/msess_1/events", json_response({"data": [], "headSeq": 3}))
    router.add("GET", f"{MA}/sessions/msess_1/stream", stream)
    events = list(make_ryu(router, MA_ENV).managed_agents.sessions.follow("msess_1"))
    assert [event["seq"] for event in events] == [4] and seen == [None]
