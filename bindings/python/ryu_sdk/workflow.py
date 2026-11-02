"""Workflow DSL that compiles to Core's JSON workflow graph, plus a run client.

Python counterpart of ``packages/sdk/src/workflow/`` for Core-executed
workflows. A :class:`Workflow` is a chain of stages built with
``.then()`` / ``.parallel()`` / ``.branch()`` / ``.foreach()`` /
``.dowhile()`` / ``.dountil()`` / ``.sleep()`` / ``.map()``. :meth:`Workflow.to_core`
compiles it to the definition Core stores at ``POST /workflows``
(``apps/core/src/workflow/mod.rs``: nodes are ``{id, type, ...kind fields,
retry?, timeout_ms?, repeat?}``), plus every child workflow it references.

Steps are Core node kinds, so every step runs on Core: an :func:`agent_step`,
a :func:`tool_step` / :func:`mcp_step`, a JavaScript :func:`script_step`, a
:func:`prompt_step`, a :func:`human_step` gate, and so on. Python callables do
not run inside a Core workflow; call Python from an agent tool instead.

Compilation:

=====================  =====================================================
DSL                    Core graph
=====================  =====================================================
input / output         ``input`` node (key ``input``) ... ``output`` node
``.then(step)``        the step's node (id = step id; repeats get ``__2``)
``.then(workflow)``    ``sub_workflow`` node + the nested definition
``.parallel([...])``   one ``parallel`` node; each branch runs a child workflow
                       and the output is ``{branch_id: result}``
``.foreach(step)``     one ``for_each`` node over a JSON array, results in order
``.branch([...])``     an if/elif chain of ``condition`` nodes; each arm restores
                       the branch input with a ``transform`` before its step,
                       and an identity ``transform`` joins the arms
``.dowhile/.dountil``  ``sub_workflow`` (first pass) then a ``while`` loop over
                       the body workflow
``.sleep(ms)``         ``delay`` node (a durable timer)
``.map(template)``     ``transform`` node with ``op: template``
=====================  =====================================================

:class:`WorkflowClient` / :class:`AsyncWorkflowClient` deploy compiled
workflows, start runs (``POST /workflows/:id/run``), poll run state into
step events while a run is in flight, and resume human gates
(``POST /workflows/runs/:id/resume``).
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Dict, Iterator, List, Mapping, Optional, Sequence, Set, Tuple, Union

import httpx

from ._transport import RequestSpec, bearer_headers, execute_async, execute_sync
from .gateway import assert_allowed_egress, pick_core_url, resolve_core_token, resolve_core_url
from .schema import OutputContract, format_schema_issues, to_jsonable, to_output_contract
from .services._base import segment

#: The run-input key the compiled ``input`` node reads.
CORE_INPUT_KEY = "input"
#: The run-output key the compiled ``output`` node writes.
CORE_OUTPUT_KEY = "output"
#: Default bound on ``.dowhile`` / ``.dountil`` passes.
DEFAULT_LOOP_ITERATIONS = 100
#: One first pass plus Core's ``while`` cap of 100 iterations.
MAX_CORE_LOOP_ITERATIONS = 101
#: Core's ceiling on ``parallel`` branches (and ``for_each`` items) per node.
MAX_FANOUT_ITEMS = 1000
#: Core's limit on a ``parallel`` branch id (it names the branch's child run).
MAX_BRANCH_ID_CHARS = 64

# Apply with ``fullmatch``: ``$`` would also accept a trailing newline.
_CORE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_INPUT_NODE = "input"
_OUTPUT_NODE = "output"


class WorkflowCompileError(ValueError):
    """The workflow cannot be expressed as a Core graph."""


def _assert_core_id(value: str, what: str) -> None:
    if not _CORE_ID.fullmatch(value):
        raise WorkflowCompileError(f'{what} "{value}" is not a valid Core id (use 1-128 of [A-Za-z0-9_-])')


def core_text(value: Any) -> str:
    """The text Core carries for a value: strings verbatim, ``None`` empty, else JSON."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(to_jsonable(value), separators=(",", ":"))


def decode_core_value(text: Optional[str]) -> Any:
    """Decode Core node/run text: JSON when it parses, the raw text otherwise."""
    raw = text or ""
    try:
        return json.loads(raw)
    except ValueError:
        return raw


# ── Conditions ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Condition:
    """A condition in Core's expression grammar (``input == "yes"``, ``input < 3``)."""

    expr: str

    def negate(self) -> "Condition":
        return Condition(negate_expr(self.expr))


_NEGATIONS = (
    ("input ==", "input !="),
    ("input !=", "input =="),
    ("input <=", "input >"),
    ("input >=", "input <"),
    ("input <", "input >="),
    ("input >", "input <="),
)


def negate_expr(expression: str) -> str:
    """The logical negation of a Core expression (used to compile ``.dountil``)."""
    expr = expression.strip()
    if expr == "input empty":
        return "input nonempty"
    if expr == "input nonempty":
        return "input empty"
    for prefix, negated in _NEGATIONS:
        if expr.startswith(prefix):
            return f"{negated}{expr[len(prefix):]}"
    raise WorkflowCompileError(
        f'Core conditions cannot negate "{expr}"; use .dowhile with the opposite condition instead of .dountil'
    )


def _quote(value: Any) -> str:
    if isinstance(value, bool):
        value = "true" if value else "false"
    return f'"{value}"'


class when:  # noqa: N801 - mirrors the TypeScript `when` builder
    """Builders for portable conditions, evaluated by Core against the value's text."""

    @staticmethod
    def equals(value: Union[str, int, float, bool]) -> Condition:
        return Condition(f"input == {_quote(value)}")

    @staticmethod
    def not_equals(value: Union[str, int, float, bool]) -> Condition:
        return Condition(f"input != {_quote(value)}")

    @staticmethod
    def contains(text: str) -> Condition:
        return Condition(f"input contains {_quote(text)}")

    @staticmethod
    def starts_with(text: str) -> Condition:
        return Condition(f"input starts_with {_quote(text)}")

    @staticmethod
    def ends_with(text: str) -> Condition:
        return Condition(f"input ends_with {_quote(text)}")

    @staticmethod
    def empty() -> Condition:
        return Condition("input empty")

    @staticmethod
    def non_empty() -> Condition:
        return Condition("input nonempty")

    @staticmethod
    def lt(n: float) -> Condition:
        return Condition(f"input < {n}")

    @staticmethod
    def lte(n: float) -> Condition:
        return Condition(f"input <= {n}")

    @staticmethod
    def gt(n: float) -> Condition:
        return Condition(f"input > {n}")

    @staticmethod
    def gte(n: float) -> Condition:
        return Condition(f"input >= {n}")

    @staticmethod
    def expr(expression: str) -> Condition:
        return Condition(expression.strip())


def _condition(value: Union[Condition, str]) -> Condition:
    return value if isinstance(value, Condition) else Condition(value.strip())


# ── Steps ─────────────────────────────────────────────────────────────────────


@dataclass
class RetryPolicy:
    """Core's per-node retry policy."""

    max_attempts: Optional[int] = None
    initial_interval_ms: Optional[int] = None
    backoff_coefficient: Optional[float] = None
    max_interval_ms: Optional[int] = None
    jitter_fraction: Optional[float] = None
    non_retryable_errors: Optional[List[str]] = None

    def to_core(self) -> Dict[str, Any]:
        return {key: value for key, value in self.__dict__.items() if value is not None}


@dataclass
class Step:
    """One Core node: an id, a node kind, and optional retry/timeout/repeat policy."""

    id: str
    kind: Dict[str, Any]
    retry: Optional[RetryPolicy] = None
    timeout_ms: Optional[int] = None
    repeat: Optional[Dict[str, Any]] = None

    def __post_init__(self) -> None:
        _assert_core_id(self.id, "step id")
        if not isinstance(self.kind.get("type"), str):
            raise WorkflowCompileError(f'step "{self.id}" has no node type')

    def node(self, node_id: str) -> Dict[str, Any]:
        node: Dict[str, Any] = {"id": node_id}
        node.update({key: value for key, value in self.kind.items() if value is not None})
        if self.retry is not None:
            node["retry"] = self.retry.to_core()
        if self.timeout_ms is not None:
            node["timeout_ms"] = self.timeout_ms
        if self.repeat is not None:
            node["repeat"] = dict(self.repeat)
        return node


def step(id: str, type: str, *, retry: Optional[RetryPolicy] = None, timeout_ms: Optional[int] = None, **fields: Any) -> Step:
    """Any Core node kind by its ``type`` tag (escape hatch for kinds without a helper)."""
    return Step(id, {"type": type, **fields}, retry=retry, timeout_ms=timeout_ms)


def agent_step(id: str, agent_id: str, *, task: Optional[str] = None, **policy: Any) -> Step:
    """Run a configured Core agent; ``task`` is a template (``{{input}}``, ``{{nodes.x}}``)."""
    return step(id, "agent", agent_id=agent_id, task=task, **policy)


def prompt_step(id: str, prompt: str, *, agent_id: Optional[str] = None, **policy: Any) -> Step:
    """One gateway-routed LLM call with a prompt template."""
    return step(id, "prompt", prompt=prompt, agent_id=agent_id, **policy)


def tool_step(id: str, name: str, args: Any = None, **policy: Any) -> Step:
    """Call a Core tool by ``<server>.<tool>`` id; string leaves of ``args`` are templates."""
    return step(id, "tool", name=name, args=args, **policy)


def mcp_step(id: str, server: str, tool: str, args: Any = None, **policy: Any) -> Step:
    """Call ``tool`` on the MCP ``server``."""
    return step(id, "mcp", server=server, tool=tool, args=args, **policy)


def script_step(
    id: str, code: str, *, agent_id: Optional[str] = None, preset: Optional[str] = None, **policy: Any
) -> Step:
    """A sandboxed JavaScript body (input is ``args``; ``return`` sets the output)."""
    return step(id, "script", code=code, agent_id=agent_id, preset=preset, **policy)


def skill_step(id: str, skill: str, *, agent_id: Optional[str] = None, task: Optional[str] = None, **policy: Any) -> Step:
    """Apply an installed skill to the value."""
    return step(id, "skill", skill=skill, agent_id=agent_id, task=task, **policy)


def plugin_step(id: str, plugin_id: str, runnable_id: str, args: Any = None, **policy: Any) -> Step:
    """Run a Runnable an installed plugin bundles."""
    return step(id, "plugin", plugin_id=plugin_id, runnable_id=runnable_id, args=args, **policy)


def human_step(id: str, prompt: Optional[str] = None, **policy: Any) -> Step:
    """A durable human-in-the-loop gate (``awakeable``); resume with the client."""
    return step(id, "awakeable", prompt=prompt, **policy)


def transform_step(id: str, op: str, template: Optional[str] = None, **policy: Any) -> Step:
    """A pure transform: ``uppercase``, ``lowercase``, ``trim``, ``json_parse``, ``template``, ``identity``."""
    return step(id, "transform", op=op, template=template, **policy)


def set_state_step(id: str, key: str, value: str, **policy: Any) -> Step:
    """Write a template value to run state (readable as ``{{state.<key>}}``)."""
    return step(id, "set_state", key=key, value=value, **policy)


def guardrails_step(id: str, checks: Sequence[str], **policy: Any) -> Step:
    """Route the value through the Gateway firewall (``pii``, ``jailbreak``, ``moderation``)."""
    return step(id, "guardrails", checks=list(checks), **policy)


def webhook_step(id: str, url: str, method: str = "POST", **policy: Any) -> Step:
    """Post the value to an external URL."""
    return step(id, "webhook", url=url, method=method, **policy)


# ── Triggers ──────────────────────────────────────────────────────────────────


def manual_trigger() -> Dict[str, Any]:
    return {"type": "manual"}


def schedule_trigger(*, cron: Optional[str] = None, every: Optional[str] = None, require_approval: bool = False) -> Dict[str, Any]:
    if not (cron or every):
        raise ValueError("a schedule trigger needs cron or every")
    trigger: Dict[str, Any] = {"type": "schedule", "require_approval": require_approval}
    if cron:
        trigger["cron"] = cron
    if every:
        trigger["every"] = every
    return trigger


def webhook_trigger(secret: Optional[str] = None) -> Dict[str, Any]:
    return {"type": "webhook", "secret": secret} if secret else {"type": "webhook"}


def event_trigger(event: str) -> Dict[str, Any]:
    return {"type": "event", "event": event}


# ── Workflow builder ──────────────────────────────────────────────────────────

StepLike = Union[Step, "Workflow"]


@dataclass
class _Stage:
    kind: str
    items: List[Any] = field(default_factory=list)
    options: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CompiledWorkflow:
    """A compiled workflow: the definition plus every child it references.

    Deploy ``children`` before ``workflow``. ``step_nodes`` maps Core node ids
    to the step id they run, for mapping run state back to steps.
    """

    workflow: Dict[str, Any]
    children: List[Dict[str, Any]]
    step_nodes: Dict[str, str]


class Workflow:
    """A chain of stages that compiles to a Core workflow graph."""

    def __init__(
        self,
        id: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        triggers: Optional[Sequence[Mapping[str, Any]]] = None,
        max_concurrency: Optional[int] = None,
        output_schema: Any = None,
    ) -> None:
        _assert_core_id(id, "workflow id")
        _check_concurrency("Workflow max_concurrency", max_concurrency)
        self.id = id
        self.name = name or id
        self.description = description
        self.triggers = [dict(trigger) for trigger in triggers or []]
        self.max_concurrency = max_concurrency
        self.output = to_output_contract(output_schema)
        self.stages: List[_Stage] = []
        self._committed = False

    def _add(self, stage: _Stage) -> "Workflow":
        if self._committed:
            raise WorkflowCompileError(f'workflow "{self.id}" is committed; build a new one to change it')
        self.stages.append(stage)
        return self

    def then(self, item: StepLike) -> "Workflow":
        """Run a step (or nested workflow) on the previous value."""
        return self._add(_Stage("then", [item]))

    def parallel(self, items: Sequence[StepLike], *, max_concurrency: Optional[int] = None) -> "Workflow":
        """Run every item on the same value; the output is ``{item_id: result}``."""
        if not items:
            raise WorkflowCompileError(".parallel() needs at least one step")
        ids = [item.id for item in items]
        if len(set(ids)) != len(ids):
            raise WorkflowCompileError(f".parallel() branch ids must be unique, got {ids}")
        if len(ids) > MAX_FANOUT_ITEMS:
            raise WorkflowCompileError(f".parallel() takes at most {MAX_FANOUT_ITEMS} branches, got {len(ids)}")
        for branch_id in ids:
            if len(branch_id) > MAX_BRANCH_ID_CHARS:
                raise WorkflowCompileError(
                    f'.parallel() branch id "{branch_id}" is longer than {MAX_BRANCH_ID_CHARS} characters'
                )
        _check_concurrency(".parallel()", max_concurrency)
        return self._add(_Stage("parallel", list(items), {"max_concurrency": max_concurrency}))

    def branch(
        self,
        arms: Sequence[Tuple[Union[Condition, str], StepLike]],
        *,
        otherwise: Optional[StepLike] = None,
    ) -> "Workflow":
        """Run the first arm whose condition holds (``otherwise`` when none does).

        With no match and no ``otherwise``, the value passes through unchanged.
        """
        if not arms:
            raise WorkflowCompileError(".branch() needs at least one arm")
        resolved = [(_condition(condition), item) for condition, item in arms]
        return self._add(_Stage("branch", resolved, {"otherwise": otherwise}))

    def foreach(
        self, item: StepLike, *, items: Optional[str] = None, concurrency: Optional[int] = None
    ) -> "Workflow":
        """Run ``item`` once per element of a JSON array (``items`` template, default the value)."""
        _check_concurrency(".foreach()", concurrency)
        return self._add(_Stage("foreach", [item], {"items": items, "concurrency": concurrency}))

    def dowhile(self, item: StepLike, condition: Union[Condition, str], *, max_iterations: int = DEFAULT_LOOP_ITERATIONS) -> "Workflow":
        """Run ``item``, then repeat while ``condition`` holds on its output."""
        return self._loop("dowhile", item, _condition(condition), max_iterations)

    def dountil(self, item: StepLike, condition: Union[Condition, str], *, max_iterations: int = DEFAULT_LOOP_ITERATIONS) -> "Workflow":
        """Run ``item``, then repeat until ``condition`` holds on its output."""
        return self._loop("dountil", item, _condition(condition), max_iterations)

    def _loop(self, mode: str, item: StepLike, condition: Condition, max_iterations: int) -> "Workflow":
        if max_iterations < 1:
            raise WorkflowCompileError(f".{mode}() max_iterations must be at least 1")
        if max_iterations > MAX_CORE_LOOP_ITERATIONS:
            raise WorkflowCompileError(
                f".{mode}(): Core loops run at most {MAX_CORE_LOOP_ITERATIONS} passes, got {max_iterations}"
            )
        expr = condition.expr if mode == "dowhile" else negate_expr(condition.expr)
        return self._add(_Stage(mode, [item], {"expr": expr, "max_iterations": max_iterations}))

    def sleep(self, ms: int) -> "Workflow":
        """Pause for ``ms`` milliseconds (a durable timer)."""
        if ms < 0:
            raise WorkflowCompileError(".sleep() needs a non-negative duration")
        return self._add(_Stage("sleep", options={"ms": int(ms)}))

    def map(self, template: str) -> "Workflow":
        """Rewrite the value with a template (``{{input}}``, ``{{nodes.<id>}}``, ``{{state.<key>}}``)."""
        return self._add(_Stage("map", options={"template": template}))

    def commit(self) -> "Workflow":
        """Freeze the workflow (it compiles the same before and after)."""
        self.to_core()
        self._committed = True
        return self

    def to_core(self) -> CompiledWorkflow:
        """Compile to Core's JSON workflow graph."""
        return _Compiler(self).compile()


def _check_concurrency(where: str, value: Optional[int]) -> None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 1):
        raise WorkflowCompileError(f"{where} concurrency must be a positive integer, got {value!r}")


class _Graph:
    def __init__(self) -> None:
        self.nodes: List[Dict[str, Any]] = []
        self.edges: List[Dict[str, Any]] = []
        self.step_nodes: Dict[str, str] = {}
        self._ids: Set[str] = set()

    def add(self, node: Dict[str, Any], step_id: Optional[str] = None) -> str:
        node_id: str = node["id"]
        _assert_core_id(node_id, "Core node id")
        if node_id in self._ids:
            raise WorkflowCompileError(f'duplicate Core node id "{node_id}"')
        self._ids.add(node_id)
        self.nodes.append(node)
        if step_id is not None:
            self.step_nodes[node_id] = step_id
        return node_id

    def edge(self, source: str, target: str, branch: Optional[str] = None) -> None:
        edge: Dict[str, Any] = {"from": source, "to": target}
        if branch is not None:
            edge["branch"] = branch
        self.edges.append(edge)


def _node_id(*parts: str) -> str:
    return "--".join(parts)


class _Compiler:
    def __init__(self, root: Workflow) -> None:
        self.root = root
        self.children: Dict[str, Dict[str, Any]] = {}
        self.in_progress = {root.id}

    def compile(self) -> CompiledWorkflow:
        definition, step_nodes = self._definition(self.root, primary=True)
        return CompiledWorkflow(workflow=definition, children=list(self.children.values()), step_nodes=step_nodes)

    def _definition(self, workflow: Workflow, primary: bool = False) -> Tuple[Dict[str, Any], Dict[str, str]]:
        graph = _Graph()
        graph.add({"id": _INPUT_NODE, "type": "input", "key": CORE_INPUT_KEY})
        last = self._stages(graph, workflow, _INPUT_NODE)
        graph.add({"id": _OUTPUT_NODE, "type": "output", "key": CORE_OUTPUT_KEY})
        graph.edge(last, _OUTPUT_NODE)
        definition: Dict[str, Any] = {"id": workflow.id, "name": workflow.name, "nodes": graph.nodes, "edges": graph.edges}
        if workflow.description:
            definition["description"] = workflow.description
        if primary and workflow.triggers:
            definition["triggers"] = workflow.triggers
        if workflow.max_concurrency is not None:
            definition["max_concurrency"] = workflow.max_concurrency
        return definition, graph.step_nodes

    def _child(self, workflow: Workflow) -> str:
        if workflow.id in self.in_progress:
            raise WorkflowCompileError(f'workflow "{workflow.id}" nests itself; Core workflows must not recurse')
        if workflow.id not in self.children:
            self.in_progress.add(workflow.id)
            definition, _ = self._definition(workflow)
            self.in_progress.discard(workflow.id)
            self.children[workflow.id] = definition
        return workflow.id

    def _body(self, owner: Workflow, stage_id: str, item: StepLike) -> str:
        """The workflow id that runs ``item`` as a whole (a one-step body for a step)."""
        if isinstance(item, Workflow):
            return self._child(item)
        body_id = re.sub(r"[^A-Za-z0-9_-]", "_", f"{owner.id}--{stage_id}--{item.id}")[:128]
        _assert_core_id(body_id, "workflow id")
        if body_id in self.children:
            raise WorkflowCompileError(f'duplicate body workflow "{body_id}"')
        graph = _Graph()
        graph.add({"id": _INPUT_NODE, "type": "input", "key": CORE_INPUT_KEY})
        node_id = f"{item.id}__2" if item.id in (_INPUT_NODE, _OUTPUT_NODE) else item.id
        graph.add(item.node(node_id), item.id)
        graph.edge(_INPUT_NODE, node_id)
        graph.add({"id": _OUTPUT_NODE, "type": "output", "key": CORE_OUTPUT_KEY})
        graph.edge(node_id, _OUTPUT_NODE)
        self.children[body_id] = {
            "id": body_id,
            "name": f"{owner.name} · {stage_id}",
            "nodes": graph.nodes,
            "edges": graph.edges,
        }
        return body_id

    def _item_node(self, graph: _Graph, item: StepLike, node_id: str) -> str:
        if isinstance(item, Workflow):
            return graph.add({"id": node_id, "type": "sub_workflow", "workflow_id": self._child(item)}, item.id)
        return graph.add(item.node(node_id), item.id)

    def _stages(self, graph: _Graph, owner: Workflow, source: str) -> str:
        counts: Dict[str, int] = {}

        def path_for(item_id: str) -> str:
            count = counts.get(item_id, 1 if item_id in (_INPUT_NODE, _OUTPUT_NODE) else 0) + 1
            counts[item_id] = count
            return item_id if count == 1 else f"{item_id}__{count}"

        current = source
        for index, stage in enumerate(owner.stages, start=1):
            stage_id = f"{stage.kind}_{index}"
            if stage.kind == "then":
                item = stage.items[0]
                node_id = self._item_node(graph, item, path_for(item.id))
                graph.edge(current, node_id)
                current = node_id
            elif stage.kind == "parallel":
                branches = [
                    {"id": item.id, "workflow_id": self._body(owner, stage_id, item)} for item in stage.items
                ]
                node: Dict[str, Any] = {"id": stage_id, "type": "parallel", "branches": branches}
                if stage.options.get("max_concurrency") is not None:
                    node["max_concurrency"] = stage.options["max_concurrency"]
                graph.add(node, stage_id)
                graph.edge(current, stage_id)
                current = stage_id
            elif stage.kind == "foreach":
                item = stage.items[0]
                node = {"id": stage_id, "type": "for_each", "body_workflow_id": self._body(owner, stage_id, item)}
                if stage.options.get("items"):
                    node["items"] = stage.options["items"]
                if stage.options.get("concurrency") is not None:
                    node["max_concurrency"] = stage.options["concurrency"]
                graph.add(node, item.id)
                graph.edge(current, stage_id)
                current = stage_id
            elif stage.kind == "branch":
                current = self._branch(graph, stage, stage_id, current)
            elif stage.kind in ("dowhile", "dountil"):
                current = self._loop(graph, owner, stage, stage_id, current)
            elif stage.kind == "sleep":
                graph.add({"id": stage_id, "type": "delay", "ms": stage.options["ms"]})
                graph.edge(current, stage_id)
                current = stage_id
            elif stage.kind == "map":
                graph.add({"id": stage_id, "type": "transform", "op": "template", "template": stage.options["template"]})
                graph.edge(current, stage_id)
                current = stage_id
        return current

    def _branch(self, graph: _Graph, stage: _Stage, stage_id: str, source: str) -> str:
        restore = f"{{{{nodes.{source}}}}}"
        join = stage_id
        arms_out: List[str] = []
        previous = source
        previous_branch: Optional[str] = None
        for index, (condition, item) in enumerate(stage.items, start=1):
            check = graph.add({"id": _node_id(stage_id, "if", str(index)), "type": "condition", "expr": condition.expr})
            if previous_branch is None:
                graph.edge(previous, check)
            else:
                # The previous condition emits "true"/"false"; restore the value first.
                again = graph.add(
                    {"id": _node_id(stage_id, "else", str(index)), "type": "transform", "op": "template", "template": restore}
                )
                graph.edge(previous, again, previous_branch)
                graph.edge(again, check)
            value = graph.add(
                {"id": _node_id(stage_id, "then", str(index)), "type": "transform", "op": "template", "template": restore}
            )
            graph.edge(check, value, "true")
            arm = self._item_node(graph, item, _node_id(stage_id, item.id))
            graph.edge(value, arm)
            arms_out.append(arm)
            previous, previous_branch = check, "false"
        fallback = graph.add(
            {"id": _node_id(stage_id, "otherwise"), "type": "transform", "op": "template", "template": restore}
        )
        graph.edge(previous, fallback, previous_branch)
        otherwise = stage.options.get("otherwise")
        if otherwise is not None:
            arm = self._item_node(graph, otherwise, _node_id(stage_id, otherwise.id))
            graph.edge(fallback, arm)
            arms_out.append(arm)
        else:
            arms_out.append(fallback)
        graph.add({"id": join, "type": "transform", "op": "identity"}, stage_id)
        for arm in arms_out:
            graph.edge(arm, join)
        return join

    def _loop(self, graph: _Graph, owner: Workflow, stage: _Stage, stage_id: str, source: str) -> str:
        item = stage.items[0]
        max_iterations = stage.options["max_iterations"]
        body_id = self._body(owner, stage_id, item)
        first_id = stage_id if max_iterations == 1 else _node_id(stage_id, "first")
        graph.add({"id": first_id, "type": "sub_workflow", "workflow_id": body_id}, item.id)
        graph.edge(source, first_id)
        if max_iterations == 1:
            return first_id
        graph.add(
            {
                "id": stage_id,
                "type": "while",
                "expr": stage.options["expr"],
                "body_workflow_id": body_id,
                "max_iterations": max_iterations - 1,
            },
            item.id,
        )
        graph.edge(first_id, stage_id)
        return stage_id


# ── Run client ────────────────────────────────────────────────────────────────

_TERMINAL = frozenset({"completed", "failed", "awaiting_input"})


@dataclass
class WorkflowEvent:
    """A run event: ``workflow-start``, ``step-start``, ``step-result``,
    ``step-error``, ``step-suspended``, or ``workflow-finish``."""

    type: str
    run_id: str
    step_id: Optional[str] = None
    path: Optional[str] = None
    output: Any = None
    error: Optional[str] = None
    status: Optional[str] = None


@dataclass
class WorkflowResult:
    """A run outcome: ``success`` (with ``result``), ``failed``, or ``suspended``."""

    status: str
    run_id: str
    result: Any = None
    error: Optional[str] = None
    steps: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    suspended: List[str] = field(default_factory=list)
    run: Optional[Dict[str, Any]] = None


@dataclass
class DeployResult:
    workflow_id: str
    children: List[str]


class _RunTracker:
    """Turns Core run-record node states into step events."""

    def __init__(self, run_id: str, step_nodes: Mapping[str, str]) -> None:
        self.run_id = run_id
        self.step_nodes = dict(step_nodes)
        self.seen: Dict[str, str] = {}
        self.steps: Dict[str, Dict[str, Any]] = {}

    def observe(self, run: Mapping[str, Any]) -> List[WorkflowEvent]:
        events: List[WorkflowEvent] = []
        nodes = run.get("nodes") or {}
        for node_id, state in nodes.items():
            step_id = self.step_nodes.get(node_id)
            status = state.get("status") if isinstance(state, dict) else None
            if step_id is None or status is None or self.seen.get(node_id) == status:
                continue
            previous = self.seen.get(node_id)
            self.seen[node_id] = status
            if previous is None and status != "skipped":
                events.append(WorkflowEvent("step-start", self.run_id, step_id, node_id))
            if status == "completed":
                output = decode_core_value(state.get("output"))
                self.steps[node_id] = {"status": "success", "step_id": step_id, "output": output}
                events.append(WorkflowEvent("step-result", self.run_id, step_id, node_id, output=output))
            elif status == "failed":
                error = state.get("error") or "step failed"
                self.steps[node_id] = {"status": "failed", "step_id": step_id, "error": error}
                events.append(WorkflowEvent("step-error", self.run_id, step_id, node_id, error=error))
        gate = run.get("awaiting_node")
        if run.get("status") == "awaiting_input" and gate and self.steps.get(gate, {}).get("status") != "suspended":
            step_id = self.step_nodes.get(gate, gate)
            self.steps[gate] = {"status": "suspended", "step_id": step_id}
            events.append(WorkflowEvent("step-suspended", self.run_id, step_id, gate))
        return events

    def finish(self, run: Optional[Mapping[str, Any]], error: Optional[BaseException], output: Optional[OutputContract]) -> Tuple[WorkflowResult, WorkflowEvent]:
        if error is not None or run is None or run.get("status") == "failed":
            message = str(error) if error is not None else str((run or {}).get("error") or "workflow run failed")
            result = WorkflowResult("failed", self.run_id, error=message, steps=dict(self.steps), run=dict(run or {}) or None)
            return result, WorkflowEvent("workflow-finish", self.run_id, status="failed", error=message)
        if run.get("status") == "awaiting_input":
            suspended = [path for path, record in self.steps.items() if record.get("status") == "suspended"]
            result = WorkflowResult("suspended", self.run_id, steps=dict(self.steps), suspended=suspended, run=dict(run))
            return result, WorkflowEvent("workflow-finish", self.run_id, status="suspended")
        text = (run.get("output") or {}).get(CORE_OUTPUT_KEY)
        value = decode_core_value(text)
        if output is not None:
            ok, validated = output.validate(value)
            if not ok and text is not None and value != text:
                # A string-typed output that happens to look like JSON ("42").
                ok, validated = output.validate(text)
            if not ok:
                message = f"workflow output is invalid:\n{format_schema_issues(validated)}"
                result = WorkflowResult("failed", self.run_id, error=message, steps=dict(self.steps), run=dict(run))
                return result, WorkflowEvent("workflow-finish", self.run_id, status="failed", error=message)
            value = validated
        result = WorkflowResult("success", self.run_id, result=value, steps=dict(self.steps), run=dict(run))
        return result, WorkflowEvent("workflow-finish", self.run_id, status="success", output=value)


def _read_run(value: Any) -> Dict[str, Any]:
    run = value.get("run") if isinstance(value, dict) else None
    if not isinstance(run, dict) or not isinstance(run.get("run_id"), str) or not isinstance(run.get("status"), str):
        raise ValueError("response has no run record")
    return run


def new_run_id() -> str:
    return f"run_{uuid.uuid4().hex}"


def _workflow_segment(workflow_id: str) -> str:
    """A workflow id as one path segment; ``""``, ``.`` and ``..`` would resolve onto another Core route."""
    return segment("Core workflows", workflow_id, "workflow id")


def _check_run_id(run_id: str) -> str:
    if not _RUN_ID.fullmatch(run_id):
        raise ValueError(f'run id "{run_id}" must be 1-64 characters of [A-Za-z0-9_-]')
    return run_id


WorkflowRef = Union[Workflow, CompiledWorkflow, str]


def _compiled(workflow: WorkflowRef) -> Optional[CompiledWorkflow]:
    if isinstance(workflow, Workflow):
        return workflow.to_core()
    if isinstance(workflow, CompiledWorkflow):
        return workflow
    return None


def _workflow_id(workflow: WorkflowRef) -> str:
    if isinstance(workflow, str):
        return workflow
    if isinstance(workflow, Workflow):
        return workflow.id
    workflow_id: str = workflow.workflow["id"]
    return workflow_id


class _WorkflowRequests:
    def _execute(self, spec: RequestSpec) -> Any:  # pragma: no cover - overridden
        raise NotImplementedError

    def get_run(self, run_id: str) -> Any:
        """Fetch a Core run record (``GET /workflows/runs/:runId``)."""
        return self._execute(RequestSpec("GET", f"/workflows/runs/{_check_run_id(run_id)}", decode=_read_run))

    def get_workflow(self, workflow_id: str) -> Any:
        return self._execute(RequestSpec("GET", f"/workflows/{_workflow_segment(workflow_id)}"))

    def delete_workflow(self, workflow_id: str) -> Any:
        return self._execute(RequestSpec("DELETE", f"/workflows/{_workflow_segment(workflow_id)}"))

    def _run_spec(self, workflow_id: str, input: Any, run_id: str) -> RequestSpec:
        return RequestSpec(
            "POST",
            f"/workflows/{_workflow_segment(workflow_id)}/run",
            json_body={"input": {CORE_INPUT_KEY: core_text(input)}, "runId": run_id},
            decode=_read_run,
        )

    def _resume_spec(self, run_id: str, payload: Any) -> RequestSpec:
        return RequestSpec(
            "POST",
            f"/workflows/runs/{_check_run_id(run_id)}/resume",
            json_body={"payload": core_text(payload)},
            decode=_read_run,
        )


class _ClientBase(_WorkflowRequests):
    def __init__(self, base_url: Optional[str], token: Optional[str], user_jwt: Optional[str], poll_interval: float) -> None:
        self.base_url = (base_url or resolve_core_url()).rstrip("/")
        assert_allowed_egress(self.base_url)
        self.headers = {"content-type": "application/json", **bearer_headers(token if token is not None else resolve_core_token(), user_jwt)}
        self.poll_interval = poll_interval


class WorkflowClient(_ClientBase):
    """Synchronous client that deploys workflows to Core and runs them there."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        token: Optional[str] = None,
        user_jwt: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
        http_client: Optional[httpx.Client] = None,
        timeout: Optional[float] = None,
        poll_interval: float = 0.25,
        node_url: Optional[str] = None,
    ) -> None:
        """Connect to a Core node.

        ``base_url`` defaults to ``RYU_CORE_URL``, then ``http://127.0.0.1:7980``; the
        token defaults to ``RYU_CORE_TOKEN``, then ``RYU_TOKEN``.

        .. deprecated::
            ``node_url`` is the older name for ``base_url`` and is still read when
            ``base_url`` is unset.
        """
        super().__init__(pick_core_url(base_url, node_url), token, user_jwt, poll_interval)
        self._client = http_client or httpx.Client(transport=transport, timeout=timeout)

    def _execute(self, spec: RequestSpec) -> Any:
        return execute_sync(self._client, self.base_url, spec, self.headers)

    def deploy(self, workflow: Union[Workflow, CompiledWorkflow]) -> DeployResult:
        """Persist the workflow's children, then the workflow (``POST /workflows``)."""
        compiled = _compiled(workflow)
        assert compiled is not None
        for child in compiled.children:
            self._execute(RequestSpec("POST", "/workflows", json_body=child))
        self._execute(RequestSpec("POST", "/workflows", json_body=compiled.workflow))
        return DeployResult(compiled.workflow["id"], [child["id"] for child in compiled.children])

    def start(self, workflow: WorkflowRef, input: Any = None, *, run_id: Optional[str] = None) -> WorkflowResult:
        """Run a deployed workflow to an outcome (success, failure, or a human gate)."""
        result = None
        for item in self.stream(workflow, input, run_id=run_id):
            if isinstance(item, WorkflowResult):
                result = item
        assert result is not None
        return result

    def resume(self, workflow: WorkflowRef, run_id: str, payload: Any = None) -> WorkflowResult:
        """Resume a run suspended at a human gate with ``payload`` as the gate's output."""
        result = None
        for item in self.resume_stream(workflow, run_id, payload):
            if isinstance(item, WorkflowResult):
                result = item
        assert result is not None
        return result

    def stream(self, workflow: WorkflowRef, input: Any = None, *, run_id: Optional[str] = None) -> Iterator[Union[WorkflowEvent, WorkflowResult]]:
        """Start a run and yield step events, ending with the :class:`WorkflowResult`."""
        run_id = _check_run_id(run_id or new_run_id())
        workflow_id = _workflow_id(workflow)
        yield WorkflowEvent("workflow-start", run_id, output=input)
        yield from self._drive(workflow, run_id, self._run_spec(workflow_id, input, run_id))

    def resume_stream(self, workflow: WorkflowRef, run_id: str, payload: Any = None) -> Iterator[Union[WorkflowEvent, WorkflowResult]]:
        yield from self._drive(workflow, run_id, self._resume_spec(run_id, payload))

    def _drive(self, workflow: WorkflowRef, run_id: str, spec: RequestSpec) -> Iterator[Union[WorkflowEvent, WorkflowResult]]:
        compiled = _compiled(workflow)
        tracker = _RunTracker(run_id, compiled.step_nodes if compiled else {})
        output = workflow.output if isinstance(workflow, Workflow) else None
        outcome: Dict[str, Any] = {}

        def call() -> None:
            try:
                outcome["run"] = self._execute(spec)
            except Exception as error:  # noqa: BLE001 - reported as the run outcome
                outcome["error"] = error

        worker = threading.Thread(target=call, daemon=True)
        worker.start()
        while worker.is_alive():
            worker.join(self.poll_interval)
            if not worker.is_alive():
                break
            try:
                yield from tracker.observe(self.get_run(run_id))
            except Exception:  # noqa: BLE001 - progress polling is best effort (404 before the first checkpoint)
                pass
        run = outcome.get("run")
        error = outcome.get("error")
        try:
            while run is not None and run.get("status") not in _TERMINAL:
                yield from tracker.observe(run)
                time.sleep(self.poll_interval)
                run = self.get_run(run_id)
        except Exception as poll_error:  # noqa: BLE001 - reported as the run outcome
            error = poll_error
        if run is not None and error is None:
            yield from tracker.observe(run)
        result, finish = tracker.finish(run, error, output)
        yield finish
        yield result

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "WorkflowClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class AsyncWorkflowClient(_ClientBase):
    """Async client that deploys workflows to Core and runs them there."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        token: Optional[str] = None,
        user_jwt: Optional[str] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        timeout: Optional[float] = None,
        poll_interval: float = 0.25,
        node_url: Optional[str] = None,
    ) -> None:
        """Connect to a Core node.

        ``base_url`` defaults to ``RYU_CORE_URL``, then ``http://127.0.0.1:7980``; the
        token defaults to ``RYU_CORE_TOKEN``, then ``RYU_TOKEN``.

        .. deprecated::
            ``node_url`` is the older name for ``base_url`` and is still read when
            ``base_url`` is unset.
        """
        super().__init__(pick_core_url(base_url, node_url), token, user_jwt, poll_interval)
        self._client = http_client or httpx.AsyncClient(transport=transport, timeout=timeout)

    def _execute(self, spec: RequestSpec) -> Any:
        return execute_async(self._client, self.base_url, spec, self.headers)

    async def deploy(self, workflow: Union[Workflow, CompiledWorkflow]) -> DeployResult:
        compiled = _compiled(workflow)
        assert compiled is not None
        for child in compiled.children:
            await self._execute(RequestSpec("POST", "/workflows", json_body=child))
        await self._execute(RequestSpec("POST", "/workflows", json_body=compiled.workflow))
        return DeployResult(compiled.workflow["id"], [child["id"] for child in compiled.children])

    async def start(self, workflow: WorkflowRef, input: Any = None, *, run_id: Optional[str] = None) -> WorkflowResult:
        result = None
        async for item in self.stream(workflow, input, run_id=run_id):
            if isinstance(item, WorkflowResult):
                result = item
        assert result is not None
        return result

    async def resume(self, workflow: WorkflowRef, run_id: str, payload: Any = None) -> WorkflowResult:
        result = None
        async for item in self.resume_stream(workflow, run_id, payload):
            if isinstance(item, WorkflowResult):
                result = item
        assert result is not None
        return result

    async def stream(
        self, workflow: WorkflowRef, input: Any = None, *, run_id: Optional[str] = None
    ) -> AsyncGenerator[Union[WorkflowEvent, WorkflowResult], None]:
        run_id = _check_run_id(run_id or new_run_id())
        yield WorkflowEvent("workflow-start", run_id, output=input)
        async for item in self._drive(workflow, run_id, self._run_spec(_workflow_id(workflow), input, run_id)):
            yield item

    async def resume_stream(
        self, workflow: WorkflowRef, run_id: str, payload: Any = None
    ) -> AsyncGenerator[Union[WorkflowEvent, WorkflowResult], None]:
        async for item in self._drive(workflow, run_id, self._resume_spec(run_id, payload)):
            yield item

    async def _drive(self, workflow: WorkflowRef, run_id: str, spec: RequestSpec) -> AsyncGenerator[Union[WorkflowEvent, WorkflowResult], None]:
        compiled = _compiled(workflow)
        tracker = _RunTracker(run_id, compiled.step_nodes if compiled else {})
        output = workflow.output if isinstance(workflow, Workflow) else None
        task = asyncio.ensure_future(self._execute(spec))
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=self.poll_interval)
                if task.done():
                    break
                try:
                    for event in tracker.observe(await self.get_run(run_id)):
                        yield event
                except Exception:  # noqa: BLE001 - progress polling is best effort
                    pass
        finally:
            if not task.done():
                task.cancel()
        run: Optional[Dict[str, Any]] = None
        error: Optional[BaseException] = None
        try:
            run = task.result()
            while run.get("status") not in _TERMINAL:
                for event in tracker.observe(run):
                    yield event
                await asyncio.sleep(self.poll_interval)
                run = await self.get_run(run_id)
        except Exception as run_error:  # noqa: BLE001 - reported as the run outcome
            error = run_error
        if run is not None and error is None:
            for event in tracker.observe(run):
                yield event
        result, finish = tracker.finish(run, error, output)
        yield finish
        yield result

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncWorkflowClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
