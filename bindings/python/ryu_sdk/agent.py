"""``Agent``: a loop-owning, tool-calling agent for Python.

Python port of ``packages/sdk/src/agent/{agent,loop}.ts``. Give an agent
instructions, a gateway-routed model, tools, and optionally an
``output_schema``; :meth:`Agent.generate` (sync), :meth:`Agent.agenerate`
(async), and :meth:`Agent.stream` (async iterator of events) run the loop:

1. call the gateway's OpenAI-compatible ``/v1/chat/completions`` with the tool
   definitions (streamed, with a JSON fallback);
2. run each requested tool (local :func:`~ryu_sdk.tools.tool` functions
   in-process, :func:`~ryu_sdk.tools.ryu_tool` references through Core
   ``/api/mcp/tools/call``), pausing for approval when a tool sets
   ``needs_approval``;
3. feed results back and repeat until the model stops calling tools or
   ``max_steps`` model rounds have run;
4. with an ``output_schema``, parse and validate the final reply and re-ask
   the model with the problems up to ``max_repair_attempts`` times (repair
   rounds do not consume ``max_steps``).

A tool output carrying Ryu's connection-required envelope stops the run with an
``auth_required`` event. Errors a tool raises are fed back to the model.

With ``session_id`` the run is owned by Core's durable harness instead: the
prompt starts a harness run and its event stream is translated into the same
events (middleware does not apply; use a plugin hook there). :meth:`Agent.stream_run`
re-attaches to a run after a cursor, :meth:`Agent.resume` starts a new attempt
of a finished run, and cancelling the task consuming :meth:`Agent.stream`
cancels the Core run it started.

The loop itself is written once, as a generator that yields effects (call the
model, run a tool, ask for approval); a sync and an async driver execute those
effects with ``httpx.Client`` and ``httpx.AsyncClient``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from typing import (
    Any,
    AsyncGenerator,
    Callable,
    Dict,
    Generator,
    Iterator,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
    Union,
)

import httpx

from ._transport import error_detail
from .gateway import (
    assert_allowed_egress,
    resolve_core_token,
    resolve_core_url,
    resolve_gateway_token,
    resolve_gateway_url,
)
from .harness import AsyncHarnessClient, HarnessClient
from .middleware import (
    ModelCallRequest,
    ModelCallResult,
    ModelUsage,
    ToolCallRequest,
    ToolCallResult,
    TurnSummary,
    compose_async,
    compose_sync,
    run_after_turn_async,
    run_after_turn_sync,
)
from .model_call import StreamEvent, request_body, stream_model_async, stream_model_sync
from .model_call import gateway_origin as _gateway_origin
from .schema import (
    DEFAULT_MAX_REPAIR_ATTEMPTS,
    STRUCTURED_OUTPUT_ERROR_CODE,
    OutputContract,
    SchemaIssue,
    StructuredOutputError,
    build_repair_prompt,
    describe_structured_output_failure,
    is_strict_compatible_json_schema,
    read_structured_reply,
    to_jsonable,
    to_output_contract,
)
from .tools import AgentTool, RemoteTool, Tool, detect_elicitation, normalize_tools

DEFAULT_MAX_STEPS = 10

# ── Events ────────────────────────────────────────────────────────────────────


@dataclass
class TextEvent:
    """A streamed text fragment from the assistant."""

    content: str
    type: str = "text"


@dataclass
class ToolCallEvent:
    """The model initiated a tool call."""

    id: str
    name: str
    input: Any
    type: str = "tool_call"


@dataclass
class ToolResultEvent:
    """A tool finished (or failed with an error output the model can recover from)."""

    id: str
    name: str
    output: Any
    type: str = "tool_result"


@dataclass
class ApprovalRequestedEvent:
    """A tool needs a human decision before it runs."""

    approval_id: str
    summary: str
    name: Optional[str] = None
    input: Any = None
    options: List[Dict[str, Any]] = field(default_factory=list)
    type: str = "approval_requested"


@dataclass
class AuthRequiredEvent:
    """A remote tool needs an account connection; the loop paused."""

    tool: str
    url: Optional[str] = None
    message: Optional[str] = None
    type: str = "auth_required"


@dataclass
class OutputRepairEvent:
    """The final reply failed ``output_schema``; the model is being re-asked."""

    attempt: int
    issues: List[SchemaIssue]
    type: str = "output_repair"


@dataclass
class ErrorEvent:
    """A fatal loop error; the stream ends after this."""

    message: str
    code: Optional[str] = None
    issues: Optional[List[SchemaIssue]] = None
    attempts: Optional[int] = None
    text: Optional[str] = None
    type: str = "error"


@dataclass
class ResultEvent:
    """Terminal event: final text, step count, usage, and validated output."""

    text: str
    steps: int
    usage: Optional[ModelUsage] = None
    output: Any = None
    type: str = "result"


AgentEvent = Union[
    TextEvent,
    ToolCallEvent,
    ToolResultEvent,
    ApprovalRequestedEvent,
    AuthRequiredEvent,
    OutputRepairEvent,
    ErrorEvent,
    ResultEvent,
]


@dataclass
class ApprovalRequest:
    """What an approval handler is asked to decide."""

    approval_id: str
    name: str
    input: Any
    summary: str
    options: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class GenerateResult:
    """Result of :meth:`Agent.generate` / :meth:`Agent.agenerate`."""

    text: str
    steps: int
    usage: Optional[ModelUsage] = None
    output: Any = None
    approval_required: Optional[ApprovalRequestedEvent] = None
    auth_required: Optional[AuthRequiredEvent] = None


class AgentError(RuntimeError):
    """A run ended with an ``error`` event."""


# ── Effects the loop asks its driver to perform ───────────────────────────────


@dataclass
class _DescribeTool:
    tool: RemoteTool


@dataclass
class _CallModel:
    request: ModelCallRequest
    response_format: Optional[Dict[str, Any]]


@dataclass
class _CallTool:
    request: ToolCallRequest
    #: The raw arguments when the model's JSON did not parse. The call still goes
    #: through ``wrap_tool_call`` (which may answer it), but the tool never runs.
    invalid_arguments: Optional[str] = None


@dataclass
class _Approve:
    request: ApprovalRequest


@dataclass
class _AfterTurn:
    summary: TurnSummary


@dataclass
class _ModelOutcome:
    result: ModelCallResult
    streamed: str


@dataclass
class _Failure:
    error: BaseException


def _describe_error(error: BaseException) -> str:
    return str(error) or type(error).__name__


def _model_call_failure(error: Exception, gateway_url: str) -> Exception:
    """A model-call error, with a gateway connection failure named in full.

    A refused, unresolvable or timed-out connection to the gateway becomes a
    ``ConnectionError`` naming the origin it tried and the settings that
    choose it, so the run's ``AgentError`` says what to fix. A gateway that
    accepted the connection but stopped answering (a read, write or pool
    timeout) becomes a ``TimeoutError`` naming the origin the same way. The
    message never contains the token; the original ``httpx`` error is the
    ``__cause__``.
    """
    reason = str(error) or type(error).__name__
    origin = _gateway_origin(gateway_url)
    wrapped: Exception
    if isinstance(error, (httpx.ConnectError, httpx.ConnectTimeout)):
        wrapped = ConnectionError(
            f"could not reach the Ryu Gateway at {origin} ({reason}). "
            "Start the Gateway, or point the agent at a running one: set RYU_GATEWAY_URL (or pass "
            "gateway_url=) to its origin and RYU_GATEWAY_TOKEN (or gateway_token=) to its token."
        )
    elif isinstance(error, httpx.TimeoutException):
        wrapped = TimeoutError(
            f"the Ryu Gateway at {origin} did not respond in time ({reason}). "
            "Check that the Gateway is healthy and its upstream model provider answers, or point "
            "the agent at another one with RYU_GATEWAY_URL (or gateway_url=) and RYU_GATEWAY_TOKEN "
            "(or gateway_token=)."
        )
    else:
        return error
    wrapped.__cause__ = error
    return wrapped


def _approved(decision: Any) -> bool:
    if decision is True:
        return True
    if isinstance(decision, str):
        return bool(decision.strip())
    return False


@dataclass
class _LoopConfig:
    model: str
    messages: List[Dict[str, Any]]
    tools: Dict[str, AgentTool]
    max_steps: int
    output: Optional[OutputContract]
    max_repair_attempts: int
    has_approval_handler: bool


def _response_format(contract: Optional[OutputContract]) -> Optional[Dict[str, Any]]:
    if contract is None:
        return None
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "ryu_output",
            "strict": is_strict_compatible_json_schema(contract.json_schema),
            "schema": contract.json_schema,
        },
    }


Loop = Generator[Any, Any, None]


def _agent_loop(config: _LoopConfig) -> Loop:
    """The agent loop as a generator of events and effects (see module docs)."""
    messages = list(config.messages)
    tool_defs: List[Dict[str, Any]] = []
    for tool_item in config.tools.values():
        if isinstance(tool_item, RemoteTool) and not tool_item.description:
            described = yield _DescribeTool(tool_item)
            tool_defs.append(tool_item.definition(described if isinstance(described, str) else None))
        else:
            tool_defs.append(tool_item.definition())
    response_format = _response_format(config.output)

    usage: Optional[ModelUsage] = None
    last_text = ""
    repairs_used = 0
    step = 0
    while step < config.max_steps + repairs_used:
        step += 1
        request = ModelCallRequest(messages=list(messages), model=config.model, step=step, tools=tool_defs or None)
        outcome = yield _CallModel(request, response_format)
        if isinstance(outcome, _Failure):
            yield ErrorEvent(message=_describe_error(outcome.error))
            return
        result = outcome.result
        if result.usage is not None:
            usage = result.usage if usage is None else usage + result.usage
        assistant = dict(result.message)
        assistant.setdefault("role", "assistant")
        messages.append(assistant)
        content = assistant.get("content") or ""
        if content and content != outcome.streamed:
            last_text = content
            if not outcome.streamed:
                yield TextEvent(content=content)
        elif outcome.streamed:
            last_text = outcome.streamed

        tool_calls = assistant.get("tool_calls") or []
        if not tool_calls:
            follow_up = None
            if step < config.max_steps:
                follow_up = yield _AfterTurn(TurnSummary(messages=tuple(messages), step=step, text=last_text))
                if isinstance(follow_up, _Failure):
                    yield ErrorEvent(message=_describe_error(follow_up.error))
                    return
            if follow_up is not None:
                messages.append({"role": "user", "content": follow_up})
                continue
            if config.output is None:
                yield ResultEvent(text=last_text, steps=step, usage=usage)
                return
            reply_text = content or outcome.streamed
            ok, value = read_structured_reply(reply_text, config.output)
            if ok:
                yield ResultEvent(text=last_text, steps=step, usage=usage, output=value)
                return
            if repairs_used < config.max_repair_attempts:
                repairs_used += 1
                yield OutputRepairEvent(attempt=repairs_used, issues=value)
                messages.append({"role": "user", "content": build_repair_prompt(value, config.output.json_schema)})
                continue
            attempts = repairs_used + 1
            yield ErrorEvent(
                message=describe_structured_output_failure(value, attempts),
                code=STRUCTURED_OUTPUT_ERROR_CODE,
                issues=value,
                attempts=attempts,
                text=reply_text,
            )
            return

        paused = yield from _run_tool_calls(tool_calls, messages, config, step)
        if paused:
            return

    steps = config.max_steps + repairs_used
    if config.output is None:
        yield ResultEvent(text=last_text, steps=steps, usage=usage)
        return
    ok, value = read_structured_reply(last_text, config.output)
    if ok:
        yield ResultEvent(text=last_text, steps=steps, usage=usage, output=value)
        return
    attempts = repairs_used + 1
    yield ErrorEvent(
        message=f"step budget ({steps}) exhausted; {describe_structured_output_failure(value, attempts)}",
        code=STRUCTURED_OUTPUT_ERROR_CODE,
        issues=value,
        attempts=attempts,
        text=last_text,
    )


def _tool_message(call_id: str, output: Any) -> Dict[str, Any]:
    content = output if isinstance(output, str) else json.dumps(to_jsonable(output), default=str)
    return {"role": "tool", "tool_call_id": call_id, "content": content}


def _run_tool_calls(
    tool_calls: Sequence[Dict[str, Any]], messages: List[Dict[str, Any]], config: _LoopConfig, step: int
) -> Generator[Any, Any, bool]:
    for call in tool_calls:
        function = call.get("function") or {}
        name = function.get("name", "")
        call_id = call.get("id") or f"call_{uuid.uuid4().hex[:8]}"
        raw = function.get("arguments") or ""
        invalid: Optional[str] = None
        try:
            parsed: Any = {} if raw.strip() == "" else json.loads(raw)
        except ValueError:
            parsed = raw
            invalid = raw
        yield ToolCallEvent(id=call_id, name=name, input=parsed)

        tool_item = config.tools.get(name)
        if tool_item is not None and tool_item.needs_approval:
            approval = ApprovalRequest(
                approval_id=f"sdk_approval_{uuid.uuid4().hex}",
                name=name,
                input=parsed,
                summary=f"The agent requested permission to run {name}.",
            )
            yield ApprovalRequestedEvent(
                approval_id=approval.approval_id, summary=approval.summary, name=name, input=parsed
            )
            if not config.has_approval_handler:
                return True
            decision = yield _Approve(approval)
            if isinstance(decision, _Failure):
                payload = {"error": _describe_error(decision.error)}
                messages.append(_tool_message(call_id, payload))
                yield ToolResultEvent(id=call_id, name=name, output=payload)
                continue
            if not _approved(decision):
                payload = {"error": "tool execution was not approved"}
                messages.append(_tool_message(call_id, payload))
                yield ToolResultEvent(id=call_id, name=name, output=payload)
                continue

        outcome = yield _CallTool(ToolCallRequest(id=call_id, name=name, input=parsed, step=step), invalid)
        if isinstance(outcome, _Failure):
            payload = {"error": _describe_error(outcome.error)}
            messages.append(_tool_message(call_id, payload))
            yield ToolResultEvent(id=call_id, name=name, output=payload)
            continue

        output = outcome.output if isinstance(outcome, ToolCallResult) else outcome
        elicitation = detect_elicitation(output)
        if elicitation is not None:
            yield AuthRequiredEvent(tool=name, url=elicitation.url, message=elicitation.message)
            return True
        messages.append(_tool_message(call_id, output))
        yield ToolResultEvent(id=call_id, name=name, output=output)
    return False


# ── Remote tool HTTP (Core) ───────────────────────────────────────────────────


def _core_headers(token: Optional[str]) -> Dict[str, str]:
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers


def _remote_call_body(
    tool_item: RemoteTool, arguments: Any, agent_id: Optional[str], user_id: Optional[str]
) -> Dict[str, Any]:
    if not agent_id:
        raise ValueError(
            f'[ryu-sdk] remote tool "{tool_item.name}" ({tool_item.id}) requires an agent_id; '
            "set it on the Agent so Core can govern the call"
        )
    body: Dict[str, Any] = {"tool": tool_item.id, "arguments": arguments, "agent_id": agent_id}
    if user_id:
        body["user_id"] = user_id
    return body


def _remote_reply(tool_item: RemoteTool, response: httpx.Response) -> Any:
    text = response.text
    if not response.is_success:
        raise RuntimeError(
            f'[ryu-sdk] Core tools/call {response.status_code} for "{tool_item.id}": {error_detail(response, text)}'
        )
    payload = json.loads(text) if text else {}
    if isinstance(payload, dict) and payload.get("ok") is False:
        raise RuntimeError(f'[ryu-sdk] tool "{tool_item.id}" failed: {payload.get("error") or "unknown error"}')
    return payload.get("output") if isinstance(payload, dict) else payload


def _described(response: httpx.Response) -> Optional[str]:
    if not response.is_success:
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    return payload.get("description") or payload.get("name") or None


def _resolve_call(agent: "Agent", effect: _CallTool, request: ToolCallRequest) -> AgentTool:
    """The tool a (possibly middleware-edited) call runs; raises for a call that must not run."""
    if effect.invalid_arguments is not None:
        raise ValueError(f'[ryu-sdk] tool "{request.name}" arguments were not valid JSON: {effect.invalid_arguments}')
    tool_item = agent.tools.get(request.name)
    if tool_item is None:
        raise LookupError(f'[ryu-sdk] model called unknown tool "{request.name}"')
    return tool_item


# ── Agent ─────────────────────────────────────────────────────────────────────

ApprovalHandler = Callable[[ApprovalRequest], Any]


class Agent:
    """A declarative agent that owns its tool-calling loop.

    Args:
        name: Display name.
        instructions: System prompt. Replaces system messages in a transcript.
        model: Model id routed by the gateway (provider keys live in the gateway).
        tools: A list of tools or a ``{name: tool}`` mapping. Bare functions are
            wrapped with :func:`~ryu_sdk.tools.tool`.
        output_schema: pydantic model, type hint, or JSON Schema dict for the
            final structured output (sent as ``response_format``).
        max_steps: Ceiling on model rounds (default 10).
        max_repair_attempts: Re-asks after an invalid structured reply (default 2).
        middleware: :class:`~ryu_sdk.middleware.Middleware` list, first outermost.
        approval_handler: Called for tools with ``needs_approval``; return
            ``True`` (or a non-empty option id) to run the tool. Without one, the
            run pauses with an ``approval_requested`` event.
        agent_id: Core agent id; required for :func:`~ryu_sdk.tools.ryu_tool`.
        user_id: Composio connected-account entity selector for remote tools.
        gateway_url / gateway_token: Gateway endpoint (defaults to
            ``RYU_GATEWAY_URL`` / ``RYU_GATEWAY_TOKEN`` or the local gateway).
        core_url / core_token: Core endpoint for remote tools and harness
            sessions (defaults to ``RYU_CORE_URL`` / ``RYU_CORE_TOKEN``, then ``RYU_TOKEN``).
        session_id: Run on a Core harness session instead of the in-process loop.
        transport: An httpx transport for every request (tests use
            ``httpx.MockTransport``).
    """

    def __init__(
        self,
        name: str,
        *,
        model: str,
        instructions: Optional[str] = None,
        tools: Any = None,
        output_schema: Any = None,
        max_steps: int = DEFAULT_MAX_STEPS,
        max_repair_attempts: int = DEFAULT_MAX_REPAIR_ATTEMPTS,
        middleware: Optional[Sequence[Any]] = None,
        approval_handler: Optional[ApprovalHandler] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        description: Optional[str] = None,
        gateway_url: Optional[str] = None,
        gateway_token: Optional[str] = None,
        core_url: Optional[str] = None,
        core_token: Optional[str] = None,
        session_id: Optional[str] = None,
        transport: Optional[Any] = None,
        timeout: Optional[float] = 120.0,
    ) -> None:
        if max_steps < 1:
            raise ValueError("max_steps must be at least 1")
        self.name = name
        self.model = model
        self.instructions = instructions
        self.description = description
        self.tools = normalize_tools(tools)
        self.output = to_output_contract(output_schema)
        self.max_steps = max_steps
        self.max_repair_attempts = max(0, int(max_repair_attempts))
        self.middleware = list(middleware or [])
        self.approval_handler = approval_handler
        self.agent_id = agent_id
        self.user_id = user_id
        self.gateway_url = (gateway_url or resolve_gateway_url()).rstrip("/")
        assert_allowed_egress(self.gateway_url)
        self.gateway_token = gateway_token if gateway_token is not None else resolve_gateway_token()
        self.core_url = (core_url or resolve_core_url()).rstrip("/")
        self.core_token = core_token if core_token is not None else resolve_core_token()
        self.session_id = session_id
        self._transport = transport
        self._timeout = timeout

    # ── public API ──

    def generate(self, prompt: Union[str, Sequence[Dict[str, Any]]]) -> GenerateResult:
        """Run to completion synchronously.

        Raises :class:`~ryu_sdk.schema.StructuredOutputError` when the reply
        never satisfied ``output_schema`` and :class:`AgentError` for any other
        terminal error. A run paused for approval or an account connection
        returns with ``approval_required`` / ``auth_required`` set.
        """
        return _collect(self.stream_sync(prompt), self.name)

    async def agenerate(self, prompt: Union[str, Sequence[Dict[str, Any]]]) -> GenerateResult:
        """Async :meth:`generate`."""
        events = []
        async for event in self.stream(prompt):
            events.append(event)
        return _collect(iter(events), self.name)

    def stream_sync(self, prompt: Union[str, Sequence[Dict[str, Any]]]) -> Iterator[AgentEvent]:
        """Yield loop events synchronously (text arrives once per model round)."""
        if self.session_id:
            yield from self._harness_sync(prompt)
            return
        with httpx.Client(transport=self._transport, timeout=self._timeout) as client:
            yield from _SyncDriver(self, client).run(_agent_loop(self._loop_config(prompt)))

    async def stream(self, prompt: Union[str, Sequence[Dict[str, Any]]]) -> AsyncGenerator[AgentEvent, None]:
        """Yield loop events as they happen, including per-token text deltas."""
        if self.session_id:
            async for event in self._harness_async(prompt):
                yield event
            return
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            driver = _AsyncDriver(self, client)
            async for event in driver.run(_agent_loop(self._loop_config(prompt))):
                yield event

    # ── internals ──

    def _loop_config(self, prompt: Union[str, Sequence[Dict[str, Any]]]) -> _LoopConfig:
        transcript = [{"role": "user", "content": prompt}] if isinstance(prompt, str) else [dict(m) for m in prompt]
        messages: List[Dict[str, Any]] = []
        if self.instructions:
            messages.append({"role": "system", "content": self.instructions})
        for message in transcript:
            if not (self.instructions and message.get("role") == "system"):
                messages.append(message)
        return _LoopConfig(
            model=self.model,
            messages=messages,
            tools=self.tools,
            max_steps=self.max_steps,
            output=self.output,
            max_repair_attempts=self.max_repair_attempts,
            has_approval_handler=self.approval_handler is not None,
        )

    def _prompt_text(self, prompt: Union[str, Sequence[Dict[str, Any]]]) -> str:
        if isinstance(prompt, str):
            return prompt
        users = [m.get("content", "") for m in prompt if m.get("role") == "user"]
        return users[-1] if users else ""

    # ── Core-owned (harness) runs ──

    def resume_sync(self, run_id: str, prompt: str) -> Iterator[AgentEvent]:
        """Resume a terminal durable run as a new attempt (needs ``session_id``)."""
        if not self.session_id:
            yield ErrorEvent(message=_RESUME_NEEDS_SESSION)
            return
        yield from self._harness_sync(prompt, resume_run_id=run_id)

    async def resume(self, run_id: str, prompt: str) -> AsyncGenerator[AgentEvent, None]:
        """Async :meth:`resume_sync`."""
        if not self.session_id:
            yield ErrorEvent(message=_RESUME_NEEDS_SESSION)
            return
        async for event in self._harness_async(prompt, resume_run_id=run_id):
            yield event

    def stream_run_sync(self, run_id: str, after: int = 0) -> Iterator[AgentEvent]:
        """Re-attach to a durable run's events after the ``after`` cursor without starting a new attempt."""
        with self._harness_client() as client:
            try:
                yield from self._consume_sync(client, run_id, after)
            except Exception as error:  # noqa: BLE001 - surfaced as a terminal event
                yield ErrorEvent(message=_describe_error(error))

    async def stream_run(self, run_id: str, after: int = 0) -> AsyncGenerator[AgentEvent, None]:
        """Async :meth:`stream_run_sync`."""
        async with self._async_harness_client() as client:
            try:
                async for event in self._consume_async(client, run_id, after):
                    yield event
            except Exception as error:  # noqa: BLE001 - surfaced as a terminal event
                yield ErrorEvent(message=_describe_error(error))

    def resolve_permission(self, request_id: str, option_id: Optional[str] = None) -> bool:
        """Resolve a pending runtime permission request surfaced by an ``approval_requested`` event."""
        with self._harness_client() as client:
            return bool(client.resolve_permission(request_id, option_id))

    async def aresolve_permission(self, request_id: str, option_id: Optional[str] = None) -> bool:
        """Async :meth:`resolve_permission`."""
        async with self._async_harness_client() as client:
            return bool(await client.resolve_permission(request_id, option_id))

    def _harness_client(self) -> HarnessClient:
        return HarnessClient(self.core_url, token=self.core_token, transport=self._transport, timeout=self._timeout)

    def _async_harness_client(self) -> AsyncHarnessClient:
        return AsyncHarnessClient(
            self.core_url, token=self.core_token, transport=self._transport, timeout=self._timeout
        )

    def _harness_sync(
        self, prompt: Union[str, Sequence[Dict[str, Any]]], resume_run_id: Optional[str] = None
    ) -> Iterator[AgentEvent]:
        if self.middleware:
            yield ErrorEvent(message=_HARNESS_MIDDLEWARE)
            return
        with self._harness_client() as client:
            try:
                started = client.start_run(
                    self.session_id or "", {"prompt": self._prompt_text(prompt)}, resume_run_id=resume_run_id
                )
                yield from self._consume_sync(client, started["run"]["id"], 0)
            except Exception as error:  # noqa: BLE001 - surfaced as a terminal event
                yield ErrorEvent(message=_describe_error(error))

    async def _harness_async(
        self, prompt: Union[str, Sequence[Dict[str, Any]]], resume_run_id: Optional[str] = None
    ) -> AsyncGenerator[AgentEvent, None]:
        if self.middleware:
            yield ErrorEvent(message=_HARNESS_MIDDLEWARE)
            return
        async with self._async_harness_client() as client:
            run_id: Optional[str] = None
            try:
                started = await client.start_run(
                    self.session_id or "", {"prompt": self._prompt_text(prompt)}, resume_run_id=resume_run_id
                )
                run_id = started["run"]["id"]
                async for event in self._consume_async(client, run_id, 0):
                    yield event
            except asyncio.CancelledError:
                # Cancelling the consuming task is this API's abort: stop the
                # Core run it started too (best effort), then propagate.
                if run_id is not None:
                    try:
                        await client.cancel(run_id)
                    except Exception:  # noqa: BLE001 - best-effort cancel
                        pass
                raise
            except Exception as error:  # noqa: BLE001 - surfaced as a terminal event
                yield ErrorEvent(message=_describe_error(error))

    def _consume_sync(self, client: HarnessClient, run_id: str, after: int) -> Iterator[AgentEvent]:
        translator = _HarnessTranslator(self.output)
        for event in client.events(run_id, after):
            for item in translator.translate(event):
                yield item
                if isinstance(item, ApprovalRequestedEvent):
                    if self.approval_handler is None:
                        return
                    error = _resolve_harness_approval_sync(client, self.approval_handler, item)
                    if error:
                        yield ErrorEvent(message=error)
                        return
                elif item.type in ("result", "error"):
                    return

    async def _consume_async(
        self, client: AsyncHarnessClient, run_id: str, after: int
    ) -> AsyncGenerator[AgentEvent, None]:
        translator = _HarnessTranslator(self.output)
        async for event in client.events(run_id, after):
            for item in translator.translate(event):
                yield item
                if isinstance(item, ApprovalRequestedEvent):
                    if self.approval_handler is None:
                        return
                    error = await _resolve_harness_approval_async(client, self.approval_handler, item)
                    if error:
                        yield ErrorEvent(message=error)
                        return
                elif item.type in ("result", "error"):
                    return


_RESUME_NEEDS_SESSION = "resuming a durable run requires session_id"

_HARNESS_MIDDLEWARE = (
    "middleware runs only in the SDK-owned loop; a session_id run is executed by Core, so use a plugin hook instead"
)


def _collect(events: Iterator[AgentEvent], agent_name: str) -> GenerateResult:
    text = ""
    pending: Optional[ApprovalRequestedEvent] = None
    for event in events:
        if isinstance(event, TextEvent):
            text += event.content
        elif isinstance(event, ResultEvent):
            return GenerateResult(text=event.text, steps=event.steps, usage=event.usage, output=event.output)
        elif isinstance(event, ApprovalRequestedEvent):
            # With an approval handler the run continues; without one it ends here.
            pending = event
        elif isinstance(event, AuthRequiredEvent):
            return GenerateResult(text=text, steps=0, auth_required=event)
        elif isinstance(event, ErrorEvent):
            message = f'[ryu-sdk] agent "{agent_name}": {event.message}'
            if event.code == STRUCTURED_OUTPUT_ERROR_CODE:
                raise StructuredOutputError(message, event.issues or [], event.attempts or 1, event.text or text)
            raise AgentError(message)
    if pending is not None:
        return GenerateResult(text=text, steps=0, approval_required=pending)
    raise AgentError(f'[ryu-sdk] agent "{agent_name}": stream ended without a result')


# ── Drivers ───────────────────────────────────────────────────────────────────


def _has_hook(middleware: Sequence[Any], attribute: str) -> bool:
    return any(callable(getattr(entry, attribute, None)) for entry in middleware)


class _SyncDriver:
    def __init__(self, agent: Agent, client: httpx.Client) -> None:
        self.agent = agent
        self.client = client

    def run(self, loop: Loop) -> Iterator[AgentEvent]:
        try:
            item = next(loop)
            while True:
                if isinstance(item, _CallModel):
                    outcome: Any = None
                    streamed: List[str] = []
                    try:
                        for event in self._model(item):
                            if event[0] == "text":
                                streamed.append(event[1])
                                yield TextEvent(content=event[1])
                            else:
                                outcome = _ModelOutcome(event[1], "".join(streamed))
                    except Exception as error:  # noqa: BLE001 - fed back to the loop
                        outcome = _Failure(_model_call_failure(error, self.agent.gateway_url))
                    item = loop.send(outcome)
                elif isinstance(item, (_DescribeTool, _CallTool, _Approve, _AfterTurn)):
                    try:
                        value = self._effect(item)
                    except Exception as error:  # noqa: BLE001 - fed back to the loop
                        value = _Failure(error)
                    item = loop.send(value)
                else:
                    yield item
                    item = next(loop)
        except StopIteration:
            return

    def _model(self, effect: _CallModel) -> Iterator[StreamEvent]:
        """Yield ``("text", delta)`` while the round streams, then ``("done", result)``.

        Without ``wrap_model_call`` middleware the gateway stream is relayed as
        it arrives. A synchronous ``wrap_model_call`` chain has to return the
        whole result, so with one the round's text follows once it returns.
        """

        def body_for(request: ModelCallRequest) -> Dict[str, Any]:
            return request_body(
                request.model,
                request.messages,
                tools=request.tools,
                tool_choice="auto" if request.tools else None,
                response_format=effect.response_format,
            )

        def stream(request: ModelCallRequest) -> Iterator[StreamEvent]:
            return stream_model_sync(self.client, self.agent.gateway_url, self.agent.gateway_token, body_for(request))

        if not _has_hook(self.agent.middleware, "wrap_model_call"):
            done = False
            for event in stream(effect.request):
                done = done or event[0] == "done"
                yield event
            if not done:
                raise RuntimeError("gateway stream ended without a result")
            return

        deltas: List[str] = []

        def gateway(request: ModelCallRequest) -> ModelCallResult:
            result: Optional[ModelCallResult] = None
            for event in stream(request):
                if event[0] == "text":
                    deltas.append(event[1])
                else:
                    result = event[1]
            if result is None:
                raise RuntimeError("gateway stream ended without a result")
            return result

        result = compose_sync(self.agent.middleware, "wrap_model_call", gateway)(effect.request)
        for delta in deltas:
            yield "text", delta
        yield "done", result

    def _effect(self, effect: Any) -> Any:
        agent = self.agent
        if isinstance(effect, _DescribeTool):
            url = f"{agent.core_url}/api/tools/describe"
            try:
                return _described(
                    self.client.get(url, params={"id": effect.tool.id}, headers=_core_headers(agent.core_token))
                )
            except httpx.HTTPError:
                return None
        if isinstance(effect, _Approve):
            decision = agent.approval_handler(effect.request)  # type: ignore[misc]
            if asyncio.iscoroutine(decision):
                decision.close()
                raise TypeError("approval_handler is async; use Agent.agenerate() or Agent.stream()")
            return decision
        if isinstance(effect, _AfterTurn):
            return run_after_turn_sync(agent.middleware, effect.summary)

        def execute(request: ToolCallRequest) -> ToolCallResult:
            tool_item = _resolve_call(agent, effect, request)
            if isinstance(tool_item, Tool):
                if not isinstance(request.input, dict):
                    raise TypeError(f'tool "{request.name}" expects an object of arguments')
                return ToolCallResult(output=tool_item.invoke(request.input))
            body = _remote_call_body(tool_item, request.input, agent.agent_id, agent.user_id)
            response = self.client.post(
                f"{agent.core_url}/api/mcp/tools/call", json=body, headers=_core_headers(agent.core_token)
            )
            return ToolCallResult(output=_remote_reply(tool_item, response))

        return compose_sync(agent.middleware, "wrap_tool_call", execute)(effect.request)


class _AsyncDriver:
    def __init__(self, agent: Agent, client: httpx.AsyncClient) -> None:
        self.agent = agent
        self.client = client

    async def run(self, loop: Loop) -> AsyncGenerator[AgentEvent, None]:
        try:
            item = next(loop)
            while True:
                if isinstance(item, _CallModel):
                    streamed: List[str] = []
                    outcome: Any = None
                    try:
                        async for event in self._model(item):
                            if event[0] == "text":
                                streamed.append(event[1])
                                yield TextEvent(content=event[1])
                            else:
                                outcome = _ModelOutcome(event[1], "".join(streamed))
                    except Exception as error:  # noqa: BLE001 - fed back to the loop
                        outcome = _Failure(_model_call_failure(error, self.agent.gateway_url))
                    item = loop.send(outcome)
                elif isinstance(item, (_DescribeTool, _CallTool, _Approve, _AfterTurn)):
                    effect_value: Any
                    try:
                        effect_value = await self._effect(item)
                    except Exception as error:  # noqa: BLE001 - fed back to the loop
                        effect_value = _Failure(error)
                    item = loop.send(effect_value)
                else:
                    yield item
                    item = next(loop)
        except StopIteration:
            return

    async def _model(self, effect: _CallModel) -> AsyncGenerator[StreamEvent, None]:
        """Run the wrapped model call, yielding deltas while it is in flight."""
        queue: "asyncio.Queue[str]" = asyncio.Queue()

        async def gateway(request: ModelCallRequest) -> ModelCallResult:
            body = request_body(
                request.model,
                request.messages,
                tools=request.tools,
                tool_choice="auto" if request.tools else None,
                response_format=effect.response_format,
            )
            result: Optional[ModelCallResult] = None
            async for event in stream_model_async(self.client, self.agent.gateway_url, self.agent.gateway_token, body):
                if event[0] == "text":
                    queue.put_nowait(event[1])
                else:
                    result = event[1]
            if result is None:
                raise RuntimeError("gateway stream ended without a result")
            return result

        call = compose_async(self.agent.middleware, "wrap_model_call", gateway)
        task = asyncio.ensure_future(call(effect.request))
        try:
            while True:
                getter = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                if getter in done:
                    yield ("text", getter.result())
                    continue
                getter.cancel()
                break
            while not queue.empty():
                yield ("text", queue.get_nowait())
            yield ("done", task.result())
        finally:
            if not task.done():
                task.cancel()

    async def _effect(self, effect: Any) -> Any:
        agent = self.agent
        if isinstance(effect, _DescribeTool):
            url = f"{agent.core_url}/api/tools/describe"
            try:
                response = await self.client.get(
                    url, params={"id": effect.tool.id}, headers=_core_headers(agent.core_token)
                )
            except httpx.HTTPError:
                return None
            return _described(response)
        if isinstance(effect, _Approve):
            decision = agent.approval_handler(effect.request)  # type: ignore[misc]
            if asyncio.iscoroutine(decision) or isinstance(decision, asyncio.Future):
                decision = await decision
            return decision
        if isinstance(effect, _AfterTurn):
            return await run_after_turn_async(agent.middleware, effect.summary)

        async def execute(request: ToolCallRequest) -> ToolCallResult:
            tool_item = _resolve_call(agent, effect, request)
            if isinstance(tool_item, Tool):
                if not isinstance(request.input, dict):
                    raise TypeError(f'tool "{request.name}" expects an object of arguments')
                return ToolCallResult(output=await tool_item.ainvoke(request.input))
            body = _remote_call_body(tool_item, request.input, agent.agent_id, agent.user_id)
            response = await self.client.post(
                f"{agent.core_url}/api/mcp/tools/call", json=body, headers=_core_headers(agent.core_token)
            )
            return ToolCallResult(output=_remote_reply(tool_item, response))

        return await compose_async(agent.middleware, "wrap_tool_call", execute)(effect.request)


# ── Harness (Core-owned) runs ─────────────────────────────────────────────────


class _HarnessTranslator:
    """Translate durable harness events into agent events."""

    def __init__(self, output: Optional[OutputContract]) -> None:
        self.output = output
        self.text = ""
        self.steps = 0

    def translate(self, event: Mapping[str, Any]) -> List[AgentEvent]:
        kind = event.get("type")
        if kind == "text_delta":
            delta = str(event.get("delta", ""))
            self.text += delta
            return [TextEvent(content=delta)]
        if kind == "tool_call_started":
            self.steps += 1
            return [ToolCallEvent(id=str(event.get("toolCallId", "")), name=str(event.get("name", "")), input={})]
        if kind == "tool_call_completed":
            output: Dict[str, Any] = {"ok": bool(event.get("ok"))}
            if event.get("resultHash"):
                output["resultHash"] = event["resultHash"]
            return [
                ToolResultEvent(id=str(event.get("toolCallId", "")), name=str(event.get("name", "")), output=output)
            ]
        if kind == "approval_requested":
            return [
                ApprovalRequestedEvent(
                    approval_id=str(event.get("approvalId", "")),
                    summary=str(event.get("summary", "")),
                    name="runtime",
                    options=list(event.get("options") or []),
                )
            ]
        if kind == "run_failed":
            return [ErrorEvent(message=str(event.get("message", "durable run failed")))]
        if kind == "run_canceled":
            return [ErrorEvent(message="durable run canceled")]
        if kind == "run_interrupted":
            return [ErrorEvent(message="durable run interrupted")]
        if kind == "run_completed":
            if self.output is None:
                return [ResultEvent(text=self.text, steps=self.steps)]
            reply = event.get("output")
            ok, value = read_structured_reply(self.text if reply is None else reply, self.output)
            if ok:
                return [ResultEvent(text=self.text, steps=self.steps, output=value)]
            return [
                ErrorEvent(
                    message=describe_structured_output_failure(value, 1),
                    code=STRUCTURED_OUTPUT_ERROR_CODE,
                    issues=value,
                    attempts=1,
                    text=self.text,
                )
            ]
        return []


def _select_option(decision: Any, options: List[Dict[str, Any]]) -> Tuple[bool, Optional[str]]:
    """Map a handler decision to ``(valid, option_id)``."""
    if isinstance(decision, str):
        option_id = decision.strip()
        if not option_id:
            return True, None
        if options and not any(option.get("optionId") == option_id for option in options):
            return False, None
        return True, option_id
    if not decision:
        return True, None
    for option in options:
        kind = str(option.get("kind", "")).lower().replace("-", "_")
        if kind in ("allow_once", "allow_always"):
            return True, option.get("optionId")
    return True, None


def _harness_request(event: ApprovalRequestedEvent) -> ApprovalRequest:
    return ApprovalRequest(
        approval_id=event.approval_id, name="runtime", input=None, summary=event.summary, options=event.options
    )


def _resolve_harness_approval_sync(
    client: HarnessClient, handler: ApprovalHandler, event: ApprovalRequestedEvent
) -> Optional[str]:
    try:
        decision = handler(_harness_request(event))
        valid, option_id = _select_option(decision, event.options)
        if not valid:
            return "approval handler returned an unknown option id"
        if not client.resolve_permission(event.approval_id, option_id):
            return "approval request is no longer active"
    except Exception as error:  # noqa: BLE001 - surfaced as a terminal event
        try:
            client.resolve_permission(event.approval_id)
        except Exception:  # noqa: BLE001 - best-effort denial
            pass
        return _describe_error(error)
    return None


async def _resolve_harness_approval_async(
    client: AsyncHarnessClient, handler: ApprovalHandler, event: ApprovalRequestedEvent
) -> Optional[str]:
    try:
        decision = handler(_harness_request(event))
        if asyncio.iscoroutine(decision):
            decision = await decision
        valid, option_id = _select_option(decision, event.options)
        if not valid:
            return "approval handler returned an unknown option id"
        if not await client.resolve_permission(event.approval_id, option_id):
            return "approval request is no longer active"
    except Exception as error:  # noqa: BLE001 - surfaced as a terminal event
        try:
            await client.resolve_permission(event.approval_id)
        except Exception:  # noqa: BLE001 - best-effort denial
            pass
        return _describe_error(error)
    return None
