"""Per-service behaviour of ryu_sdk.services: routes, bodies, composite helpers and iterators."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Optional

import httpx
import pytest

from ryu_sdk.services import (
    Ryu,
    RyuConfigurationError,
    RyuError,
    RyuInvalidRequestError,
    RyuNotFoundError,
    RyuResponseValidationError,
    RyuTimeoutError,
    RyuUnavailableError,
    messaging_error_record,
)
from ryu_sdk.services.sites import PUBLIC_DISABLED_HINT, STORED_PUBLIC_HINT


def sse(*frames: str) -> bytes:
    return "".join(f"{frame}\n\n" for frame in frames).encode("utf-8")


class Router:
    """Answers requests by ``"METHOD /path"`` (query ignored); each route may hold a list of answers."""

    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes = {key: list(value) if isinstance(value, list) else [value] for key, value in routes.items()}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = f"{request.method} {request.url.path}"
        if key not in self.routes:
            return httpx.Response(404, json={"code": "not_found", "message": f"no route {key}"})
        answers = self.routes[key]
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        return answer(request) if callable(answer) else answer

    def ryu(self, env: dict[str, str], **options: Any) -> Ryu:
        ryu = Ryu(env=env, transport=httpx.MockTransport(self), **options)
        clock = {"now": 1_000_000.0}

        def sleep(seconds: float) -> None:
            clock["now"] += seconds

        ryu._core.sleep = sleep  # type: ignore[assignment]
        ryu._core.wall_clock = lambda: clock["now"]
        return ryu

    def bodies(self, key: str) -> list[Any]:
        method, path = key.split(" ", 1)
        return [
            json.loads(request.content) if request.content else None
            for request in self.requests
            if request.method == method and request.url.path == path
        ]


# ── Mail ─────────────────────────────────────────────────────────────────────

MAIL_ENV = {"RYU_MAIL_GATEWAY_KEY": "gw"}


def test_mail_send_resolves_the_sender_once_and_sends_with_a_key():
    router = Router(
        {
            "GET /api/mail/inboxes": httpx.Response(
                200, json={"inboxes": [{"id": "ibx_1", "address": "Agent@Acme.example"}]}
            ),
            "POST /api/mail/inboxes/ibx_1/send": httpx.Response(
                200, json={"message": {"id": "msg_1", "status": "sent"}}
            ),
        }
    )
    ryu = router.ryu(MAIL_ENV, result="object")
    first = ryu.mail.send(
        {"from": "Agent <agent@acme.example>", "to": ["p@example.com"], "subject": "Hi", "text": "Hello"},
        idempotency_key="welcome-42",
    )
    assert first.data == {"id": "msg_1", "status": "sent"}
    assert first.meta.idempotency_key == "welcome-42"
    ryu.mail.send({"from": "agent@acme.example", "to": ["q@example.com"], "text": "Again"})
    assert [request.url.path for request in router.requests].count("/api/mail/inboxes") == 1
    sends = [request for request in router.requests if request.url.path.endswith("/send")]
    assert sends[0].headers["idempotency-key"] == "welcome-42"
    assert sends[1].headers["idempotency-key"] != "welcome-42"
    assert json.loads(sends[0].content) == {"to": ["p@example.com"], "subject": "Hi", "text": "Hello"}


TICKET = "mrt_2r7Yf0kQ6bWm9pXcJ3hT1sLeAa8uVnZg4oDiRyKqE5w"
TICKET_REPLY = {
    "ticket": TICKET,
    "expiresAt": "2026-10-23T12:00:30.000Z",
    "expiresIn": 30,
    "path": "/api/mail/realtime",
    "protocols": ["ryu-mail.v1", f"ryu-ticket.{TICKET}"],
}


@pytest.mark.parametrize(
    ("env", "header", "value"),
    [
        (MAIL_ENV, "x-gateway-key", "gw"),
        ({"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}, "x-api-key", "ryu_key"),
    ],
)
def test_mail_create_realtime_ticket_mints_with_the_hosted_key(env, header, value):
    router = Router({"POST /api/mail/realtime/tickets": httpx.Response(201, json=TICKET_REPLY)})
    ticket = router.ryu(env).mail.create_realtime_ticket()
    assert ticket == dict(TICKET_REPLY, url="wss://api.ryuhq.com/api/mail/realtime")
    assert list(ticket) == ["expiresAt", "expiresIn", "path", "protocols", "ticket", "url"]
    (request,) = router.requests
    assert request.headers[header] == value
    assert "Idempotency-Key".lower() not in request.headers
    assert value not in ticket["url"] and all(value not in p for p in ticket["protocols"])


def test_mail_inboxes_create_sends_a_hosted_local_part_without_an_address():
    inbox = {"id": "inbox_1", "address": "support@acme.example", "name": "Support"}
    router = Router({"POST /api/mail/inboxes": httpx.Response(201, json=inbox)})
    created = router.ryu(MAIL_ENV).mail.inboxes.create({"name": "Support", "localPart": "support"})
    assert created["address"] == "support@acme.example"
    assert router.bodies("POST /api/mail/inboxes") == [{"name": "Support", "localPart": "support"}]


def test_mail_create_realtime_ticket_is_refused_on_self_hosted_mail():
    router = Router({})
    ryu = router.ryu({"RYU_MAIL_URL": "http://127.0.0.1:7996", "RYU_MAIL_API_KEY": "s"}, result="object")
    result = ryu.mail.create_realtime_ticket()
    assert isinstance(result.error, RyuConfigurationError)
    assert result.error.code == "realtime_ticket_unavailable"
    assert router.requests == []


def test_mail_send_reports_an_unknown_sender_and_bad_ids():
    router = Router({"GET /api/mail/inboxes": httpx.Response(200, json={"inboxes": []})})
    ryu = router.ryu(MAIL_ENV, result="object")
    missing = ryu.mail.send({"from": "nobody@acme.example", "text": "x"})
    assert isinstance(missing.error, RyuNotFoundError) and missing.error.code == "inbox_not_found"
    bad = ryu.mail.messages.get("../etc")
    assert isinstance(bad.error, RyuInvalidRequestError) and bad.error.code == "invalid_id"


def test_mail_attachments_and_references_use_the_wire_form():
    router = Router(
        {"POST /api/mail/inboxes/ibx_1/messages/m_1/reply": httpx.Response(200, json={"message": {"id": "r"}})}
    )
    ryu = router.ryu(MAIL_ENV)
    ryu.mail.with_options(idempotency_key="ticket-1234-reply").messages.reply(
        "ibx_1",
        "m_1",
        {
            "text": "Thanks",
            "references": ["<a@x>", "<b@x>"],
            "attachments": [{"filename": "a.txt", "contentBase64": "aGk=", "contentType": "text/plain"}],
        },
    )
    request = router.requests[0]
    assert request.headers["idempotency-key"] == "ticket-1234-reply"
    assert json.loads(request.content) == {
        "text": "Thanks",
        "references": "<a@x> <b@x>",
        "attachments": [{"content": "aGk=", "content_type": "text/plain", "filename": "a.txt"}],
    }


def test_mail_messages_iterate_pages_by_created_at_and_dedupes():
    pages = [
        {"messages": [{"id": "m3", "createdAt": "2026-10-03"}, {"id": "m2", "createdAt": "2026-10-02"}]},
        {"messages": [{"id": "m2", "createdAt": "2026-10-02"}, {"id": "m1", "createdAt": "2026-10-01"}]},
        {"messages": [{"id": "m0", "createdAt": "2026-09-30"}]},
    ]
    router = Router({"GET /api/mail/inboxes/ibx_1/messages": [httpx.Response(200, json=page) for page in pages]})
    ryu = router.ryu(MAIL_ENV)
    ids = [message["id"] for message in ryu.mail.messages.iterate("ibx_1", limit=2)]
    assert ids == ["m3", "m2", "m1", "m0"]
    befores = [request.url.params.get("before") for request in router.requests]
    assert befores == [None, "2026-10-02", "2026-10-01"]
    assert all(request.url.params["limit"] == "2" for request in router.requests)


def test_paginated_collect_respects_max_items():
    router = Router(
        {
            "GET /api/mail/inboxes/ibx_1/messages": httpx.Response(
                200, json={"messages": [{"id": f"m{i}", "createdAt": str(i)} for i in range(5)]}
            )
        }
    )
    assert len(router.ryu(MAIL_ENV).mail.messages.iterate("ibx_1", limit=5).collect(3)) == 3


# ── Notify ───────────────────────────────────────────────────────────────────

NOTIFY_ENV = {"RYU_NOTIFY_API_KEY": "n"}


def test_notify_topic_publish_is_plain_text_with_ntfy_headers():
    router = Router({"POST /v1/topics/deployments": httpx.Response(200, json={"event": {"id": "e"}})})
    router.ryu(NOTIFY_ENV).notify.topics.publish("deployments", "Canary is live", {"priority": 4, "tags": ["a", "b"]})
    request = router.requests[0]
    assert request.content == b"Canary is live"
    assert request.headers["content-type"].startswith("text/plain")
    assert request.headers["priority"] == "4" and request.headers["tags"] == "a,b"
    assert "idempotency-key" in request.headers


def test_notify_events_iterate_follows_next_cursor():
    router = Router(
        {
            "GET /v1/events": [
                httpx.Response(200, json={"events": [{"id": "e2"}, {"id": "e1"}], "nextCursor": "c1"}),
                httpx.Response(200, json={"events": [{"id": "e0"}], "nextCursor": None}),
            ]
        }
    )
    ryu = router.ryu(NOTIFY_ENV)
    assert [event["id"] for event in ryu.notify.events.iterate(level="error", limit=100)] == ["e2", "e1", "e0"]
    assert router.requests[1].url.params["before"] == "c1"
    assert router.requests[1].url.params["level"] == "error"


def test_notify_request_approval_polls_until_answered():
    pending = {"id": "evt_a", "response": {"status": "pending", "value": None}}
    approved = {"id": "evt_a", "response": {"status": "approved", "value": "yes please"}}
    router = Router(
        {
            "POST /v1/events": httpx.Response(201, json={"event": pending}),
            "GET /v1/events/evt_a": [
                httpx.Response(200, json={"event": pending}),
                httpx.Response(200, json={"event": approved}),
            ],
        }
    )
    ryu = router.ryu(NOTIFY_ENV, result="object")
    answer, error, meta = ryu.notify.request_approval(
        {"title": "Ship v2?", "prompt": "Ship build 184?"}, timeout=600, poll_interval=5
    )
    assert error is None
    assert answer["approved"] is True and answer["value"] == "yes please" and answer["timed_out"] is False
    published = router.bodies("POST /v1/events")[0]
    assert published["response"]["type"] == "approval" and published["response"]["prompt"] == "Ship build 184?"
    assert published["response"]["expiresAt"].endswith("Z")
    assert meta.idempotency_key is not None


def test_notify_request_approval_validates_its_options():
    ryu = Router({}).ryu(NOTIFY_ENV, result="object")
    assert ryu.notify.request_approval({"title": "x"}, timeout=-1).error.code == "invalid_timeout"
    assert ryu.notify.request_approval({"title": "x", "responseType": "text"}).error.code == "invalid_response_type"


@pytest.mark.parametrize(
    ("field", "keyword"), [("timeoutMs", "timeout="), ("pollIntervalMs", "poll_interval="), ("waitMs", "wait=")]
)
def test_notify_request_approval_refuses_typescript_option_keys_in_input(field: str, keyword: str) -> None:
    router = Router({})
    ryu = router.ryu(NOTIFY_ENV)
    with pytest.raises(RyuInvalidRequestError) as caught:
        ryu.notify.request_approval({"title": "x", "prompt": "y", field: 1000})
    assert caught.value.code == "invalid_request"
    assert field in caught.value.message and keyword in caught.value.message
    assert caught.value.details == {"fields": [field]}
    assert router.requests == []


def test_notify_activities_create_always_has_a_key_and_usage_needs_a_window():
    router = Router({"POST /v1/activities": httpx.Response(201, json={"activity": {"id": "a"}})})
    ryu = router.ryu(NOTIFY_ENV, result="object")
    ryu.notify.activities.create({"title": "Build 184", "progress": 0.1}, "build-184")
    assert router.requests[0].headers["idempotency-key"] == "build-184"
    assert ryu.notify.usage({"from": "2026-10-01T00:00:00Z"}).error.details == {"missing": ["to"]}


def test_notify_events_stream_yields_notifications_and_activities():
    body = sse('event: notification\nid: 1\ndata: {"id": "e1"}', 'event: activity\nid: 2\ndata: {"id": "a1"}')
    router = Router(
        {"GET /v1/events/stream": httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})}
    )
    items = list(router.ryu(NOTIFY_ENV).notify.events.stream(topic="deployments"))
    assert items == [
        {"type": "notification", "id": "1", "event": {"id": "e1"}},
        {"type": "activity", "id": "2", "activity": {"id": "a1"}},
    ]
    assert router.requests[0].headers["accept"] == "text/event-stream"


# ── Box ──────────────────────────────────────────────────────────────────────

BOX_ENV = {"RYU_BOX_API_KEY": "b"}


def test_box_run_creates_waits_and_collects_the_command():
    exec_stream = sse(
        'event: stdout\nid: 1\ndata: {"data": "v22.1.0\\n"}',
        'event: stderr\nid: 2\ndata: {"data": "warn"}',
        'event: exit\ndata: {"exitCode": 0, "durationMs": 12, "status": "exited"}',
    )
    router = Router(
        {
            "POST /v1/boxes": httpx.Response(201, json={"box": {"id": "box_1", "status": "provisioning"}}),
            "GET /v1/boxes/box_1": [
                httpx.Response(200, json={"box": {"id": "box_1", "status": "provisioning"}}),
                httpx.Response(200, json={"box": {"id": "box_1", "status": "ready"}}),
            ],
            "POST /v1/boxes/box_1/commands": httpx.Response(
                200, content=exec_stream, headers={"content-type": "text/event-stream"}
            ),
        }
    )
    ryu = router.ryu(BOX_ENV, result="object")
    data, error, meta = ryu.box.run({"size": "small", "command": ["node", "-v"]}, idempotency_key="run-1")
    assert error is None
    assert data["box"]["status"] == "ready"
    assert data["result"] == {"durationMs": 12, "exitCode": 0, "stderr": "warn", "stdout": "v22.1.0\n"}
    create = router.bodies("POST /v1/boxes")[0]
    assert create["size"] == "small" and create["name"].startswith("run-")
    assert router.requests[0].headers["idempotency-key"] == "run-1"
    assert router.bodies("POST /v1/boxes/box_1/commands")[0] == {"command": "node", "args": ["-v"], "stream": True}
    assert meta.idempotency_key == "run-1"


def test_box_run_times_out_while_provisioning():
    router = Router(
        {
            "POST /v1/boxes": httpx.Response(201, json={"box": {"id": "box_1", "status": "provisioning"}}),
            "GET /v1/boxes/box_1": httpx.Response(200, json={"box": {"id": "box_1", "status": "provisioning"}}),
        }
    )
    ryu = router.ryu(BOX_ENV, result="object")
    result = ryu.box.run({"command": "ls"}, ready_timeout=3, poll_interval=1)
    assert isinstance(result.error, RyuTimeoutError) and result.error.code == "box_ready_timeout"


def test_box_create_replays_are_reported_and_files_round_trip():
    router = Router(
        {
            "POST /v1/boxes": httpx.Response(200, json={"box": {"id": "box_1"}, "type": "box.existing"}),
            "PUT /v1/boxes/box_1/files/content": httpx.Response(204),
            "GET /v1/boxes/box_1/files/content": httpx.Response(200, content=b"hi\n"),
        }
    )
    ryu = router.ryu(BOX_ENV, result="object")
    created = ryu.safe.box.with_options(idempotency_key="build-runner-1").create({"name": "build-runner"})
    assert created.meta.replayed is True
    ryu.box.files.write("box_1", "hello.txt", "hi\n")
    put = next(request for request in router.requests if request.method == "PUT")
    assert put.content == b"hi\n" and put.url.params["path"] == "hello.txt"
    assert ryu.box.files.read_text("box_1", "hello.txt").data == "hi\n"


def test_box_command_parts_refuse_ambiguous_arguments():
    ryu = Router({}).ryu(BOX_ENV, result="object")
    assert ryu.box.run({"command": ["ls"], "args": ["-la"]}).error.code == "invalid_input"


# ── Gateway ──────────────────────────────────────────────────────────────────


def test_gateway_streams_chunks_until_done_and_raises_stream_errors():
    ok = sse(
        'data: {"choices": [{"delta": {"content": "Hel"}}]}',
        'data: {"choices": [{"delta": {"content": "lo"}}]}',
        "data: [DONE]",
    )
    router = Router(
        {"POST /v1/chat/completions": httpx.Response(200, content=ok, headers={"content-type": "text/event-stream"})}
    )
    ryu = router.ryu({"RYU_GATEWAY_TOKEN": "g"})
    chunks = list(ryu.gateway.chat.completions.create(model="openai/gpt-4o-mini", messages=[], stream=True))
    assert "".join(chunk["choices"][0]["delta"]["content"] for chunk in chunks) == "Hello"
    assert json.loads(router.requests[0].content)["stream"] is True

    bad = sse('data: {"error": {"message": "upstream", "type": "upstream_error"}}')
    router = Router(
        {"POST /v1/chat/completions": httpx.Response(200, content=bad, headers={"content-type": "text/event-stream"})}
    )
    with pytest.raises(RyuError) as raised:
        list(router.ryu({}).gateway.chat.completions.stream({"model": "m", "messages": []}))
    assert raised.value.code == "upstream_error"


def test_gateway_openai_compatible_config():
    ryu = Ryu(env={"RYU_GATEWAY_TOKEN": "g", "RYU_GATEWAY_URL": "http://127.0.0.1:7981/"})
    assert ryu.gateway.openai_compatible() == {"base_url": "http://127.0.0.1:7981/v1", "api_key": "g"}
    with pytest.raises(RyuConfigurationError):
        Ryu(env={"RYU_GATEWAY_URL": "nope"}, result="object").gateway.openai_compatible()


# ── Connect, Passport, Sites ─────────────────────────────────────────────────

CONNECT_ENV = {"RYU_CONNECT_URL": "https://connect.example.com", "RYU_CONNECT_API_KEY": "c"}


def test_connect_bodies_and_mcp_config():
    router = Router(
        {
            "POST /v1/exec/tool": httpx.Response(200, json={"ok": True}),
            "POST /v1/composio/execute": httpx.Response(200, json={"successful": True}),
            "GET /v1/usage": [
                httpx.Response(200, json={"lines": [{"transactionId": "t1"}], "nextCursor": "n1"}),
                httpx.Response(200, json={"lines": [{"transactionId": "t2"}], "nextCursor": None}),
            ],
        }
    )
    ryu = router.ryu(CONNECT_ENV)
    ryu.connect.tools.exec(tool_id="composio.SLACK_SEND_MESSAGE", arguments={"text": "hi"})
    ryu.connect.composio.execute(tool_id="SLACK_SEND_MESSAGE", body={"text": "hi"})
    assert router.bodies("POST /v1/exec/tool")[0] == {
        "arguments": {"text": "hi"},
        "kind": "tool",
        "tool_id": "composio.SLACK_SEND_MESSAGE",
    }
    assert router.bodies("POST /v1/composio/execute")[0] == {
        "body": {"text": "hi"},
        "operation": "execute",
        "toolId": "SLACK_SEND_MESSAGE",
    }
    lines = list(ryu.connect.usage.iterate({"from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00Z"}))
    assert [line["transactionId"] for line in lines] == ["t1", "t2"]
    assert ryu.connect.mcp() == {
        "headers": {"Authorization": "Bearer c"},
        "type": "http",
        "url": "https://connect.example.com/mcp",
    }
    assert Ryu(env=CONNECT_ENV, result="object").connect.usage({"to": "x"}).error.code == "invalid_request"


def test_passport_uses_the_runtime_key_on_runtime_routes():
    router = Router(
        {
            "POST /v1/connections/conn_1/fetch": httpx.Response(200, json=PASSPORT_FETCH),
            "GET /v1/runtime/connections": httpx.Response(200, json={"connections": []}),
        }
    )
    env = {"RYU_PASSPORT_URL": "https://passport.example.com", "RYU_PASSPORT_RUNTIME_KEY": "rt"}
    ryu = router.ryu(env, result="object")
    page = ryu.passport.runtime.connections.fetch("conn_1", {"url": "https://api.github.com/user"})
    assert page.data["status"] == 200
    ryu.passport.runtime.connections.list()
    assert all(request.headers["authorization"] == "Bearer rt" for request in router.requests)
    admin = ryu.passport.connections.create({"profile_id": "work", "domain": "api.github.com"})
    assert admin.error.details == {"missing": ["RYU_PASSPORT_API_KEY"]}
    assert ryu.passport.runtime.connections.has_runtime_grant() is True


#: ``CONNECTION`` in passport.test.ts: every field ``passportConnectionSchema`` requires.
PASSPORT_CONNECTION = {
    "created_at": 1_760_000_000,
    "domain": "github.com",
    "flow_status": "IDLE",
    "id": "conn_0123456789abcdef",
    "last_checked": 0,
    "profile_id": "work",
    "source": "manual",
    "status": "NEEDS_AUTH",
    "updated_at": 1_760_000_000,
}
PASSPORT_ENV = {"RYU_PASSPORT_URL": "https://passport.example.com", "RYU_PASSPORT_API_KEY": "admin"}
#: ``passportFetchResultSchema``: every required field of a fetch reply.
PASSPORT_FETCH = {"authenticated": True, "content": "{}", "status": 200, "truncated": False}


def test_passport_import_state_completes_a_manual_login():
    """Mirrors passport.test.ts: create, login (manual), import_state, then fetch."""
    connection = {**PASSPORT_CONNECTION, "id": "conn_1", "domain": "example.com"}
    router = Router(
        {
            "POST /v1/connections": httpx.Response(201, json={"connection": connection}),
            "POST /v1/connections/conn_1/login": httpx.Response(
                200, json={"flow_id": "flow_1", "kind": {"kind": "manual"}}
            ),
            # apps/passport/src/lib.rs import_connection: status metadata only, never the state.
            "POST /v1/connections/conn_1/import": httpx.Response(
                200,
                json={
                    "connection": {**connection, "status": "AUTHENTICATED", "flow_status": "DONE"},
                    "status": "AUTHENTICATED",
                    "flow_status": "DONE",
                },
            ),
            "POST /v1/connections/conn_1/fetch": httpx.Response(200, json=PASSPORT_FETCH),
        }
    )
    ryu = router.ryu({"RYU_PASSPORT_URL": "https://passport.example.com", "RYU_PASSPORT_API_KEY": "admin"})
    created = ryu.passport.connections.create({"profile_id": "work", "domain": "example.com", "source": "manual"})
    assert created["connection"]["status"] == "NEEDS_AUTH"
    assert ryu.passport.connections.login(created["connection"]["id"])["kind"] == {"kind": "manual"}
    imported = ryu.passport.connections.import_state("conn_1", {"state": "cookie=session=abc"})
    assert imported["status"] == "AUTHENTICATED"
    assert ryu.passport.connections.fetch("conn_1", {"url": "https://example.com/me"})["status"] == 200
    assert router.bodies("POST /v1/connections/conn_1/import") == [{"state": "cookie=session=abc"}]
    assert all(request.headers["authorization"] == "Bearer admin" for request in router.requests)


def test_passport_import_state_needs_the_admin_key_and_is_never_retried():
    runtime_only = Router({}).ryu(
        {"RYU_PASSPORT_URL": "https://passport.example.com", "RYU_PASSPORT_RUNTIME_KEY": "rt"}, result="object"
    )
    missing = runtime_only.passport.connections.import_state("conn_1", {"state": "s"})
    assert missing.error.details == {"missing": ["RYU_PASSPORT_API_KEY"]}

    router = Router(
        {
            "POST /v1/connections/conn_1/import": [
                httpx.Response(503, json={"code": "unavailable", "message": "down"}),
                httpx.Response(200, json={"id": "conn_1", "status": "AUTHENTICATED"}),
            ]
        }
    )
    flaky = router.ryu(
        {"RYU_PASSPORT_URL": "https://passport.example.com", "RYU_PASSPORT_API_KEY": "admin"}, result="object"
    )
    failed = flaky.passport.connections.import_state("conn_1", {"state": "s"})
    assert failed.error is not None
    assert len(router.requests) == 1


@pytest.mark.parametrize(
    "reply",
    [
        {"id": "conn_1", "status": "AUTHENTICATED"},
        {"connection": {**PASSPORT_CONNECTION, "created_at": "now"}, "status": "AUTHENTICATED", "flow_status": "DONE"},
        {"connection": PASSPORT_CONNECTION, "status": "SIGNED_IN", "flow_status": "DONE"},
        {"connection": PASSPORT_CONNECTION, "status": "AUTHENTICATED"},
        [],
        # Past float range: ``JSON.parse`` reads Infinity, which ``z.number()`` refuses.
        {
            "connection": {**PASSPORT_CONNECTION, "created_at": 10**400},
            "status": "AUTHENTICATED",
            "flow_status": "DONE",
        },
        {
            "connection": {**PASSPORT_CONNECTION, "updated_at": -(10**400)},
            "status": "AUTHENTICATED",
            "flow_status": "DONE",
        },
        # The ``NaN`` token (sent raw below): JSON.parse already fails on it in TypeScript.
        {
            "connection": {**PASSPORT_CONNECTION, "last_checked": math.nan},
            "status": "AUTHENTICATED",
            "flow_status": "DONE",
        },
    ],
)
def test_passport_import_state_and_get_refuse_a_reply_that_is_not_a_connection_detail(reply):
    # passportConnectionDetailSchema in TypeScript: the same replies fail with invalid_response.
    # Raw content so a 400-digit int and the ``NaN`` token reach the client as a server would send them.
    content = json.dumps(reply).encode()
    headers = {"content-type": "application/json"}
    router = Router(
        {
            "POST /v1/connections/conn_1/import": httpx.Response(200, content=content, headers=headers),
            "GET /v1/connections/conn_1": httpx.Response(200, content=content, headers=headers),
        }
    )
    ryu = router.ryu(PASSPORT_ENV, result="object")
    for result in (
        ryu.passport.connections.import_state("conn_1", {"state": "s"}),
        ryu.passport.connections.get("conn_1"),
    ):
        assert isinstance(result.error, RyuResponseValidationError)
        assert result.error.code == "invalid_response"


def test_passport_get_keeps_a_connection_detail_with_unknown_keys():
    detail = {"connection": PASSPORT_CONNECTION, "status": "NEEDS_AUTH", "flow_status": "IDLE", "extra": 1}
    router = Router({"GET /v1/connections/conn_1": httpx.Response(200, json=detail)})
    assert router.ryu(PASSPORT_ENV).passport.connections.get("conn_1") == detail


PASSPORT_BOTH_KEYS = {**PASSPORT_ENV, "RYU_PASSPORT_RUNTIME_KEY": "rt"}
PASSPORT_USAGE_WINDOW = {"from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00Z"}

#: One call per validated Passport route: (route key, call, a reply its TS schema accepts).
PASSPORT_VALIDATED_ROUTES = [
    (
        "GET /v1/connections",
        lambda ryu: ryu.passport.connections.list(),
        {"connections": [PASSPORT_CONNECTION]},
    ),
    (
        "POST /v1/connections",
        lambda ryu: ryu.passport.connections.create({"profile_id": "work", "domain": "github.com"}),
        {"connection": PASSPORT_CONNECTION},
    ),
    (
        "DELETE /v1/connections/conn_1",
        lambda ryu: ryu.passport.connections.delete("conn_1"),
        {"deleted": True, "id": "conn_1"},
    ),
    (
        "POST /v1/connections/conn_1/login",
        lambda ryu: ryu.passport.connections.login("conn_1"),
        {"flow_id": "flow_1", "kind": {"kind": "hosted", "url": "https://passport.example.com/flow/1"}},
    ),
    (
        "POST /v1/connections/conn_1/fetch",
        lambda ryu: ryu.passport.connections.fetch("conn_1", {"url": "https://api.github.com/user"}),
        {**PASSPORT_FETCH, "wwwAuthenticate": ['Bearer realm="api"']},
    ),
    (
        "GET /v1/runtime/connections",
        lambda ryu: ryu.passport.runtime.connections.list(),
        {"connections": []},
    ),
    (
        "POST /v1/connections/conn_1/fetch",
        lambda ryu: ryu.passport.runtime.connections.fetch("conn_1", {"url": "https://api.github.com/user"}),
        PASSPORT_FETCH,
    ),
    (
        "GET /v1/profiles",
        lambda ryu: ryu.passport.profiles.list(),
        {"profiles": [{"profile_id": "work", "connections": [PASSPORT_CONNECTION]}]},
    ),
    (
        "GET /v1/capabilities",
        lambda ryu: ryu.passport.capabilities(),
        {"api_version": "v1", "service": "passport", "features": {"idempotency_keys": True}},
    ),
    (
        "GET /v1/usage",
        lambda ryu: ryu.passport.usage(PASSPORT_USAGE_WINDOW),
        {
            "from": PASSPORT_USAGE_WINDOW["from"],
            "to": PASSPORT_USAGE_WINDOW["to"],
            "ok": True,
            "type": "passport.usage",
            "meters": {"connectionSeconds": 3600, "fetches": 2},
        },
    ),
]

#: Replies each route's TS schema refuses (``invalid_response``), keyed by the route's index above.
PASSPORT_MALFORMED_REPLIES = [
    (0, {"connections": [{**PASSPORT_CONNECTION, "status": "SIGNED_IN"}]}),
    (0, {"connections": {"id": "conn_1"}}),
    (0, {}),
    (1, {"connection": {**PASSPORT_CONNECTION, "domain": None}}),
    (1, {"id": "conn_1"}),
    (2, {"deleted": "yes", "id": "conn_1"}),
    (2, {"deleted": True}),
    (3, {"flow_id": "flow_1", "kind": {"kind": "hosted"}}),
    (3, {"flow_id": "flow_1", "kind": {"kind": "device"}}),
    (3, {"flow_id": "flow_1", "kind": "manual"}),
    (3, {"kind": {"kind": "manual"}}),
    (4, {**PASSPORT_FETCH, "status": "200"}),
    (4, {**PASSPORT_FETCH, "wwwAuthenticate": None}),
    (4, {**PASSPORT_FETCH, "wwwAuthenticate": [1]}),
    (4, {"status": 200, "content": "{}"}),
    (5, {"connections": [{**PASSPORT_CONNECTION, "last_checked": True}]}),
    (6, {**PASSPORT_FETCH, "truncated": 0}),
    (6, {**PASSPORT_FETCH, "status": 10**400}),
    (7, {"profiles": [{"profile_id": "work"}]}),
    (7, {"profiles": [{"profile_id": 1, "connections": []}]}),
    (7, {"profiles": [{"profile_id": "work", "connections": [{"id": "conn_1"}]}]}),
    (8, {"api_version": "v1", "service": "passport", "features": {"idempotency_keys": "true"}}),
    (8, {"api_version": "v1", "features": {}}),
    (9, {"from": "a", "to": "b", "ok": True, "type": "passport.usage", "meters": {"fetches": 2}}),
    (
        9,
        {
            "from": "a",
            "to": "b",
            "ok": "true",
            "type": "passport.usage",
            "meters": {"connectionSeconds": 1, "fetches": 2},
        },
    ),
    (9, []),
]


#: The passport/client.ts schema each route of PASSPORT_VALIDATED_ROUTES decodes with (by index).
PASSPORT_ROUTE_SCHEMAS = [
    "connectionList",
    "createdConnection",
    "deletedConnection",
    "loginFlow",
    "fetchResult",
    "connectionList",
    "fetchResult",
    "profileList",
    "capabilities",
    "usageReport",
]


def test_passport_malformed_table_is_refused_by_the_typescript_schemas():
    # services_vectors.ts runs these bodies through the Zod schemas; the hand-written table must stay
    # a subset of what TypeScript refuses. 10**400 cannot be written as JSON by TypeScript, so the
    # int-past-float case is pinned here alone.
    vectors = json.loads((Path(__file__).parent / "fixtures" / "services_vectors.json").read_text())
    refused = [(v["schema"], v["body"]) for v in vectors["passportReplies"] if not v["accepted"]]
    assert len(PASSPORT_ROUTE_SCHEMAS) == len(PASSPORT_VALIDATED_ROUTES)
    for index, reply in PASSPORT_MALFORMED_REPLIES:
        if reply == {**PASSPORT_FETCH, "status": 10**400}:
            continue
        assert (PASSPORT_ROUTE_SCHEMAS[index], reply) in refused, (index, reply)


def _passport_router(route, reply):
    content = json.dumps(reply).encode()
    return Router({route: httpx.Response(200, content=content, headers={"content-type": "application/json"})})


@pytest.mark.parametrize(("route", "call", "reply"), PASSPORT_VALIDATED_ROUTES)
def test_passport_routes_keep_a_valid_reply_with_unknown_keys(route, call, reply):
    # z.looseObject in passport/client.ts: unknown keys pass through untouched.
    body = {**reply, "extra": {"kept": True}}
    router = _passport_router(route, body)
    assert call(router.ryu(PASSPORT_BOTH_KEYS)) == body


@pytest.mark.parametrize(("index", "reply"), PASSPORT_MALFORMED_REPLIES)
def test_passport_routes_refuse_a_malformed_reply_like_typescript(index, reply):
    # Each route decodes with its passport/client.ts schema; a body it refuses is invalid_response.
    route, call, _valid = PASSPORT_VALIDATED_ROUTES[index]
    router = _passport_router(route, reply)
    result = call(router.ryu(PASSPORT_BOTH_KEYS, result="object"))
    assert isinstance(result.error, RyuResponseValidationError)
    assert result.error.code == "invalid_response"
    assert result.error.service == "passport"
    assert result.error.retryable is False
    # Never retried (the create's capability read is a separate GET).
    assert [f"{r.method} {r.url.path}" for r in router.requests].count(route) == 1


def test_passport_malformed_reply_raises_in_throw_mode():
    router = _passport_router("GET /v1/profiles", {"profiles": None})
    with pytest.raises(RyuResponseValidationError):
        router.ryu(PASSPORT_ENV).passport.profiles.list()


@pytest.mark.parametrize(
    ("state_input", "details"),
    [
        ({}, {"missing": ["state"]}),
        ({"state": None}, {"missing": ["state"]}),
        ({"state": 5}, {"invalid": ["state"]}),
        ({"state": ["a"]}, {"invalid": ["state"]}),
    ],
)
def test_passport_import_state_refuses_a_missing_or_non_string_state_before_any_request(state_input, details):
    router = Router({})
    result = router.ryu(PASSPORT_ENV, result="object").passport.connections.import_state("conn_1", state_input)
    assert isinstance(result.error, RyuInvalidRequestError)
    assert result.error.code == "invalid_request"
    assert result.error.details == details
    assert router.requests == []


def test_sites_deploy_saves_a_version_and_names_the_failed_step():
    router = Router(
        {
            "GET /api/sites/projects/site_1": httpx.Response(200, json={"id": "site_1", "revision": 3}),
            "GET /api/sites/status": httpx.Response(200, json={"baseDomain": "localhost", "visitorPort": 8091}),
            "POST /api/sites/projects/site_1/versions": httpx.Response(
                200, json={"id": "site_1", "revision": 4, "versions": [{"id": "v1"}, {"id": "v2"}]}
            ),
            "POST /api/sites/projects/site_1/deploy": httpx.Response(
                200,
                json={"id": "site_1", "slug": "launch-notes", "revision": 5, "versions": [{"id": "v2", "bytes": 10}]},
            ),
        }
    )
    env = {"RYU_SITES_URL": "http://localhost:8090", "RYU_SITES_API_KEY": "s"}
    ryu = router.ryu(env, result="object")
    data, error, _meta = ryu.sites.deploy({"projectId": "site_1", "html": "<h1>Hi</h1>", "message": "First"})
    assert error is None
    assert data["url"] == "http://launch-notes.localhost:8091/"
    assert data["version"] == {"id": "v2", "bytes": 10}
    assert router.bodies("POST /api/sites/projects/site_1/deploy")[0] == {"expectedRevision": 4, "versionId": "v2"}

    failing = Router(
        {
            "GET /api/sites/status": httpx.Response(200, json={"baseDomain": "sites.example.com"}),
            "POST /api/sites/projects/site_1/deploy": httpx.Response(
                409, json={"code": "conflict", "message": "stale"}
            ),
        }
    )
    error = (
        failing.ryu(env, result="object")
        .sites.deploy({"projectId": "site_1", "versionId": "v9", "expectedRevision": 7})
        .error
    )
    assert error.code == "conflict"
    assert error.details["step"] == "deploy" and error.details["versionId"] == "v9"


def test_a_sites_url_on_the_visitor_listener_gets_a_port_hint():
    # The visitor listener answers every unknown host with this 404; the management listener never does.
    visitor = {"error": {"code": "not_found", "message": "Site is not deployed"}}
    router = Router(
        {
            "POST /api/sites/projects": httpx.Response(404, json=visitor),
            "GET /api/sites/status": httpx.Response(404, json=visitor),
        }
    )
    env = {"RYU_SITES_URL": "http://127.0.0.1:8022", "RYU_SITES_API_KEY": "s"}
    ryu = router.ryu(env, result="object")
    for result in (ryu.sites.projects.create({"name": "Launch"}), ryu.sites.status()):
        assert isinstance(result.error, RyuNotFoundError)
        assert result.error.message == f"Site is not deployed. Hint: {result.error.hint}"
        assert "visitor listener" in result.error.hint and "RYU_SITES_PORT" in result.error.hint
    with pytest.raises(RyuNotFoundError) as raised:
        router.ryu(env).sites.status()
    assert "RYU_SITES_PORT" in raised.value.hint

    # A management 404 (an unknown project) keeps its own message and no visitor hint.
    missing = Router(
        {
            "GET /api/sites/projects/site_9": httpx.Response(
                404, json={"code": "not_found", "message": "Project not found"}
            )
        }
    )
    error = missing.ryu(env, result="object").sites.projects.get("site_9").error
    assert isinstance(error, RyuNotFoundError) and "visitor listener" not in (error.hint or "")


SITES_ENV = {"RYU_SITES_URL": "http://localhost:8021", "RYU_SITES_API_KEY": "s"}
SITE_SETTINGS = {
    "mode": "local",
    "audience": "private",
    "workspaceId": "ws_1",
    "viewers": [],
    "database": {"databaseId": "db_1", "spaceId": "space_1"},
    "extensions": {"connections": [], "mcp": False},
    "allowRemix": False,
}


def test_sites_update_settings_reads_then_puts_every_setting_with_the_patch():
    router = Router(
        {
            "GET /api/sites/projects/site_1": httpx.Response(
                200, json={"id": "site_1", "revision": 2, "settings": SITE_SETTINGS}
            ),
            "PUT /api/sites/projects/site_1/settings": lambda request: httpx.Response(
                200, json={"id": "site_1", "revision": 3, **json.loads(request.content)}
            ),
        }
    )
    ryu = router.ryu(SITES_ENV, result="object")
    data, error, _meta = ryu.sites.projects.update_settings(
        "site_1", {"audience": "invited", "viewers": ["ada@example.com"], "workspaceId": None}
    )
    assert error is None and data["revision"] == 3
    assert [f"{r.method} {r.url.path}" for r in router.requests] == [
        "GET /api/sites/projects/site_1",
        "PUT /api/sites/projects/site_1/settings",
    ]
    put = router.requests[1]
    assert put.headers["authorization"] == "Bearer s" and "idempotency-key" not in put.headers
    assert json.loads(put.content) == {
        "expectedRevision": 2,
        "settings": {**SITE_SETTINGS, "audience": "invited", "viewers": ["ada@example.com"], "workspaceId": None},
    }


def test_sites_update_settings_sends_a_pinned_revision_and_names_the_step():
    router = Router(
        {
            "GET /api/sites/projects/site_1": httpx.Response(
                200, json={"id": "site_1", "revision": 5, "settings": SITE_SETTINGS}
            ),
            "PUT /api/sites/projects/site_1/settings": httpx.Response(
                409, json={"error": {"code": "conflict", "message": "Site changed. Reload before saving."}}
            ),
        }
    )
    error = (
        router.ryu(SITES_ENV, result="object")
        .sites.projects.update_settings("site_1", {"allowRemix": True}, expected_revision=4)
        .error
    )
    assert error.code == "conflict"
    assert error.details["step"] == "settings" and error.details["expectedRevision"] == 4
    assert router.bodies("PUT /api/sites/projects/site_1/settings")[0]["expectedRevision"] == 4
    assert [r.method for r in router.requests] == ["GET", "PUT"]


def test_sites_update_settings_refuses_bad_patches_before_any_request():
    router = Router({})
    ryu = router.ryu(SITES_ENV, result="object")
    for patch in ({}, {"database": None}, {"extensions": {}}, ["audience"]):
        error = ryu.sites.projects.update_settings("site_1", patch).error  # type: ignore[arg-type]
        assert isinstance(error, RyuInvalidRequestError) and error.code == "invalid_request"
    assert router.requests == []
    with pytest.raises(RyuInvalidRequestError):
        router.ryu(SITES_ENV).sites.projects.update_settings("site_1", {})


def test_sites_make_public_sets_the_audience_and_hints_at_the_operator_switch():
    router = Router(
        {
            "GET /api/sites/projects/site_1": httpx.Response(
                200, json={"id": "site_1", "revision": 1, "settings": SITE_SETTINGS}
            ),
            "PUT /api/sites/projects/site_1/settings": httpx.Response(
                403,
                json={"error": {"code": "policy_denied", "message": "Public publishing is disabled by the operator"}},
            ),
        }
    )
    error = router.ryu(SITES_ENV, result="object").sites.projects.make_public("site_1").error
    assert router.bodies("PUT /api/sites/projects/site_1/settings")[0] == {
        "expectedRevision": 1,
        "settings": {**SITE_SETTINGS, "audience": "public"},
    }
    assert error.status == 403 and error.code == "policy_denied" and error.details["step"] == "settings"
    assert "RYU_SITES_PUBLIC=1" in error.hint and "publicEnabled" in error.hint


def test_sites_update_settings_refuses_none_on_settings_that_cannot_be_cleared():
    router = Router({})
    error = router.ryu(SITES_ENV, result="object").sites.projects.update_settings("site_1", {"audience": None}).error
    assert isinstance(error, RyuInvalidRequestError) and error.details == {"fields": ["audience"]}
    assert router.requests == []


def test_sites_update_settings_refuses_a_read_without_settings():
    router = Router({"GET /api/sites/projects/site_1": httpx.Response(200, json={"id": "site_1", "revision": 2})})
    error = router.ryu(SITES_ENV, result="object").sites.projects.update_settings("site_1", {"allowRemix": True}).error
    assert isinstance(error, RyuResponseValidationError) and error.code == "invalid_response"
    assert error.details == {"projectId": "site_1", "step": "read"}
    assert [r.method for r in router.requests] == ["GET"]


def test_sites_update_settings_does_not_retry_a_503_unavailable_configuration_refusal():
    router = Router(
        {
            "GET /api/sites/projects/site_1": httpx.Response(
                200, json={"id": "site_1", "revision": 2, "settings": SITE_SETTINGS}
            ),
            "PUT /api/sites/projects/site_1/settings": httpx.Response(
                503,
                json={
                    "error": {
                        "code": "unavailable",
                        "message": "Connect platform identity before enabling sharing or sign-in",
                    }
                },
            ),
        }
    )
    error = (
        router.ryu(SITES_ENV, result="object").sites.projects.update_settings("site_1", {"audience": "invited"}).error
    )
    assert isinstance(error, RyuUnavailableError) and error.retryable is False
    assert error.details["step"] == "settings"
    assert [r.method for r in router.requests] == ["GET", "PUT"]


def test_sites_update_settings_and_delete_are_sent_once_after_a_5xx():
    # Both carry expectedRevision, which the first attempt moves; a replay would answer a spurious 409.
    router = Router(
        {
            "GET /api/sites/projects/site_1": httpx.Response(
                200, json={"id": "site_1", "revision": 2, "settings": SITE_SETTINGS}
            ),
            "PUT /api/sites/projects/site_1/settings": httpx.Response(
                503, headers={"retry-after": "0"}, json={"error": {"code": "overloaded", "message": "Try again"}}
            ),
            "DELETE /api/sites/projects/site_1": httpx.Response(
                503, headers={"retry-after": "0"}, json={"error": {"code": "overloaded", "message": "Try again"}}
            ),
        }
    )
    ryu = router.ryu(SITES_ENV, result="object")
    assert isinstance(ryu.sites.projects.update_settings("site_1", {"allowRemix": True}).error, RyuUnavailableError)
    assert isinstance(
        ryu.sites.projects.delete("site_1", {"expectedRevision": 2, "slug": "launch"}).error, RyuUnavailableError
    )
    assert [r.method for r in router.requests] == ["GET", "PUT", "DELETE"]


def test_sites_update_settings_explains_a_site_still_saved_as_public():
    router = Router(
        {
            "GET /api/sites/projects/site_1": httpx.Response(
                200, json={"id": "site_1", "revision": 2, "settings": {**SITE_SETTINGS, "audience": "public"}}
            ),
            "PUT /api/sites/projects/site_1/settings": httpx.Response(
                403,
                json={"error": {"code": "policy_denied", "message": "Public publishing is disabled by the operator"}},
            ),
        }
    )
    ryu = router.ryu(SITES_ENV, result="object")
    error = ryu.sites.projects.update_settings("site_1", {"allowRemix": True}).error
    assert error.code == "policy_denied" and error.hint == STORED_PUBLIC_HINT
    assert error.details["step"] == "settings"
    asked = ryu.sites.projects.update_settings("site_1", {"audience": "public", "allowRemix": True}).error
    assert asked.hint == PUBLIC_DISABLED_HINT


# ── Messaging ────────────────────────────────────────────────────────────────

MESSAGING_ENV = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}


def test_messaging_sends_on_the_organization_path_with_a_key():
    router = Router(
        {
            "POST /api/messaging/orgs/org_1/sms": httpx.Response(
                201, json={"message": {"id": "msg_1", "status": "queued"}}
            )
        }
    )
    ryu = router.ryu(MESSAGING_ENV, result="object")
    data, _error, meta = ryu.messaging.sms.send(
        {"from": "num_1", "to": "+6591234567", "body": "Shipped"}, idempotency_key="order-1842"
    )
    assert data["id"] == "msg_1" and meta.idempotency_key == "order-1842"
    request = router.requests[0]
    assert request.headers["x-api-key"] == "ryu_key" and request.headers["x-ryu-organization"] == "org_1"
    # status() is credential-free; every other method still needs the full pair.
    assert Ryu(env={"RYU_API_KEY": "k"}, result="object").messaging.numbers.list().error.details == {
        "missing": ["RYU_ORGANIZATION_ID"]
    }


def test_hosted_mail_status_is_credential_free_and_self_hosted_is_not():
    router = Router({"GET /api/mail/status": httpx.Response(200, json={"configured": True, "sendConfigured": True})})
    anonymous = router.ryu({})
    assert anonymous.mail.status()["configured"] is True
    request = router.requests[0]
    assert str(request.url) == "https://api.ryuhq.com/api/mail/status"
    assert not any(h in request.headers for h in ("authorization", "x-api-key", "x-gateway-key", "x-ryu-organization"))
    router.ryu({"RYU_API_URL": "https://cp.example.com", "RYU_MAIL_URL": "https://cp.example.com"}).mail.status()
    assert str(router.requests[1].url) == "https://cp.example.com/api/mail/status"
    assert anonymous.is_configured("mail") is False
    assert anonymous.can_call_without_credentials("mail") is True
    assert anonymous.can_call_without_credentials("messaging") is True
    assert anonymous.can_call_without_credentials("notify") is False
    # Every other Mail method still needs a key.
    assert Ryu(env={}, result="object").mail.inboxes.list().error.code == "configuration_error"
    # A self-hosted URL guards its status route: its token is still required, and a ryu_ key
    # is never sent there.
    self_hosted = Ryu(env={"RYU_MAIL_URL": "http://127.0.0.1:7996", "RYU_API_KEY": "ryu_k"}, result="object")
    assert self_hosted.mail.status().error.details == {"missing": ["RYU_MAIL_API_KEY"]}
    assert self_hosted.can_call_without_credentials("mail") is False
    assert Ryu(env={"RYU_API_URL": "not a url"}).can_call_without_credentials("mail") is False
    assert len(router.requests) == 2


def test_control_plane_mail_url_without_a_key_asks_for_a_hosted_key():
    hosted = Ryu(env={"RYU_MAIL_URL": "https://api.ryuhq.com"}, result="object")
    error = hosted.mail.inboxes.list().error
    assert error.code == "configuration_error"
    assert error.details == {"missing": ["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY"]}
    assert "Hosted Ryu Mail needs a key" in str(error)
    assert "RYU_MAIL_API_KEY" not in (error.hint or "")
    assert hosted.is_configured("mail") is False
    assert hosted.can_call_without_credentials("mail") is True


def test_messaging_outcome_unknown_carries_the_record_and_is_not_retried():
    body = {"error": "outcome_unknown", "message": "unclear", "messageRecord": {"id": "msg_9", "status": "unresolved"}}
    router = Router({"POST /api/messaging/orgs/org_1/voice": httpx.Response(502, json=body)})
    ryu = router.ryu(MESSAGING_ENV, result="object")
    error = (
        ryu.messaging.with_options(idempotency_key="order-1842-voice")
        .voice.send({"from": "n", "to": "+1", "text": "t"})
        .error
    )
    assert error.code == "outcome_unknown" and error.envelope == "messaging"
    assert messaging_error_record(error) == {"id": "msg_9", "status": "unresolved"}
    assert len(router.requests) == 1


def test_messaging_feature_off_gets_the_availability_hint():
    router = Router(
        {
            "GET /api/messaging/orgs/org_1/settings": httpx.Response(
                403, json={"error": "feature_disabled", "message": "off"}
            )
        }
    )
    error = router.ryu(MESSAGING_ENV, result="object").messaging.settings.get().error
    assert error.hint.startswith("The organization's Ryu Messaging feature is off")


def test_messaging_opt_outs_iterate_skips_empty_pages():
    router = Router(
        {
            "GET /api/messaging/orgs/org_1/opt-outs": [
                httpx.Response(200, json={"optOuts": [], "nextToken": "t1"}),
                httpx.Response(200, json={"optOuts": [{"phoneNumber": "+1"}], "nextToken": None}),
            ]
        }
    )
    assert [item["phoneNumber"] for item in router.ryu(MESSAGING_ENV).messaging.opt_outs.iterate()] == ["+1"]


# ── Managed Agents ───────────────────────────────────────────────────────────

MA_ENV = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}
MA = "/api/v1/managed-agents"


def ma_stream(*events: dict[str, Any], end: Optional[int] = None) -> httpx.Response:
    frames = [f"id: {event['seq']}\nevent: message\ndata: {json.dumps(event)}" for event in events]
    if end is not None:
        frames.append(f'event: end\ndata: {{"headSeq": {end}}}')
    return httpx.Response(200, content=sse(*frames), headers={"content-type": "text/event-stream"})


def test_managed_agents_run_creates_follows_the_turn_and_rereads():
    events = (
        {"seq": 1, "type": "session.status", "status": "idle", "detail": "provisioned"},
        {"seq": 2, "type": "user.message", "content": [{"type": "text", "text": "Summarize"}]},
        {"seq": 3, "type": "agent.message", "content": [{"type": "text", "text": "Done."}]},
        {"seq": 4, "type": "session.status", "status": "idle", "inputSeq": 2, "stopReason": "end_turn"},
        {"seq": 5, "type": "agent.message", "content": [{"type": "text", "text": "never read"}]},
    )
    router = Router(
        {
            f"POST {MA}/sessions": httpx.Response(201, json={"id": "msess_1", "headSeq": 2}),
            f"GET {MA}/sessions/msess_1/stream": ma_stream(*events),
            f"GET {MA}/sessions/msess_1": httpx.Response(
                200, json={"id": "msess_1", "status": "idle", "stopReason": "end_turn"}
            ),
        }
    )
    ryu = router.ryu(MA_ENV, result="object")
    seen: list[str] = []
    data, error, meta = ryu.managed_agents.sessions.run(
        {"agentId": "magt_1", "environmentId": "menv_1", "message": "Summarize"},
        on_event=lambda event: seen.append(event["type"]),
    )
    assert error is None
    assert data["text"] == "Done."
    assert sorted(data) == ["events", "pendingApprovals", "session", "text"]
    assert data["pendingApprovals"] == []
    assert [event["seq"] for event in data["events"]] == [1, 2, 3, 4]
    assert data["session"]["stopReason"] == "end_turn"
    assert seen[-1] == "session.status"
    created = router.bodies(f"POST {MA}/sessions")[0]
    assert created["initialEvents"][-1] == {"type": "user.message", "content": [{"type": "text", "text": "Summarize"}]}
    assert "message" not in created
    create_request = next(request for request in router.requests if request.method == "POST")
    assert create_request.headers["idempotency-key"]
    stream_request = next(request for request in router.requests if request.url.path.endswith("/stream"))
    assert stream_request.headers["x-api-key"] == "ryu_key"
    assert meta.status == 200


def test_pending_tool_approvals_drops_answered_and_interrupted_requests():
    from ryu_sdk.services.managed_agents import pending_tool_approvals

    first = {"seq": 3, "type": "agent.tool_approval_request", "toolUseId": "toolu_1"}
    second = {"seq": 4, "type": "agent.tool_approval_request", "toolUseId": "toolu_2"}
    answered = {"seq": 5, "type": "user.tool_approval", "toolUseId": "toolu_1", "decision": "allow"}
    assert pending_tool_approvals([first, second, answered]) == [second]
    interrupt = {"seq": 6, "type": "user.interrupt"}
    # The interrupt alone does not abandon them (the server may reject or queue it) ...
    assert pending_tool_approvals([first, second, interrupt]) == [first, second]
    # ... the interrupted idle with no pending ids that answers it does.
    interrupted = {
        "seq": 7,
        "type": "session.status",
        "status": "idle",
        "stopReason": "interrupted",
        "inputSeq": 6,
        "pendingToolUseIds": [],
    }
    assert pending_tool_approvals([first, second, interrupt, interrupted]) == []
    # An interrupted idle that answers some other input leaves them open.
    assert pending_tool_approvals([first, second, interrupt, {**interrupted, "inputSeq": 2}]) == [first, second]
    # Out-of-order input still comes back in log order.
    assert pending_tool_approvals([second, first]) == [first, second]


def test_managed_agents_follow_terminal_and_iterate():
    router = Router(
        {
            f"GET {MA}/sessions/s_1/events": httpx.Response(200, json={"data": [], "headSeq": 2}),
            f"GET {MA}/sessions/s_1/stream": ma_stream(
                {"seq": 1, "type": "agent.message", "content": []},
                {"seq": 2, "type": "session.status", "status": "completed"},
            ),
            f"GET {MA}/agents": [
                httpx.Response(200, json={"data": [{"id": "a2"}], "nextCursor": "c"}),
                httpx.Response(200, json={"data": [{"id": "a1"}], "nextCursor": None}),
            ],
        }
    )
    ryu = router.ryu(MA_ENV)
    assert [event["seq"] for event in ryu.managed_agents.sessions.follow("s_1", until="terminal")] == [1, 2]
    assert [agent["id"] for agent in ryu.managed_agents.agents.iterate(limit=100)] == ["a2", "a1"]


def test_managed_agents_approve_tool_derives_its_idempotency_key():
    answer = {"seq": 9, "type": "user.tool_approval", "toolUseId": "toolu_0123456789", "decision": "allow"}
    router = Router({f"POST {MA}/sessions/s_1/events": httpx.Response(200, json={"data": [answer]})})
    ryu = router.ryu(MA_ENV)
    assert ryu.managed_agents.sessions.approve_tool("s_1", "toolu_0123456789") == answer
    request = router.requests[0]
    assert request.headers["idempotency-key"] == "tool-approval-allow-toolu_0123456789"
    assert json.loads(request.content)["events"][0]["decision"] == "allow"


def test_managed_agents_bound_key_is_used_for_send():
    router = Router({f"POST {MA}/sessions/msess_1/events": httpx.Response(200, json={"data": []})})
    ryu = router.ryu(MA_ENV)
    ryu.managed_agents.with_options(idempotency_key="ticket-1234-message-2").sessions.send(
        "msess_1", [{"type": "user.message", "content": [{"type": "text", "text": "Draft a reply."}]}]
    )
    assert router.requests[0].headers["idempotency-key"] == "ticket-1234-message-2"


def test_managed_agents_stream_errors_become_ryu_errors():
    router = Router(
        {f"GET {MA}/sessions/s_1/stream": httpx.Response(404, json={"error": {"code": "not_found", "message": "gone"}})}
    )
    with pytest.raises(RyuNotFoundError) as raised:
        list(router.ryu(MA_ENV).managed_agents.sessions.stream("s_1"))
    assert raised.value.envelope == "managed-agents"


def test_context_manager_returns_resolve_with_get_type_hints() -> None:
    # `Ryu.__enter__`/`AsyncRyu.__aenter__` annotate with a module-level TypeVar rather than a
    # TYPE_CHECKING-only `typing_extensions.Self`, so runtime introspection does not raise NameError.
    import typing

    from ryu_sdk.services import AsyncRyu

    for method in (Ryu.__enter__, AsyncRyu.__aenter__):
        hints = typing.get_type_hints(method)
        assert hints["return"] is hints["self"]


def test_passport_profile_that_is_not_an_object_names_its_index():
    router = _passport_router("GET /v1/profiles", {"profiles": ["work"]})
    with pytest.raises(RyuResponseValidationError) as raised:
        router.ryu(PASSPORT_ENV).passport.profiles.list()
    assert str(raised.value).endswith("expected an object profiles[0]")
