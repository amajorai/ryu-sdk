"""The registry, tool selection, and how a tool runs, shared by every adapter.

``RYU_TOOLS`` joins each spec from ``manifest.json`` with its body. Running a
tool parses its arguments (a failure is a ``RyuInvalidRequestError`` with code
``invalid_arguments`` and the issues in ``details``), runs the body against the
client's object-mode view, and settles the outcome into a
:class:`~ryu_sdk.services.result.Result`. Nothing here raises for a service
failure: an adapter decides how to hand it to its host.
:func:`to_tool_result_json` is the model-facing projection the adapters return.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import queue
import threading
import time
from collections.abc import Generator, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import TYPE_CHECKING, Any, Literal, Optional, Protocol, Union, cast

from ..config import ENV_OPTION_NAMES, ENV_VARS, service_docs_url
from ..errors import RyuConfigurationError, RyuError, RyuInvalidRequestError, message_without_hint
from ..managed_agents import STREAM_READ_DEADLINE
from ..result import EMPTY_META, ResponseMeta, Result
from ._bodies import BODIES, Body, Collect, Collected
from ._manifest import TOOL_PREFIXES, TOOL_SERVICES, TOOL_SPECS, ToolAnnotations, ToolSpec
from ._validate import ToolInputIssue, parse_arguments

try:  # Python 3.8+
    from typing import TypedDict
except ImportError:  # pragma: no cover
    from typing_extensions import TypedDict

if TYPE_CHECKING:
    from ..client import AsyncRyu, Ryu

    #: A sync client in the default result mode: what :func:`run_ryu_tool` runs on.
    SyncToolClient = Ryu[Literal["throw"]]
    #: Either client in the default result mode. A ``Ryu(result="object")`` client is a type
    #: error here (and a ``RyuConfigurationError`` at runtime, for untyped callers).
    ToolClient = Union[Ryu[Literal["throw"]], AsyncRyu[Literal["throw"]]]


@dataclass(frozen=True)
class RyuTool:
    """One service tool: its spec (name, description, schema, annotations) and its body."""

    spec: ToolSpec
    body: Body

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def service(self) -> str:
        return self.spec.service

    @property
    def title(self) -> str:
        return self.spec.title

    @property
    def description(self) -> str:
        return self.spec.description

    @property
    def annotations(self) -> ToolAnnotations:
        return self.spec.annotations

    @property
    def input_schema(self) -> dict[str, Any]:
        """The JSON Schema of the arguments (a fresh copy; safe to modify)."""
        copied: dict[str, Any] = json.loads(json.dumps(self.spec.input_schema))
        return copied

    @property
    def credential_free(self) -> bool:
        """Whether the tool needs no credentials (always read-only): ``credentialFree``."""
        return self.spec.credential_free

    @property
    def output_schema(self) -> dict[str, Any]:
        """The JSON Schema of a successful result, ``{"data", "meta"}`` (the MCP ``outputSchema``;
        a fresh copy). ``properties.data`` is the schema of the ``data`` the adapters return."""
        copied: dict[str, Any] = json.loads(json.dumps(self.spec.output_schema))
        return copied


#: Every service tool, in registry order (the TypeScript ``RYU_TOOLS``).
RYU_TOOLS: tuple[RyuTool, ...] = tuple(RyuTool(spec, BODIES[spec.name]) for spec in TOOL_SPECS)
#: The service ids that have tools, in registry order.
RYU_TOOL_SERVICES: tuple[str, ...] = TOOL_SERVICES
#: The tool-name prefix of each service id.
RYU_TOOL_PREFIXES: Mapping[str, str] = TOOL_PREFIXES
#: Each service's tools, in registry order.
RYU_TOOLS_BY_SERVICE: Mapping[str, tuple[RyuTool, ...]] = {
    service: tuple(tool for tool in RYU_TOOLS if tool.service == service) for service in TOOL_SERVICES
}

_BY_NAME = {tool.name: tool for tool in RYU_TOOLS}
#: Python attribute names accepted in ``services=`` besides the service ids.
_SERVICE_ALIASES = {"managed_agents": "managedAgents"}


def get_ryu_tool(name: str) -> Optional[RyuTool]:
    """The registry tool called ``name``, or ``None``."""
    return _BY_NAME.get(name)


class CredentialProbe(Protocol):
    """What :func:`credential_free_ryu_tools` reads from a client (``Ryu`` or ``AsyncRyu``)."""

    def is_configured(self, service: str) -> bool: ...

    def can_call_without_credentials(self, service: str) -> bool: ...


def credential_free_ryu_tools(ryu: CredentialProbe, service: str) -> list[RyuTool]:
    """The credential-free tools of ``service`` (``credential_free``, read-only by rule) that
    ``ryu`` can call although ``service`` is not configured (``credentialFreeRyuTools``).

    Empty when ``service`` is configured (all of its tools apply), has no such tools, or
    ``ryu.can_call_without_credentials(service)`` is false (self-hosted Mail without its token,
    an invalid URL). What an MCP server registers for an unconfigured service; the adapters do
    not use it.
    """
    if ryu.is_configured(service) or not ryu.can_call_without_credentials(service):
        return []
    return [
        tool
        for tool in RYU_TOOLS_BY_SERVICE.get(service, ())
        if tool.credential_free and tool.annotations.read_only_hint
    ]


def default_needs_approval(tool: RyuTool) -> bool:
    """The default approval: every tool that is not read-only, and every open-world tool
    (``passport_fetch`` sends a stored login to an outside site)."""
    return not tool.annotations.read_only_hint or tool.annotations.open_world_hint


def ryu_tool_passes_filter(
    tool: RyuTool,
    *,
    read_only: bool,
    include: Optional[Sequence[str]] = None,
    exclude: Optional[Sequence[str]] = None,
) -> bool:
    """Whether one tool passes the read-only and include/exclude filter (``ryuToolPassesFilter``).
    A bare string in ``include``/``exclude`` is one tool name, not a sequence of characters."""
    include = _as_names(include)
    exclude = _as_names(exclude)
    if read_only and not tool.annotations.read_only_hint:
        return False
    if include is not None and tool.name not in include:
        return False
    return tool.name not in (exclude or ())


def _as_names(names: Optional[Sequence[str]]) -> Optional[list[str]]:
    """``names`` as a list; one string is one name (``include="notify_get_event"``)."""
    if names is None:
        return None
    return [names] if isinstance(names, str) else list(names)


def _service_of_name(name: str) -> Optional[str]:
    return next((service for service, prefix in TOOL_PREFIXES.items() if name.startswith(prefix)), None)


def _configuration_error(service: Optional[str], message: str, details: dict[str, Any]) -> RyuConfigurationError:
    # `service` is required on a RyuError; a name with no known prefix belongs to no service, so
    # the error says so in `details.service`.
    return RyuConfigurationError(message, service=service or "managedAgents", details={**details, "service": service})


def _setup_hint(ryu: Any, service: str) -> str:
    """What sets ``service`` up: its own configuration hint ("Set RYU_MAIL_URL ..."), or, for a
    service that resolves from a built-in default alone (Gateway's local URL), its variables."""
    try:
        _ = ryu._core.engine(service).config
    except RyuError as error:
        if error.hint:
            return f"{service}: {error.hint}"
    names = [row.name for row in ENV_VARS if row.service == service]
    options = " or ".join(ENV_OPTION_NAMES.get(name, name) for name in names)
    return f"{service}: Set {' or '.join(names)} (or pass {options} to Ryu()). See {service_docs_url(service)}."


def _check_names(option: str, names: Optional[Sequence[str]]) -> None:
    unknown = [name for name in names or () if name not in _BY_NAME]
    if unknown:
        raise _configuration_error(
            _service_of_name(unknown[0]),
            f"Unknown tool name in {option}: {', '.join(unknown)}. Tool names are listed in RYU_TOOLS.",
            {"option": option, "unknown": unknown},
        )


def _normalize_services(services: Optional[Sequence[str]]) -> Optional[list[str]]:
    if services is None:
        return None
    if isinstance(services, str):
        services = [services]
    normalized = [_SERVICE_ALIASES.get(service, service) for service in services]
    unknown = [original for original, service in zip(services, normalized) if service not in TOOL_PREFIXES]
    if unknown:
        raise _configuration_error(
            None,
            f"Unknown service in services: {', '.join(unknown)}. Services with tools: {', '.join(TOOL_SERVICES)}.",
            {"option": "services", "unknown": unknown},
        )
    if "connect" in normalized:
        raise _configuration_error(
            "connect",
            "Connect has no tools: it is an MCP server itself. Add ryu.connect.mcp() to your MCP client instead.",
            {"option": "services", "unknown": []},
        )
    return normalized


def _result_mode(ryu: Any) -> str:
    return str(getattr(ryu, "result", "throw"))


def select_ryu_tools(
    ryu: ToolClient,
    *,
    services: Optional[Sequence[str]] = None,
    include: Optional[Sequence[str]] = None,
    exclude: Optional[Sequence[str]] = None,
    read_only: bool = True,
) -> list[RyuTool]:
    """The registry tools an adapter should expose for ``ryu`` (``selectRyuTools``).

    ``read_only`` (default ``True``) keeps only tools that change nothing:
    tools that send email or SMS, charge credit, run a model or an agent, or
    stop, delete or overwrite something appear only with ``read_only=False``.
    ``services`` (service ids or Python names, e.g. ``"managed_agents"``)
    defaults to every service ``ryu`` is configured for. ``services``,
    ``include`` and ``exclude`` each take a sequence or one string. Raises
    ``RyuConfigurationError`` for an unknown service or tool name, for
    ``connect``, for a write tool in ``include`` while ``read_only`` is on, for
    a listed service ``ryu`` is not configured for, and for a client built with
    ``result="object"``, so a wrong option never silently hides a tool.
    """
    if _result_mode(ryu) != "throw":
        raise _configuration_error(
            None,
            'Service tools need a Ryu client in the default result mode; this one was built with result="object". '
            "Pass Ryu() (or Ryu(result='throw')).",
            {"option": "result", "resultMode": _result_mode(ryu)},
        )
    explicit = _normalize_services(services)
    include = _as_names(include)
    exclude = _as_names(exclude)
    _check_names("include", include)
    _check_names("exclude", exclude)
    if read_only:
        writes = [name for name in include or () if not _BY_NAME[name].annotations.read_only_hint]
        if writes:
            pronoun = "it" if len(writes) == 1 else "them"
            raise _configuration_error(
                _service_of_name(writes[0]),
                f"{', '.join(writes)} change state or reach the outside world; pass read_only=False to expose {pronoun}.",
                {"option": "include", "writes": writes},
            )
    if explicit is not None:
        missing = [service for service in explicit if not ryu.is_configured(service)]
        if missing:
            hints = " ".join(_setup_hint(ryu, service) for service in missing)
            raise _configuration_error(
                missing[0],
                f"Not configured: {', '.join(missing)}. {hints} Every service in services= must be configured; "
                "omit services= to get tools for the configured services only.",
                {"option": "services", "missing": missing},
            )
    chosen = explicit if explicit is not None else [service for service in TOOL_SERVICES if ryu.is_configured(service)]
    return [
        tool
        for tool in RYU_TOOLS
        if tool.service in chosen
        and ryu_tool_passes_filter(tool, read_only=read_only, include=include, exclude=exclude)
    ]


# ── Running a tool ────────────────────────────────────────────────────────────


def invalid_tool_input(tool: RyuTool, issues: Sequence[ToolInputIssue]) -> RyuInvalidRequestError:
    """The RyuError a call with arguments the tool's schema rejects answers with."""
    summary = "; ".join(
        issue["message"] if issue["path"] == "" else f"{issue['path']}: {issue['message']}" for issue in issues
    )
    return RyuInvalidRequestError(
        f"{tool.name} was called with invalid arguments: {summary}",
        service=tool.service,
        status=0,
        code="invalid_arguments",
        hint="Fix the arguments named in details.issues and call the tool again.",
        details={"tool": tool.name, "issues": list(issues)},
        retryable=False,
    )


def _to_ryu_error(error: BaseException, service: str) -> RyuError:
    if isinstance(error, RyuError):
        return error
    wrapped = RyuError(str(error) or type(error).__name__, service=service, code="client_error", retryable=False)
    wrapped.__cause__ = error
    return wrapped


def _settle(outcome: Any) -> Result[Any]:
    if isinstance(outcome, Result):
        return outcome
    return Result(outcome, None, EMPTY_META)


def _object_mode_failure(tool: RyuTool, ryu: Any) -> Optional[Result[Any]]:
    if _result_mode(ryu) == "throw":
        return None
    # An object-mode client resolves failures as data, which would turn a 401 into a successful tool result.
    error = RyuConfigurationError(
        f'{tool.name} needs a Ryu client in the default result mode; this one was built with result="object".',
        service=tool.service,
    )
    return Result(None, error, None)


def _prepare(
    ryu: Any, tool: Union[RyuTool, str], arguments: Any
) -> tuple[RyuTool, Optional[Result[Any]], dict[str, Any]]:
    resolved = tool if isinstance(tool, RyuTool) else get_ryu_tool(tool)
    if resolved is None:
        name = str(tool)
        error = RyuInvalidRequestError(
            f"Unknown tool {name!r}. Tool names are listed in RYU_TOOLS.",
            service=_service_of_name(name) or "managedAgents",
            code="unknown_tool",
            details={"tool": name},
            retryable=False,
        )
        return RYU_TOOLS[0], Result(None, error, None), {}
    failure = _object_mode_failure(resolved, ryu)
    if failure is not None:
        return resolved, failure, {}
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments) if arguments.strip() else {}
        except ValueError:
            issue: ToolInputIssue = {"code": "invalid_json", "path": "", "message": "The arguments are not valid JSON."}
            return resolved, Result(None, invalid_tool_input(resolved, [issue]), None), {}
    value, issues = parse_arguments(resolved.name, resolved.spec.input_schema, arguments)
    if value is None:
        return resolved, Result(None, invalid_tool_input(resolved, issues), None), {}
    return resolved, None, value


def _collect_sync(step: Collect) -> Collected:
    """Drains a blocking iterator on a worker thread, so the time bound holds while a read blocks.

    When the count is reached first, the worker closes the stream at its next item.
    A blocked read cannot be interrupted from another thread, so the worker runs
    with :data:`~ryu_sdk.services.managed_agents.STREAM_READ_DEADLINE` set to the
    bound: the session stream's reads time out there, and the worker closes the
    response and exits instead of holding a pooled connection until the next event.
    """
    items: queue.Queue[tuple[str, Any]] = queue.Queue()
    stop = threading.Event()
    iterable = step.open()
    deadline = time.monotonic() + step.timeout

    def drain() -> None:
        STREAM_READ_DEADLINE.set(deadline)
        iterator = iter(iterable)
        try:
            for item in iterator:
                items.put(("item", item))
                if stop.is_set():
                    return
            items.put(("done", None))
        except BaseException as error:  # noqa: BLE001 - handed to the caller's thread
            items.put(("error", error))
        finally:
            close = getattr(iterator, "close", None)
            if callable(close):
                close()

    worker = threading.Thread(target=drain, name="ryu-tool-collect", daemon=True)
    worker.start()
    events: list[Any] = []
    done = timed_out = False
    try:
        while len(events) < step.max_events:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                kind, value = items.get(timeout=remaining)
            except queue.Empty:
                timed_out = True
                break
            if kind == "item":
                events.append(value)
            elif kind == "done":
                done = True
                break
            else:
                raise value
    finally:
        stop.set()
    return Collected(events, done, timed_out)


async def _collect_async(step: Collect) -> Collected:
    iterator = step.open().__aiter__()
    events: list[Any] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + step.timeout
    done = timed_out = False
    try:
        while len(events) < step.max_events:
            remaining = deadline - loop.time()
            if remaining <= 0:
                timed_out = True
                break
            try:
                events.append(await asyncio.wait_for(iterator.__anext__(), remaining))
            except StopAsyncIteration:
                done = True
                break
            except asyncio.TimeoutError:
                timed_out = True
                break
    finally:
        close = getattr(iterator, "aclose", None)
        if callable(close) and not done:
            try:
                await close()
            except (RuntimeError, asyncio.CancelledError):  # already closed by the cancelled read
                pass
    return Collected(events, done, timed_out)


def _drive_sync(generator: Generator[Any, Any, Any]) -> Any:
    reply: Any = None
    while True:
        try:
            step = generator.send(reply)
        except StopIteration as stop:
            return stop.value
        reply = _collect_sync(step) if isinstance(step, Collect) else step


async def _drive_async(generator: Generator[Any, Any, Any]) -> Any:
    reply: Any = None
    while True:
        try:
            step = generator.send(reply)
        except StopIteration as stop:
            return stop.value
        if isinstance(step, Collect):
            reply = await _collect_async(step)
        elif inspect.isawaitable(step):
            reply = await step
        else:
            reply = step


def run_ryu_tool(ryu: SyncToolClient, tool: Union[RyuTool, str], arguments: Any = None) -> Result[Any]:
    """Validates ``arguments`` (a dict or a JSON string) and runs ``tool`` on a sync ``Ryu``.

    Returns the SDK's ``Result(data, error, meta)``; never raises for a service
    failure or bad arguments (``invalid_arguments``).
    """
    if getattr(ryu, "_is_async", False):
        raise TypeError("run_ryu_tool needs a Ryu client; use `await arun_ryu_tool(...)` with AsyncRyu.")
    resolved, failure, value = _prepare(ryu, tool, arguments)
    if failure is not None:
        return failure
    try:
        return _settle(_drive_sync(resolved.body(ryu.safe, value)))
    except Exception as error:  # noqa: BLE001 - every failure becomes the tool's error
        return Result(None, _to_ryu_error(error, resolved.service), None)


async def arun_ryu_tool(ryu: ToolClient, tool: Union[RyuTool, str], arguments: Any = None) -> Result[Any]:
    """:func:`run_ryu_tool` for ``AsyncRyu`` (a sync ``Ryu`` runs on a worker thread)."""
    if not getattr(ryu, "_is_async", False):
        sync_client = cast("SyncToolClient", ryu)
        return await asyncio.get_running_loop().run_in_executor(None, run_ryu_tool, sync_client, tool, arguments)
    resolved, failure, value = _prepare(ryu, tool, arguments)
    if failure is not None:
        return failure
    try:
        return _settle(await _drive_async(resolved.body(ryu.safe, value)))
    except Exception as error:  # noqa: BLE001 - every failure becomes the tool's error
        return Result(None, _to_ryu_error(error, resolved.service), None)


# ── The model-facing projection ───────────────────────────────────────────────


class ToolMetaJSON(TypedDict, total=False):
    """A tool result's meta as a model sees it: each field only when set."""

    requestId: str
    idempotencyKey: str
    #: The server answered from an earlier call with the same idempotency key.
    replayed: bool


class _ToolErrorRequired(TypedDict):
    code: str
    message: str
    service: str
    #: The HTTP status; 0 when no response arrived (bad arguments, timeout).
    status: int
    retryable: bool


class ToolErrorJSON(_ToolErrorRequired, total=False):
    """A tool error as a model sees it: the fields it can act on, never keys, headers or URLs."""

    hint: str
    details: Any
    requestId: str
    #: Seconds to wait before retrying, when the service said.
    retryAfterSeconds: float


class ToolResultJSON(TypedDict):
    """A tool result as compact plain JSON: ``{"data", "error", "meta"}``."""

    data: Any
    error: Optional[ToolErrorJSON]
    meta: ToolMetaJSON


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", errors="replace")
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return str(value)


def to_plain_json(value: Any) -> Any:
    """Round-trips ``value`` through JSON, so a result holds only JSON values."""
    loaded: Any = json.loads(json.dumps(value, default=_json_default))
    return loaded


def to_tool_meta_json(meta: Optional[ResponseMeta]) -> ToolMetaJSON:
    """The meta fields a model can use, each only when set."""
    out: ToolMetaJSON = {}
    if meta is not None and meta.request_id:
        out["requestId"] = meta.request_id
    if meta is not None and meta.idempotency_key:
        out["idempotencyKey"] = meta.idempotency_key
    if meta is not None and meta.replayed:
        out["replayed"] = True
    return out


def to_tool_error_json(error: RyuError) -> ToolErrorJSON:
    """The error fields a model can act on; never keys, headers or URLs.

    The hint has its own field, so ``message`` is the error's message without it.
    """
    out: ToolErrorJSON = {
        "code": error.code,
        "message": message_without_hint(error),
        "service": error.service,
        "status": error.status,
        "retryable": bool(error.retryable),
    }
    if error.hint:
        out["hint"] = error.hint
    if error.details is not None:
        out["details"] = to_plain_json(error.details)
    if error.request_id:
        out["requestId"] = error.request_id
    if isinstance(error.retry_after_seconds, (int, float)) and not isinstance(error.retry_after_seconds, bool):
        out["retryAfterSeconds"] = error.retry_after_seconds
    return out


def to_tool_result_json(result: Result[Any]) -> ToolResultJSON:
    """Projects a tool's Result for a model: ``{"data", "error", "meta"}`` (``toToolResultJson``)."""
    if result.error is None:
        return {"data": to_plain_json(result.data), "error": None, "meta": to_tool_meta_json(result.meta)}
    return {"data": None, "error": to_tool_error_json(result.error), "meta": to_tool_meta_json(result.meta)}
