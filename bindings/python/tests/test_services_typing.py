"""Static typing of ryu_sdk.services: the generated views, the client's typed surface, and mypy.

``views.py`` is generated from the live client (``_gen_views.py``) and must be
current. The mypy checks run when mypy is installed: the package itself must
be clean under ``--strict``, and a sample program, also under ``--strict``,
must reveal the expected types (``Ryu()`` and a bare ``Ryu`` annotation ->
plain shapes, ``result="object"`` -> ``Result[...]``, ``AsyncRyu`` ->
``Awaitable[...]``) and reject an unknown constructor option, a misspelt
method, an unknown parameter, and an object-mode or async client where the
tool runners need a sync ``result="throw"`` one.
"""

from __future__ import annotations

import importlib.util
import inspect
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Literal

import pytest

from ryu_sdk.services import AsyncRyu, Ryu
from ryu_sdk.services._gen_views import RETURNS, generate
from ryu_sdk.services.client import RyuOptions, _NamespaceAttribute, _RyuBase
from ryu_sdk.services.notify import NotifyNamespace

PYTHON_ROOT = Path(__file__).resolve().parents[1]
SERVICES = PYTHON_ROOT / "ryu_sdk" / "services"
HAS_MYPY = importlib.util.find_spec("mypy") is not None


def test_committed_views_match_the_generator():
    assert (SERVICES / "views.py").read_text() == generate(), (
        "views.py is stale: run `PYTHONPATH=bindings/python python -m ryu_sdk.services._gen_views "
        "> bindings/python/ryu_sdk/services/views.py`"
    )


def test_every_typed_path_exists_on_the_client():
    ryu = Ryu(env=False)
    for path in RETURNS:
        target: object = ryu
        for segment in path.split("."):
            target = getattr(target, segment)
        assert callable(target), path


def _resources(target: object, path: str):
    from ryu_sdk.services._base import Resource

    for name in sorted(dir(target)):
        if name.startswith("_"):
            continue
        value = getattr(target, name)
        if isinstance(value, Resource):
            yield f"{path}.{name}", value
            yield from _resources(value, f"{path}.{name}")


def test_views_declare_every_method_and_keep_callable_resources_callable():
    from ryu_sdk.services import views
    from ryu_sdk.services._gen_views import _class_stem

    source = (SERVICES / "views.py").read_text()
    assert "__getattr__" not in source  # a misspelt attribute is a type error, not Any
    ryu = Ryu(env=False)
    callable_paths = []
    for attribute in (
        "managed_agents",
        "messaging",
        "mail",
        "notify",
        "box",
        "gateway",
        "connect",
        "passport",
        "sites",
    ):
        for path, resource in _resources(getattr(ryu, attribute), attribute):
            for prefix, suffix in (("", "API"), ("", "ResultAPI"), ("Async", "API"), ("Async", "ResultAPI")):
                view = getattr(views, f"{prefix}{_class_stem(path)}{suffix}")
                for name in dir(resource):
                    if not name.startswith("_") and callable(getattr(resource, name)):
                        assert name in view.__dict__ or name in view.__annotations__, (path, name)
                if "__call__" in type(resource).__dict__:
                    assert "__call__" in view.__dict__, path
            if "__call__" in type(resource).__dict__:
                callable_paths.append(path)
    assert {"box.events", "box.processes", "box.prompts", "connect.usage"} <= set(callable_paths)


def test_the_typed_options_name_every_constructor_option():
    parameters = set(inspect.signature(_RyuBase.__init__).parameters) - {"self", "result"}
    assert set(RyuOptions.__annotations__) == parameters


def test_the_typed_surface_keeps_the_runtime_behaviour():
    assert isinstance(_RyuBase.__dict__["notify"], _NamespaceAttribute)
    assert isinstance(Ryu.notify, _NamespaceAttribute)  # class access returns the descriptor
    ryu = Ryu[Literal["throw"]](env={"RYU_NOTIFY_API_KEY": "n"})  # subscripting works at runtime
    assert isinstance(ryu.notify, NotifyNamespace) and ryu.notify is ryu.notify
    assert ryu.safe.notify._b.mode == "object" and ryu.notify._b.mode == "throw"
    assert Ryu(env=False, result="object").notify._b.mode == "object"
    assert AsyncRyu(env=False).notify._b.is_async is True
    with Ryu(env=False) as entered:
        assert isinstance(entered, Ryu)


def test_every_async_stream_is_an_async_generator():
    # views.py types async streams as AsyncGenerator so `contextlib.aclosing()` type-checks.
    env = {
        "RYU_API_KEY": "ryu_x",
        "RYU_ORGANIZATION_ID": "org_1",
        "RYU_NOTIFY_URL": "http://notify.test",
        "RYU_NOTIFY_API_KEY": "n",
        "RYU_BOX_URL": "http://box.test",
        "RYU_BOX_API_KEY": "b",
        "RYU_GATEWAY_TOKEN": "g",
    }
    streams = [spec for spec in RETURNS.items() if spec[1].startswith("stream:")]
    assert {path for path, _spec in streams} == {
        "managed_agents.sessions.stream",
        "managed_agents.sessions.follow",
        "notify.events.stream",
        "box.exec_stream",
        "gateway.chat.completions.stream",
    }
    for mode in ("throw", "object"):
        ryu = AsyncRyu(env=env, result=mode)
        made = [
            ryu.managed_agents.sessions.stream("s"),
            ryu.managed_agents.sessions.follow("s"),
            ryu.notify.events.stream(),
            ryu.box.exec_stream("b", {"command": "true"}),
            ryu.gateway.chat.completions.stream({}),
            ryu.gateway.chat.completions.create({}, stream=True),
        ]
        for stream in made:
            assert inspect.isasyncgen(stream), (mode, type(stream))


def test_every_sync_stream_is_a_generator():
    # views.py types sync streams as Generator so `close()` and `contextlib.closing()` type-check.
    env = {
        "RYU_API_KEY": "ryu_x",
        "RYU_ORGANIZATION_ID": "org_1",
        "RYU_NOTIFY_URL": "http://notify.test",
        "RYU_NOTIFY_API_KEY": "n",
        "RYU_BOX_URL": "http://box.test",
        "RYU_BOX_API_KEY": "b",
        "RYU_GATEWAY_TOKEN": "g",
    }
    for mode in ("throw", "object"):
        ryu = Ryu(env=env, result=mode)
        made = [
            ryu.managed_agents.sessions.stream("s"),
            ryu.managed_agents.sessions.follow("s"),
            ryu.notify.events.stream(),
            ryu.box.exec_stream("b", {"command": "true"}),
            ryu.gateway.chat.completions.stream({}),
            ryu.gateway.chat.completions.create({}, stream=True),
        ]
        for stream in made:
            assert inspect.isgenerator(stream), (mode, type(stream))
            stream.close()


def test_the_package_ships_its_type_marker():
    assert (PYTHON_ROOT / "ryu_sdk" / "py.typed").exists()


def _mypy(*arguments: str, cwd: Path, root: Path = PYTHON_ROOT) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "mypy", "--no-incremental", "--cache-dir", str(cwd / ".mypy_cache"), *arguments],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env={"PYTHONPATH": str(root), "PATH": "/usr/bin:/bin"},
    )


PYPROJECT = PYTHON_ROOT / "pyproject.toml"


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_strict_is_clean_on_the_services_package(tmp_path: Path):
    # No --follow-imports=silent: every ryu_sdk module the services package imports
    # (schema, workflow, agent, ...) must be strict-clean too. pyproject.toml only
    # treats the generated UniFFI module as an untyped dependency.
    completed = _mypy("--strict", "--config-file", str(PYPROJECT), str(SERVICES), cwd=tmp_path)
    assert completed.returncode == 0, completed.stdout + completed.stderr


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_strict_is_clean_on_the_whole_package(tmp_path: Path):
    completed = _mypy("--strict", "--config-file", str(PYPROJECT), str(PYTHON_ROOT / "ryu_sdk"), cwd=tmp_path)
    assert completed.returncode == 0, completed.stdout + completed.stderr


STREAM_EVENT_SAMPLE = """
from ryu_sdk.middleware import ModelCallResult
from ryu_sdk.model_call import StreamEvent


def narrowed(event: StreamEvent) -> str:
    return event[1] if event[0] == "text" else event[1].content or ""


def mispaired(result: ModelCallResult) -> StreamEvent:
    return ("text", result)
"""


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_stream_events_narrow_on_their_tag(tmp_path: Path):
    sample = tmp_path / "stream_sample.py"
    sample.write_text(STREAM_EVENT_SAMPLE)
    completed = _mypy("--strict", "--follow-imports=silent", str(sample), cwd=tmp_path)
    errors = [line for line in completed.stdout.splitlines() if ": error:" in line]
    assert len(errors) == 1 and "stream_sample.py:11:" in errors[0] and "return-value" in errors[0], completed.stdout


# Stand-in for the UniFFI output that test.sh and CI generate before pytest runs:
# unannotated, so --strict would reject it if mypy collected it as a source.
GENERATED_STAND_IN = """
def assert_allowed_egress(url, allowlist):
    return None


def untyped_native_call(value):
    return value
"""


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_strict_skips_the_generated_native_module(tmp_path: Path):
    # The CI layout: ryu_sdk/ryu_sdk.py exists when the directory is checked.
    root = tmp_path / "root"
    package = root / "ryu_sdk"
    shutil.copytree(PYTHON_ROOT / "ryu_sdk", package, ignore=shutil.ignore_patterns("__pycache__", "ryu_sdk.py"))
    (package / "ryu_sdk.py").write_text(GENERATED_STAND_IN)
    for checked in (package, package / "services"):
        completed = _mypy("--strict", "--config-file", str(PYPROJECT), str(checked), cwd=tmp_path, root=root)
        assert completed.returncode == 0, completed.stdout + completed.stderr
    # Without the pyproject exclusion the stand-in really is rejected, so the check above is meaningful.
    bare = _mypy("--strict", str(package / "ryu_sdk.py"), cwd=tmp_path, root=root)
    assert "no-untyped-def" in bare.stdout, bare.stdout + bare.stderr


SAMPLE = """
from contextlib import aclosing, closing as close_after
from typing import Any, Dict, Literal
from ryu_sdk.services import AsyncRyu, Ryu
from ryu_sdk.services.tools import RyuServiceTool, run_ryu_tool, to_openai_tools, to_ryu_agent_tools

ryu = Ryu()
reveal_type(ryu)
reveal_type(ryu.notify.publish({"title": "Deployed"}))
reveal_type(ryu.box.exec("bx_1", {"command": "ls"}))
reveal_type(ryu.notify.with_options(idempotency_key="k").events.list(limit=3))
reveal_type(ryu.notify.topics.list())
reveal_type(ryu.safe.mail.send({}))
reveal_type(Ryu(result="object").managed_agents.sessions.get("s"))
reveal_type(AsyncRyu().sites.deploy({}))
reveal_type(AsyncRyu(result="object").gateway.models.list())
reveal_type(AsyncRyu().managed_agents.sessions.follow("s"))
reveal_type(AsyncRyu().passport.runtime.connections.has_runtime_grant())
reveal_type(ryu.box.files.read_text("bx_1", "a.txt"))
reveal_type(ryu.gateway.chat.completions.create({"model": "m", "messages": []}))
reveal_type(ryu.gateway.chat.completions.create({"model": "m", "messages": []}, stream=True))
reveal_type(ryu.box.events("bx_1"))
reveal_type(ryu.notify.destinations)


def helper(client: Ryu) -> None:
    reveal_type(client)
    reveal_type(client.notify.publish({"title": "Deployed"}))


async def async_helper(client: AsyncRyu) -> None:
    reveal_type(client.notify.publish({"title": "Deployed"}))


async def closing(client: AsyncRyu) -> None:
    async with aclosing(client.managed_agents.sessions.follow("s")) as events:
        async for event in events:
            reveal_type(event)
    async with aclosing(AsyncRyu(result="object").notify.events.stream()) as feed:
        async for _item in feed:
            pass


def sync_closing(client: Ryu) -> None:
    # Sync streams are generators: close() and contextlib.closing() type-check.
    with close_after(client.box.exec_stream("bx_1", {"command": "ls"})) as chunks:
        for _chunk in chunks:
            break
    feed = Ryu(result="object").notify.events.stream()
    feed.close()


def tools(tool: RyuServiceTool) -> None:
    reveal_type(tool.invoke({}))
    reveal_type(to_openai_tools(ryu).execute("notify_get_event", {}))
    reveal_type(run_ryu_tool(ryu, "notify_get_event", {}))
    # The definitions are typed Any on purpose (see RyuFunctionTools): pin that choice.
    reveal_type(to_openai_tools(ryu)[0])
    to_ryu_agent_tools(AsyncRyu())


Ryu(not_an_option=1)
ryu.notify.publsh({"title": "typo"})
ryu.notify.publish({"title": "x"}, not_a_parameter=1)
to_openai_tools(Ryu(result="object"))
run_ryu_tool(AsyncRyu(), "notify_get_event", {})
"""

EXPECTED = [
    "Ryu[Literal['throw']]",
    "TypedDict(ryu_sdk.services.shapes.NotifyEvent,",
    "TypedDict(ryu_sdk.services.shapes.BoxExecResult,",
    "TypedDict(ryu_sdk.services.shapes.NotifyEventPage,",
    "list[TypedDict(ryu_sdk.services.shapes.NotifyTopic,",
    "ryu_sdk.services.result.Result[TypedDict(ryu_sdk.services.shapes.MailMessage,",
    "ryu_sdk.services.result.Result[TypedDict(ryu_sdk.services.shapes.ManagedAgentSession,",
    "typing.Awaitable[TypedDict(ryu_sdk.services.shapes.SitesDeployResult,",
    # A Result is a (data, error, meta) tuple subclass, so mypy prints its element types first.
    "typing.Awaitable[tuple[TypedDict(ryu_sdk.services.shapes.GatewayModelList,",
    "typing.AsyncGenerator[TypedDict(ryu_sdk.services.shapes.ManagedAgentEvent,",
    'Revealed type is "bool"',
    'Revealed type is "str"',
    "TypedDict(ryu_sdk.services.shapes.GatewayChatCompletion,",
    "typing.Generator[dict[str, Any], None, None]",
    'Revealed type is "Any"',  # a callable resource keeps its call form
    "ryu_sdk.services.views.NotifyDestinationsAPI",
    "Ryu[Literal['throw']]",  # a bare annotation is the default result="throw" client
    "TypedDict(ryu_sdk.services.shapes.NotifyEvent,",
    "typing.Awaitable[TypedDict(ryu_sdk.services.shapes.NotifyEvent,",
    "TypedDict(ryu_sdk.services.shapes.ManagedAgentEvent,",  # aclosing() keeps the item type
    "TypedDict(ryu_sdk.services.tools._run.ToolResultJSON,",
    "TypedDict(ryu_sdk.services.tools._run.ToolResultJSON,",
    "ryu_sdk.services.result.Result[Any]",
    'Revealed type is "Any"',  # a function-tool definition item, so it passes as a vendor `tools=` item
]

EXPECTED_ERRORS = [
    "not_an_option",
    '"NotifyAPI" has no attribute "publsh"',
    '"not_a_parameter"',
    'Argument 1 to "to_openai_tools" has incompatible type "Ryu[Literal[\'object\']]"',
    'Argument 1 to "run_ryu_tool" has incompatible type "AsyncRyu[Literal[\'throw\']]"',
]


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_reveals_the_mode_specific_types(tmp_path: Path):
    sample = tmp_path / "sample.py"
    sample.write_text(textwrap.dedent(SAMPLE))
    completed = _mypy("--strict", "--follow-imports=silent", "--show-absolute-path", str(sample), cwd=tmp_path)
    # Older mypy prints builtins with their module ("builtins.bool") and List as "builtins.list".
    revealed = [line.replace("builtins.", "") for line in completed.stdout.splitlines() if "Revealed type is" in line]
    assert len(revealed) == len(EXPECTED), completed.stdout
    for line, expected in zip(revealed, EXPECTED):
        assert expected in line, f"{expected!r} not in {line!r}"
    errors = [line for line in completed.stdout.splitlines() if ": error:" in line]
    # --strict has nothing else to report: a bare `Ryu` annotation needs no type argument.
    assert len(errors) == len(EXPECTED_ERRORS), completed.stdout
    for line, expected in zip(errors, EXPECTED_ERRORS):
        assert expected in line, f"{expected!r} not in {line!r}"


# The names the docs import from the package root (agent-tools.mdx, choose-an-sdk.mdx), a
# Result unpacked the way every sample does it, and iterate() items.
NEWCOMER_SAMPLE = """
from ryu_sdk import Agent, AsyncRyu, Ryu, Workflow, tool

ryu = Ryu(result="object")
data, error, meta = ryu.notify.publish({"title": "Deployed"})
reveal_type(data)
reveal_type(error)
reveal_type(meta)
reveal_type(Ryu().notify.events.iterate(level="error"))
for event in Ryu().notify.events.iterate(level="error"):
    reveal_type(event)
reveal_type(Ryu().mail.messages.iterate("inb_1").collect())


async def main() -> None:
    async for message in AsyncRyu().mail.messages.iterate("inb_1"):
        reveal_type(message)
    reveal_type(await AsyncRyu().managed_agents.sessions.iterate().collect(5))


reveal_type(Agent)
reveal_type(Workflow)
reveal_type(tool)
"""

NEWCOMER_EXPECTED = [
    "TypedDict(ryu_sdk.services.shapes.NotifyEvent,",
    "ryu_sdk.services.errors.RyuError | None",
    "ryu_sdk.services.result.ResponseMeta | None",
    "ryu_sdk.services.views.PageIterator[TypedDict(ryu_sdk.services.shapes.NotifyEvent,",
    "TypedDict(ryu_sdk.services.shapes.NotifyEvent,",
    "list[TypedDict(ryu_sdk.services.shapes.MailMessage,",
    "TypedDict(ryu_sdk.services.shapes.MailMessage,",
    "list[TypedDict(ryu_sdk.services.shapes.ManagedAgentSession,",
    "ryu_sdk.agent.Agent",
    "ryu_sdk.workflow.Workflow",
    "def (fn:",  # the tool decorator
]


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_strict_accepts_the_documented_imports_and_types_unpacking_and_iteration(tmp_path: Path):
    sample = tmp_path / "newcomer.py"
    sample.write_text(textwrap.dedent(NEWCOMER_SAMPLE))
    completed = _mypy("--strict", "--follow-imports=silent", str(sample), cwd=tmp_path)
    assert [line for line in completed.stdout.splitlines() if ": error:" in line] == [], completed.stdout
    revealed = [line.replace("builtins.", "") for line in completed.stdout.splitlines() if "Revealed type is" in line]
    assert len(revealed) == len(NEWCOMER_EXPECTED), completed.stdout
    for line, expected in zip(revealed, NEWCOMER_EXPECTED):
        assert expected in line, f"{expected!r} not in {line!r}"
    assert not any('"Any"' in line for line in revealed), completed.stdout


# The values the SDK builds itself carry every key (required, not ``total=False``), so strict
# code can unpack or index them without ``.get()``; webhook envelopes and Connect usage too.
LOCAL_SHAPES_SAMPLE = """
from datetime import datetime, timezone
from typing import List
from ryu_sdk.services import (
    AsyncRyu,
    Ryu,
    is_known_mail_webhook_event,
    is_known_messaging_webhook_event,
    verify_mail_webhook,
    verify_messaging_webhook,
    verify_webhook,
)
from ryu_sdk.services.box import command_parts
from ryu_sdk.services.shapes import ConnectMcpHeaders, MailRealtimeTicket
from ryu_sdk.services.tools import NotifyUsageWindow, default_notify_usage_window

ryu = Ryu()
gateway = ryu.gateway.openai_compatible()
reveal_type(gateway)
base_url: str = gateway["base_url"]
api_key: str = gateway["api_key"]
mcp = ryu.connect.mcp()
reveal_type(mcp)
headers: ConnectMcpHeaders = mcp["headers"]
authorization: str = mcp["headers"]["Authorization"]
reveal_type(mcp["type"])
reveal_type(ryu.connect.usage({"from": "a", "to": "b"}))
reveal_type(Ryu(result="object").connect.usage(from_="a", to="b"))
reveal_type(AsyncRyu().connect.usage.iterate({"from": "a", "to": "b"}))
reveal_type(ryu.mail.create_realtime_ticket())
ticket: MailRealtimeTicket = ryu.mail.create_realtime_ticket()
socket_url: str = ticket["url"]
protocols: List[str] = ticket["protocols"]
mail_event = verify_mail_webhook(payload=b"", headers={}, secret="whsec_")
reveal_type(mail_event)
event_id: str = mail_event["event_id"]
if is_known_mail_webhook_event(mail_event):
    reveal_type(mail_event["event_type"])
messaging_event = verify_messaging_webhook(payload=b"", headers={}, secret="whsec_")
reveal_type(messaging_event)
if is_known_messaging_webhook_event(messaging_event):
    reveal_type(messaging_event["event_type"])
reveal_type(verify_webhook(service="mail", payload=b"", headers={}, secret="whsec_"))
reveal_type(verify_webhook(service="messaging", payload=b"", headers={}, secret="whsec_"))
reveal_type(verify_webhook(service="notify", payload=b"", headers={}, secret="s"))
some_service: str = "mail"
reveal_type(verify_webhook(service=some_service, payload=b"", headers={}, secret="s"))
reveal_type(command_parts(["ls", "-la"], None))
window: NotifyUsageWindow = default_notify_usage_window(datetime.now(timezone.utc))
reveal_type(window)
"""

LOCAL_SHAPES_EXPECTED = [
    "TypedDict(ryu_sdk.services.shapes.GatewayOpenAICompatibleConfig, {'base_url': str, 'api_key': str})",
    "TypedDict(ryu_sdk.services.shapes.ConnectMcpConfig,",
    "Literal['http']",
    "TypedDict(ryu_sdk.services.shapes.ConnectUsageReport,",
    "ryu_sdk.services.result.Result[TypedDict(ryu_sdk.services.shapes.ConnectUsageReport,",
    "ryu_sdk.services.views.AsyncPageIterator[TypedDict(ryu_sdk.services.shapes.ConnectUsageLine,",
    "TypedDict(ryu_sdk.services.shapes.MailRealtimeTicket,",
    "TypedDict(ryu_sdk.services.shapes.MailWebhookEvent,",
    "Literal['message.received'] | Literal['message.received.spam'] |",
    "TypedDict(ryu_sdk.services.shapes.MessagingWebhookEvent,",
    (
        "Literal['message.received'] | Literal['message.delivered'] | Literal['message.failed'] | "
        "Literal['number.suspended'] | Literal['number.released']"
    ),
    "TypedDict(ryu_sdk.services.shapes.MailWebhookEvent,",
    "TypedDict(ryu_sdk.services.shapes.MessagingWebhookEvent,",
    "ryu_sdk.services.webhooks.NotifyWebhookDelivery",
    # mypy folds the two structurally identical envelopes into one member of the union.
    "}) | ryu_sdk.services.webhooks.NotifyWebhookDelivery",
    "TypedDict(ryu_sdk.services.shapes.BoxCommandParts, {'command': str, 'args': list[str]})",
    "TypedDict(ryu_sdk.services.shapes.NotifyUsageWindow, {'from': str, 'to': str})",
]


def test_the_fixed_shape_types_are_exported_from_shapes():
    from ryu_sdk.services import shapes

    for name in (
        "BoxCommandParts",
        "ConnectMcpConfig",
        "ConnectMcpHeaders",
        "ConnectUnresolvedReceipt",
        "ConnectUsageLine",
        "ConnectUsageReport",
        "GatewayOpenAICompatibleConfig",
        "KnownMailWebhookEvent",
        "KnownMessagingWebhookEvent",
        "MailEventType",
        "MailRealtimeTicket",
        "MailWebhookEvent",
        "MessagingEventType",
        "MessagingWebhookEvent",
        "NotifyUsageWindow",
    ):
        assert name in shapes.__all__
        assert hasattr(shapes, name)
    # Locally built values carry every key; server replies stay ``total=False``.
    assert shapes.GatewayOpenAICompatibleConfig.__required_keys__ == frozenset({"base_url", "api_key"})
    assert shapes.ConnectMcpConfig.__required_keys__ == frozenset({"type", "url", "headers"})
    assert shapes.ConnectUsageReport.__required_keys__ == frozenset()
    assert shapes.ConnectMcpHeaders.__required_keys__ == frozenset({"Authorization"})
    assert shapes.MailRealtimeTicket.__required_keys__ == frozenset(
        {"expiresAt", "expiresIn", "path", "protocols", "ticket", "url"}
    )
    assert shapes.BoxCommandParts.__required_keys__ == frozenset({"command", "args"})
    assert shapes.NotifyUsageWindow.__required_keys__ == frozenset({"from", "to"})
    # The public helpers re-export the shapes they return.
    from ryu_sdk.services import box, tools

    assert tools.NotifyUsageWindow is shapes.NotifyUsageWindow and "NotifyUsageWindow" in tools.__all__
    assert box.BoxCommandParts is shapes.BoxCommandParts


def test_the_known_event_type_literals_match_the_runtime_lists():
    from typing import get_args, get_type_hints

    from ryu_sdk.services import shapes, webhooks

    assert get_args(shapes.MailEventType) == webhooks.MAIL_EVENT_TYPES
    assert get_args(shapes.MessagingEventType) == webhooks.MESSAGING_EVENT_TYPES
    hints = get_type_hints(shapes.KnownMailWebhookEvent)
    assert get_args(hints["event_type"]) == webhooks.MAIL_EVENT_TYPES
    hints = get_type_hints(shapes.KnownMessagingWebhookEvent)
    assert get_args(hints["event_type"]) == webhooks.MESSAGING_EVENT_TYPES


def test_the_fixed_shape_returns_resolve_at_runtime():
    # The shapes are real module-level imports, so typing.get_type_hints (and ryu_sdk.schema)
    # resolves each annotated return instead of raising NameError on a TYPE_CHECKING-only name.
    import typing

    from ryu_sdk.services import box, mail, shapes, webhooks
    from ryu_sdk.services.connect import ConnectNamespace
    from ryu_sdk.services.gateway import GatewayNamespace
    from ryu_sdk.services.tools import _bodies

    expected = {
        GatewayNamespace.openai_compatible: shapes.GatewayOpenAICompatibleConfig,
        ConnectNamespace.mcp: shapes.ConnectMcpConfig,
        mail._realtime_ticket: shapes.MailRealtimeTicket,
        webhooks.verify_mail_webhook: shapes.MailWebhookEvent,
        webhooks.parse_mail_webhook_event: shapes.MailWebhookEvent,
        webhooks.verify_messaging_webhook: shapes.MessagingWebhookEvent,
        webhooks.parse_messaging_webhook_event: shapes.MessagingWebhookEvent,
        box.command_parts: shapes.BoxCommandParts,
        _bodies.default_notify_usage_window: shapes.NotifyUsageWindow,
    }
    for function, shape in expected.items():
        assert typing.get_type_hints(function)["return"] is shape, function.__qualname__
    union = typing.get_type_hints(webhooks.verify_webhook)["return"]
    assert set(typing.get_args(union)) == {
        shapes.MailWebhookEvent,
        shapes.MessagingWebhookEvent,
        webhooks.NotifyWebhookDelivery,
    }
    for guard in (webhooks.is_known_mail_webhook_event, webhooks.is_known_messaging_webhook_event):
        assert typing.get_type_hints(guard)["return"] is not None


def test_the_known_event_guards_keep_their_runtime_answers():
    from ryu_sdk.services import webhooks

    envelope = {"type": "event", "event_id": "e", "data": {}}
    assert webhooks.is_known_mail_webhook_event({**envelope, "event_type": "message.received"}) is True
    assert webhooks.is_known_mail_webhook_event({**envelope, "event_type": "message.future"}) is False
    assert webhooks.is_known_messaging_webhook_event({**envelope, "event_type": "number.released"}) is True
    assert webhooks.is_known_messaging_webhook_event({**envelope, "event_type": "message.sent"}) is False


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_types_the_locally_built_values_with_required_keys(tmp_path: Path):
    sample = tmp_path / "local_shapes.py"
    sample.write_text(textwrap.dedent(LOCAL_SHAPES_SAMPLE))
    completed = _mypy("--strict", "--follow-imports=silent", str(sample), cwd=tmp_path)
    assert [line for line in completed.stdout.splitlines() if ": error:" in line] == [], completed.stdout
    revealed = [line.replace("builtins.", "") for line in completed.stdout.splitlines() if "Revealed type is" in line]
    assert len(revealed) == len(LOCAL_SHAPES_EXPECTED), completed.stdout
    for line, expected in zip(revealed, LOCAL_SHAPES_EXPECTED):
        assert expected in line, f"{expected!r} not in {line!r}"


HAS_VENDOR_SDKS = all(importlib.util.find_spec(name) is not None for name in ("openai", "anthropic"))

# The documented hand-offs: each adapter's list goes straight to the vendor SDK's `tools=`.
VENDOR_TOOLS_SAMPLE = """
import anthropic
import openai

from ryu_sdk.services import Ryu
from ryu_sdk.services.tools import to_anthropic_tools, to_openai_tools

ryu = Ryu()
chat = to_openai_tools(ryu, services=["notify"])
openai.OpenAI().chat.completions.create(model="m", messages=[], tools=chat)
responses = to_openai_tools(ryu, api="responses")
openai.OpenAI().responses.create(model="m", input="hi", tools=responses)
claude = to_anthropic_tools(ryu, services=["notify"])
anthropic.Anthropic().messages.create(model="m", max_tokens=1, messages=[], tools=claude)
"""


@pytest.mark.skipif(not (HAS_MYPY and HAS_VENDOR_SDKS), reason="mypy, openai and anthropic are not all installed")
def test_mypy_strict_accepts_the_function_tools_as_the_vendor_sdks_tools_argument(tmp_path: Path):
    sample = tmp_path / "vendor_tools.py"
    sample.write_text(textwrap.dedent(VENDOR_TOOLS_SAMPLE))
    # The vendor SDKs live in the running interpreter's site-packages, which PYTHONPATH alone does not name.
    completed = _mypy(
        "--strict", "--follow-imports=silent", f"--python-executable={sys.executable}", str(sample), cwd=tmp_path
    )
    assert [line for line in completed.stdout.splitlines() if ": error:" in line] == [], completed.stdout


def test_the_package_root_exports_its_pure_surface_statically():
    import ryu_sdk

    source = (PYTHON_ROOT / "ryu_sdk" / "__init__.py").read_text()
    for name in ("Agent", "Ryu", "AsyncRyu", "Workflow", "tool", "services"):
        assert f'    "{name}",\n' in source and name in ryu_sdk.__all__
        assert getattr(ryu_sdk, name) is not None
    assert len(ryu_sdk.__all__) == len(set(ryu_sdk.__all__))


def test_a_result_is_a_typed_three_tuple():
    import copy
    import pickle

    from ryu_sdk.services import RyuNotFoundError
    from ryu_sdk.services.result import EMPTY_META, Result

    ok = Result({"id": "evt_1"}, None, EMPTY_META)
    data, error, meta = ok
    assert (data, error, meta) == ({"id": "evt_1"}, None, EMPTY_META) == tuple(ok)
    assert ok.data is data and ok.error is None and ok.meta is EMPTY_META and ok.ok and ok.unwrap() is data
    assert ok == Result({"id": "evt_1"}, None, EMPTY_META) and len(ok) == 3
    assert repr(ok).startswith("Result(data={'id': 'evt_1'}, error=None, meta=ResponseMeta(")
    assert pickle.loads(pickle.dumps(ok)) == ok and copy.deepcopy(ok) == ok and copy.copy(ok) == ok
    with pytest.raises(AttributeError):
        ok.data = None  # type: ignore[misc]
    failed = Result[object](None, RyuNotFoundError("gone", service="notify", status=404), None)
    assert not failed.ok
    with pytest.raises(RyuNotFoundError):
        failed.unwrap()


def test_an_agent_tool_returning_a_result_reaches_the_model_with_keys():
    # Result is a tuple subclass; to_jsonable must keep {data, error, meta} (its dataclass-era
    # shape), not flatten it to [data, error, meta].
    import json

    from ryu_sdk.agent import _tool_message
    from ryu_sdk.schema import to_jsonable
    from ryu_sdk.services import RyuNotFoundError
    from ryu_sdk.services.result import ResponseMeta, Result

    ok = Result({"id": "e1"}, None, ResponseMeta(attempts=1, status=200))
    assert ok._asdict() == {"data": {"id": "e1"}, "error": None, "meta": ok.meta}
    jsonable = to_jsonable(ok)
    assert jsonable["data"] == {"id": "e1"} and jsonable["error"] is None
    assert jsonable["meta"]["attempts"] == 1 and jsonable["meta"]["status"] == 200
    failed = Result[object](None, RyuNotFoundError("boom", service="notify", status=404), None)
    content = json.loads(_tool_message("call_1", failed)["content"])
    assert set(content) == {"data", "error", "meta"}
    assert content["data"] is None and content["meta"] is None and "boom" in content["error"]
    # Plain tuples still serialize as lists.
    assert to_jsonable((1, "a")) == [1, "a"]


SITES_SIDECAR = Path(__file__).resolve().parents[3] / "apps-store" / "sites" / "sidecar" / "src" / "server.ts"


def _sites_status_route_keys(source: str) -> set[str]:
    import re

    start = source.index('if (path === "/status" && request.method === "GET")')
    body = source[start : source.index("});", start)]
    return set(re.findall(r"^\s*([A-Za-z]+)(?::|,)", body, re.MULTILINE))


@pytest.mark.skipif(not SITES_SIDECAR.exists(), reason="the Sites sidecar source is not in this checkout")
def test_sites_status_declares_every_key_the_sidecar_returns():
    from ryu_sdk.services.shapes import SitesStatus

    returned = _sites_status_route_keys(SITES_SIDECAR.read_text())
    assert "identityAvailable" in returned and "visitorPort" in returned, returned
    assert returned == set(SitesStatus.__annotations__), (
        "SitesStatus in shapes.py drifted from GET /api/sites/status in apps-store/sites/sidecar/src/server.ts"
    )


SITES_STATUS_SAMPLE = """
from ryu_sdk.services import Ryu

status = Ryu().sites.status()
identity: bool = status["identityAvailable"]
domains: bool = status["domainsAvailable"]
reveal_type(status["publicEnabled"])
"""


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_strict_accepts_the_sites_capability_flags(tmp_path: Path):
    sample = tmp_path / "sites_status.py"
    sample.write_text(textwrap.dedent(SITES_STATUS_SAMPLE))
    completed = _mypy("--strict", "--follow-imports=silent", str(sample), cwd=tmp_path)
    assert [line for line in completed.stdout.splitlines() if ": error:" in line] == [], completed.stdout
    assert 'Revealed type is "builtins.bool"' in completed.stdout or 'Revealed type is "bool"' in completed.stdout


ALIASES_SAMPLE = """
from ryu_sdk.services import AsyncObjectRyu, AsyncRyu, ObjectRyu, Ryu


def publish(ryu: ObjectRyu) -> None:
    reveal_type(ryu)
    reveal_type(ryu.notify.publish({"title": "x"}))


async def apublish(ryu: AsyncObjectRyu) -> None:
    reveal_type(ryu)
    reveal_type(await ryu.notify.publish({"title": "x"}))


publish(Ryu(result="object"))
publish(ObjectRyu(result="object"))
publish(Ryu())


async def main() -> None:
    await apublish(AsyncRyu())
"""


def test_object_mode_aliases_are_the_subscripted_clients():
    from typing import get_args, get_origin

    from ryu_sdk.services import AsyncObjectRyu, ObjectRyu

    assert get_origin(ObjectRyu) is Ryu and get_args(ObjectRyu) == (Literal["object"],)
    assert get_origin(AsyncObjectRyu) is AsyncRyu and get_args(AsyncObjectRyu) == (Literal["object"],)
    # Calling the alias builds a plain client, so `ObjectRyu(result="object")` works too.
    client = ObjectRyu(result="object", env=False)
    assert type(client) is Ryu and client.result == "object"
    # The aliases are for annotations only (the docs say so): a class check refuses them, and the
    # mode is read from `client.result` instead.
    for alias in (ObjectRyu, AsyncObjectRyu):
        with pytest.raises(TypeError):
            isinstance(client, alias)


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_mypy_reads_the_object_mode_aliases_as_object_mode_clients(tmp_path: Path):
    sample = tmp_path / "aliases.py"
    sample.write_text(ALIASES_SAMPLE)
    completed = _mypy("--strict", "--follow-imports=silent", str(sample), cwd=tmp_path)
    revealed = [line for line in completed.stdout.splitlines() if "Revealed type is" in line]
    assert len(revealed) == 4, completed.stdout
    assert "Ryu[Literal['object']]" in revealed[0]
    assert "ryu_sdk.services.result.Result[TypedDict(ryu_sdk.services.shapes.NotifyEvent," in revealed[1]
    assert "AsyncRyu[Literal['object']]" in revealed[2]
    assert "ryu_sdk.services.result.Result[TypedDict(ryu_sdk.services.shapes.NotifyEvent," in revealed[3]
    errors = [line for line in completed.stdout.splitlines() if ": error:" in line]
    # A throw-mode client is refused where the alias is expected, sync and async alike.
    assert len(errors) == 2, completed.stdout
    assert "incompatible type \"Ryu[Literal['throw']]\"" in errors[0]
    assert "incompatible type \"AsyncRyu[Literal['throw']]\"" in errors[1]


def test_every_annotation_evaluates_at_runtime():
    # requires-python is 3.9, where typing.get_type_hints (ryu_sdk.schema, a reader's own
    # introspection) cannot evaluate `X | None` (a TypeError); pyproject's keep-runtime-typing keeps
    # ruff from suggesting it. Every TypedDict and function in the package must resolve.
    import importlib
    import pkgutil
    import typing

    import ryu_sdk.services as package
    import ryu_sdk.services._gen_views as views

    # Names a module imports only under TYPE_CHECKING (to avoid an import cycle). Any other
    # NameError is a real unresolvable annotation and fails the test.
    type_checking_only = {"ManagedAgentsAPI", "SyncToolClient", "ToolClient"}
    type_checking_only.update(name for name in vars(views) if not name.startswith("_"))

    def missing_name(error: NameError) -> str:
        found = getattr(error, "name", None)  # Python 3.10+
        if found:
            return str(found)
        match = re.search(r"name '([^']+)' is not defined", str(error))
        return match.group(1) if match else ""

    checked = 0
    for info in pkgutil.walk_packages(package.__path__, f"{package.__name__}."):
        if info.name.endswith(("._gen_views", "._surface")):
            continue
        module = importlib.import_module(info.name)
        for value in vars(module).values():
            if getattr(value, "__module__", None) != module.__name__:
                continue
            targets = [value]
            if inspect.isclass(value):
                targets.extend(member for member in vars(value).values() if inspect.isfunction(member))
            elif not inspect.isfunction(value):
                continue
            for target in targets:
                try:
                    typing.get_type_hints(target)
                except NameError as error:
                    # A TYPE_CHECKING-only name; `X | None` on 3.9 is a TypeError and still fails.
                    assert missing_name(error) in type_checking_only, (target, error)
                    continue
                checked += 1
    assert checked > 500, checked
