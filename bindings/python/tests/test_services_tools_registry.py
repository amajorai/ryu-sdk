"""ryu_sdk.services.tools against the TypeScript registry it ports.

``ryu_sdk/services/tools/manifest.json`` (names, titles, descriptions,
annotations, default approval, input JSON Schemas) and
``tests/fixtures/services_tools_vectors.json`` (arguments run through each
tool's zod schema) are exported from ``packages/services/src/tools`` by
``tests/fixtures/services_tools.ts``. When bun is installed both are
regenerated here and must match the committed files.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from ryu_sdk.services.client import NAMESPACES
from ryu_sdk.services.tools import (
    CONSTANTS,
    RYU_TOOL_PREFIXES,
    RYU_TOOL_SERVICES,
    RYU_TOOLS,
    get_ryu_tool,
    parse_arguments,
)
from ryu_sdk.services.tools._bodies import BODIES
from ryu_sdk.services.tools._validate import REFINED_TOOLS

FIXTURES = Path(__file__).parent / "fixtures"
PACKAGE = Path(__file__).resolve().parents[1] / "ryu_sdk" / "services" / "tools"
REPO_ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((FIXTURES / "services_tools_vectors.json").read_text())


def _regenerate(mode: str) -> Any:
    bun = shutil.which("bun")
    if bun is None or not (REPO_ROOT / "packages/services/src/tools/registry.ts").exists():
        pytest.skip("bun or the @ryuhq/services source is not available")
    completed = subprocess.run(
        [bun, str(FIXTURES / "services_tools.ts"), mode],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    return json.loads(completed.stdout)


def test_committed_manifest_matches_the_typescript_registry():
    committed = json.loads((PACKAGE / "manifest.json").read_text())
    assert committed == _regenerate("manifest"), (
        "manifest.json is stale: run `bun bindings/python/tests/fixtures/services_tools.ts manifest "
        "> bindings/python/ryu_sdk/services/tools/manifest.json`"
    )


def test_committed_vectors_match_the_typescript_schemas():
    assert VECTORS == _regenerate("vectors"), (
        "services_tools_vectors.json is stale: run `bun bindings/python/tests/fixtures/services_tools.ts vectors "
        "> bindings/python/tests/fixtures/services_tools_vectors.json`"
    )


def test_every_registry_tool_has_exactly_one_python_body():
    assert sorted(BODIES) == sorted(tool.name for tool in RYU_TOOLS)
    assert len({tool.name for tool in RYU_TOOLS}) == len(RYU_TOOLS)


def test_names_prefixes_and_services_line_up():
    service_ids = {service for service, _cls in NAMESPACES.values()}
    assert set(RYU_TOOL_PREFIXES) == service_ids
    assert "connect" not in RYU_TOOL_SERVICES
    for tool in RYU_TOOLS:
        assert tool.service in RYU_TOOL_SERVICES
        assert tool.name.startswith(RYU_TOOL_PREFIXES[tool.service])
        assert tool.input_schema["type"] == "object"
        annotations = tool.annotations
        if annotations.read_only_hint:
            assert not annotations.destructive_hint


def test_sends_charges_and_destroys_are_never_read_only():
    writes = {
        "mail_send",
        "messaging_send_sms",
        "notify_publish",
        "notify_request_approval",
        "box_create",
        "box_exec",
        "box_write_file",
        "box_stop",
        "box_resume",
        "box_delete",
        "gateway_chat",
        "sites_create",
        "sites_deploy",
        "managed_agents_create_session",
        "managed_agents_send_message",
        "managed_agents_answer_approval",
    }
    for name in writes:
        tool = get_ryu_tool(name)
        assert tool is not None and tool.annotations.read_only_hint is False, name
    for name in ("box_delete", "box_stop", "box_exec", "sites_deploy"):
        tool = get_ryu_tool(name)
        assert tool is not None and tool.annotations.destructive_hint, name


def test_constants_the_bodies_read_are_exported():
    for name in (
        "DEFAULT_BOX_READ_CHARS",
        "DEFAULT_EVENTS_PAGE",
        "DEFAULT_MAX_EVENTS",
        "MESSAGING_METADATA_MAX_ENTRIES",
    ):
        assert isinstance(CONSTANTS[name], int)


def test_the_ported_refinements_cover_every_tool_whose_vectors_need_one():
    custom = {
        case["tool"] for case in VECTORS["cases"] if any(issue["code"] == "custom" for issue in case.get("issues", []))
    }
    assert custom <= REFINED_TOOLS


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: f"{case['tool']}-{json.dumps(case['input'])[:40]}")
def test_python_arguments_validate_like_zod(case: dict[str, Any]):
    tool = get_ryu_tool(case["tool"])
    assert tool is not None
    value, issues = parse_arguments(tool.name, tool.spec.input_schema, case["input"])
    if case["ok"]:
        assert issues == [] and value == case["value"]
    else:
        assert value is None
        assert [{"code": issue["code"], "path": issue["path"]} for issue in issues] == case["issues"]
        assert all(issue["message"] for issue in issues)


def test_validation_details_beyond_the_vectors():
    tool = get_ryu_tool("messaging_quote")
    assert tool is not None
    # JavaScript's `$` does not match before a trailing newline, and `\d` is ASCII-only.
    assert parse_arguments(tool.name, tool.spec.input_schema, {"to": "+6591234567\n", "body": "x"})[0] is None
    assert parse_arguments(tool.name, tool.spec.input_schema, {"to": "+65١٢٣", "body": "x"})[0] is None
    # Lengths count UTF-16 code units: one emoji is two.
    send = get_ryu_tool("messaging_send_sms")
    assert send is not None
    body = "\U0001f600" * 801
    value, issues = parse_arguments(
        send.name, send.spec.input_schema, {"from": "n", "to": "+6591234567", "body": body, "idempotencyKey": "k"}
    )
    assert value is None and issues[0]["code"] == "too_big"
    # A whole-number float reads as an integer; null is not "absent".
    events = get_ryu_tool("notify_list_events")
    assert events is not None
    assert parse_arguments(events.name, events.spec.input_schema, {"limit": 5.0}) == ({"limit": 5}, [])
    assert parse_arguments(events.name, events.spec.input_schema, {"limit": None})[1][0]["code"] == "invalid_type"
    assert parse_arguments(events.name, events.spec.input_schema, None) == ({}, [])
    assert parse_arguments(events.name, events.spec.input_schema, [])[1][0]["code"] == "invalid_type"
