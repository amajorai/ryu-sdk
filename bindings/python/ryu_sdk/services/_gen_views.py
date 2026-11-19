"""Generates ``views.py``: typed views of every ``ryu.<namespace>`` for type checkers.

The client's namespaces are one set of classes for four behaviours: sync or
async, raising or returning ``Result``. ``views.py`` gives each namespace and
resource four ``Protocol`` views whose methods return ``T``, ``Result[T]``,
``Awaitable[T]`` and ``Awaitable[Result[T]]``; ``Ryu``/``AsyncRyu`` pick one
by the client class and its ``result`` mode. Parameters are copied from the
live methods, and return types come from ``RETURNS`` (or ``OVERLOADS``) below;
a method not listed there keeps its parameters and returns ``Any``. Views have
no ``__getattr__`` fallback, so a misspelt method is a type error.

Regenerate after changing a namespace's methods or ``RETURNS``
(``tests/test_services_typing.py`` fails when the file is stale)::

    PYTHONPATH=bindings/python python -m ryu_sdk.services._gen_views > bindings/python/ryu_sdk/services/views.py
"""

from __future__ import annotations

import inspect
import re
from typing import Any

from ._base import Resource
from .client import NAMESPACES, Ryu

#: ``path`` -> return type. ``T`` is a call (wrapped per view); ``plain:T`` returns ``T`` in every
#: view (no request, or a local value); ``stream:T`` is ``Generator[T, None, None]`` / ``AsyncGenerator[T, None]``
#: (every async stream is an async generator, so ``contextlib.aclosing`` type-checks on it);
#: ``pages:T`` is an ``iterate()`` result (``PageIterator[T]`` / ``AsyncPageIterator[T]``), never
#: wrapped in ``Result``. ``<resource>.__call__`` types a callable resource (``ryu.connect.usage(...)``).
RETURNS: dict[str, str] = {
    # Managed Agents
    "managed_agents.agents.create": "ManagedAgent",
    "managed_agents.agents.list": "ManagedAgentPage",
    "managed_agents.agents.get": "ManagedAgent",
    "managed_agents.agents.update": "ManagedAgent",
    "managed_agents.agents.archive": "ManagedAgent",
    "managed_agents.agents.iterate": "pages:ManagedAgent",
    "managed_agents.environments.create": "ManagedAgentEnvironment",
    "managed_agents.environments.list": "ManagedAgentEnvironmentPage",
    "managed_agents.environments.get": "ManagedAgentEnvironment",
    "managed_agents.environments.iterate": "pages:ManagedAgentEnvironment",
    "managed_agents.sessions.create": "ManagedAgentSession",
    "managed_agents.sessions.list": "ManagedAgentSessionPage",
    "managed_agents.sessions.get": "ManagedAgentSession",
    "managed_agents.sessions.iterate": "pages:ManagedAgentSession",
    "managed_agents.sessions.update": "ManagedAgentSession",
    "managed_agents.sessions.send": "list[ManagedAgentEvent]",
    "managed_agents.sessions.send_message": "list[ManagedAgentEvent]",
    "managed_agents.sessions.respond_to_approval": "ManagedAgentEvent",
    "managed_agents.sessions.approve_tool": "ManagedAgentEvent",
    "managed_agents.sessions.deny_tool": "ManagedAgentEvent",
    "managed_agents.sessions.events": "ManagedAgentEventPage",
    "managed_agents.sessions.cancel": "ManagedAgentSession",
    "managed_agents.sessions.complete": "ManagedAgentSession",
    "managed_agents.sessions.stream": "stream:ManagedAgentEvent",
    "managed_agents.sessions.follow": "stream:ManagedAgentEvent",
    "managed_agents.sessions.run": "ManagedAgentsRunResult",
    # Messaging
    "messaging.status": "MessagingStatus",
    "messaging.quote": "MessagingQuote",
    "messaging.sms.send": "MessagingMessage",
    "messaging.mms.send": "MessagingMessage",
    "messaging.voice.send": "MessagingMessage",
    "messaging.whatsapp.send": "MessagingMessage",
    "messaging.messages.list": "MessagingMessagePage",
    "messaging.messages.get": "MessagingMessage",
    "messaging.messages.iterate": "pages:MessagingMessage",
    "messaging.opt_outs.iterate": "pages:dict[str, Any]",
    "messaging.numbers.list": "list[MessagingNumber]",
    "messaging.numbers.buy": "MessagingNumber",
    "messaging.numbers.update": "MessagingNumber",
    "messaging.numbers.release": "MessagingNumber",
    # Mail
    "mail.status": "MailStatus",
    "mail.send": "MailMessage",
    "mail.create_realtime_ticket": "MailRealtimeTicket",
    "mail.inboxes.list": "list[MailInbox]",
    "mail.inboxes.get": "MailInbox",
    "mail.inboxes.create": "MailInbox",
    "mail.inboxes.update": "MailInbox",
    "mail.messages.list": "list[MailMessage]",
    "mail.messages.search": "list[MailMessage]",
    "mail.messages.iterate": "pages:MailMessage",
    "mail.messages.get": "MailMessage",
    "mail.messages.send": "MailMessage",
    "mail.messages.reply": "MailMessage",
    "mail.messages.reply_all": "MailMessage",
    "mail.messages.forward": "MailMessage",
    # Notify
    "notify.publish": "NotifyEvent",
    "notify.request_approval": "NotifyApprovalResult",
    "notify.usage": "NotifyUsageReport",
    "notify.events.list": "NotifyEventPage",
    "notify.events.get": "NotifyEvent",
    "notify.events.iterate": "pages:NotifyEvent",
    "notify.events.acknowledge": "NotifyEvent",
    "notify.events.archive": "NotifyEvent",
    "notify.events.unarchive": "NotifyEvent",
    "notify.events.respond": "NotifyEvent",
    "notify.events.cancel_response": "NotifyEvent",
    "notify.events.stream": "stream:dict[str, Any]",
    "notify.topics.list": "list[NotifyTopic]",
    "notify.topics.publish": "NotifyEvent",
    # Box
    "box.list": "list[Box]",
    "box.get": "Box",
    "box.create": "Box",
    "box.delete": "None",
    "box.stop": "None",
    "box.resume": "Box",
    "box.fork": "Box",
    "box.wait_until_ready": "Box",
    "box.exec": "BoxExecResult",
    "box.exec_stream": "stream:dict[str, Any]",
    "box.run": "BoxRun",
    "box.files.read": "bytes",
    "box.files.read_text": "str",
    # Gateway
    "gateway.models.list": "GatewayModelList",
    "gateway.chat.completions.stream": "stream:dict[str, Any]",
    "gateway.openai_compatible": "plain:GatewayOpenAICompatibleConfig",
    # Connect
    "connect.mcp": "plain:ConnectMcpConfig",
    "connect.usage.__call__": "ConnectUsageReport",
    "connect.usage.iterate": "pages:ConnectUsageLine",
    # Passport
    "passport.profiles.list": "PassportProfileList",
    "passport.connections.list": "PassportConnectionList",
    "passport.connections.get": "PassportConnection",
    "passport.connections.import_state": "PassportConnection",
    "passport.connections.fetch": "PassportFetchResult",
    "passport.runtime.connections.list": "PassportConnectionList",
    "passport.runtime.connections.fetch": "PassportFetchResult",
    "passport.runtime.connections.has_runtime_grant": "plain:bool",
    "passport.runtime.connections.is_configured": "plain:bool",
    # Sites
    "sites.status": "SitesStatus",
    "sites.deploy": "SitesDeployResult",
    "sites.projects.list": "list[SitesProject]",
    "sites.projects.get": "SitesProject",
    "sites.projects.create": "SitesProject",
    "sites.projects.update_settings": "SitesProject",
    "sites.projects.make_public": "SitesProject",
}

#: ``path`` -> ``[(parameters after self, return spec), ...]``: methods whose return depends on an
#: argument, declared as ``@overload``s instead of one ``RETURNS`` row.
OVERLOADS: dict[str, list[tuple[str, str]]] = {
    # ``stream=True`` returns the chunk iterator (raising in both result modes); otherwise the
    # completion. Pass ``stream`` as a keyword (or call ``.stream()``) for the iterator type.
    "gateway.chat.completions.create": [
        ("params: Optional[Mapping[str, Any]] = ..., *, stream: Literal[True], **kwargs: Any", "stream:dict[str, Any]"),
        (
            "params: Optional[Mapping[str, Any]] = ..., *, stream: Literal[False] = ..., **kwargs: Any",
            "GatewayChatCompletion",
        ),
    ],
}

#: Names an annotation may use, and where views.py imports them from.
_IMPORTS: dict[str, str] = {
    **{name: "typing" for name in ("Any", "Callable", "Literal", "Optional", "Union")},
    **{name: "collections.abc" for name in ("Mapping", "Sequence")},
    "ToolApprovalHandler": ".managed_agents",
}
#: Builtins an annotation may name without an import (PEP 585 generics included).
_BUILTINS = {"None", "str", "int", "float", "bool", "bytes", "self", "dict", "list", "tuple", "set"}
_VARIANTS = (
    # (class-name prefix, class-name suffix, is_async, object_mode)
    ("", "API", False, False),
    ("", "ResultAPI", False, True),
    ("Async", "API", True, False),
    ("Async", "ResultAPI", True, True),
)
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _class_stem(path: str) -> str:
    return "".join(part.capitalize() for segment in path.split(".") for part in segment.split("_"))


def _class_name(path: str, variant: tuple[str, str, bool, bool]) -> str:
    prefix, suffix, _is_async, _object_mode = variant
    return f"{prefix}{_class_stem(path)}{suffix}"


def _wrap(spec: str, variant: tuple[str, str, bool, bool]) -> str:
    _prefix, _suffix, is_async, object_mode = variant
    if spec.startswith("plain:"):
        return spec[len("plain:") :]
    if spec.startswith("stream:"):
        item = spec[len("stream:") :]
        return f"AsyncGenerator[{item}, None]" if is_async else f"Generator[{item}, None, None]"
    if spec.startswith("pages:"):
        item = spec[len("pages:") :]
        return f"AsyncPageIterator[{item}]" if is_async else f"PageIterator[{item}]"
    inner = f"Result[{spec}]" if object_mode else spec
    return f"Awaitable[{inner}]" if is_async else inner


def _parameters(method: Any, used: set[str]) -> str:
    rendered: list[str] = ["self"]
    marked_keyword_only = False
    for parameter in inspect.signature(method).parameters.values():
        annotation = parameter.annotation
        text = "Any" if annotation is inspect.Parameter.empty else str(annotation)
        used.update(_IDENTIFIER.findall(text))
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            rendered.append(f"*{parameter.name}: {text}")
            marked_keyword_only = True
            continue
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            rendered.append(f"**{parameter.name}: {text}")
            continue
        if parameter.kind is inspect.Parameter.KEYWORD_ONLY and not marked_keyword_only:
            rendered.append("*")
            marked_keyword_only = True
        default = "" if parameter.default is inspect.Parameter.empty else " = ..."
        rendered.append(f"{parameter.name}: {text}{default}")
    return ", ".join(rendered)


def _members(target: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    resources: dict[str, Any] = {}
    methods: dict[str, Any] = {}
    for name in sorted(dir(target)):
        if name.startswith("_"):
            continue
        value = getattr(target, name)
        if isinstance(value, Resource):
            resources[name] = value
        elif callable(value):
            methods[name] = value
    return resources, methods


def _method_lines(path: str, name: str, method: Any, variant: tuple[str, str, bool, bool], used: set[str]) -> list[str]:
    """The view's declaration(s) of ``path.name``: the overloads in ``OVERLOADS``, the typed return in
    ``RETURNS``, or the live signature returning ``Any`` (so a misspelt method or a wrong argument is a
    type error even where the return is not typed yet)."""
    key = f"{path}.{name}"
    if key in OVERLOADS:
        lines: list[str] = []
        for parameters, spec in OVERLOADS[key]:
            annotations = re.sub(r"Literal\[[^\]]*\]", "Literal", re.sub(r"\*{0,2}\w+\s*:", "", parameters))
            used.update(_IDENTIFIER.findall(annotations))
            lines.append("    @overload")
            lines.append(f"    def {name}(self, {parameters}) -> {_wrap(spec, variant)}: ...")
        return lines
    returns = _wrap(RETURNS[key], variant) if key in RETURNS else "Any"
    return [f"    def {name}({_parameters(method, used)}) -> {returns}: ..."]


def _emit(path: str, target: Any, is_namespace: bool, out: list[str], used: set[str], seen: set[str]) -> None:
    """Appends the four views of ``path`` and of every resource under it. Every public method and
    resource is declared (a view has no ``__getattr__`` fallback), so an attribute the client does not
    have is a type error; methods without a ``RETURNS`` row return ``Any``."""
    resources, methods = _members(target)
    for name, resource in resources.items():
        _emit(f"{path}.{name}", resource, False, out, used, seen)
    if is_namespace:
        methods.pop("with_options", None)
    seen.update(f"{path}.{name}" for name in methods if f"{path}.{name}" in RETURNS or f"{path}.{name}" in OVERLOADS)
    call = type(target).__dict__.get("__call__")
    call_spec = RETURNS.get(f"{path}.__call__") if call is not None else None
    if call_spec is not None:
        seen.add(f"{path}.__call__")
    for variant in _VARIANTS:
        lines = [f"class {_class_name(path, variant)}(Protocol):"]
        lines.append(f'    """``ryu.{path}``{_variant_note(variant)}."""')
        lines.append("")
        for name in resources:
            lines.append(f"    {name}: {_class_name(f'{path}.{name}', variant)}")
        if resources:
            lines.append("")
        if call is not None:
            # A callable resource (``ryu.box.events("bx_1")``) keeps its call form in the view; a
            # ``<path>.__call__`` row in ``RETURNS`` types its result like a method's.
            returns = _wrap(call_spec, variant) if call_spec is not None else "Any"
            lines.append(f"    def __call__({_parameters(target.__call__, used)}) -> {returns}: ...")
        if is_namespace:
            lines.append(
                "    def with_options(self, *, idempotency_key: Optional[str] = ..., "
                "headers: Optional[Mapping[str, str]] = ..., timeout: Optional[float] = ...) -> "
                f"{_class_name(path, variant)}: ..."
            )
        for name, method in methods.items():
            lines.extend(_method_lines(path, name, method, variant, used))
        if lines[-1] == "":
            lines.pop()
        if len(lines) == 2:
            lines.append("    pass")
        out.append("\n".join(lines))


def _variant_note(variant: tuple[str, str, bool, bool]) -> str:
    _prefix, _suffix, is_async, object_mode = variant
    client = "AsyncRyu" if is_async else "Ryu"
    mode = 'result="object"' if object_mode else 'result="throw"'
    return f" on ``{client}({mode})``"


#: The views of ``Paginated`` (what every ``iterate()`` returns), typed by item.
_PAGE_ITERATORS = '''_Item = TypeVar("_Item")


class PageIterator(Protocol[_Item]):
    """``iterate()`` on ``Ryu``: ``for item in ...``. Raises ``RyuError`` in both result modes."""

    def __iter__(self) -> Iterator[_Item]: ...
    def pages(self) -> Iterator[Any]: ...
    def collect(self, max_items: Optional[int] = ...) -> list[_Item]: ...


class AsyncPageIterator(Protocol[_Item]):
    """``iterate()`` on ``AsyncRyu``: ``async for item in ...``. Raises ``RyuError`` in both result modes."""

    def __aiter__(self) -> AsyncIterator[_Item]: ...
    def pages(self) -> AsyncIterator[Any]: ...
    def collect(self, max_items: Optional[int] = ...) -> Awaitable[list[_Item]]: ...'''


def _safe_views(out: list[str]) -> None:
    for is_async in (False, True):
        variant = ("Async" if is_async else "", "ResultAPI", is_async, True)
        name = "AsyncSafeView" if is_async else "SafeView"
        lines = [
            f"class {name}(Protocol):",
            f'    """``{"AsyncRyu" if is_async else "Ryu"}().safe``: every namespace in object mode."""',
            "",
        ]
        for attribute in NAMESPACES:
            lines.append(f"    {attribute}: {_class_name(attribute, variant)}")
        out.append("\n".join(lines))


def generate() -> str:
    """The source of ``views.py``."""
    ryu = Ryu(env=False)
    classes: list[str] = []
    used: set[str] = set()
    seen: set[str] = set()
    for attribute in NAMESPACES:
        _emit(attribute, getattr(ryu, attribute), True, classes, used, seen)
    missing = sorted((set(RETURNS) | set(OVERLOADS)) - seen)
    if missing:
        raise SystemExit(f"RETURNS/OVERLOADS name methods the client does not have: {', '.join(missing)}")
    _safe_views(classes)
    specs = [*RETURNS.values(), *(spec for rows in OVERLOADS.values() for _parameters_text, spec in rows)]
    shape_names = sorted(
        {name for spec in specs for name in _IDENTIFIER.findall(spec)} - {"plain", "stream", "pages", "Any", *_BUILTINS}
    )
    unknown = sorted(name for name in used if name not in _IMPORTS and name not in _BUILTINS)
    if unknown:
        raise SystemExit(f"Add an import for: {', '.join(unknown)} (in _IMPORTS)")
    typing_names = sorted(
        {"Any", "Optional", "Protocol", "TypeVar"}
        | {name for name in used if _IMPORTS.get(name) == "typing"}
        | ({"overload"} if OVERLOADS else set())
    )
    abc_names = sorted(
        {"AsyncGenerator", "AsyncIterator", "Awaitable", "Generator", "Iterator", "Mapping"}
        | {name for name in used if _IMPORTS.get(name) == "collections.abc"}
    )
    shapes = [name for name in shape_names if name != "ManagedAgentsRunResult"]
    header = [
        '"""Typed views of every ``ryu.<namespace>``, for type checkers. GENERATED; do not edit.',
        "",
        "Generated by ``ryu_sdk/services/_gen_views.py`` from the live client and its ``RETURNS``",
        "table. Each namespace and resource has four views: ``<Name>API`` (``Ryu()``),",
        '``<Name>ResultAPI`` (``Ryu(result="object")`` and ``ryu.safe``), ``Async<Name>API`` and',
        "``Async<Name>ResultAPI`` (``AsyncRyu``). Every public method is declared; one without a",
        "typed return reads as ``Any``. Formatters skip this file (``fmt: off``); regenerate instead.",
        '"""',
        "",
        "# fmt: off",
        "from __future__ import annotations",
        "",
        "import builtins",
        "from collections.abc import (",
        *(f"    {name}," for name in abc_names),
        ")",
        "from typing import (",
        *(f"    {name}," for name in typing_names),
        ")",
        "",
        "from .managed_agents import ManagedAgentsRunResult, ToolApprovalHandler",
        "from .result import Result",
        "from .shapes import (",
        *(f"    {name}," for name in shapes),
        ")",
    ]
    # Views declare methods named ``list``, which shadow the builtin inside their class body, so
    # a ``list[...]`` annotation is spelled ``builtins.list[...]``.
    body = re.sub(r"(?<![\w.])list\[", "builtins.list[", "\n\n\n".join([_PAGE_ITERATORS, *classes]))
    exported = sorted(re.findall(r"^class (\w+)\(Protocol(?:\[\w+\])?\)", body, re.MULTILINE))
    footer = "__all__ = [\n" + "".join(f'    "{name}",\n' for name in exported) + "]\n"
    # The body opens with the ``_Item`` TypeVar, a plain statement, so isort (ruff I001) puts one
    # blank line after the imports, not two.
    return "\n".join(header) + "\n\n" + body + "\n\n\n" + footer


if __name__ == "__main__":
    print(generate(), end="")
