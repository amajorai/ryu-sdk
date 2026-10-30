"""The hosted Mail mailbox, alias, agent-send, send-policy and approval calls, and ``box.limits``.

Each call is checked against the request ``@ryuhq/services`` makes for it (``MailAPI`` in
``packages/client/src/mail.ts``): method, path, query, body and ``Idempotency-Key`` behaviour.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

import httpx
import pytest

from ryu_sdk.services import Ryu, RyuInvalidRequestError
from ryu_sdk.services.box import BOX_ERROR_CODES
from ryu_sdk.services.transport import SERVICE_ROUTES

MAIL_ENV = {"RYU_MAIL_GATEWAY_KEY": "gw"}


def _mail(requests: list[httpx.Request], **options: Any) -> Ryu:
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True})

    return Ryu(env=MAIL_ENV, transport=httpx.MockTransport(handler), **options)


def _body(request: httpx.Request) -> Any:
    return json.loads(request.content) if request.content else None


Call = Callable[[Any], Any]

#: (call, method, path, query, body). ``body`` None means the request has no body.
CASES: list[tuple[str, Call, str, str, dict[str, str], Any]] = [
    ("get_mailbox", lambda m: m.get_mailbox(), "GET", "/api/mail/mailbox", {}, None),
    (
        "check_mailbox_handle",
        lambda m: m.check_mailbox_handle("acme"),
        "GET",
        "/api/mail/mailbox/check",
        {"handle": "acme"},
        None,
    ),
    (
        "claim_mailbox",
        lambda m: m.claim_mailbox({"handle": "acme", "confirmAddress": "acme@x.example"}),
        "POST",
        "/api/mail/mailbox",
        {},
        {"handle": "acme", "confirmAddress": "acme@x.example"},
    ),
    (
        "adopt_mailbox",
        lambda m: m.adopt_mailbox({"inboxId": "ibx_1", "confirmAddress": "a@x.example"}),
        "POST",
        "/api/mail/mailbox/adopt",
        {},
        {"inboxId": "ibx_1", "confirmAddress": "a@x.example"},
    ),
    (
        "set_mailbox_alias_host",
        lambda m: m.set_mailbox_alias_host("team"),
        "POST",
        "/api/mail/mailbox/alias-host",
        {},
        {"label": "team"},
    ),
    (
        "update_mailbox",
        lambda m: m.update_mailbox({"enabled": False}),
        "PATCH",
        "/api/mail/mailbox",
        {},
        {"enabled": False},
    ),
    (
        "list_aliases",
        lambda m: m.list_aliases({"cursor": "c1", "limit": 25, "status": "pending", "ignored": "x"}),
        "GET",
        "/api/mail/aliases",
        {"cursor": "c1", "limit": "25", "status": "pending"},
        None,
    ),
    (
        "list_aliases_keywords",
        lambda m: m.list_aliases(status="active"),
        "GET",
        "/api/mail/aliases",
        {"status": "active"},
        None,
    ),
    ("list_aliases_empty", lambda m: m.list_aliases(), "GET", "/api/mail/aliases", {}, None),
    (
        "check_alias",
        lambda m: m.check_alias("sales", "dom_1"),
        "GET",
        "/api/mail/aliases/check",
        {"domainId": "dom_1", "localPart": "sales"},
        None,
    ),
    (
        "assign_alias",
        lambda m: m.assign_alias({"agentId": "ag_1", "localPart": "sales"}),
        "POST",
        "/api/mail/aliases",
        {},
        {"agentId": "ag_1", "localPart": "sales"},
    ),
    ("approve_alias", lambda m: m.approve_alias("al 1"), "POST", "/api/mail/aliases/al%201/approve", {}, None),
    ("reject_alias", lambda m: m.reject_alias("al_1"), "POST", "/api/mail/aliases/al_1/reject", {}, None),
    ("revoke_alias", lambda m: m.revoke_alias("al_1"), "POST", "/api/mail/aliases/al_1/revoke", {}, {}),
    (
        "revoke_alias_reason",
        lambda m: m.revoke_alias("al_1", "left the team"),
        "POST",
        "/api/mail/aliases/al_1/revoke",
        {},
        {"reason": "left the team"},
    ),
    ("reinstate_alias", lambda m: m.reinstate_alias("al_1"), "POST", "/api/mail/aliases/al_1/reinstate", {}, None),
    (
        "transfer_alias",
        lambda m: m.transfer_alias("al_1", {"agentId": "ag_2", "confirmAddress": "a@x.example"}),
        "POST",
        "/api/mail/aliases/al_1/transfer",
        {},
        {"agentId": "ag_2", "confirmAddress": "a@x.example"},
    ),
    (
        "get_agent_alias",
        lambda m: m.get_agent_alias("node:ag/1"),
        "GET",
        "/api/mail/agents/node%3Aag%2F1/alias",
        {},
        None,
    ),
    (
        "check_agent_alias",
        lambda m: m.check_agent_alias("ag_1", "sales"),
        "GET",
        "/api/mail/agents/ag_1/alias/check",
        {"localPart": "sales"},
        None,
    ),
    (
        "check_agent_alias_default",
        lambda m: m.check_agent_alias("ag_1"),
        "GET",
        "/api/mail/agents/ag_1/alias/check",
        {},
        None,
    ),
    ("claim_agent_alias_default", lambda m: m.claim_agent_alias("ag_1"), "POST", "/api/mail/agents/ag_1/alias", {}, {}),
    (
        "claim_agent_alias",
        lambda m: m.claim_agent_alias("ag_1", {"localPart": "sales", "displayName": "Sales"}),
        "POST",
        "/api/mail/agents/ag_1/alias",
        {},
        {"localPart": "sales", "displayName": "Sales"},
    ),
    (
        "list_agent_messages",
        lambda m: m.list_agent_messages("ag_1", {"cursor": "c", "limit": 10, "unread": True}),
        "GET",
        "/api/mail/agents/ag_1/messages",
        {"cursor": "c", "limit": "10", "unread": "1"},
        None,
    ),
    (
        "list_agent_messages_read",
        lambda m: m.list_agent_messages("ag_1", unread=False),
        "GET",
        "/api/mail/agents/ag_1/messages",
        {},
        None,
    ),
    (
        "get_agent_message",
        lambda m: m.get_agent_message("ag_1", "m 1"),
        "GET",
        "/api/mail/agents/ag_1/messages/m%201",
        {},
        None,
    ),
    (
        "get_agent_thread",
        lambda m: m.get_agent_thread("ag_1", "t_1"),
        "GET",
        "/api/mail/agents/ag_1/threads/t_1",
        {},
        None,
    ),
    (
        "send_as_agent",
        lambda m: m.send_as_agent("ag_1", {"to": ["a@x.example"], "subject": "Hi", "text": "Hello"}),
        "POST",
        "/api/mail/agents/ag_1/send",
        {},
        {"to": ["a@x.example"], "subject": "Hi", "text": "Hello"},
    ),
    (
        "reply_as_agent",
        lambda m: m.reply_as_agent("ag_1", "m_1", {"text": "Thanks", "replyAll": True}),
        "POST",
        "/api/mail/agents/ag_1/messages/m_1/reply",
        {},
        {"text": "Thanks", "replyAll": True},
    ),
    ("get_send_policy", lambda m: m.get_send_policy(), "GET", "/api/mail/send-policy", {}, None),
    (
        "get_send_policy_alias",
        lambda m: m.get_send_policy("al_1"),
        "GET",
        "/api/mail/send-policy",
        {"aliasId": "al_1"},
        None,
    ),
    (
        "set_send_policy",
        lambda m: m.set_send_policy({"mode": "always"}),
        "PUT",
        "/api/mail/send-policy",
        {},
        {"mode": "always"},
    ),
    (
        "delete_alias_send_policy",
        lambda m: m.delete_alias_send_policy("al_1"),
        "DELETE",
        "/api/mail/send-policy/alias/al_1",
        {},
        None,
    ),
    ("list_approvals", lambda m: m.list_approvals(), "GET", "/api/mail/approvals", {}, None),
    (
        "list_approvals_cursor",
        lambda m: m.list_approvals({"cursor": "c"}),
        "GET",
        "/api/mail/approvals",
        {"cursor": "c"},
        None,
    ),
    ("approve_draft", lambda m: m.approve_draft("d_1"), "POST", "/api/mail/drafts/d_1/approve", {}, None),
    ("reject_draft", lambda m: m.reject_draft("d_1"), "POST", "/api/mail/drafts/d_1/reject", {}, {}),
    (
        "reject_draft_reason",
        lambda m: m.reject_draft("d_1", "off topic"),
        "POST",
        "/api/mail/drafts/d_1/reject",
        {},
        {"reason": "off topic"},
    ),
]


@pytest.mark.parametrize(("name", "call", "method", "path", "query", "body"), CASES, ids=[case[0] for case in CASES])
def test_hosted_mail_calls_make_the_typescript_request(
    name: str, call: Call, method: str, path: str, query: dict[str, str], body: Any
) -> None:
    requests: list[httpx.Request] = []
    call(_mail(requests).mail)
    (request,) = requests
    assert request.method == method
    assert request.url.raw_path.decode().split("?")[0] == path
    assert dict(request.url.params) == query
    assert _body(request) == body
    assert request.headers["x-gateway-key"] == "gw"


def test_calls_that_answer_no_content_return_none() -> None:
    requests: list[httpx.Request] = []
    mail = _mail(requests).mail
    assert mail.reject_alias("al_1") is None
    assert mail.delete_alias_send_policy("al_1") is None
    assert mail.reject_draft("d_1") is None


def test_replies_are_the_raw_json() -> None:
    requests: list[httpx.Request] = []
    assert _mail(requests).mail.get_mailbox() == {"ok": True}


@pytest.mark.parametrize(
    ("call", "path"),
    [
        (lambda m, key: m.send_as_agent("ag_1", {"text": "x"}, idempotency_key=key), "/api/mail/agents/ag_1/send"),
        (lambda m, key: m.reply_as_agent("ag_1", "m_1", {"text": "x"}), "/api/mail/agents/ag_1/messages/m_1/reply"),
        (lambda m, key: m.approve_draft("d_1"), "/api/mail/drafts/d_1/approve"),
    ],
    ids=["send_as_agent", "reply_as_agent", "approve_draft"],
)
def test_the_three_idempotent_routes_carry_a_key(call: Callable[[Any, Optional[str]], Any], path: str) -> None:
    requests: list[httpx.Request] = []
    call(_mail(requests).mail, None)
    (request,) = requests
    assert request.url.path == path
    assert request.headers["idempotency-key"]


def test_a_caller_key_is_sent_as_is_on_send_as_agent_and_with_options() -> None:
    requests: list[httpx.Request] = []
    mail = _mail(requests).mail
    mail.send_as_agent("ag_1", {"text": "x"}, idempotency_key="ticket-1234-send")
    mail.with_options(idempotency_key="ticket-1234-reply").reply_as_agent("ag_1", "m_1", {"text": "x"})
    assert [request.headers["idempotency-key"] for request in requests] == ["ticket-1234-send", "ticket-1234-reply"]


def test_a_retried_agent_send_reuses_its_key() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(503, json={"message": "try again"}, headers={"retry-after": "0"})
        return httpx.Response(200, json={"status": "sent", "messageId": "m_1"})

    ryu = Ryu(env=MAIL_ENV, transport=httpx.MockTransport(handler))
    ryu._core.sleep = lambda _seconds: None  # type: ignore[assignment]
    assert ryu.mail.send_as_agent("ag_1", {"text": "x"})["status"] == "sent"
    assert len(requests) == 2
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]


def test_claim_agent_alias_sends_a_key_only_when_given() -> None:
    requests: list[httpx.Request] = []
    mail = _mail(requests).mail
    mail.claim_agent_alias("ag_1")
    mail.claim_agent_alias("ag_1", {"localPart": "sales"}, idempotency_key="claim-ag-1-sales")
    assert "idempotency-key" not in requests[0].headers
    assert requests[1].headers["idempotency-key"] == "claim-ag-1-sales"


def test_reads_and_other_writes_carry_no_key() -> None:
    requests: list[httpx.Request] = []
    mail = _mail(requests).mail
    mail.get_mailbox()
    mail.approve_alias("al_1")
    mail.set_send_policy({"mode": "auto"})
    mail.reject_draft("d_1")
    assert all("idempotency-key" not in request.headers for request in requests)


def test_the_route_table_names_the_three_hosted_routes() -> None:
    rows = {(route.method, route.path, route.required) for route in SERVICE_ROUTES["mail"].idempotent}
    assert {
        ("POST", "/drafts/{id}/approve", False),
        ("POST", "/agents/{agentId}/send", False),
        ("POST", "/agents/{agentId}/messages/{messageId}/reply", False),
    } <= rows


@pytest.mark.parametrize(
    "call",
    [
        lambda m: m.approve_alias(""),
        lambda m: m.revoke_alias(".."),
        lambda m: m.get_agent_alias(""),
        lambda m: m.get_agent_message("ag_1", ".."),
        lambda m: m.get_agent_thread("ag_1", "."),
        lambda m: m.send_as_agent("", {"text": "x"}),
        lambda m: m.reply_as_agent("ag_1", "", {"text": "x"}),
        lambda m: m.delete_alias_send_policy(".."),
        lambda m: m.approve_draft(""),
        lambda m: m.reject_draft(".."),
    ],
)
def test_empty_and_dot_ids_are_refused_before_any_request(call: Call) -> None:
    requests: list[httpx.Request] = []
    with pytest.raises(RyuInvalidRequestError) as raised:
        call(_mail(requests).mail)
    assert raised.value.code == "invalid_id"
    assert requests == []


def test_box_limits_reads_the_tenant_limits() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"limits": {"runningBoxes": 2}})

    ryu = Ryu(env={"RYU_BOX_API_KEY": "b"}, transport=httpx.MockTransport(handler))
    assert ryu.box.limits() == {"limits": {"runningBoxes": 2}}
    (request,) = requests
    assert (request.method, request.url.path) == ("GET", "/v1/limits")


def test_box_error_codes_include_the_capacity_billing_stream_and_replay_codes() -> None:
    assert BOX_ERROR_CODES[-4:] == (
        "capacity_unavailable",
        "billing_owner_mismatch",
        "stream_direct_only",
        "token_replayed",
    )
