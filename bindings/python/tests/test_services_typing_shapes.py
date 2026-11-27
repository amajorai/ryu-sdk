"""Static typing of ryu_sdk.services, continued: the fixed shapes the SDK builds itself,
the function tools as the vendor SDKs' ``tools`` argument, and typed results.
"""

from __future__ import annotations

import importlib.util
import sys
import textwrap
from pathlib import Path

import pytest
from test_services_typing import HAS_MYPY, PYTHON_ROOT, _mypy

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
