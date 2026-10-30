"""ryu_sdk.services.tools: each tool's output JSON Schema (the MCP ``outputSchema``).

The schemas come from the TypeScript registry through ``manifest.json``
(``test_services_tools_registry.py`` keeps it current). Every Python body runs
against the stubbed replies the TypeScript test
``packages/services/src/tools/output.test.ts`` uses
(``fixtures/services_tools_output_cases.json``, exported from
``packages/services/test/tool-output-cases.ts``: one case per tool plus result
variants); its success must conform to the tool's schema and answer the same
``data`` as the TypeScript body. Also: every spec carries a schema, the adapters
expose it, and the wait path Python implements on its own conforms.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

import httpx
import pytest
from helpers import Router as HttpRouter

from ryu_sdk.services import Ryu
from ryu_sdk.services.managed_agents import SessionsResource
from ryu_sdk.services.tools import (
    RYU_TOOLS,
    get_ryu_tool,
    run_ryu_tool,
    to_anthropic_tools,
    to_openai_tools,
    to_ryu_agent_tools,
    to_tool_result_json,
)
from ryu_sdk.services.tools._mail import _js_number
from ryu_sdk.services.tools._manifest import TOOL_SPECS

FIXTURES = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_CASES: dict[str, Any] = json.loads((FIXTURES / "services_tools_output_cases.json").read_text())
MA = "/api/v1/managed-agents"
NOW = "2026-10-21T12:00:00.000Z"
FUTURE = "2099-01-01T00:00:00.000Z"
_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "null": type(None),
}


def schema_errors(schema: Mapping[str, Any], value: Any, path: str = "$") -> list[str]:
    """The JSON Schema keywords zod emits for these schemas, checked against ``value``."""
    if "anyOf" in schema:
        if any(not schema_errors(option, value, path) for option in schema["anyOf"]):
            return []
        return [f"{path}: matches no anyOf option"]
    errors: list[str] = []
    kind = schema.get("type")
    if isinstance(kind, list):
        # zod 4.6+ emits a nullable as {"type": ["string", "null"]} instead of an
        # anyOf; the value matches when it matches any listed type.
        if any(not schema_errors({**schema, "type": option}, value, path) for option in kind):
            return []
        return [f"{path}: expected one of {kind}, got {type(value).__name__}"]
    if kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return [f"{path}: expected {kind}"]
    elif kind is not None and not isinstance(value, _TYPES[kind]):
        return [f"{path}: expected {kind}, got {type(value).__name__}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} is not one of {schema['enum']}")
    if isinstance(value, dict):
        properties: Mapping[str, Any] = schema.get("properties", {})
        errors.extend(f"{path}.{name}: missing" for name in schema.get("required", []) if name not in value)
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if name in properties:
                errors.extend(schema_errors(properties[name], item, f"{path}.{name}"))
            elif extra is False:
                errors.append(f"{path}.{name}: not allowed")
            elif isinstance(extra, dict):
                errors.extend(schema_errors(extra, item, f"{path}.{name}"))
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            errors.extend(schema_errors(schema["items"], item, f"{path}[{index}]"))
    return errors


def success_errors(name: str, result: Any) -> list[str]:
    """``to_tool_result_json`` of a success, checked as ``{data, meta}`` against ``name``'s schema."""
    projected = to_tool_result_json(result)
    assert projected["error"] is None, projected["error"]
    tool = get_ryu_tool(name)
    assert tool is not None
    return schema_errors(tool.output_schema, {"data": projected["data"], "meta": projected["meta"]})


def json_response(body: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=body, headers={"x-request-id": "req_out"})


def make_ryu(router: HttpRouter, env: dict[str, str]) -> Ryu:
    return Ryu(env=env, transport=router.transport(), max_retries=0)


# ── Every spec ───────────────────────────────────────────────────────────────


def test_every_tool_declares_a_data_and_meta_output_schema() -> None:
    assert [spec.name for spec in TOOL_SPECS] == [tool.name for tool in RYU_TOOLS]
    for tool in RYU_TOOLS:
        schema = tool.output_schema
        assert schema["type"] == "object", tool.name
        assert schema["required"] == ["data", "meta"], tool.name
        assert sorted(schema["properties"]) == ["data", "meta"], tool.name
        # A fresh copy each time, like input_schema.
        schema["properties"].clear()
        assert tool.output_schema["properties"], tool.name


def test_the_validator_refuses_what_the_schema_does_not_allow() -> None:
    tool = get_ryu_tool("box_read_file")
    assert tool is not None
    assert schema_errors(tool.output_schema, {"data": {"path": "a"}, "meta": {}})
    assert schema_errors(tool.output_schema, {"data": None, "meta": {}})
    good = {"data": {"path": "a", "content": "", "truncated": False, "totalChars": 0}, "meta": {}}
    assert schema_errors(tool.output_schema, good) == []


def test_the_adapters_expose_the_output_schema() -> None:
    ryu = Ryu(env={"RYU_BOX_API_KEY": "b"})
    agent_tools = to_ryu_agent_tools(ryu)
    expected = get_ryu_tool("box_get")
    assert expected is not None
    assert agent_tools["box_get"].output_schema == expected.output_schema
    openai = to_openai_tools(ryu)
    anthropic = to_anthropic_tools(ryu)
    assert openai.output_schema("box_get") == expected.output_schema
    assert anthropic.output_schema("box_list") == get_ryu_tool("box_list").output_schema  # type: ignore[union-attr]
    assert openai.output_schema("box_delete") is None  # not offered while read-only
    # The function-calling definitions carry no output schema: neither API takes one.
    assert all("output_schema" not in json.dumps(item) and "outputSchema" not in json.dumps(item) for item in openai)
    assert all(set(item) == {"name", "description", "input_schema"} for item in anthropic)


# ── Every body, against the TypeScript test's stubbed replies ────────────────


def _stub_reply(reply: Mapping[str, Any]) -> httpx.Response:
    headers = {"x-request-id": "req_out"}
    if reply.get("empty"):
        return httpx.Response(204, headers=headers)
    if "text" in reply:
        return httpx.Response(200, text=reply["text"], headers=headers)
    return httpx.Response(200, json=reply["json"], headers=headers)


def stubbed_ryu(routes: list[list[Any]]) -> Ryu:
    """A client whose requests the first route found in ``METHOD /path`` answers."""

    def handle(request: httpx.Request) -> httpx.Response:
        key = f"{request.method} {request.url.path}"
        for pattern, reply in routes:
            if re.search(pattern, key):
                return _stub_reply(reply)
        return httpx.Response(599, json={"error": f"no stub for {key}"})

    return Ryu(env=dict(OUTPUT_CASES["env"]), transport=httpx.MockTransport(handle), max_retries=0)


def _run_case(name: str, case: Mapping[str, Any]) -> None:
    result = run_ryu_tool(stubbed_ryu(case["routes"]), name, case["input"])
    projected = to_tool_result_json(result)
    assert projected["error"] is None, projected["error"]
    assert success_errors(name, result) == []
    # The same data as the TypeScript body, so the shared schema describes both ports.
    assert json.loads(json.dumps(projected["data"])) == case["expected"]


def test_there_is_a_case_for_every_tool_and_no_stale_one() -> None:
    assert sorted(OUTPUT_CASES["cases"]) == sorted(tool.name for tool in RYU_TOOLS)
    names = {tool.name for tool in RYU_TOOLS}
    assert all(variant["tool"] in names for variant in OUTPUT_CASES["variants"])


def test_committed_output_cases_match_the_typescript_ones() -> None:
    bun = shutil.which("bun")
    if bun is None or not (REPO_ROOT / "packages/services/test/tool-output-cases.ts").exists():
        pytest.skip("bun or the @ryuhq/services source is not available")
    completed = subprocess.run(
        [bun, str(FIXTURES / "services_tools.ts"), "output-cases"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    assert json.loads(completed.stdout) == OUTPUT_CASES, (
        "services_tools_output_cases.json is stale: run `bun bindings/python/tests/fixtures/services_tools.ts "
        "output-cases > bindings/python/tests/fixtures/services_tools_output_cases.json`"
    )


@pytest.mark.parametrize("name", sorted(OUTPUT_CASES["cases"]))
def test_every_body_conforms_and_answers_what_typescript_does(name: str) -> None:
    _run_case(name, OUTPUT_CASES["cases"][name])


@pytest.mark.parametrize(
    "variant", OUTPUT_CASES["variants"], ids=[f"{item['tool']}: {item['label']}" for item in OUTPUT_CASES["variants"]]
)
def test_every_variant_conforms_and_answers_what_typescript_does(variant: dict[str, Any]) -> None:
    _run_case(variant["tool"], variant)


def test_an_error_result_has_no_data_to_validate() -> None:
    result = run_ryu_tool(stubbed_ryu([]), "mail_get_message", {"messageId": "msg_1"})
    projected = to_tool_result_json(result)
    assert projected["data"] is None
    assert projected["error"] is not None


def test_a_mail_reply_with_a_wrong_text_type_is_an_invalid_response() -> None:
    message = {**OUTPUT_CASES["cases"]["mail_get_message"]["routes"][0][1]["json"], "subject": 5}
    result = run_ryu_tool(
        stubbed_ryu([["/api/mail/messages/msg_1$", {"json": message}]]), "mail_get_message", {"messageId": "msg_1"}
    )
    error = to_tool_result_json(result)["error"]
    assert error is not None
    assert error["code"] == "invalid_response"


@pytest.mark.parametrize(
    ("name", "arguments", "pattern", "reply"),
    [
        ("mail_status", {}, "/api/mail/status$", {"configured": True, "inboxCount": "n/a"}),
        (
            "mail_get_message",
            {"messageId": "msg_1"},
            "/api/mail/messages/msg_1$",
            {"id": "msg_1", "inbox_id": "inbox_1", "attachments": [{"id": "att_1", "size": [True]}]},
        ),
        # Past float range: ``JSON.parse`` reads Infinity, which ``z.number()`` refuses. The shared
        # TypeScript cases cannot carry this reply (a TS literal this large is already Infinity).
        ("mail_status", {}, "/api/mail/status$", {"configured": True, "inboxCount": 10**400}),
        (
            "mail_get_message",
            {"messageId": "msg_1"},
            "/api/mail/messages/msg_1$",
            {"id": "msg_1", "inbox_id": "inbox_1", "attachments": [{"id": "att_1", "size": -(10**400)}]},
        ),
    ],
)
def test_a_mail_count_or_size_that_is_not_a_number_is_an_invalid_response(
    name: str, arguments: dict[str, Any], pattern: str, reply: dict[str, Any]
) -> None:
    # TypeScript's ``Number()`` gives NaN here, which the client refuses rather than return as null.
    result = run_ryu_tool(stubbed_ryu([[pattern, {"json": reply}]]), name, arguments)
    projected = to_tool_result_json(result)
    assert projected["data"] is None
    assert projected["error"] is not None
    assert projected["error"]["code"] == "invalid_response"


def test_a_mail_number_just_past_dbl_max_rounds_like_json_parse() -> None:
    # ``JSON.parse`` rounds an int below DBL_MAX plus half an ulp down to DBL_MAX, which
    # ``z.number()`` takes; only the true overflow point reads as Infinity (NaN here).
    assert _js_number(int(sys.float_info.max) + 1) == int(sys.float_info.max) + 1
    assert _js_number(-(int(sys.float_info.max) + 1)) == -(int(sys.float_info.max) + 1)
    assert _js_number(2**1024) is None


@pytest.mark.parametrize("count", ["-0x10", "+0x10", "0x", "0x1_0", "0x1.8", "0b12", "0o8", "0x" + "f" * 300])
def test_a_prefixed_count_number_reads_as_nan_is_an_invalid_response(count: str) -> None:
    # ``Number()`` takes 0x/0b/0o integers unsigned, without ``_`` or a fraction, and below Infinity.
    result = run_ryu_tool(
        stubbed_ryu([["/api/mail/status$", {"json": {"inboxCount": count}}]]),
        "mail_status",
        {},
    )
    assert to_tool_result_json(result)["error"]["code"] == "invalid_response"


def test_a_mail_count_that_number_reads_is_kept() -> None:
    result = run_ryu_tool(
        stubbed_ryu([["/api/mail/status$", {"json": {"inboxCount": "3", "domain": "agents.example.com"}}]]),
        "mail_status",
        {},
    )
    data = to_tool_result_json(result)["data"]
    assert data["inboxCount"] == 3
    assert data["domain"] == "agents.example.com"
    assert success_errors("mail_status", result) == []


# ── Python bodies that build their own result ────────────────────────────────


def test_box_bodies_conform() -> None:
    router = HttpRouter()
    router.add("GET", "/v1/boxes/bx_1/files/content", httpx.Response(200, content=b"hello"))
    router.add("PUT", "/v1/boxes/bx_1/files/content", httpx.Response(204))
    router.add("POST", "/v1/boxes/bx_1/stop", json_response({"ok": True}))
    ryu = make_ryu(router, {"RYU_BOX_API_KEY": "b"})
    read = run_ryu_tool(ryu, "box_read_file", {"boxId": "bx_1", "path": "notes.txt", "maxChars": 3})
    assert success_errors("box_read_file", read) == []
    written = run_ryu_tool(ryu, "box_write_file", {"boxId": "bx_1", "path": "notes.txt", "content": "x"})
    assert success_errors("box_write_file", written) == []
    stopped = run_ryu_tool(ryu, "box_stop", {"boxId": "bx_1"})
    assert success_errors("box_stop", stopped) == []


def _event(answer: str) -> dict[str, Any]:
    return {
        "id": "evt_1",
        "type": "notification",
        "title": "Ship?",
        "body": "",
        "level": "info",
        "priority": 3,
        "source": "app",
        "topic": None,
        "recipient": None,
        "project": None,
        "url": None,
        "tags": [],
        "data": {},
        "actions": [],
        "attachment": None,
        "externalId": None,
        "fingerprint": None,
        "icon": None,
        "response": {
            "type": "approval",
            "status": answer,
            "prompt": "Ship?",
            "value": None,
            "expiresAt": FUTURE,
            "respondedAt": NOW,
            "callbackUrl": None,
        },
        "acknowledgedAt": None,
        "archivedAt": None,
        "occurredAt": NOW,
        "createdAt": NOW,
    }


def test_notify_request_approval_conforms_with_and_without_a_value() -> None:
    for value in (None, "ok"):
        event = _event("approved")
        event["response"]["value"] = value
        router = HttpRouter().add("POST", "/v1/events", json_response({"event": event}))
        result = run_ryu_tool(
            make_ryu(router, {"RYU_NOTIFY_API_KEY": "n"}), "notify_request_approval", {"title": "Ship?"}
        )
        assert success_errors("notify_request_approval", result) == []
        # Always set, null included, as in TypeScript.
        assert to_tool_result_json(result)["data"]["value"] == value


def _session() -> dict[str, Any]:
    return {
        "id": "msess_1",
        "agentId": "magt_1",
        "environmentId": "menv_1",
        "backend": "anthropic",
        "status": "idle",
        "stopReason": "requires_action",
        "pendingToolUseIds": ["mtool_1"],
        "title": None,
        "headSeq": 2,
        "usage": {},
        "lastError": None,
        "metadata": {},
        "createdAt": NOW,
        "updatedAt": NOW,
    }


def _envelope(seq: int) -> dict[str, Any]:
    return {"id": f"mevt_{seq}", "sessionId": "msess_1", "seq": seq, "createdAt": NOW}


def test_managed_agents_bodies_conform(monkeypatch: pytest.MonkeyPatch) -> None:
    log = [
        {
            **_envelope(1),
            "type": "agent.tool_use",
            "toolUseId": "mtool_1",
            "name": "bash",
            "input": {"cmd": "ls"},
            "inputTruncated": False,
            "source": "builtin",
            "server": None,
        },
        {
            **_envelope(2),
            "type": "agent.tool_approval_request",
            "toolUseId": "mtool_1",
            "name": "bash",
            "source": "builtin",
            "server": None,
            "expiresAt": FUTURE,
        },
    ]
    router = HttpRouter()
    router.add("GET", f"{MA}/sessions/msess_1", json_response(_session()))
    router.add(
        "GET",
        f"{MA}/sessions/msess_1/events",
        json_response({"data": log, "hasMore": False, "nextAfter": 2, "headSeq": 2}),
    )
    ryu = make_ryu(router, {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"})
    pending = run_ryu_tool(ryu, "managed_agents_list_pending_approvals", {"sessionId": "msess_1"})
    assert success_errors("managed_agents_list_pending_approvals", pending) == []
    paged = run_ryu_tool(ryu, "managed_agents_list_events", {"sessionId": "msess_1"})
    assert success_errors("managed_agents_list_events", paged) == []

    def follow(self: Any, session_id: str, **_: Any) -> Iterator[dict[str, Any]]:
        yield from log
        yield {
            **_envelope(3),
            "type": "session.status",
            "status": "idle",
            "stopReason": "requires_action",
            "pendingToolUseIds": ["mtool_1"],
            "detail": None,
            "inputSeq": None,
        }

    monkeypatch.setattr(SessionsResource, "follow", follow)
    waited = run_ryu_tool(ryu, "managed_agents_list_events", {"sessionId": "msess_1", "wait": True})
    assert to_tool_result_json(waited)["data"]["requiresAction"] is True
    assert success_errors("managed_agents_list_events", waited) == []
