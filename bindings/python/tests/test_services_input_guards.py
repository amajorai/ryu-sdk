"""Caller input that must fail before a request is sent, and error bodies that must stay bounded.

- path ids: an empty, ``.`` or ``..`` id raises ``invalid_id`` (as ``pathSegment`` does in
  TypeScript) instead of letting the URL collapse onto another route;
- header values follow ``fetch``: Latin-1 text is sent as Latin-1 bytes, and anything ``fetch``
  refuses fails as a typed ``invalid_request_header`` in both throw and object modes (Notify topic
  text outside Latin-1 is first encoded as an RFC 2047 word, as ``@ryuhq/client`` does);
- an error response's body is read up to 64 KiB plus one chunk, never in full.
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

from ryu_sdk.services import AsyncRyu, Ryu, RyuError, RyuInvalidRequestError
from ryu_sdk.services import errors as errors_module
from ryu_sdk.services import notify as notify_module
from ryu_sdk.services.config import SERVICE_TITLES
from ryu_sdk.services.errors import MAX_ERROR_BODY_BYTES

BOX_ENV = {"RYU_BOX_API_KEY": "b"}
NOTIFY_ENV = {"RYU_NOTIFY_API_KEY": "n"}
MAIL_ENV = {"RYU_MAIL_GATEWAY_KEY": "gw"}
CONTROL_PLANE_ENV = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}


class Recorder:
    """A transport that records every request and answers 200 ``{}``."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(200, json={"event": {"id": "evt_1"}})

    def ryu(self, env: Any, **options: Any) -> Ryu:
        return Ryu(env=env, transport=httpx.MockTransport(self), **options)


# ── path ids ─────────────────────────────────────────────────────────────────

DOT_IDS = ["", ".", ".."]

CALLS: list[Any] = [
    # Box: a collapsed preview/process path would otherwise address the Box itself.
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.previews.delete("box_1", bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.processes.kill("box_1", bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.processes.get("box_1", bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.processes.logs("box_1", bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.get(bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.delete(bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.snapshots.get(bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.snapshots.delete(bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.secrets.set(bad, "v")),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.secrets.delete(bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.prompts.get("box_1", bad)),
    ("box", BOX_ENV, lambda ryu, bad: ryu.box.prompts.cancel("box_1", bad)),
    # Messaging
    ("messaging", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.messaging.messages.get(bad)),
    ("messaging", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.messaging.numbers.update(bad, {"label": "x"})),
    ("messaging", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.messaging.numbers.release(bad)),
    ("messaging", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.messaging.opt_outs.remove(bad)),
    ("messaging", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.messaging.whatsapp.templates.list(bad)),
    # Notify
    ("notify", NOTIFY_ENV, lambda ryu, bad: ryu.notify.events.get(bad)),
    ("notify", NOTIFY_ENV, lambda ryu, bad: ryu.notify.topics.publish(bad, "hi")),
    ("notify", NOTIFY_ENV, lambda ryu, bad: ryu.notify.destinations.delete(bad)),
    ("notify", NOTIFY_ENV, lambda ryu, bad: ryu.notify.silences.delete(bad)),
    # Mail
    ("mail", MAIL_ENV, lambda ryu, bad: ryu.mail.inboxes.get_for_agent(bad)),
    ("mail", MAIL_ENV, lambda ryu, bad: ryu.mail.inboxes.ensure_for_agent(bad)),
    ("mail", MAIL_ENV, lambda ryu, bad: ryu.mail.lists.remove("org", "org_1", "inbound", "block", bad)),
    # Managed Agents (ids are checked on the captured request path)
    ("managedAgents", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.managed_agents.sessions.delete(bad)),
    ("managedAgents", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.managed_agents.agents.get(bad)),
    ("managedAgents", CONTROL_PLANE_ENV, lambda ryu, bad: ryu.managed_agents.agents.get_version("agt_1", bad)),
]


@pytest.mark.parametrize("bad", DOT_IDS)
@pytest.mark.parametrize(("service", "env", "call"), CALLS)
def test_dot_and_empty_ids_raise_invalid_id_and_send_nothing(service: str, env: Any, call: Callable, bad: str):
    recorder = Recorder()
    with pytest.raises(RyuInvalidRequestError) as raised:
        call(recorder.ryu(env), bad)
    assert raised.value.code == "invalid_id"
    assert raised.value.service == service
    assert raised.value.retryable is False
    # The message names the service by its title, as hints do ("Ryu Box", not "Ryu box").
    assert raised.value.message.startswith(f"{SERVICE_TITLES[service]}: ")
    result = call(recorder.ryu(env).safe, bad)
    assert isinstance(result.error, RyuInvalidRequestError) and result.error.code == "invalid_id"
    assert recorder.requests == []


@pytest.mark.parametrize("bad", ["abc\n", "abc\r\n", "\nabc"])
def test_mail_ids_reject_a_trailing_newline_as_typescript_does(bad: str):
    # ``$`` matches before a trailing ``\n``; the guard uses ``fullmatch`` so it is a typed invalid_id.
    recorder = Recorder()
    with pytest.raises(RyuInvalidRequestError) as raised:
        recorder.ryu(MAIL_ENV).mail.inboxes.get(bad)
    assert raised.value.code == "invalid_id"
    result = recorder.ryu(MAIL_ENV).safe.mail.inboxes.get(bad)
    assert isinstance(result.error, RyuInvalidRequestError) and result.error.code == "invalid_id"
    assert recorder.requests == []


MESSAGING_ORG_CALLS: list[Any] = [
    lambda ryu: ryu.messaging.numbers.list(),
    lambda ryu: ryu.messaging.sms.send({"to": "+15550100", "body": "hi"}),
    lambda ryu: ryu.messaging.settings.get(),
    lambda ryu: ryu.messaging.messages.list(),
]


@pytest.mark.parametrize("bad", [".", ".."])
@pytest.mark.parametrize("call", MESSAGING_ORG_CALLS)
def test_dot_organization_ids_raise_invalid_id_on_org_scoped_messaging_calls(call: Callable, bad: str):
    recorder = Recorder()
    env = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": bad}
    with pytest.raises(RyuInvalidRequestError) as raised:
        call(recorder.ryu(env))
    assert raised.value.code == "invalid_id"
    assert raised.value.service == "messaging"
    assert recorder.requests == []


def test_box_preview_delete_with_a_dot_dot_token_never_deletes_the_box():
    recorder = Recorder()
    ryu = recorder.ryu(BOX_ENV)
    with pytest.raises(RyuInvalidRequestError):
        ryu.box.previews.delete("box_1", "..")
    assert not any(request.method == "DELETE" for request in recorder.requests)


def test_box_follow_logs_refuses_a_dot_dot_process_id_before_streaming():
    recorder = Recorder()
    with pytest.raises(RyuInvalidRequestError) as raised:
        list(recorder.ryu(BOX_ENV).box.processes.follow_logs("box_1", ".."))
    assert raised.value.code == "invalid_id"
    assert recorder.requests == []


def test_dot_ids_are_refused_by_the_async_client_too():
    recorder = Recorder()

    async def run() -> Any:
        ryu = AsyncRyu(env=BOX_ENV, transport=httpx.MockTransport(recorder))
        with pytest.raises(RyuInvalidRequestError):
            await ryu.box.processes.kill("box_1", "..")
        return await ryu.safe.box.previews.delete("box_1", "..")

    result = asyncio.run(run())
    assert isinstance(result.error, RyuInvalidRequestError) and result.error.code == "invalid_id"
    assert recorder.requests == []


def test_ids_with_dots_inside_still_percent_encode():
    recorder = Recorder()
    ryu = recorder.ryu(BOX_ENV)
    ryu.box.previews.delete("box_1", "a..b")
    ryu.box.secrets.delete("../x")
    assert [request.url.raw_path for request in recorder.requests] == [
        b"/v1/boxes/box_1/previews/a..b",
        b"/v1/secrets/..%2Fx",
    ]


# ── header values ────────────────────────────────────────────────────────────


def test_a_latin_1_title_is_sent_as_latin_1_bytes_like_fetch():
    recorder = Recorder()
    recorder.ryu(NOTIFY_ENV).notify.topics.publish("alerts", "hi", {"title": "Déploiement"})
    result = recorder.ryu(NOTIFY_ENV).safe.notify.topics.publish("alerts", "hi", {"title": "Déploiement"})
    assert result.error is None
    assert (b"title", "Déploiement".encode("latin-1")) in recorder.requests[0].headers.raw
    assert recorder.requests[1].headers.get_list("title") == ["Déploiement"]


def _word(text: str) -> bytes:
    return b"=?UTF-8?B?" + base64.b64encode(text.encode("utf-8")) + b"?="


def test_topic_text_outside_latin_1_is_sent_as_rfc_2047_words_in_both_modes():
    recorder = Recorder()
    options = {"title": "Deploy ✓", "tags": ["生产", "canary"], "click": "https://example.test/部署"}
    recorder.ryu(NOTIFY_ENV).notify.topics.publish("alerts", "hi", options)
    result = recorder.ryu(NOTIFY_ENV).safe.notify.topics.publish("alerts", "hi", options)
    assert result.error is None
    for request in recorder.requests:
        raw = dict(request.headers.raw)
        assert raw[b"title"] == _word("Deploy ✓")
        assert raw[b"tags"] == _word("生产,canary")
        assert raw[b"click"] == _word("https://example.test/部署")


@pytest.mark.parametrize(
    "title", ["=?UTF-8?B?aGk=?=", "=?ISO-8859-1?Q?caf=E9?=", "Price =?x?Q?y?=", "部署 =?UTF-8?B?aGk=?="]
)
def test_topic_text_containing_an_encoded_word_marker_is_wrapped_so_it_round_trips(title: str):
    recorder = Recorder()
    options = {"title": title, "tags": [title], "click": f"https://example.test/?q={title}"}
    recorder.ryu(NOTIFY_ENV).notify.topics.publish("alerts", "hi", options)
    raw = dict(recorder.requests[0].headers.raw)
    assert raw[b"title"] == _word(title)
    assert raw[b"tags"] == _word(title)
    assert raw[b"click"] == _word(f"https://example.test/?q={title}")


def test_topic_actions_are_ascii_json():
    recorder = Recorder()
    actions = [{"label": "打开", "url": "https://example.test/run"}]
    recorder.ryu(NOTIFY_ENV).notify.topics.publish("alerts", "hi", {"actions": actions})
    raw = dict(recorder.requests[0].headers.raw)[b"actions"]
    assert raw.isascii() and json.loads(raw) == actions


@pytest.mark.parametrize("title", ["a\nb", "部署\n完成", "\ud800", "a\ud800b", "a\x00b"])
def test_a_title_fetch_refuses_still_fails_as_a_typed_error_in_both_modes(title: str):
    recorder = Recorder()
    with pytest.raises(RyuInvalidRequestError) as raised:
        recorder.ryu(NOTIFY_ENV).notify.topics.publish("alerts", "hi", {"title": title})
    assert raised.value.code == "invalid_request_header"
    assert raised.value.retryable is False
    assert raised.value.details == {"header": "title"}
    result = recorder.ryu(NOTIFY_ENV).safe.notify.topics.publish("alerts", "hi", {"title": title})
    assert isinstance(result.error, RyuInvalidRequestError) and result.error.code == "invalid_request_header"
    assert recorder.requests == []


@pytest.mark.parametrize("value", ["a\nb", "a\rb", "a\x00b", "部署"])
def test_per_call_headers_fetch_refuses_fail_as_a_typed_error(value: str):
    recorder = Recorder()
    result = recorder.ryu(NOTIFY_ENV).safe.notify.with_options(headers={"x-note": value}).publish({"title": "x"})
    assert isinstance(result.error, RyuInvalidRequestError) and result.error.code == "invalid_request_header"
    assert recorder.requests == []


def test_async_header_errors_are_typed():
    recorder = Recorder()

    async def run() -> Any:
        ryu = AsyncRyu(env=NOTIFY_ENV, transport=httpx.MockTransport(recorder))
        return await ryu.safe.notify.topics.publish("alerts", "hi", {"title": "Deploy\n✓"})

    result = asyncio.run(run())
    assert isinstance(result.error, RyuInvalidRequestError) and result.error.code == "invalid_request_header"
    assert recorder.requests == []


# ── error bodies ─────────────────────────────────────────────────────────────

CHUNK = b"x" * 4096


class EndlessBody(httpx.SyncByteStream, httpx.AsyncByteStream):
    """An error body that never ends; counts how much of it was read."""

    def __init__(self) -> None:
        self.read = 0
        self.closed = False

    def _next(self) -> bytes:
        self.read += len(CHUNK)
        if self.read > 64 * MAX_ERROR_BODY_BYTES:
            raise AssertionError("the client kept reading an endless error body")
        return CHUNK

    def __iter__(self) -> Iterator[bytes]:
        while True:
            yield self._next()

    async def __aiter__(self) -> Any:
        while True:
            yield self._next()

    def close(self) -> None:
        self.closed = True

    async def aclose(self) -> None:
        self.closed = True


def endless_transport(bodies: list[EndlessBody]) -> httpx.MockTransport:
    def answer(_request: httpx.Request) -> httpx.Response:
        body = EndlessBody()
        bodies.append(body)
        return httpx.Response(500, headers={"content-type": "text/plain"}, stream=body)

    return httpx.MockTransport(answer)


def assert_capped(bodies: list[EndlessBody]) -> None:
    assert bodies
    for body in bodies:
        assert body.read <= MAX_ERROR_BODY_BYTES + len(CHUNK)
        assert body.closed


def test_an_endless_error_body_is_read_only_up_to_the_cap():
    bodies: list[EndlessBody] = []
    ryu = Ryu(env=NOTIFY_ENV, transport=endless_transport(bodies), max_retries=0)
    with pytest.raises(RyuError) as raised:
        ryu.notify.events.get("evt_1")
    assert raised.value.status == 500
    assert_capped(bodies)


def test_an_endless_error_body_is_capped_on_every_retry():
    bodies: list[EndlessBody] = []
    ryu = Ryu(env=NOTIFY_ENV, transport=endless_transport(bodies), max_retries=2)
    ryu._core.sleep = lambda _seconds: None  # type: ignore[assignment]
    result = ryu.safe.notify.events.get("evt_1")
    assert isinstance(result.error, RyuError) and result.error.status == 500
    assert len(bodies) == 3
    assert_capped(bodies)


def test_the_async_client_caps_an_endless_error_body():
    bodies: list[EndlessBody] = []

    async def run() -> Any:
        ryu = AsyncRyu(env=NOTIFY_ENV, transport=endless_transport(bodies), max_retries=0)
        return await ryu.safe.notify.events.get("evt_1")

    result = asyncio.run(run())
    assert isinstance(result.error, RyuError) and result.error.status == 500
    assert_capped(bodies)


def test_the_managed_agents_stream_caps_an_endless_error_body():
    bodies: list[EndlessBody] = []
    ryu = Ryu(env=CONTROL_PLANE_ENV, transport=endless_transport(bodies), max_retries=0)
    with pytest.raises(RyuError) as raised:
        list(ryu.managed_agents.sessions.stream("s_1"))
    assert raised.value.status == 500
    assert_capped(bodies)


def test_a_capped_error_body_still_yields_the_error_envelope():
    envelope = b'{"code":"upstream_broken","message":"boom"}'

    def answer(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, headers={"content-type": "application/json"}, content=envelope)

    ryu = Ryu(env=NOTIFY_ENV, transport=httpx.MockTransport(answer), max_retries=0)
    result = ryu.safe.notify.events.get("evt_1")
    assert isinstance(result.error, RyuError)
    assert result.error.status == 502
    assert result.error.code == "upstream_broken"


_REPO = Path(__file__).resolve().parents[3]
_SERVICES_SRC = Path(__file__).resolve().parents[1] / "ryu_sdk" / "services"


def test_service_titles_match_typescript():
    # Messages and hints name each service the same way in both SDKs.
    source = (_REPO / "packages" / "services" / "src" / "service-titles.ts").read_text(encoding="utf-8")
    typescript = dict(re.findall(r'^\t(\w+): "([^"]+)",$', source, flags=re.MULTILINE))
    assert typescript == SERVICE_TITLES


def test_messages_never_prefix_the_lowercase_service_id():
    # `f"Ryu {service}: ..."` printed "Ryu box:" beside hints saying "Ryu Box"; messages go through
    # service_title(). A method path (`Ryu {service}.usage:`) stays code-shaped.
    pattern = re.compile(r"Ryu \{[^}]*service[^}]*\}(?!\.)")
    offenders = [
        f"{path.name}:{number}"
        for path in sorted(_SERVICES_SRC.rglob("*.py"))
        if path.name != "_service_titles.py"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if pattern.search(line)
    ]
    lowercase = re.compile(r"Ryu (?:" + "|".join(SERVICE_TITLES) + r")[: ]")
    offenders += [
        f"{path.name}:{number}"
        for path in sorted(_SERVICES_SRC.rglob("*.py"))
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if lowercase.search(line)
    ]
    assert offenders == []


@pytest.mark.parametrize("value", [math.nan, 0, -1.5, True, "5"])
def test_notify_approval_durations_reject_nan_and_non_positive_values(value: Any) -> None:
    with pytest.raises(RyuInvalidRequestError) as raised:
        notify_module._positive(value, 30.0, "timeout")
    assert raised.value.code == "invalid_timeout"


def test_notify_approval_durations_accept_positive_numbers_and_default_none() -> None:
    assert notify_module._positive(None, 30.0, "timeout") == 30.0
    assert notify_module._positive(2, 30.0, "timeout") == 2
    assert notify_module._positive(0.5, 30.0, "poll_interval") == 0.5


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (math.nan, None),
        (math.inf, None),
        (-math.inf, None),
        (True, None),
        ("3", None),
        (3.0, 3),
        (2.5, 2.5),
        (7, 7),
        (10**400, None),
        (-(10**400), None),
        (10**300, 10**300),
        # JSON.parse rounds an int just past DBL_MAX down to DBL_MAX; float() rounds the same way.
        (int(sys.float_info.max) + 1, int(sys.float_info.max) + 1),
    ],
)
def test_error_retry_after_numbers_drop_non_finite_values(value: Any, expected: Any) -> None:
    assert errors_module._num(value) == expected
