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
