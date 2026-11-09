"""Workflow DSL compilation, the Core wire contract, and the run client."""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
from pathlib import Path
from typing import Dict, List, Set

import httpx
import pydantic
import pytest
from helpers import CORE, Router

from ryu_sdk.services import RyuInvalidRequestError
from ryu_sdk.workflow import (
    AsyncWorkflowClient,
    RetryPolicy,
    Workflow,
    WorkflowClient,
    WorkflowCompileError,
    WorkflowEvent,
    WorkflowResult,
    agent_step,
    core_text,
    human_step,
    mcp_step,
    negate_expr,
    prompt_step,
    schedule_trigger,
    script_step,
    set_state_step,
    tool_step,
    transform_step,
    when,
)


def edges(compiled) -> List[tuple]:
    return [(edge["from"], edge["to"], edge.get("branch")) for edge in compiled["edges"]]


def test_then_chain_compiles_to_input_steps_output():
    flow = Workflow("summarize", name="Summarize", description="d", triggers=[schedule_trigger(cron="0 9 * * *")], max_concurrency=2)
    flow.then(agent_step("draft", "writer", task="Draft: {{input}}", retry=RetryPolicy(max_attempts=3), timeout_ms=5000))
    flow.then(tool_step("save", "notes.create", {"body": "{{input}}"}))
    flow.then(agent_step("draft", "writer"))
    compiled = flow.commit().to_core()
    definition = compiled.workflow
    assert [node["id"] for node in definition["nodes"]] == ["input", "draft", "save", "draft__2", "output"]
    assert definition["nodes"][1] == {
        "id": "draft",
        "type": "agent",
        "agent_id": "writer",
        "task": "Draft: {{input}}",
        "retry": {"max_attempts": 3},
        "timeout_ms": 5000,
    }
    assert definition["nodes"][0] == {"id": "input", "type": "input", "key": "input"}
    assert definition["nodes"][-1] == {"id": "output", "type": "output", "key": "output"}
    assert edges(definition) == [
        ("input", "draft", None),
        ("draft", "save", None),
        ("save", "draft__2", None),
        ("draft__2", "output", None),
    ]
    assert definition["triggers"] == [{"type": "schedule", "require_approval": False, "cron": "0 9 * * *"}]
    assert definition["max_concurrency"] == 2
    assert definition["description"] == "d"
    assert compiled.children == []
    assert compiled.step_nodes == {"draft": "draft", "save": "save", "draft__2": "draft"}
    with pytest.raises(WorkflowCompileError, match="committed"):
        flow.then(agent_step("late", "x"))


def test_branch_compiles_to_an_if_elif_chain_that_restores_the_value():
    flow = Workflow("route").then(agent_step("triage", "t")).branch(
        [(when.contains("bug"), agent_step("bug", "b")), ('input == "feature"', agent_step("feature", "f"))],
        otherwise=agent_step("other", "o"),
    )
    definition = flow.to_core().workflow
    nodes = {node["id"]: node for node in definition["nodes"]}
    assert nodes["branch_2--if--1"] == {"id": "branch_2--if--1", "type": "condition", "expr": 'input contains "bug"'}
    assert nodes["branch_2--then--1"]["template"] == "{{nodes.triage}}"
    assert nodes["branch_2--else--2"]["template"] == "{{nodes.triage}}"
    assert nodes["branch_2"] == {"id": "branch_2", "type": "transform", "op": "identity"}
    assert edges(definition) == [
        ("input", "triage", None),
        ("triage", "branch_2--if--1", None),
        ("branch_2--if--1", "branch_2--then--1", "true"),
        ("branch_2--then--1", "branch_2--bug", None),
        ("branch_2--if--1", "branch_2--else--2", "false"),
        ("branch_2--else--2", "branch_2--if--2", None),
        ("branch_2--if--2", "branch_2--then--2", "true"),
        ("branch_2--then--2", "branch_2--feature", None),
        ("branch_2--if--2", "branch_2--otherwise", "false"),
        ("branch_2--otherwise", "branch_2--other", None),
        ("branch_2--bug", "branch_2", None),
        ("branch_2--feature", "branch_2", None),
        ("branch_2--other", "branch_2", None),
        ("branch_2", "output", None),
    ]
    passthrough = Workflow("pass").branch([(when.empty(), agent_step("fill", "f"))]).to_core().workflow
    assert ("pass" and ("branch_1--otherwise", "branch_1", None)) in edges(passthrough)


def test_parallel_foreach_and_loops_reference_child_workflows():
    nested = Workflow("research").then(agent_step("search", "s")).then(agent_step("read", "r"))
    flow = (
        Workflow("pipeline")
        .parallel([nested, prompt_step("tldr", "Summarize {{input}}")], max_concurrency=2)
        .foreach(mcp_step("fetch", "spider", "crawl", {"url": "{{input}}"}), items="{{state.urls}}", concurrency=4)
        .dountil(agent_step("refine", "editor"), when.gte(0.9), max_iterations=3)
        .dowhile(nested, when.non_empty(), max_iterations=1)
        .sleep(250)
        .map("Result: {{input}}")
    )
    compiled = flow.to_core()
    nodes = {node["id"]: node for node in compiled.workflow["nodes"]}
    assert nodes["parallel_1"] == {
        "id": "parallel_1",
        "type": "parallel",
        "branches": [
            {"id": "research", "workflow_id": "research"},
            {"id": "tldr", "workflow_id": "pipeline--parallel_1--tldr"},
        ],
        "max_concurrency": 2,
    }
    assert nodes["foreach_2"] == {
        "id": "foreach_2",
        "type": "for_each",
        "body_workflow_id": "pipeline--foreach_2--fetch",
        "items": "{{state.urls}}",
        "max_concurrency": 4,
    }
    assert nodes["dountil_3--first"] == {"id": "dountil_3--first", "type": "sub_workflow", "workflow_id": "pipeline--dountil_3--refine"}
    assert nodes["dountil_3"] == {
        "id": "dountil_3",
        "type": "while",
        "expr": "input < 0.9",
        "body_workflow_id": "pipeline--dountil_3--refine",
        "max_iterations": 2,
    }
    assert nodes["dowhile_4"] == {"id": "dowhile_4", "type": "sub_workflow", "workflow_id": "research"}
    assert nodes["sleep_5"] == {"id": "sleep_5", "type": "delay", "ms": 250}
    assert nodes["map_6"] == {"id": "map_6", "type": "transform", "op": "template", "template": "Result: {{input}}"}
    children = {child["id"]: child for child in compiled.children}
    assert list(children) == ["research", "pipeline--parallel_1--tldr", "pipeline--foreach_2--fetch", "pipeline--dountil_3--refine"]
    body = children["pipeline--foreach_2--fetch"]
    assert [node["id"] for node in body["nodes"]] == ["input", "fetch", "output"]
    assert body["nodes"][1] == {"id": "fetch", "type": "mcp", "server": "spider", "tool": "crawl", "args": {"url": "{{input}}"}}
    assert compiled.step_nodes["foreach_2"] == "fetch"


def test_compile_errors():
    with pytest.raises(WorkflowCompileError):
        Workflow("bad id")
    with pytest.raises(WorkflowCompileError):
        agent_step("bad/step", "a")
    with pytest.raises(WorkflowCompileError, match="unique"):
        Workflow("w").parallel([agent_step("a", "x"), agent_step("a", "y")])
    with pytest.raises(WorkflowCompileError, match="at most 101"):
        Workflow("w").dowhile(agent_step("a", "x"), when.lt(1), max_iterations=500)
    with pytest.raises(WorkflowCompileError, match="cannot negate"):
        Workflow("w").dountil(agent_step("a", "x"), when.contains("done"))
    with pytest.raises(WorkflowCompileError, match="longer than 64"):
        Workflow("w").parallel([agent_step("a" * 65, "x")])
    with pytest.raises(WorkflowCompileError, match="positive integer"):
        Workflow("w").foreach(agent_step("a", "x"), concurrency=0)
    with pytest.raises(WorkflowCompileError, match="positive integer"):
        Workflow("w", max_concurrency=-1)
    loop = Workflow("loop")
    loop.then(loop)
    with pytest.raises(WorkflowCompileError, match="nests itself"):
        loop.to_core()


def test_conditions_and_text():
    assert negate_expr("input empty") == "input nonempty"
    assert negate_expr('input == "x"') == 'input != "x"'
    assert negate_expr("input <= 3") == "input > 3"
    assert when.equals(True).expr == 'input == "true"'
    assert when.lte(2).expr == "input <= 2"
    assert core_text({"a": 1}) == '{"a":1}'
    assert core_text(None) == ""
    assert core_text("raw") == "raw"


# ── Core wire contract ────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[3]
CORE_WORKFLOW_RS = Path(os.environ.get("RYU_CORE_WORKFLOW_RS", REPO_ROOT / "apps/core/src/workflow/mod.rs"))


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _block(source: str, header: str) -> str:
    start = source.index(header)
    depth = 0
    for index in range(source.index("{", start), len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index]
    raise AssertionError(f"unterminated {header}")


def _fields(block: str, indent: int) -> Set[str]:
    pattern = re.compile(rf"^ {{{indent}}}(?:pub )?([a-z_][a-z0-9_]*):", re.MULTILINE)
    fields = set(pattern.findall(block))
    renamed = re.findall(r'#\[serde\(rename = "([a-z_]+)"', block)
    return fields | set(renamed)


def _node_kinds(source: str) -> Dict[str, Set[str]]:
    block = _block(source, "pub enum NodeKind")
    kinds: Dict[str, Set[str]] = {}
    for match in re.finditer(r"^    ([A-Z][A-Za-z]+)( \{|,)", block, re.MULTILINE):
        name = _snake(match.group(1))
        if match.group(2) == ",":
            kinds[name] = set()
        else:
            variant = _block(block, f"    {match.group(1)} {{")
            first_line = variant.split("\n", 1)[0]
            inline = set(re.findall(r"([a-z_][a-z0-9_]*):", first_line))
            kinds[name] = inline | _fields(variant, 8)
    return kinds


@pytest.mark.skipif(not CORE_WORKFLOW_RS.exists(), reason="Core sources are not in this checkout")
def test_compiled_nodes_match_cores_node_kinds():
    source = CORE_WORKFLOW_RS.read_text()
    kinds = _node_kinds(source)
    common = {"id", "type", "retry", "timeout_ms", "repeat"}
    assert {"retry", "timeout_ms", "repeat"} <= _fields(_block(source, "pub struct WorkflowNode"), 4)
    workflow_fields = _fields(_block(source, "pub struct Workflow {"), 4)
    edge_fields = _fields(_block(source, "pub struct WorkflowEdge"), 4)
    retry_fields = _fields(_block(source, "pub struct RetryPolicy"), 4)
    assert set(RetryPolicy(1, 1, 1.0, 1, 0.1, ["x"]).to_core()) <= retry_fields

    # ForEach/Parallel and the workflow-level `max_concurrency` arrived together.
    has_fanout = {"for_each", "parallel"} <= set(kinds) and "max_concurrency" in workflow_fields
    nested = Workflow("nested").then(agent_step("n", "x"))
    flow = (
        Workflow("contract", triggers=[schedule_trigger(every="1h")], max_concurrency=3 if has_fanout else None)
        .then(agent_step("a", "x", task="t", retry=RetryPolicy(max_attempts=2), timeout_ms=10))
        .then(prompt_step("p", "{{input}}", agent_id="x"))
        .then(tool_step("t", "s.t", {}))
        .then(mcp_step("m", "s", "t", {}))
        .then(script_step("s", "return args;", preset="research"))
        .then(human_step("h", "ok?"))
        .then(transform_step("x", "trim"))
        .then(set_state_step("st", "k", "{{input}}"))
        .then(nested)
        .branch([(when.non_empty(), agent_step("b", "x"))])
        .dowhile(agent_step("loop", "x"), when.lt(3))
        .sleep(1)
        .map("{{input}}")
    )
    parallel_flow = Workflow("fanout").parallel([agent_step("one", "x")], max_concurrency=2).foreach(agent_step("each", "x"), items="{{input}}", concurrency=2)
    compiled = [flow.to_core()] + ([parallel_flow.to_core()] if has_fanout else [])
    for result in compiled:
        for definition in [result.workflow, *result.children]:
            assert set(definition) <= workflow_fields | {"triggers"}
            for edge in definition["edges"]:
                assert set(edge) <= edge_fields
            for node in definition["nodes"]:
                assert node["type"] in kinds, f"Core has no node kind {node['type']!r}"
                extra = set(node) - common - kinds[node["type"]]
                assert not extra, f"{node['type']} fields {extra} are not in Core's NodeKind"
    if not has_fanout:
        pytest.skip("this Core checkout predates the ForEach/Parallel node kinds; only the other kinds were checked")
    branch_fields = _fields(_block(source, "pub struct ParallelBranch"), 4)
    for node in parallel_flow.to_core().workflow["nodes"]:
        for branch in node.get("branches", []):
            assert set(branch) <= branch_fields


# ── Run client ────────────────────────────────────────────────────────────────


def run_record(status: str, nodes: Dict[str, dict] = None, **fields) -> dict:
    return {"run": {"run_id": "run_1", "workflow_id": "flow", "status": status, "nodes": nodes or {}, **fields}}


class Report(pydantic.BaseModel):
    score: int


def flow() -> Workflow:
    return Workflow("flow", output_schema=Report).then(agent_step("score", "grader")).then(human_step("review", "OK?"))


def test_deploy_posts_children_first():
    router = Router().add("POST", "/workflows", httpx.Response(200, json={"ok": True}))
    nested = Workflow("child").then(agent_step("c", "x"))
    parent = Workflow("parent").then(nested)
    with WorkflowClient(CORE, token="tok", transport=router.transport()) as client:
        result = client.deploy(parent)
    assert result.workflow_id == "parent" and result.children == ["child"]
    assert [body["id"] for body in router.bodies("POST", "/workflows")] == ["child", "parent"]
    assert router.requests[0].headers["authorization"] == "Bearer tok"


def test_run_streams_progress_suspends_and_resumes():
    release = threading.Event()

    def blocking_run(request: httpx.Request) -> httpx.Response:
        release.wait(5)
        return httpx.Response(200, json=run_record(
            "awaiting_input",
            {"score": {"status": "completed", "output": '{"score": 9}'}, "review": {"status": "running"}},
            awaiting_node="review",
        ))

    polls = {"count": 0}

    def poll(request: httpx.Request) -> httpx.Response:
        polls["count"] += 1
        if polls["count"] >= 2:
            release.set()
        return httpx.Response(200, json=run_record("running", {"score": {"status": "running"}}))

    router = (
        Router()
        .add("POST", "/workflows/flow/run", blocking_run)
        .add("GET", "/workflows/runs/run_1", poll)
        .add("POST", "/workflows/runs/run_1/resume", httpx.Response(200, json=run_record(
            "completed",
            {"score": {"status": "completed", "output": '{"score": 9}'}, "review": {"status": "completed", "output": "yes"}},
            output={"output": '{"score": 9}'},
        )))
    )
    client = WorkflowClient(CORE, transport=router.transport(), poll_interval=0.01)
    items = list(client.stream(flow(), {"text": "essay"}, run_id="run_1"))
    kinds = [(item.type, item.step_id) for item in items if isinstance(item, WorkflowEvent)]
    assert kinds[0] == ("workflow-start", None)
    assert ("step-start", "score") in kinds
    assert ("step-result", "score") in kinds
    assert ("step-suspended", "review") in kinds
    assert kinds[-1] == ("workflow-finish", None)
    result = items[-1]
    assert isinstance(result, WorkflowResult) and result.status == "suspended" and result.suspended == ["review"]
    assert router.bodies("POST", "/workflows/flow/run") == [{"input": {"input": '{"text":"essay"}'}, "runId": "run_1"}]

    resumed = client.resume(flow(), "run_1", {"approved": True})
    assert resumed.status == "success"
    assert isinstance(resumed.result, Report) and resumed.result.score == 9
    assert router.bodies("POST", "/workflows/runs/run_1/resume") == [{"payload": '{"approved":true}'}]


def test_failures_waiting_runs_and_output_validation():
    router = (
        Router()
        .add("POST", "/workflows/flow/run", httpx.Response(200, json=run_record("waiting")))
        .add("GET", "/workflows/runs/run_1", httpx.Response(200, json=run_record(
            "completed", output={"output": '{"score": "high"}'}
        )))
    )
    result = WorkflowClient(CORE, transport=router.transport(), poll_interval=0.01).start(flow(), "x", run_id="run_1")
    assert result.status == "failed"
    assert "workflow output is invalid" in result.error

    failing = Router().add("POST", "/workflows/flow/run", httpx.Response(500, json={"error": "node exploded"}))
    failed = WorkflowClient(CORE, transport=failing.transport()).start("flow", "x", run_id="run_2")
    assert failed.status == "failed" and "node exploded" in failed.error

    with pytest.raises(ValueError):
        WorkflowClient(CORE, transport=failing.transport()).start("flow", run_id="bad id")


def test_async_client_runs_and_decodes_plain_text():
    router = (
        Router()
        .add("POST", "/workflows", httpx.Response(200, json={}))
        .add("POST", "/workflows/plain/run", httpx.Response(200, json=run_record("completed", output={"output": "hello"})))
    )
    plain = Workflow("plain").then(agent_step("say", "x"))

    async def go():
        async with AsyncWorkflowClient(CORE, transport=router.transport(), poll_interval=0.01) as client:
            await client.deploy(plain)
            return await client.start(plain, "hi")

    result = asyncio.run(go())
    assert result.status == "success" and result.result == "hello"
    body = router.bodies("POST", "/workflows/plain/run")[0]
    assert body["input"] == {"input": "hi"} and body["runId"].startswith("run_")
    assert json.loads(router.calls("POST", "/workflows")[0].content)["id"] == "plain"


@pytest.mark.parametrize("bad", ["", ".", ".."])
def test_dot_and_empty_workflow_ids_raise_invalid_id_and_send_nothing(bad: str):
    router = Router()
    with WorkflowClient(CORE, token="tok", transport=router.transport()) as client:
        for call in (lambda: client.get_workflow(bad), lambda: client.delete_workflow(bad), lambda: client.start(bad)):
            with pytest.raises(RyuInvalidRequestError) as raised:
                call()
            assert raised.value.code == "invalid_id"
    assert router.requests == []


@pytest.mark.parametrize("bad", ["abc\n", "run_1\n", "\nabc"])
def test_run_and_core_ids_reject_a_trailing_newline_as_typescript_does(bad: str):
    # ``$`` matches before a trailing newline; ``fullmatch`` does not.
    router = Router()
    with WorkflowClient(CORE, token="tok", transport=router.transport()) as client:
        with pytest.raises(ValueError, match="must be 1-64 characters"):
            client.get_run(bad)
        with pytest.raises(ValueError, match="must be 1-64 characters"):
            client.resume("flow", bad)
    assert router.requests == []
    with pytest.raises(WorkflowCompileError, match="not a valid Core id"):
        Workflow(bad).then(agent_step("a", "x")).compile()
