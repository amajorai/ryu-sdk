"""Gateway egress rule and endpoint resolution."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ryu_sdk import gateway

RUST_GATEWAY = Path(__file__).resolve().parents[3] / "crates/sdk/core/src/gateway.rs"


@pytest.mark.skipif(not RUST_GATEWAY.exists(), reason="the Rust kernel is not in this checkout")
def test_blocklist_matches_the_rust_kernel():
    source = RUST_GATEWAY.read_text()
    block = source[source.index("const BLOCKED_PROVIDER_PATTERNS") :]
    block = block[: block.index("];")]
    assert tuple(re.findall(r'r"([^"]+)"', block)) == gateway.BLOCKED_PROVIDER_PATTERNS
    assert f'"{gateway.DEFAULT_GATEWAY_URL}"' in source
    assert f'"{gateway.ENV_GATEWAY_URL}"' in source
    assert f'"{gateway.ENV_GATEWAY_TOKEN}"' in source


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com",
        "https://API.Anthropic.com/v1",
        "https://openrouter.ai/api",
    ],
)
def test_direct_providers_are_blocked(url):
    with pytest.raises(gateway.EgressNotAllowedError, match="direct provider egress is not allowed"):
        gateway.assert_allowed_egress(url)


def test_gateway_and_core_urls_allowed_and_resolved(monkeypatch):
    gateway.assert_allowed_egress("http://127.0.0.1:7981")
    monkeypatch.setenv("RYU_GATEWAY_URL", "  ")
    monkeypatch.delenv("RYU_GATEWAY_TOKEN", raising=False)
    assert gateway.resolve_gateway_url() == gateway.DEFAULT_GATEWAY_URL
    assert gateway.resolve_gateway_token() is None
    monkeypatch.setenv("RYU_GATEWAY_URL", "https://node.example/gw")
    monkeypatch.setenv("RYU_CORE_URL", "https://node.example")
    monkeypatch.delenv("RYU_CORE_TOKEN", raising=False)
    monkeypatch.setenv("RYU_TOKEN", "tok")
    assert gateway.resolve_gateway_url() == "https://node.example/gw"
    assert gateway.resolve_core_url() == "https://node.example"
    assert gateway.resolve_core_token() == "tok"


def test_core_token_reads_ryu_core_token_then_ryu_token(monkeypatch):
    assert gateway.ENV_CORE_TOKENS == ("RYU_CORE_TOKEN", "RYU_TOKEN")
    monkeypatch.setenv("RYU_CORE_TOKEN", "core")
    monkeypatch.setenv("RYU_TOKEN", "legacy")
    assert gateway.resolve_core_token() == "core"
    monkeypatch.setenv("RYU_CORE_TOKEN", "  ")
    assert gateway.resolve_core_token() == "legacy"
    monkeypatch.delenv("RYU_TOKEN")
    assert gateway.resolve_core_token() is None


def test_workflow_and_harness_clients_use_the_core_token_resolver(monkeypatch):
    from ryu_sdk.harness import HarnessClient
    from ryu_sdk.workflow import WorkflowClient

    monkeypatch.setenv("RYU_CORE_TOKEN", "core")
    monkeypatch.setenv("RYU_TOKEN", "legacy")
    assert WorkflowClient().headers["authorization"] == "Bearer core"
    assert HarnessClient().token == "core"


def test_pick_core_url_treats_trailing_slash_variants_as_the_same_url():
    assert gateway.pick_core_url("http://a/", "http://a") == "http://a"
    assert gateway.pick_core_url(" http://a// ", "http://a") == "http://a"


def test_pick_core_url_prefers_base_url_and_still_reads_node_url():
    assert gateway.pick_core_url("http://core:7980/", None) == "http://core:7980"
    assert gateway.pick_core_url(None, "http://old:7980//") == "http://old:7980"
    assert gateway.pick_core_url("http://core", "http://core") == "http://core"
    assert gateway.pick_core_url("  ", "http://old") == "http://old"
    assert gateway.pick_core_url(None, None) is None
    with pytest.raises(ValueError, match="base_url or node_url"):
        gateway.pick_core_url("http://a", "http://b")


def test_workflow_clients_take_base_url_and_the_deprecated_node_url(monkeypatch):
    from ryu_sdk.workflow import AsyncWorkflowClient, WorkflowClient

    monkeypatch.setenv("RYU_CORE_URL", "http://env:7980")
    assert WorkflowClient(base_url="http://10.0.0.1:7980/").base_url == "http://10.0.0.1:7980"
    assert WorkflowClient(node_url="http://10.0.0.2:7980").base_url == "http://10.0.0.2:7980"
    assert WorkflowClient("http://10.0.0.3:7980").base_url == "http://10.0.0.3:7980"
    assert AsyncWorkflowClient(node_url="http://10.0.0.4:7980").base_url == "http://10.0.0.4:7980"
    assert WorkflowClient().base_url == "http://env:7980"
    with pytest.raises(ValueError, match="base_url or node_url"):
        WorkflowClient(base_url="http://a", node_url="http://b")
    with pytest.raises(gateway.EgressNotAllowedError):
        WorkflowClient(base_url="https://api.openai.com/v1")


def test_stream_assembler_tolerates_a_null_tool_call_index():
    from ryu_sdk.model_call import StreamAssembler

    assembler = StreamAssembler()
    chunk = {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": None,
                            "id": "c1",
                            "function": {"name": "f", "arguments": "{}"},
                        }
                    ]
                }
            }
        ]
    }
    assembler.feed(f"data: {json.dumps(chunk)}\n\n")
    assert assembler.result().tool_calls == [
        {"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}
    ]
