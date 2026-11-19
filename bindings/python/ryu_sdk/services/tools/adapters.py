"""The registry's tools in the shapes agent hosts take.

- :func:`to_ryu_agent_tools`: ``ryu_sdk`` :class:`~ryu_sdk.tools.Tool` objects,
  keyed by tool name, for ``Agent(tools=...)``;
- :func:`to_openai_tools`: OpenAI function-calling definitions (Chat
  Completions, or the Responses API with ``api="responses"``);
- :func:`to_anthropic_tools`: Anthropic Messages API tool definitions.

The function-calling lists are plain lists of dicts you pass as ``tools``,
with ``execute(name, arguments)`` (``aexecute`` on ``AsyncRyu``) to run the
call the model asked for. Every adapter returns the compact
``{"data", "error", "meta"}`` JSON and never raises for a service failure or
bad arguments, so the model sees ``error.code``, ``error.message`` and
``error.hint``. Only the selected tools run: a name the model invents, or a
write tool left out by ``read_only``, answers with ``unknown_tool``; a tool
that needs approval answers with ``approval_required`` until the host approves
the call (``execute(..., approved=True)`` or an ``approve`` callback).

Each tool's output JSON Schema (the MCP ``outputSchema``, ``{"data", "meta"}``)
is ``RyuServiceTool.output_schema`` and ``RyuFunctionTools.output_schema(name)``.
The OpenAI and Anthropic tool definitions carry no output schema, so it is not
added to them.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Awaitable, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Callable, Literal, Optional, Union

from ...tools import Tool
from ..errors import RyuInvalidRequestError, RyuPermissionError
from ..result import Result
from ._manifest import ToolAnnotations
from ._run import (
    RyuTool,
    ToolResultJSON,
    _service_of_name,
    arun_ryu_tool,
    default_needs_approval,
    run_ryu_tool,
    select_ryu_tools,
    to_tool_result_json,
)

if TYPE_CHECKING:
    from ._run import ToolClient

#: ``True``/``False`` for every tool, or a function deciding per tool. Default:
#: :func:`~ryu_sdk.services.tools.default_needs_approval` (not read-only, or open-world).
ApprovalOption = Union[bool, Callable[[RyuTool], bool]]
#: ``approve(tool, arguments) -> bool``: whether :meth:`RyuFunctionTools.execute` may run a call that
#: needs approval (ask the user here). ``arguments`` is the parsed dict (or the raw text when it is
#: not JSON). It may be a coroutine function with ``aexecute``.
ApproveCallback = Callable[[RyuTool, Any], Union[bool, Awaitable[bool]]]
#: Which OpenAI API the definitions are for.
OpenAIApi = Literal["chat_completions", "responses"]


def _needs_approval(tool: RyuTool, option: Optional[ApprovalOption]) -> bool:
    if callable(option):
        return bool(option(tool))
    return default_needs_approval(tool) if option is None else bool(option)


def _is_async(ryu: Any) -> bool:
    return bool(getattr(ryu, "_is_async", False))


def _pass_arguments(arguments: Mapping[str, Any]) -> dict[str, Any]:
    # The registry validates (zod's rules, issues as data); the Agent's own JSON-schema check is skipped.
    return dict(arguments)


class RyuServiceTool(Tool):
    """A registry tool as a ``ryu_sdk`` Agent tool.

    It validates its own arguments, so a rejected argument reaches the model as
    ``invalid_arguments`` in the tool result instead of ending the run, and it
    runs with your ``Ryu`` (``invoke``) or ``AsyncRyu`` (``ainvoke``) client in
    your process. It cannot be packed into a plugin.

    The wrapped function carries the behaviour (a coroutine function on
    ``AsyncRyu``), so a plain :class:`~ryu_sdk.tools.Tool` copy, as
    ``Agent(tools={"alias": tool})`` makes when it renames one, runs the same way.
    """

    def __init__(self, ryu: ToolClient, tool: RyuTool, *, needs_approval: bool) -> None:
        self._ryu: Any = ryu
        #: The registry tool.
        self.ryu_tool = tool
        #: The human title, e.g. "Publish a Notify event".
        self.title = tool.title
        #: The tool's effects, as in MCP.
        self.annotations: ToolAnnotations = tool.annotations
        #: The service id the tool calls.
        self.service = tool.service
        #: The JSON Schema of a successful result, ``{"data", "meta"}`` (the MCP ``outputSchema``).
        #: The result also carries ``"error": None``; a tool error has ``data: None`` instead.
        self.output_schema: dict[str, Any] = tool.output_schema
        super().__init__(
            self._arun_kwargs if _is_async(ryu) else self._run_kwargs,
            name=tool.name,
            description=tool.description,
            args_schema=tool.input_schema,
            needs_approval=needs_approval,
        )
        # An instance attribute (not a method override), so normalize_tools' plain-Tool copy keeps it.
        self.__dict__["_arguments"] = _pass_arguments

    def _run_kwargs(self, **arguments: Any) -> ToolResultJSON:
        return to_tool_result_json(run_ryu_tool(self._ryu, self.ryu_tool, arguments))

    async def _arun_kwargs(self, **arguments: Any) -> ToolResultJSON:
        return to_tool_result_json(await arun_ryu_tool(self._ryu, self.ryu_tool, arguments))

    def invoke(self, arguments: Mapping[str, Any]) -> ToolResultJSON:
        """Runs the tool on a sync ``Ryu``; returns ``{"data", "error", "meta"}``."""
        if _is_async(self._ryu):
            raise TypeError(
                f'tool "{self.name}" runs on AsyncRyu; call it from Agent.agenerate()/Agent.stream(), '
                "or build the tools from a sync Ryu"
            )
        return self._run_kwargs(**arguments)

    async def ainvoke(self, arguments: Mapping[str, Any]) -> ToolResultJSON:
        """Runs the tool from async code (a sync ``Ryu`` runs on a worker thread)."""
        return to_tool_result_json(await arun_ryu_tool(self._ryu, self.ryu_tool, dict(arguments)))

    def __repr__(self) -> str:
        return f"RyuServiceTool(name={self.name!r})"


def to_ryu_agent_tools(
    ryu: ToolClient,
    *,
    services: Optional[Sequence[str]] = None,
    include: Optional[Sequence[str]] = None,
    exclude: Optional[Sequence[str]] = None,
    read_only: bool = True,
    needs_approval: Optional[ApprovalOption] = None,
) -> dict[str, RyuServiceTool]:
    """The service tools for ``ryu`` as ``ryu_sdk`` Agent tools, keyed by tool name.

    Read-only tools only unless ``read_only=False``. ``needs_approval`` makes the
    Agent ask its approval handler first; by default every tool that is not
    read-only or is open-world asks. See :func:`select_ryu_tools` for the
    selection options and the errors they raise.
    """
    selected = select_ryu_tools(ryu, services=services, include=include, exclude=exclude, read_only=read_only)
    return {
        tool.name: RyuServiceTool(ryu, tool, needs_approval=_needs_approval(tool, needs_approval)) for tool in selected
    }


def _parsed_arguments(arguments: Any) -> Any:
    if isinstance(arguments, str):
        try:
            return json.loads(arguments) if arguments.strip() else {}
        except ValueError:
            return arguments
    return {} if arguments is None else arguments


class RyuFunctionTools(list[Any]):
    """Function-calling tool definitions (pass the list as ``tools``) plus their dispatcher.

    Each item is a plain ``dict`` in the shape the adapter documents. The items
    are typed ``Any`` on purpose, so that
    ``client.chat.completions.create(..., tools=tools)``,
    ``client.responses.create(..., tools=tools)`` and
    ``client.messages.create(..., tools=tools)`` pass ``mypy --strict``. The
    OpenAI and Anthropic SDKs type ``tools=`` as an iterable of their own
    ``TypedDict`` unions. A ``Dict[str, Any]`` item is not assignable to those.
    A ``TypedDict`` of ours would be assignable only while it repeats every
    optional key of the vendor's own ``TypedDict``, so it would break whenever
    a vendor adds a key: a minimal mirror of Anthropic's ``ToolParam``
    (``name``, ``description``, ``input_schema``) is already rejected because
    ``ToolParam`` declares more optional keys. The cost is that indexing or
    iterating the list gives ``Any``, not ``Dict[str, Any]``.

    :meth:`execute` and :meth:`aexecute` refuse a tool that needs approval
    (:meth:`needs_approval`) with an ``approval_required`` tool error, unless
    the call passes ``approved=True`` or the adapter's ``approve`` callback
    returns ``True`` for it.
    """

    def __init__(
        self,
        ryu: ToolClient,
        tools: Sequence[RyuTool],
        definitions: Sequence[dict[str, Any]],
        approvals: Mapping[str, bool],
        approve: Optional[ApproveCallback] = None,
    ) -> None:
        super().__init__(definitions)
        self._ryu: Any = ryu
        self._tools: dict[str, RyuTool] = {tool.name: tool for tool in tools}
        self._approvals = dict(approvals)
        self._approve = approve

    @property
    def names(self) -> list[str]:
        """The selected tool names, in registry order."""
        return list(self._tools)

    def tool(self, name: str) -> Optional[RyuTool]:
        """The selected registry tool called ``name``, or ``None``."""
        return self._tools.get(name)

    def output_schema(self, name: str) -> Optional[dict[str, Any]]:
        """The JSON Schema of a successful ``execute(name, ...)`` result's ``data`` and ``meta``
        (the MCP ``outputSchema``; a fresh copy), or ``None`` for a name that is not offered.

        Its root allows only ``data`` and ``meta``: validate ``{"data": ..., "meta": ...}`` taken
        from the result, which also carries ``"error": None`` on success."""
        tool = self._tools.get(name)
        return None if tool is None else tool.output_schema

    def needs_approval(self, name: str) -> bool:
        """Whether a person must approve a call to ``name`` before :meth:`execute` runs it.

        ``False`` for a name that is not offered (see :attr:`names`): :meth:`execute` refuses it
        with ``unknown_tool`` before any approval step, so there is nothing to ask a person about.
        """
        return self._approvals.get(name, False)

    def _unknown(self, name: str) -> Optional[ToolResultJSON]:
        if name in self._tools:
            return None
        error = RyuInvalidRequestError(
            f"Unknown tool {name!r}: it is not one of the tools offered ({', '.join(self._tools) or 'none'}).",
            service=_service_of_name(name) or "managedAgents",
            code="unknown_tool",
            hint="Call one of the offered tools by its exact name.",
            details={"tool": name},
            retryable=False,
        )
        return to_tool_result_json(Result(None, error, None))

    def _approval_required(self, tool: RyuTool) -> ToolResultJSON:
        error = RyuPermissionError(
            f"{tool.name} needs a person's approval before it runs; it was not run.",
            service=tool.service,
            status=0,
            code="approval_required",
            hint="Ask the user to approve this call. The host runs it with execute(name, arguments, approved=True).",
            details={"tool": tool.name},
            retryable=False,
        )
        return to_tool_result_json(Result(None, error, None))

    def execute(self, name: str, arguments: Any = None, *, approved: bool = False) -> ToolResultJSON:
        """Runs the model's call on a sync ``Ryu``. ``arguments`` is a dict or the JSON string the
        model produced. A tool that needs approval runs only with ``approved=True`` or when the
        adapter's ``approve`` callback allows it; otherwise the result is an ``approval_required``
        error and nothing is sent. Returns ``{"data", "error", "meta"}``; never raises for a
        service failure."""
        if _is_async(self._ryu):
            raise TypeError("these tools run on AsyncRyu; use `await tools.aexecute(name, arguments)`")
        unknown = self._unknown(name)
        if unknown is not None:
            return unknown
        tool = self._tools[name]
        if self._approvals[name] and not approved:
            allowed = self._approve(tool, _parsed_arguments(arguments)) if self._approve is not None else False
            if inspect.isawaitable(allowed):
                close = getattr(allowed, "close", None)
                if callable(close):
                    close()  # the coroutine will never run; close it so Python does not warn
                raise TypeError("an async approve callback needs `await tools.aexecute(...)`")
            if allowed is not True:
                return self._approval_required(tool)
        return to_tool_result_json(run_ryu_tool(self._ryu, tool, arguments))

    async def aexecute(self, name: str, arguments: Any = None, *, approved: bool = False) -> ToolResultJSON:
        """:meth:`execute` from async code (a sync ``Ryu`` runs on a worker thread); the ``approve``
        callback may be a coroutine function here."""
        unknown = self._unknown(name)
        if unknown is not None:
            return unknown
        tool = self._tools[name]
        if self._approvals[name] and not approved:
            allowed = self._approve(tool, _parsed_arguments(arguments)) if self._approve is not None else False
            if inspect.isawaitable(allowed):
                allowed = await allowed
            if allowed is not True:
                return self._approval_required(tool)
        return to_tool_result_json(await arun_ryu_tool(self._ryu, tool, arguments))


def _function_tools(
    ryu: ToolClient,
    shape: Callable[[RyuTool], dict[str, Any]],
    *,
    services: Optional[Sequence[str]],
    include: Optional[Sequence[str]],
    exclude: Optional[Sequence[str]],
    read_only: bool,
    needs_approval: Optional[ApprovalOption],
    approve: Optional[ApproveCallback],
) -> RyuFunctionTools:
    selected = select_ryu_tools(ryu, services=services, include=include, exclude=exclude, read_only=read_only)
    approvals = {tool.name: _needs_approval(tool, needs_approval) for tool in selected}
    return RyuFunctionTools(ryu, selected, [shape(tool) for tool in selected], approvals, approve)


def to_openai_tools(
    ryu: ToolClient,
    *,
    api: OpenAIApi = "chat_completions",
    services: Optional[Sequence[str]] = None,
    include: Optional[Sequence[str]] = None,
    exclude: Optional[Sequence[str]] = None,
    read_only: bool = True,
    needs_approval: Optional[ApprovalOption] = None,
    approve: Optional[ApproveCallback] = None,
) -> RyuFunctionTools:
    """The service tools as OpenAI function tools, with ``execute(name, arguments)``.

    ``api="chat_completions"`` (default) gives ``{"type": "function", "function":
    {"name", "description", "parameters"}}``; ``api="responses"`` gives the
    Responses API's flat ``{"type": "function", "name", "description",
    "parameters"}``. Read-only tools only unless ``read_only=False``.
    ``execute`` refuses a tool that needs approval (``needs_approval``; by default
    every write tool and the open-world ``passport_fetch``) with an
    ``approval_required`` error unless the call passes ``approved=True`` or
    ``approve(tool, arguments)`` returns ``True``.
    """
    if api not in ("chat_completions", "responses"):
        raise ValueError(f"api must be 'chat_completions' or 'responses' (got {api!r})")

    def shape(tool: RyuTool) -> dict[str, Any]:
        function = {"name": tool.name, "description": tool.description, "parameters": tool.input_schema}
        if api == "responses":
            return {"type": "function", **function}
        return {"type": "function", "function": function}

    return _function_tools(
        ryu,
        shape,
        services=services,
        include=include,
        exclude=exclude,
        read_only=read_only,
        needs_approval=needs_approval,
        approve=approve,
    )


def to_anthropic_tools(
    ryu: ToolClient,
    *,
    services: Optional[Sequence[str]] = None,
    include: Optional[Sequence[str]] = None,
    exclude: Optional[Sequence[str]] = None,
    read_only: bool = True,
    needs_approval: Optional[ApprovalOption] = None,
    approve: Optional[ApproveCallback] = None,
) -> RyuFunctionTools:
    """The service tools as Anthropic Messages API tools (``{"name", "description",
    "input_schema"}``), with ``execute(name, input)``. Read-only tools only unless
    ``read_only=False``. Approval works as in :func:`to_openai_tools`."""

    def shape(tool: RyuTool) -> dict[str, Any]:
        return {"name": tool.name, "description": tool.description, "input_schema": tool.input_schema}

    return _function_tools(
        ryu,
        shape,
        services=services,
        include=include,
        exclude=exclude,
        read_only=read_only,
        needs_approval=needs_approval,
        approve=approve,
    )


__all__ = [
    "ApprovalOption",
    "ApproveCallback",
    "OpenAIApi",
    "RyuFunctionTools",
    "RyuServiceTool",
    "to_anthropic_tools",
    "to_openai_tools",
    "to_ryu_agent_tools",
]
