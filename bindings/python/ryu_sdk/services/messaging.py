"""``ryu.messaging``: Ryu Messaging (SMS, MMS, voice, WhatsApp) on the control plane.

Uses the same ``ryu_`` key and organization as Managed Agents
(``RYU_API_KEY``, ``RYU_ORGANIZATION_ID``, ``RYU_API_URL``); every route names
the organization in its path. ``sms/mms/voice/whatsapp.send`` and
``numbers.buy`` spend credit, so the server requires an ``Idempotency-Key``:
the SDK always sends one (yours, or a generated one) and reuses it on retries.
``settings.update`` (``PUT``) is never resent after a network error, timeout
or 5xx: the reply that creates the webhook secret is the only one that
carries it. ``status()`` needs no credentials: without ``RYU_API_KEY`` and
``RYU_ORGANIZATION_ID`` it runs and sends neither; every other method still
fails with the missing-credential ``RyuConfigurationError``.

``status``, ``quote``, ``sms.send``, ``mms.send``, ``voice.send``,
``whatsapp.send``, ``whatsapp.senders``, ``whatsapp.templates.list/create``,
``numbers.list/quote/buy/update/release``, ``messages.list/get/iterate``,
``opt_outs.list/add/remove/iterate``, ``settings.get/update/rotate_webhook_secret``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

from ._base import Namespace, Resource, call_options, compact, field, segment
from ._runtime import Binding, Paginated, Request, next_cursor_field
from .errors import RyuError, copy_ryu_error

MOUNT = "/api/messaging"
#: Methods whose route needs no credential (``GET /api/messaging/status`` is unauthenticated).
CREDENTIAL_FREE_METHODS = ("status",)
DOCS = "https://docs.ryuhq.com/docs/standalone/messaging"
_AVAILABILITY_MESSAGE = "not available for this organization"


def messaging_availability_hint(error: RyuError) -> Optional[str]:
    if error.code == "feature_disabled":
        return (
            f"The organization's Ryu Messaging feature is off; an organization owner or admin turns it on. See {DOCS}"
        )
    if error.status == 404 and error.code == "not_found" and _AVAILABILITY_MESSAGE in error.message:
        return f"Ryu Messaging is in early access, and Ryu enables it for each organization. See {DOCS}"
    return None


def decorate_messaging_error(error: RyuError) -> RyuError:
    if error.service != "messaging" or error.hint is not None:
        return error
    hint = messaging_availability_hint(error)
    return error if hint is None else copy_ryu_error(error, docs=DOCS, hint=hint)


def messaging_error_record(error: Any) -> Optional[dict[str, Any]]:
    """The message record a Messaging error carries (``details["messageRecord"]``), e.g. after
    ``outcome_unknown``, so you can read its latest status with ``messages.get``."""
    if not isinstance(error, RyuError) or error.service != "messaging":
        return None
    details = error.details if isinstance(error.details, dict) else {}
    record = details.get("messageRecord")
    return record if isinstance(record, dict) and isinstance(record.get("id"), str) else None


def _seg(value: Any, name: str) -> str:
    """A Messaging path id; empty, ``.`` and ``..`` raise ``invalid_id`` instead of collapsing the route."""
    return segment("messaging", value, name)


def _org(config: Any, path: str) -> str:
    """An org-scoped path; a ``.`` or ``..`` organization id raises ``invalid_id`` (as in TypeScript)."""
    return f"{MOUNT}/orgs/{segment('messaging', config.organization_id, 'the organization id')}{path}"


class SendResource(Resource):
    def __init__(self, binding: Binding, path: str) -> None:
        super().__init__(binding)
        self._path = path

    def send(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """Sends one message; returns the message record (``status``, ``heldMicroUsd``, ...)."""
        return self._b.call(
            lambda c: Request("POST", _org(c, self._path), json=dict(input), decode=field("message")),
            call_options(idempotency_key),
        )


class WhatsAppTemplates(Resource):
    def list(self, sender_id: str, *, next_token: Optional[str] = None) -> Any:
        return self._b.call(
            lambda c: Request(
                "GET",
                _org(c, f"/whatsapp/senders/{_seg(sender_id, 'the sender id')}/templates"),
                params=compact({"nextToken": next_token}),
            )
        )

    def create(self, sender_id: str, definition: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda c: Request(
                "POST",
                _org(c, f"/whatsapp/senders/{_seg(sender_id, 'the sender id')}/templates"),
                json={"definition": dict(definition)},
                decode=field("template"),
            )
        )


class WhatsApp(SendResource):
    def __init__(self, binding: Binding) -> None:
        super().__init__(binding, "/whatsapp")
        self.templates = WhatsAppTemplates(binding)

    def senders(self) -> Any:
        return self._b.call(lambda c: Request("GET", _org(c, "/whatsapp/senders"), decode=field("senders")))


class Numbers(Resource):
    def list(self, *, status: Optional[str] = None) -> Any:
        return self._b.call(
            lambda c: Request("GET", _org(c, "/numbers"), params=compact({"status": status}), decode=field("numbers"))
        )

    def quote(self, *, country: str, type: Optional[str] = None) -> Any:
        return self._b.call(
            lambda c: Request("GET", _org(c, "/numbers/quote"), params=compact({"country": country, "type": type}))
        )

    def buy(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """Leases a number (spends credit; always carries an ``Idempotency-Key``)."""
        return self._b.call(
            lambda c: Request("POST", _org(c, "/numbers"), json=dict(input), decode=field("number")),
            call_options(idempotency_key),
        )

    def update(self, number_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda c: Request(
                "PATCH",
                _org(c, f"/numbers/{_seg(number_id, 'the number id')}"),
                json=dict(input),
                decode=field("number"),
            )
        )

    def release(self, number_id: str) -> Any:
        return self._b.call(
            lambda c: Request("DELETE", _org(c, f"/numbers/{_seg(number_id, 'the number id')}"), decode=field("number"))
        )


class Messages(Resource):
    def list(self, **query: Any) -> Any:
        """One page: ``channel``, ``cursor``, ``direction``, ``limit``, ``status``."""
        return self._b.call(lambda c: Request("GET", _org(c, "/messages"), params=compact(query)))

    def get(self, message_id: str) -> Any:
        return self._b.call(
            lambda c: Request(
                "GET", _org(c, f"/messages/{_seg(message_id, 'the message id')}"), decode=field("message")
            )
        )

    def iterate(self, *, max_items: Optional[int] = None, **query: Any) -> Paginated:
        filters = compact(query)
        filters.pop("cursor", None)
        return Paginated(
            self._b,
            lambda c, cursor: Request(
                "GET", _org(c, "/messages"), params=filters if cursor is None else dict(filters, cursor=cursor)
            ),
            lambda page: page.get("messages") or [],
            next_cursor_field,
            max_items=max_items,
        )


class OptOuts(Resource):
    def list(self, *, next_token: Optional[str] = None) -> Any:
        return self._b.call(lambda c: Request("GET", _org(c, "/opt-outs"), params=compact({"nextToken": next_token})))

    def add(self, phone_number: str) -> Any:
        return self._b.call(
            lambda c: Request("POST", _org(c, "/opt-outs"), json={"phoneNumber": phone_number}, decode=field("optOut"))
        )

    def remove(self, phone_number: str) -> Any:
        return self._b.call(
            lambda c: Request(
                "DELETE", _org(c, f"/opt-outs/{_seg(phone_number, 'the phone number')}"), decode=lambda _v: None
            )
        )

    def iterate(self, *, max_items: Optional[int] = None) -> Paginated:
        """Every opt-out across pages (empty pages with a next token are skipped)."""

        def fetch(config: Any, token: Optional[str]) -> Any:
            seen = set()
            current = token
            while True:
                page = yield Request("GET", _org(config, "/opt-outs"), params=compact({"nextToken": current}))
                following = page.get("nextToken")
                if page.get("optOuts") or following is None or following in seen:
                    return page
                if current is not None:
                    seen.add(current)
                seen.add(following)
                current = following

        def next_token(page: Any, _last: Any) -> Optional[str]:
            value = page.get("nextToken")
            return value if isinstance(value, str) and value else None

        return Paginated(self._b, fetch, lambda page: page.get("optOuts") or [], next_token, max_items=max_items)


class Settings(Resource):
    def get(self) -> Any:
        return self._b.call(lambda c: Request("GET", _org(c, "/settings"), decode=field("settings")))

    def update(self, input: Mapping[str, Any]) -> Any:
        """Updates settings; returns ``{"settings", "webhookSecret"}`` (the secret only when one was created).

        Never resent after a network error, timeout or 5xx (a replay after a lost reply would
        answer without the new secret); if the reply is lost, call ``rotate_webhook_secret()``.
        A ``429`` that names a wait is still retried."""
        return self._b.call(lambda c: Request("PUT", _org(c, "/settings"), json=dict(input)))

    def rotate_webhook_secret(self) -> Any:
        return self._b.call(lambda c: Request("POST", _org(c, "/settings/webhook-secret/rotate")))


class MessagingNamespace(Namespace):
    """``ryu.messaging``."""

    def __init__(self, binding: Binding) -> None:
        super().__init__(binding)
        self.sms = SendResource(binding, "/sms")
        self.mms = SendResource(binding, "/mms")
        self.voice = SendResource(binding, "/voice")
        self.whatsapp = WhatsApp(binding)
        self.numbers = Numbers(binding)
        self.messages = Messages(binding)
        self.opt_outs = OptOuts(binding)
        self.settings = Settings(binding)

    def status(self) -> Any:
        """``GET /api/messaging/status``; runs without credentials (and then sends none)."""
        return self._b.call(lambda _c: Request("GET", f"{MOUNT}/status"), method="status")

    def quote(self, input: Mapping[str, Any]) -> Any:
        """Prices a send before you make it: ``{"quote", "credit"}`` in micro-USD."""
        return self._b.call(lambda c: Request("GET", _org(c, "/quote"), params=compact(dict(input))))
