"""Tools an :class:`~ryu_sdk.agent.Agent` can offer the model.

Two kinds feed the same OpenAI ``tools[]`` array, as in the TypeScript SDK
(``packages/sdk/src/agent/tools.ts``):

- **Local** tools are Python callables wrapped by :func:`tool`. Their JSON
  Schema is inferred from type hints (or a pydantic ``args_schema``) and they
  run in-process. Async functions are supported.
- **Remote** tools reference an existing Ryu tool by id (:func:`ryu_tool`, e.g.
  ``composio.GMAIL_SEARCH_EMAILS``). They execute through Core
  ``POST /api/mcp/tools/call``, which enforces the agent's allowlist, so they
  need the agent's Core ``agent_id``.

The model-facing function name is the tool's ``name`` (a dict key when tools
are passed as a mapping), never the raw Composio slug.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Union

from .schema import (
    JsonSchema,
    SchemaIssue,
    _type_hints,
    coerce_argument,
    format_schema_issues,
    function_parameters_schema,
    is_pydantic_model,
    json_schema_for,
    parse_docstring,
    to_jsonable,
    validate_json_schema,
)

_TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PERMISSIVE_OBJECT: JsonSchema = {"type": "object", "additionalProperties": True}


class ToolArgumentsError(ValueError):
    """The model's arguments did not satisfy the tool's schema."""

    def __init__(self, tool_name: str, issues: List[SchemaIssue]) -> None:
        super().__init__(f'tool "{tool_name}" arguments are invalid:\n{format_schema_issues(issues)}')
        self.issues = issues


def _ensure_object_schema(schema: JsonSchema) -> JsonSchema:
    if schema.get("type") not in (None, "object"):
        raise TypeError(f"tool parameters must be a JSON Schema object, got type {schema.get('type')!r}")
    return {"type": "object", **schema}


class Tool:
    """A local tool: a Python callable plus the schema the model sees."""

    kind = "local"

    def __init__(
        self,
        fn: Callable[..., Any],
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        args_schema: Any = None,
        needs_approval: bool = False,
    ) -> None:
        self.fn = fn
        self.name = name or fn.__name__
        if not _TOOL_NAME.match(self.name):
            raise ValueError(f"tool name {self.name!r} must be 1-64 characters of [A-Za-z0-9_-]")
        summary, _ = parse_docstring(inspect.getdoc(fn))
        self.description = description or summary or self.name
        self.needs_approval = needs_approval
        self._model_param: Optional[str] = None
        self._hints: Dict[str, Any] = {}
        if args_schema is not None:
            self._args_model = args_schema if is_pydantic_model(args_schema) else None
            self.parameters = _ensure_object_schema(
                dict(args_schema) if isinstance(args_schema, dict) else json_schema_for(args_schema)
            )
        else:
            self._args_model = None
            self._hints = _type_hints(fn)
            params = [
                parameter
                for parameter in inspect.signature(fn).parameters.values()
                if parameter.kind not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
            ]
            # A single pydantic-model parameter: the model *is* the argument object.
            if len(params) == 1 and is_pydantic_model(self._hints.get(params[0].name)):
                self._model_param = params[0].name
                self._args_model = self._hints[params[0].name]
                self.parameters = _ensure_object_schema(json_schema_for(self._args_model))
            else:
                self.parameters = function_parameters_schema(fn)

    @property
    def is_async(self) -> bool:
        return inspect.iscoroutinefunction(self.fn)

    def definition(self) -> Dict[str, Any]:
        """The OpenAI function-tool definition."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def _arguments(self, arguments: Mapping[str, Any]) -> Dict[str, Any]:
        if self._args_model is not None:
            from .schema import pydantic, _pydantic_issues

            try:
                model = self._args_model.model_validate(dict(arguments))
            except pydantic.ValidationError as error:
                raise ToolArgumentsError(self.name, _pydantic_issues(error)) from error
            if self._model_param is not None:
                return {self._model_param: model}
            return dict(model)
        issues = validate_json_schema(self.parameters, dict(arguments))
        if issues:
            raise ToolArgumentsError(self.name, issues)
        return {key: coerce_argument(self._hints.get(key, Any), value) for key, value in arguments.items()}

    def invoke(self, arguments: Mapping[str, Any]) -> Any:
        """Run the tool synchronously (an async tool runs on a fresh event loop)."""
        result = self.fn(**self._arguments(arguments))
        if inspect.isawaitable(result):
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                return to_jsonable(asyncio.run(_await(result)))
            raise RuntimeError(
                f'tool "{self.name}" is async; call it from Agent.agenerate()/Agent.stream() '
                "inside a running event loop"
            )
        return to_jsonable(result)

    async def ainvoke(self, arguments: Mapping[str, Any]) -> Any:
        """Run the tool from async code (a sync tool runs in a worker thread)."""
        kwargs = self._arguments(arguments)
        if self.is_async:
            return to_jsonable(await self.fn(**kwargs))
        result = await asyncio.get_running_loop().run_in_executor(None, lambda: self.fn(**kwargs))
        if inspect.isawaitable(result):
            result = await result
        return to_jsonable(result)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.fn(*args, **kwargs)

    def __repr__(self) -> str:
        return f"Tool(name={self.name!r})"


async def _await(awaitable: Any) -> Any:
    return await awaitable


def tool(
    fn: Optional[Callable[..., Any]] = None,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    args_schema: Any = None,
    needs_approval: bool = False,
) -> Any:
    """Turn a function into a :class:`Tool`.

    Usable bare (``@tool``) or with options (``@tool(name="search",
    needs_approval=True)``). The description defaults to the docstring summary,
    per-argument descriptions come from a Google-style ``Args:`` section or
    ``Annotated[T, "description"]``, and ``args_schema`` (a pydantic model or a
    JSON Schema dict) overrides inference.
    """

    def wrap(target: Callable[..., Any]) -> Tool:
        return Tool(
            target,
            name=name,
            description=description,
            args_schema=args_schema,
            needs_approval=needs_approval,
        )

    return wrap(fn) if fn is not None else wrap


@dataclass
class RemoteTool:
    """A reference to an existing Ryu tool, resolved and executed through Core."""

    id: str
    name: str
    description: Optional[str] = None
    parameters: Optional[JsonSchema] = None
    needs_approval: bool = False
    kind: str = "remote"

    def definition(self, described: Optional[str] = None) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description or described or self.id,
                "parameters": self.parameters or dict(_PERMISSIVE_OBJECT),
            },
        }


def ryu_tool(
    id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    parameters: Any = None,
    needs_approval: bool = False,
) -> RemoteTool:
    """Reference an existing Ryu tool by id so an agent can call it.

    ``parameters`` is a JSON Schema dict, a pydantic model, or a type hint.
    Without it a permissive object schema is sent (Core's describe endpoint is
    shallow), so supplying one improves the model's tool-call accuracy.
    """
    tool_name = name or re.sub(r"[^A-Za-z0-9_-]", "_", id.split(".")[-1])[:64]
    schema = None
    if parameters is not None:
        schema = _ensure_object_schema(
            dict(parameters) if isinstance(parameters, dict) else json_schema_for(parameters)
        )
    return RemoteTool(
        id=id,
        name=tool_name,
        description=description,
        parameters=schema,
        needs_approval=needs_approval,
    )


AgentTool = Union[Tool, RemoteTool]


def normalize_tools(
    tools: Union[None, Mapping[str, Any], Iterable[Any]],
) -> Dict[str, AgentTool]:
    """Key tools by model-facing name.

    Accepts a mapping (the key is the name, as in the TypeScript SDK) or a list
    of :class:`Tool` / :class:`RemoteTool`. Bare callables are wrapped with
    :func:`tool`.
    """
    if tools is None:
        return {}
    out: Dict[str, AgentTool] = {}
    items = tools.items() if isinstance(tools, Mapping) else ((None, item) for item in tools)
    for key, item in items:
        if isinstance(item, (Tool, RemoteTool)):
            resolved: AgentTool = item
        elif callable(item):
            resolved = Tool(item)
        else:
            raise TypeError(f"not a tool: {item!r}")
        tool_name = key or resolved.name
        if not _TOOL_NAME.match(tool_name):
            raise ValueError(f"tool name {tool_name!r} must be 1-64 characters of [A-Za-z0-9_-]")
        if tool_name != resolved.name:
            if isinstance(resolved, Tool):
                renamed = Tool.__new__(Tool)
                renamed.__dict__.update(resolved.__dict__)
                renamed.name = tool_name
                resolved = renamed
            else:
                resolved = RemoteTool(
                    id=resolved.id,
                    name=tool_name,
                    description=resolved.description,
                    parameters=resolved.parameters,
                    needs_approval=resolved.needs_approval,
                )
        if tool_name in out:
            raise ValueError(f"duplicate tool name {tool_name!r}")
        out[tool_name] = resolved
    return out


# ── Elicitation (connection-required) detection ───────────────────────────────


@dataclass
class Elicitation:
    """Ryu's connect-required envelope (e.g. first-run Gmail OAuth)."""

    url: Optional[str] = None
    message: Optional[str] = None
    kind: Optional[str] = None


def detect_elicitation(output: Any) -> Optional[Elicitation]:
    """Find ``{"__ryu_elicitation__": {...}}`` in a tool output (object or JSON text)."""
    if isinstance(output, str):
        try:
            output = json.loads(output)
        except ValueError:
            return None
    if not isinstance(output, dict):
        return None
    envelope = output.get("__ryu_elicitation__")
    if not isinstance(envelope, dict):
        return None
    fields = {}
    for key in ("url", "message", "kind"):
        value = envelope.get(key)
        if value is not None and not isinstance(value, str):
            return None
        fields[key] = value
    return Elicitation(**fields)
