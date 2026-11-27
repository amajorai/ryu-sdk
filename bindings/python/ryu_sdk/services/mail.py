"""``ryu.mail``: hosted or self-hosted Ryu Mail.

Canonical spelling ``ryu.mail.<resource>.<verb>`` as in ``@ryuhq/services``:

==========  ===================================================================
inboxes     list, get, create, update, delete, rotate_secret, check_address,
            change_address, get_for_agent, ensure_for_agent
messages    list, search, get, update, delete, send, reply, reply_all, forward,
            download_raw, download_attachment, iterate
threads     list, get, update, delete
drafts      list, get, create, update, delete, send
webhooks    list, get, create, update, delete, rotate_secret,
            headers.list, headers.update, deliveries.list
events      list
pods        list, get, create, delete
domains     list, get, create, update, delete, verify
lists       entries, add, remove
==========  ===================================================================

plus the top-level ``status()`` and ``send()``, which resolves ``from`` (an
address or an inbox id) to the inbox and sends from it, and the hosted mailbox,
alias, agent-send, send-policy and approval calls, which have no resource
namespace and keep their ``@ryuhq/services`` names in snake_case:

==========  ===================================================================
mailbox     get_mailbox, check_mailbox_handle, claim_mailbox, adopt_mailbox,
            set_mailbox_alias_host, update_mailbox
aliases     list_aliases, check_alias, assign_alias, approve_alias,
            reject_alias, revoke_alias, reinstate_alias, transfer_alias
agents      get_agent_alias, check_agent_alias, claim_agent_alias,
            list_agent_messages, get_agent_message, get_agent_thread,
            send_as_agent, reply_as_agent
policy      get_send_policy, set_send_policy, delete_alias_send_policy
approvals   list_approvals, approve_draft, reject_draft
==========  ===================================================================
 Replies are the raw
JSON the server returns, with list containers unwrapped (``inboxes.list()``
returns the list). The Python client opens no WebSocket: on hosted Mail,
``create_realtime_ticket()`` mints a one-use ticket and returns the socket
``url`` and the ``protocols`` to offer, for any WebSocket library; otherwise poll
``events.list`` or register a webhook.

Auth follows ``config``: ``x-gateway-key`` (node gateway key),
``x-api-key`` plus ``X-Ryu-Organization`` (a ``ryu_`` key with
``mail:read|send|manage`` scopes on hosted Mail), or a bearer token for a
self-hosted server. Sends, replies, forwards, draft sends, held-draft approvals and the agent send and
reply routes get an ``Idempotency-Key`` that is reused on every retry.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any, Callable, Optional

from ._base import Namespace, Resource, call_options, compact, segment
from ._runtime import Binding, Paginated, Request
from .errors import RyuConfigurationError, RyuInvalidRequestError, RyuNotFoundError
from .shapes import MailRealtimeTicket

MOUNT = "/api/mail"
#: Methods whose route needs no credential on hosted Mail (``GET /api/mail/status`` is
#: unauthenticated on the control plane; a self-hosted server still needs its token).
CREDENTIAL_FREE_METHODS = ("status",)
#: Hosted Mail's realtime socket, opened with a ticket from ``create_realtime_ticket()``.
REALTIME_PATH = f"{MOUNT}/realtime"


def _realtime_ticket(value: Any, socket_url: str) -> MailRealtimeTicket:
    """The ticket reply in ``createRealtimeTicket``'s shape (camelCase, snake_case fallback)."""
    source: Mapping[str, Any] = value if isinstance(value, Mapping) else {}

    def pick(camel: str, snake: str, default: Any) -> Any:
        found = source.get(camel)
        if found is None:
            found = source.get(snake)
        return default if found is None else found

    protocols = source.get("protocols")
    return {
        "expiresAt": str(pick("expiresAt", "expires_at", "")),
        "expiresIn": pick("expiresIn", "expires_in", 0),
        "path": str(pick("path", "path", REALTIME_PATH)),
        "protocols": [str(item) for item in protocols] if isinstance(protocols, list) else [],
        "ticket": str(pick("ticket", "ticket", "")),
        "url": socket_url,
    }


# Apply with ``fullmatch``: ``$`` would also accept a trailing newline, which TypeScript rejects.
MAIL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
_ANGLE_ADDRESS = re.compile(r"<([^<>]+)>")

#: Prose-only Mail errors the server sends without a machine code, mapped to one.
MAIL_MESSAGE_CODES = (
    (409, "idempotency_in_progress", "a request with this Idempotency-Key is still in progress; retry shortly"),
    (
        409,
        "outcome_unknown",
        (
            "the outcome of an earlier request with this Idempotency-Key is unknown and it may have been sent; check "
            "this inbox's sent messages before sending it again with a new Idempotency-Key"
        ),
    ),
    (409, "idempotency_key_reused", "Idempotency-Key was already used with a different request"),
    (
        502,
        "outcome_unknown",
        (
            "the mail provider did not confirm this send, so it may have been sent; check this inbox's sent messages "
            "before sending it again"
        ),
    ),
    (
        409,
        "outcome_unknown",
        (
            "this draft's last send ended without a definite answer from the mail provider, so it may have been sent; "
            "check this inbox's sent messages, then send or edit it with `confirmNotSent: true` only if it is not there"
        ),
    ),
    (409, "idempotency_key_reused", "idempotency key was reused with a different inbox or request"),
    (409, "outcome_unknown", "mail send outcome is unresolved; reconcile this request before sending again"),
    (
        500,
        "outcome_unknown",
        (
            "Mail transport acknowledged the message but its replay record could not be saved; reconcile this request "
            "before retrying"
        ),
    ),
)


def mail_error_code(status: int, message: str) -> Optional[str]:
    """The machine code for a prose-only Mail error, or ``None``."""
    text = message.strip()
    return next(
        (code for code_status, code, prose in MAIL_MESSAGE_CODES if code_status == status and prose == text), None
    )


def _id(value: Any, label: str, position: int) -> str:
    if not isinstance(value, str) or not MAIL_ID_PATTERN.fullmatch(value):
        raise RyuInvalidRequestError(
            f"Ryu mail.{label}: argument {position} is not a Mail id (1-128 letters, digits, `_` and `-`).",
            service="mail",
            code="invalid_id",
            retryable=False,
        )
    return value


def _unwrap(key: str) -> Callable[[Any], Any]:
    def decode(value: Any) -> Any:
        if isinstance(value, dict) and key in value:
            return value[key]
        return value

    return decode


def _items(key: str) -> Callable[[Any], Any]:
    def decode(value: Any) -> list[Any]:
        if not isinstance(value, dict):
            raise TypeError(f"expected an object with {key!r}")
        items = value.get(key)
        return list(items) if isinstance(items, list) else []

    return decode


def wire_send_input(input: Mapping[str, Any]) -> dict[str, Any]:
    """The send body as the server reads it (attachment fields in snake_case, references joined)."""
    body = dict(input)
    attachments = body.get("attachments")
    if isinstance(attachments, list):
        body["attachments"] = [
            compact(
                {
                    "content": item.get("content", item.get("contentBase64")),
                    "content_id": item.get("contentId"),
                    "content_type": item.get("contentType"),
                    "filename": item.get("filename"),
                    "inline": item.get("inline"),
                    "url": item.get("url"),
                }
            )
            for item in attachments
        ]
    references = body.get("references")
    if isinstance(references, (list, tuple)):
        body["references"] = " ".join(references)
    return body


def _query(query: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    params: dict[str, Any] = {}
    for key, value in (query or {}).items():
        if value is None:
            continue
        params[key] = ",".join(value) if isinstance(value, (list, tuple)) else value
    return params


def _limit(limit: Any, label: str) -> Optional[dict[str, Any]]:
    """``{"limit": n}`` for the list routes that take a ``limit``, else None.

    A limit that is not a positive integer (a bool, a float, NaN, 0, a negative
    number) is refused before any request, as TypeScript refuses it: hosted
    Mail reads a bad limit as its default and self-hosted Mail answers 400.
    """
    if limit is None:
        return None
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise RyuInvalidRequestError(
            f"Ryu mail.{label}: limit must be a positive integer.",
            service="mail",
            code="invalid_limit",
            retryable=False,
        )
    return {"limit": limit}


def _agent_path(agent_id: str, rest: str = "") -> str:
    """``/api/mail/agents/<id><rest>``; an empty, ``.`` or ``..`` id is refused with ``invalid_id``."""
    return f"{MOUNT}/agents/{segment('mail', agent_id, 'the agent id')}{rest}"


def _suffix_params(values: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    """The query of ``querySuffix``: entries that are unset or empty are left out; ``None`` when none remain."""
    params = {key: value for key, value in values.items() if value is not None and value != ""}
    return params or None


def _page_query(query: Optional[Mapping[str, Any]], filters: Mapping[str, Any], *keys: str) -> dict[str, Any]:
    """The ``keys`` of ``query`` (plus keyword ``filters``) the call takes; others are ignored, as in TypeScript."""
    merged = {**dict(query or {}), **filters}
    return {key: merged.get(key) for key in keys}


def sender_address(sender: str) -> Optional[str]:
    trimmed = sender.strip()
    match = _ANGLE_ADDRESS.search(trimmed)
    address = match.group(1) if match else trimmed
    return address.strip().lower() if "@" in address else None


def page_size(limit: Optional[int]) -> int:
    if limit is None:
        return DEFAULT_PAGE_SIZE
    return min(MAX_PAGE_SIZE, max(1, int(limit)))


class InboxesResource(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/inboxes", decode=_items("inboxes")))

    def get(self, inbox_id: str) -> Any:
        return self._b.call(
            lambda _c: Request("GET", f"{MOUNT}/inboxes/{_id(inbox_id, 'inboxes.get', 1)}", decode=_unwrap("inbox"))
        )

    def create(self, input: Mapping[str, Any]) -> Any:
        """Creates an inbox from ``name`` plus, on self-hosted Mail, the required ``address``.

        Hosted Mail ignores ``address``: it uses ``localPart`` (refused when taken or invalid;
        see ``check_address``), else a local part derived from ``name``, on the default domain
        or ``domainId``.
        """
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/inboxes", json=dict(input), decode=_unwrap("inbox")))

    def update(self, inbox_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'inboxes.update', 1)}",
                json=dict(input),
                decode=_unwrap("inbox"),
            )
        )

    def delete(self, inbox_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE", f"{MOUNT}/inboxes/{_id(inbox_id, 'inboxes.delete', 1)}", decode=lambda _v: None
            )
        )

    def rotate_secret(self, inbox_id: str) -> Any:
        """Rotates the inbound secret; returns the new secret."""

        def decode(value: Any) -> str:
            value = value or {}
            return str(value.get("inboundSecret") or value.get("inbound_secret") or "")

        return self._b.call(
            lambda _c: Request(
                "POST", f"{MOUNT}/inboxes/{_id(inbox_id, 'inboxes.rotateSecret', 1)}/rotate-secret", decode=decode
            )
        )

    def check_address(self, local_part: str, *, domain_id: Optional[str] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"{MOUNT}/addresses/check", params=compact({"localPart": local_part, "domainId": domain_id})
            )
        )

    def change_address(self, inbox_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST", f"{MOUNT}/inboxes/{_id(inbox_id, 'inboxes.changeAddress', 1)}/address", json=dict(input)
            )
        )

    def get_for_agent(self, agent_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"{MOUNT}/agents/{segment('mail', agent_id, 'the agent id')}/inbox", decode=_unwrap("inbox")
            )
        )

    def ensure_for_agent(self, agent_id: str, input: Optional[Mapping[str, Any]] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/agents/{segment('mail', agent_id, 'the agent id')}/inbox",
                json=dict(input or {}),
                decode=_unwrap("inbox"),
            )
        )


class MessagesResource(Resource):
    def list(self, inbox_id: str, query: Optional[Mapping[str, Any]] = None, **filters: Any) -> Any:
        """One page: ``after``, ``before``, ``direction``, ``labels``, ``limit``, ``q``."""
        params = _query({**dict(query or {}), **filters})
        return self._b.call(
            lambda _c: Request(
                "GET",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'messages.list', 1)}/messages",
                params=params,
                decode=_items("messages"),
            )
        )

    def iterate(
        self,
        inbox_id: str,
        *,
        after: Optional[str] = None,
        before: Optional[str] = None,
        direction: Optional[str] = None,
        labels: Optional[Sequence[str]] = None,
        limit: Optional[int] = None,
        q: Optional[str] = None,
        max_items: Optional[int] = None,
    ) -> Paginated:
        """Every matching message, newest first, paging by ``createdAt`` (duplicates on a boundary are dropped)."""
        size = page_size(limit)
        filters = _query({"after": after, "direction": direction, "labels": labels, "q": q})

        def fetch(_config: Any, cursor: Optional[str]) -> Request:
            start = cursor if cursor is not None else before
            params = dict(filters, limit=size)
            if start is not None:
                params["before"] = start
            return Request(
                "GET",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'messages.iterate', 1)}/messages",
                params=params,
                decode=_items("messages"),
            )

        def next_cursor(page: list[Any], last: Any) -> Optional[str]:
            if last is None or len(page) < size or not isinstance(last, dict):
                return None
            value = last.get("createdAt", last.get("created_at"))
            return str(value) if isinstance(value, (str, int, float)) else None

        return Paginated(
            self._b,
            fetch,
            lambda page: page,
            next_cursor,
            key=lambda message: str(message.get("id")),
            max_items=max_items,
        )

    def search(self, inbox_id: str, q: str, query: Optional[Mapping[str, Any]] = None) -> Any:
        params = dict(_query(query), q=q)
        return self._b.call(
            lambda _c: Request(
                "GET",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'messages.search', 1)}/messages/search",
                params=params,
                decode=_items("messages"),
            )
        )

    def get(self, message_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"{MOUNT}/messages/{_id(message_id, 'messages.get', 1)}", decode=_unwrap("message")
            )
        )

    def update(self, inbox_id: str, message_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'messages.update', 1)}/messages/{_id(message_id, 'messages.update', 2)}",
                json=dict(input),
                decode=_unwrap("message"),
            )
        )

    def delete(self, inbox_id: str, message_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'messages.delete', 1)}/messages/{_id(message_id, 'messages.delete', 2)}",
                decode=lambda _v: None,
            )
        )

    def send(self, inbox_id: str, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """``POST /inboxes/:id/send``. Gets an ``Idempotency-Key`` (yours, or a generated one)."""
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'messages.send', 1)}/send",
                json=wire_send_input(input),
                decode=_unwrap("message"),
            ),
            call_options(idempotency_key),
        )

    def _respond(
        self,
        verb: str,
        label: str,
        inbox_id: str,
        message_id: str,
        input: Optional[Mapping[str, Any]],
        key: Optional[str],
    ) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/inboxes/{_id(inbox_id, label, 1)}/messages/{_id(message_id, label, 2)}/{verb}",
                json=wire_send_input(input or {}),
                decode=_unwrap("message"),
            ),
            call_options(key),
        )

    def reply(
        self,
        inbox_id: str,
        message_id: str,
        input: Optional[Mapping[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        return self._respond("reply", "messages.reply", inbox_id, message_id, input, idempotency_key)

    def reply_all(
        self,
        inbox_id: str,
        message_id: str,
        input: Optional[Mapping[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        return self._respond("reply-all", "messages.replyAll", inbox_id, message_id, input, idempotency_key)

    def forward(
        self, inbox_id: str, message_id: str, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None
    ) -> Any:
        return self._respond("forward", "messages.forward", inbox_id, message_id, input, idempotency_key)

    def download_raw(self, message_id: str) -> Any:
        """The raw RFC 822 message, as bytes."""
        return self._b.call(
            lambda _c: Request("GET", f"{MOUNT}/messages/{_id(message_id, 'messages.downloadRaw', 1)}/raw", raw=True)
        )

    def download_attachment(self, inbox_id: str, message_id: str, attachment_id: str) -> Any:
        """An attachment's bytes. A JSON ``{url}`` reply is followed to the signed URL without credentials."""
        label = "messages.downloadAttachment"

        def op(_config: Any) -> Any:
            response = yield Request(
                "GET",
                f"{MOUNT}/inboxes/{_id(inbox_id, label, 1)}/messages/{_id(message_id, label, 2)}"
                f"/attachments/{_id(attachment_id, label, 3)}",
                raw="response",
            )
            if "application/json" not in response.headers.get("content-type", ""):
                return response.content
            body = response.json()
            url = body.get("url") if isinstance(body, dict) else None
            if not isinstance(url, str) or not url:
                raise TypeError("the attachment response did not include a URL")
            return (yield Request("GET", url=url, raw=True))

        return self._b.call(op)


class ThreadsResource(Resource):
    def list(self, inbox_id: str, search: Optional[str] = None) -> Any:
        def op(_config: Any) -> Request:
            inbox = _id(inbox_id, "threads.list", 1)
            if search:
                return Request(
                    "GET", f"{MOUNT}/inboxes/{inbox}/threads/search", params={"q": search}, decode=_items("threads")
                )
            return Request("GET", f"{MOUNT}/inboxes/{inbox}/threads", decode=_items("threads"))

        return self._b.call(op)

    def get(self, inbox_id: str, thread_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'threads.get', 1)}/threads/{_id(thread_id, 'threads.get', 2)}",
                decode=_items("messages"),
            )
        )

    def update(self, inbox_id: str, thread_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'threads.update', 1)}/threads/{_id(thread_id, 'threads.update', 2)}",
                json=dict(input),
                decode=_items("messages"),
            )
        )

    def delete(self, inbox_id: str, thread_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'threads.delete', 1)}/threads/{_id(thread_id, 'threads.delete', 2)}",
                decode=lambda _v: None,
            )
        )


class DraftsResource(Resource):
    def list(self, inbox_id: str, *, limit: Optional[int] = None) -> Any:
        """An inbox's drafts. ``limit`` (a positive integer) caps the reply (clamped to 200, default 50); no cursor."""
        return self._b.call(
            lambda _c: Request(
                "GET",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'drafts.list', 1)}/drafts",
                params=_limit(limit, "drafts.list"),
                decode=_items("drafts"),
            )
        )

    def get(self, inbox_id: str, draft_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'drafts.get', 1)}/drafts/{_id(draft_id, 'drafts.get', 2)}",
                decode=_unwrap("draft"),
            )
        )

    def create(self, inbox_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'drafts.create', 1)}/drafts",
                json=wire_send_input(input),
                decode=_unwrap("draft"),
            )
        )

    def update(self, inbox_id: str, draft_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'drafts.update', 1)}/drafts/{_id(draft_id, 'drafts.update', 2)}",
                json=wire_send_input(input),
                decode=_unwrap("draft"),
            )
        )

    def delete(self, inbox_id: str, draft_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'drafts.delete', 1)}/drafts/{_id(draft_id, 'drafts.delete', 2)}",
                decode=lambda _v: None,
            )
        )

    def send(
        self, inbox_id: str, draft_id: str, *, idempotency_key: Optional[str] = None, confirm_not_sent: bool = False
    ) -> Any:
        """Sends a draft. Gets an ``Idempotency-Key``."""
        body: Any = {"confirmNotSent": True} if confirm_not_sent else None
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/inboxes/{_id(inbox_id, 'drafts.send', 1)}/drafts/{_id(draft_id, 'drafts.send', 2)}/send",
                **({"json": body} if body is not None else {}),
                decode=_unwrap("message"),
            ),
            call_options(idempotency_key),
        )


class WebhookHeadersResource(Resource):
    def list(self, webhook_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"{MOUNT}/webhooks/{_id(webhook_id, 'webhooks.headers.list', 1)}/headers", decode=_header_names
            )
        )

    def update(
        self,
        webhook_id: str,
        headers: Optional[Mapping[str, str]] = None,
        remove_headers: Optional[Sequence[str]] = None,
    ) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"{MOUNT}/webhooks/{_id(webhook_id, 'webhooks.headers.update', 1)}/headers",
                json={"headers": dict(headers or {}), "removeHeaders": list(remove_headers or [])},
                decode=_header_names,
            )
        )


def _header_names(value: Any) -> list[str]:
    value = value or {}
    names = value.get("headers", value.get("header_names"))
    return [str(name) for name in names] if isinstance(names, list) else []


class WebhookDeliveriesResource(Resource):
    def list(self, webhook_id: str, *, limit: Optional[int] = None) -> Any:
        """A webhook's delivery attempts, newest first. ``limit`` (a positive integer) caps the reply (default 100)."""
        return self._b.call(
            lambda _c: Request(
                "GET",
                f"{MOUNT}/webhooks/{_id(webhook_id, 'webhooks.deliveries.list', 1)}/deliveries",
                params=_limit(limit, "webhooks.deliveries.list"),
                decode=_items("deliveries"),
            )
        )


def _with_secret(value: Any) -> dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    return {"secret": value.get("secret"), "webhook": value.get("webhook", value)}


class WebhooksResource(Resource):
    def __init__(self, binding: Binding) -> None:
        super().__init__(binding)
        self.headers = WebhookHeadersResource(binding)
        self.deliveries = WebhookDeliveriesResource(binding)

    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/webhooks", decode=_items("webhooks")))

    def get(self, webhook_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"{MOUNT}/webhooks/{_id(webhook_id, 'webhooks.get', 1)}", decode=_unwrap("webhook")
            )
        )

    def create(self, input: Mapping[str, Any], inbox_id: Optional[str] = None) -> Any:
        """Creates a webhook; returns ``{"secret", "webhook"}`` (the ``whsec_`` secret is shown once)."""

        def op(_config: Any) -> Request:
            path = (
                f"{MOUNT}/inboxes/{_id(inbox_id, 'webhooks.create', 2)}/webhooks" if inbox_id else f"{MOUNT}/webhooks"
            )
            return Request("POST", path, json=dict(input), decode=_with_secret)

        return self._b.call(op)

    def update(self, webhook_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"{MOUNT}/webhooks/{_id(webhook_id, 'webhooks.update', 1)}",
                json=dict(input),
                decode=_with_secret,
            )
        )

    def rotate_secret(self, webhook_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"{MOUNT}/webhooks/{_id(webhook_id, 'webhooks.rotateSecret', 1)}",
                json={"rotateSecret": True},
                decode=_with_secret,
            )
        )

    def delete(self, webhook_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE", f"{MOUNT}/webhooks/{_id(webhook_id, 'webhooks.delete', 1)}", decode=lambda _v: None
            )
        )


class EventsResource(Resource):
    def list(
        self, inbox_id: Optional[str] = None, event_type: Optional[str] = None, *, limit: Optional[int] = None
    ) -> Any:
        """Recent events, newest first: one inbox's, or every inbox's.

        ``event_type`` filters the every-inbox route on hosted Mail only: self-hosted Mail ignores it, and
        the inbox route takes no event type. ``limit`` caps the reply; the routes have no cursor. An empty
        ``inbox_id`` is refused with ``invalid_id``, as TypeScript refuses it; pass None for every inbox.
        """
        if inbox_id is not None:
            return self._b.call(
                lambda _c: Request(
                    "GET",
                    f"{MOUNT}/inboxes/{_id(inbox_id, 'events.list', 1)}/events",
                    params=_limit(limit, "events.list"),
                    decode=_items("events"),
                )
            )

        def every_inbox(_c: Any) -> Request:
            params: dict[str, Any] = {"eventType": event_type} if event_type else {}
            params.update(_limit(limit, "events.list") or {})
            return Request("GET", f"{MOUNT}/events", params=params or None, decode=_items("events"))

        return self._b.call(every_inbox)


class PodsResource(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/pods", decode=_items("pods")))

    def get(self, pod_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/pods/{_id(pod_id, 'pods.get', 1)}"))

    def create(self, input: Mapping[str, Any]) -> Any:
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/pods", json=dict(input)))

    def delete(self, pod_id: str) -> Any:
        return self._b.call(
            lambda _c: Request("DELETE", f"{MOUNT}/pods/{_id(pod_id, 'pods.delete', 1)}", decode=lambda _v: None)
        )


class DomainsResource(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/domains", decode=_items("domains")))

    def get(self, domain_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/domains/{_id(domain_id, 'domains.get', 1)}"))

    def create(self, input: Mapping[str, Any]) -> Any:
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/domains", json=dict(input)))

    def update(self, domain_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request("PATCH", f"{MOUNT}/domains/{_id(domain_id, 'domains.update', 1)}", json=dict(input))
        )

    def verify(self, domain_id: str) -> Any:
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/domains/{_id(domain_id, 'domains.verify', 1)}/verify"))

    def delete(self, domain_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE", f"{MOUNT}/domains/{_id(domain_id, 'domains.delete', 1)}", decode=lambda _v: None
            )
        )


class ListsResource(Resource):
    """Allow and block lists: ``scope`` / ``scope_id`` / ``direction`` / ``list_type``."""

    @staticmethod
    def _path(label: str, scope: str, scope_id: str, direction: str, list_type: str) -> str:
        parts = [_id(value, label, index + 1) for index, value in enumerate((scope, scope_id, direction, list_type))]
        return f"{MOUNT}/lists/{'/'.join(parts)}"

    def entries(self, scope: str, scope_id: str, direction: str, list_type: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", self._path("lists.entries", scope, scope_id, direction, list_type), decode=_items("entries")
            )
        )

    def add(self, scope: str, scope_id: str, direction: str, list_type: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                self._path("lists.add", scope, scope_id, direction, list_type),
                json=dict(input),
                decode=_unwrap("entry"),
            )
        )

    def remove(self, scope: str, scope_id: str, direction: str, list_type: str, entry: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE",
                f"{self._path('lists.remove', scope, scope_id, direction, list_type)}/"
                f"{segment('mail', entry, 'the list entry')}",
                decode=lambda _v: None,
            )
        )


class MailNamespace(Namespace):
    """``ryu.mail``."""

    def __init__(self, binding: Binding) -> None:
        super().__init__(binding)
        self.inboxes = InboxesResource(binding)
        self.messages = MessagesResource(binding)
        self.threads = ThreadsResource(binding)
        self.drafts = DraftsResource(binding)
        self.webhooks = WebhooksResource(binding)
        self.events = EventsResource(binding)
        self.pods = PodsResource(binding)
        self.domains = DomainsResource(binding)
        self.lists = ListsResource(binding)

    def status(self) -> Any:
        """``GET /api/mail/status``: whether Mail is configured and can send. On hosted Mail it runs
        without a Mail key (and then sends none); a self-hosted server needs its token."""
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/status"), method="status")

    def create_realtime_ticket(self) -> Any:
        """``POST /api/mail/realtime/tickets``: a one-use hosted Mail realtime ticket.

        The ticket is valid for 30 seconds and opens one socket. Returns the same
        shape as the TypeScript ``createRealtimeTicket()``: ``ticket``,
        ``expiresAt``, ``expiresIn``, ``path``, ``protocols`` and ``url`` (the
        absolute ``wss://`` socket URL); offer ``protocols`` as the WebSocket
        subprotocols, e.g.
        ``websockets.connect(t["url"], subprotocols=t["protocols"])``. Neither the
        key nor the ticket goes in the URL. Self-hosted Mail has no tickets: its
        socket takes the token as a ``ryu-bearer.<token>`` subprotocol.
        """

        def op(config: Any) -> Request:
            if config.mail_mode == "self-hosted":
                raise RyuConfigurationError(
                    "Ryu mail.create_realtime_ticket: realtime tickets are a hosted Mail feature; self-hosted Mail "
                    "authenticates the socket with its token.",
                    service="mail",
                    code="realtime_ticket_unavailable",
                    retryable=False,
                )
            socket_url = re.sub(r"^http", "ws", config.base_url.rstrip("/") + REALTIME_PATH)
            return Request(
                "POST",
                f"{MOUNT}/realtime/tickets",
                decode=lambda value: _realtime_ticket(value, socket_url),
            )

        return self._b.call(op)

    def send(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """Sends from the inbox ``input["from"]`` names (an address this key can see, or an inbox id).

        The address is resolved with one ``inboxes.list()`` the first time and
        cached on this ``Ryu`` instance. The send gets an ``Idempotency-Key``.
        """
        body = dict(input)
        sender = body.pop("from", None)
        cache = self._b.core.caches.setdefault("mail.inboxes", {})

        def op(_config: Any) -> Any:
            inbox_id = yield from _resolve_inbox(sender, cache)
            return (
                yield Request(
                    "POST",
                    f"{MOUNT}/inboxes/{inbox_id}/send",
                    json=wire_send_input(body),
                    decode=_unwrap("message"),
                )
            )

        return self._b.call(op, call_options(idempotency_key, headers))

    # -- Hosted mailbox, alias, agent-send, send-policy and approval calls -------------------------------------------

    def get_mailbox(self) -> Any:
        """``GET /api/mail/mailbox``: the organization mailbox, or the legacy inboxes an admin may adopt one from."""
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/mailbox"))

    def check_mailbox_handle(self, handle: str) -> Any:
        """``GET /api/mail/mailbox/check``: whether ``handle`` could become the organization mailbox."""
        return self._b.call(
            lambda _c: Request("GET", f"{MOUNT}/mailbox/check", params=_suffix_params({"handle": handle}))
        )

    def claim_mailbox(self, input: Mapping[str, Any]) -> Any:
        """Claims the organization mailbox: ``{"handle", "confirmAddress", "name"?}``. It can never be changed."""
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/mailbox", json=dict(input)))

    def adopt_mailbox(self, input: Mapping[str, Any]) -> Any:
        """Makes a legacy shared inbox the organization mailbox, permanently: ``{"inboxId", "confirmAddress"}``."""
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/mailbox/adopt", json=dict(input)))

    def set_mailbox_alias_host(self, label: str) -> Any:
        """Chooses the mailbox's alias host label once."""
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/mailbox/alias-host", json={"label": label}))

    def update_mailbox(self, patch: Mapping[str, Any]) -> Any:
        """``PATCH /api/mail/mailbox``: ``aliasClaimPolicy``, ``brandingRemoved``, ``enabled`` or ``name``."""
        return self._b.call(lambda _c: Request("PATCH", f"{MOUNT}/mailbox", json=dict(patch)))

    def list_aliases(self, query: Optional[Mapping[str, Any]] = None, **filters: Any) -> Any:
        """One page of aliases: ``cursor``, ``limit``, ``status``."""
        params = _suffix_params(_page_query(query, filters, "cursor", "limit", "status"))
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/aliases", params=params))

    def check_alias(self, local_part: str, domain_id: Optional[str] = None) -> Any:
        """Whether an admin could assign ``local_part`` (on ``domain_id``)."""
        params = _suffix_params({"domainId": domain_id, "localPart": local_part})
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/aliases/check", params=params))

    def assign_alias(self, input: Mapping[str, Any]) -> Any:
        """Assigns an agent its permanent address: ``{"agentId", "localPart", "displayName"?, "domainId"?}``."""
        return self._b.call(lambda _c: Request("POST", f"{MOUNT}/aliases", json=dict(input)))

    def approve_alias(self, alias_id: str) -> Any:
        return self._b.call(
            lambda _c: Request("POST", f"{MOUNT}/aliases/{segment('mail', alias_id, 'the alias id')}/approve")
        )

    def reject_alias(self, alias_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/aliases/{segment('mail', alias_id, 'the alias id')}/reject",
                decode=lambda _v: None,
            )
        )

    def revoke_alias(self, alias_id: str, reason: Optional[str] = None) -> Any:
        """Retires an alias forever; it can be reinstated for the same agent for 30 days."""
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/aliases/{segment('mail', alias_id, 'the alias id')}/revoke",
                json=compact({"reason": reason}),
            )
        )

    def reinstate_alias(self, alias_id: str) -> Any:
        return self._b.call(
            lambda _c: Request("POST", f"{MOUNT}/aliases/{segment('mail', alias_id, 'the alias id')}/reinstate")
        )

    def transfer_alias(self, alias_id: str, input: Mapping[str, Any]) -> Any:
        """Moves an active alias to another agent: ``{"agentId", "confirmAddress"}``."""
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/aliases/{segment('mail', alias_id, 'the alias id')}/transfer",
                json=dict(input),
            )
        )

    def get_agent_alias(self, agent_id: str) -> Any:
        """The agent's live address and the organization mailbox it sits on."""
        return self._b.call(lambda _c: Request("GET", _agent_path(agent_id, "/alias")))

    def check_agent_alias(self, agent_id: str, local_part: Optional[str] = None) -> Any:
        """Whether the agent could claim ``local_part`` (else its default name)."""
        params = _suffix_params({"localPart": local_part})
        return self._b.call(lambda _c: Request("GET", _agent_path(agent_id, "/alias/check"), params=params))

    def claim_agent_alias(
        self,
        agent_id: str,
        input: Optional[Mapping[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        """Claims the agent's permanent address, or returns the one it has.

        The route is not in the Mail route table, so no key is generated: ``idempotency_key``
        is sent as the ``Idempotency-Key`` header when given, and only then.
        """
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self._b.call(
            lambda _c: Request("POST", _agent_path(agent_id, "/alias"), json=dict(input or {}), headers=headers)
        )

    def list_agent_messages(self, agent_id: str, query: Optional[Mapping[str, Any]] = None, **filters: Any) -> Any:
        """One page of the agent's view: ``cursor``, ``limit``, ``unread`` (a truthy value sends ``unread=1``)."""
        merged = _page_query(query, filters, "cursor", "limit", "unread")
        merged["unread"] = "1" if merged["unread"] else None
        params = _suffix_params(merged)
        return self._b.call(lambda _c: Request("GET", _agent_path(agent_id, "/messages"), params=params))

    def get_agent_message(self, agent_id: str, message_id: str) -> Any:
        """One message of the agent's view; marks it read."""
        return self._b.call(
            lambda _c: Request(
                "GET", _agent_path(agent_id, f"/messages/{segment('mail', message_id, 'the message id')}")
            )
        )

    def get_agent_thread(self, agent_id: str, thread_ref: str) -> Any:
        """One conversation of the agent's view, oldest first (``thread_ref`` is a ``threadId`` the view returned)."""
        return self._b.call(
            lambda _c: Request(
                "GET", _agent_path(agent_id, f"/threads/{segment('mail', thread_ref, 'the thread ref')}")
            )
        )

    def send_as_agent(self, agent_id: str, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """Sends from the agent's address; held for an admin when the send policy says so. Gets an ``Idempotency-Key``."""
        return self._b.call(
            lambda _c: Request("POST", _agent_path(agent_id, "/send"), json=dict(input)),
            call_options(idempotency_key),
        )

    def reply_as_agent(self, agent_id: str, message_id: str, input: Mapping[str, Any]) -> Any:
        """Replies from the agent's address: ``{"text", "replyAll"?}``. Gets an ``Idempotency-Key``."""
        return self._b.call(
            lambda _c: Request(
                "POST",
                _agent_path(agent_id, f"/messages/{segment('mail', message_id, 'the message id')}/reply"),
                json=dict(input),
            )
        )

    def get_send_policy(self, alias_id: Optional[str] = None) -> Any:
        """The effective send policy of an alias, else the owner default."""
        params = _suffix_params({"aliasId": alias_id})
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/send-policy", params=params))

    def set_send_policy(self, input: Mapping[str, Any]) -> Any:
        return self._b.call(lambda _c: Request("PUT", f"{MOUNT}/send-policy", json=dict(input)))

    def delete_alias_send_policy(self, alias_id: str) -> Any:
        """Removes an alias's override, so the owner default applies again."""
        return self._b.call(
            lambda _c: Request(
                "DELETE",
                f"{MOUNT}/send-policy/alias/{segment('mail', alias_id, 'the alias id')}",
                decode=lambda _v: None,
            )
        )

    def list_approvals(self, query: Optional[Mapping[str, Any]] = None, **filters: Any) -> Any:
        """Agent sends waiting for an admin, newest first (``cursor``)."""
        params = _suffix_params(_page_query(query, filters, "cursor"))
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/approvals", params=params))

    def approve_draft(self, draft_id: str) -> Any:
        """Sends a held draft; refused with ``approval_stale`` when it changed. Gets an ``Idempotency-Key``."""
        return self._b.call(
            lambda _c: Request("POST", f"{MOUNT}/drafts/{segment('mail', draft_id, 'the draft id')}/approve")
        )

    def reject_draft(self, draft_id: str, reason: Optional[str] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"{MOUNT}/drafts/{segment('mail', draft_id, 'the draft id')}/reject",
                json=compact({"reason": reason}),
                decode=lambda _v: None,
            )
        )


def _resolve_inbox(sender: Any, cache: dict[str, str]) -> Any:
    if not isinstance(sender, str) or sender.strip() == "":
        raise RyuInvalidRequestError(
            "Ryu mail.send: `from` must be a sender address or an inbox id.",
            service="mail",
            code="invalid_from",
            retryable=False,
        )
    address = sender_address(sender)
    if address is None:
        inbox_id = sender.strip()
        if not MAIL_ID_PATTERN.fullmatch(inbox_id):
            raise RyuInvalidRequestError(
                "Ryu mail.send: `from` is neither an address nor an inbox id (letters, digits, `_` and `-`).",
                service="mail",
                code="invalid_from",
                retryable=False,
            )
        return inbox_id
    cached = cache.get(address)
    if cached is not None:
        return cached
    inboxes = yield Request("GET", f"{MOUNT}/inboxes", decode=_items("inboxes"))
    for inbox in inboxes:
        if isinstance(inbox, dict) and inbox.get("address") and inbox.get("id"):
            cache[str(inbox["address"]).lower()] = str(inbox["id"])
    found = cache.get(address)
    if found is None:
        raise RyuNotFoundError(
            f"Ryu mail.send: no inbox this key can see has the address {address}.",
            service="mail",
            code="inbox_not_found",
            details={"from": address},
            hint="Create the inbox first, or pass its id as `from`.",
            retryable=False,
        )
    return found
