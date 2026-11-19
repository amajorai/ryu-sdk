"""The Mail tools' reply shapes, ported from ``packages/client/src/mail.ts``.

``ryu.mail`` returns the server's raw JSON (snake_case from a self-hosted
server, camelCase from hosted Mail). The TypeScript client normalizes every
Mail reply into one camelCase record with every field set (``status()``,
``inbox()``, ``message()`` and ``attachment()``), and the Mail tools' output
schemas describe that record. The Python Mail tool bodies run their replies
through the same normalizers so both ports answer the same ``data``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any, Callable, Optional

from ..errors import RyuResponseValidationError

_JS_NUMBER = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
# ``Number("0x10")`` is 16; the prefixed forms take no sign (``Number("-0x10")`` is NaN) and no ``_``.
_JS_PREFIXED = re.compile(r"^0(?:[xX][0-9a-fA-F]+|[bB][01]+|[oO][0-7]+)$")
_JS_RADIX = {"x": 16, "b": 2, "o": 8}
_INBOX_PROVIDERS = ("webhook", "imap")


def _invalid(what: str) -> RyuResponseValidationError:
    return RyuResponseValidationError(f"Ryu Mail: the server returned {what}.", service="mail")


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _array(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _first(source: Mapping[str, Any], *keys: str) -> Any:
    """The first of ``keys`` whose value is neither absent nor null (JavaScript ``a ?? b``)."""
    for key in keys:
        value = source.get(key)
        if value is not None:
            return value
    return None


def _text(value: Any) -> Optional[str]:
    """``nullableText``: a string or null; anything else is an invalid reply."""
    if value is None or isinstance(value, str):
        return value
    raise _invalid(f"{type(value).__name__} where text was expected")


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    if not all(isinstance(item, str) for item in value):
        raise _invalid("a list with non-text items where a list of text was expected")
    return list(value)


def _headers(value: Any) -> dict[str, str]:
    source = _record(value)
    if not all(isinstance(item, str) for item in source.values()):
        raise _invalid("headers with non-text values")
    return source


def _js_string(value: Any) -> str:
    """JavaScript ``String(value)`` for JSON values."""
    if value is None:
        return "null"
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, list):
        return ",".join("" if item is None else _js_string(item) for item in value)
    return "[object Object]"


def _js_number(value: Any) -> Optional[float]:
    """JavaScript ``Number(value)`` for JSON values, with NaN as ``None`` (JSON has no NaN)."""
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        # An int past float range is ``Infinity`` once ``JSON.parse`` reads it in TypeScript, which
        # ``z.number()`` refuses; answer NaN here instead of raising OverflowError from isfinite.
        # ``float()`` rounds like ``JSON.parse`` and raises only where that read gives Infinity.
        try:
            float(value)
        except OverflowError:
            return None
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed == "":
            return 0
        if _JS_PREFIXED.match(trimmed):
            try:
                return int(float(int(trimmed[2:], _JS_RADIX[trimmed[1].lower()])))
            except OverflowError:  # past the largest double: ``Infinity`` in JavaScript, not a count
                return None
        if not _JS_NUMBER.match(trimmed):
            return None
        number = float(trimmed)
        if not math.isfinite(number):
            return None
        return int(number) if number.is_integer() else number
    if isinstance(value, list) and len(value) <= 1:
        # An array converts through its text: ``Number([true])`` is NaN, ``Number([null])`` is 0.
        return _js_number("" if not value or value[0] is None else _js_string(value[0]))
    return None


def _wire_number(value: Any, what: str) -> float:
    """``wireNumber``: a count or size as ``Number()`` reads it; one it cannot read (NaN) is an invalid reply."""
    number = _js_number(value)
    if number is None:
        raise _invalid(f"{what} that is not a number")
    return number


def _string_or(source: Mapping[str, Any], default: str, *keys: str) -> str:
    value = _first(source, *keys)
    return default if value is None else _js_string(value)


def _payload(value: Any, key: str) -> dict[str, Any]:
    """``firstPayload``: the body's ``key`` member when it has one, else the body."""
    body = _record(value)
    inner = body.get(key)
    return _record(body[key] if inner is not None else value)


def mail_status(value: Any) -> dict[str, Any]:
    """``MailAPI.status()``."""
    source = _record(value)
    inbox_count = _first(source, "inboxCount", "inbox_count")
    return {
        "apiVersion": _string_or(source, "v1", "apiVersion", "api_version"),
        "configured": source.get("configured") is True,
        "domain": _text(source.get("domain")),
        "domainMode": _string_or(source, "byo", "domainMode", "domain_mode"),
        "inboxCount": 0 if inbox_count is None else _wire_number(inbox_count, "an inbox count"),
        "inbound": _string_or(source, "webhook", "inbound"),
        "sendConfigured": source.get("sendConfigured") is True or source.get("send_configured") is True,
    }


def _optional(source: Mapping[str, Any], key: str, alias: str, keep: Callable[[Any], bool]) -> Any:
    value = _first(source, key, alias)
    return value if keep(value) else None


_CREATED_WITH_IDS = ("apiKeyId", "gatewayCredentialId", "oauthClientId", "serviceAccountId")


def _created_with(value: Any) -> tuple[bool, Optional[dict[str, Any]]]:
    """``optionalCreatedWithSchema``: ``(keep, value)``; null stays null and a bad shape is left out."""
    if value is None:
        return True, None
    if not isinstance(value, Mapping) or not isinstance(value.get("via"), str):
        return False, None
    created: dict[str, Any] = {}
    for key in _CREATED_WITH_IDS:
        item = value.get(key)
        if item is not None and not isinstance(item, str):
            return False, None
        created[key] = item
    created["via"] = value["via"]
    return True, created


def mail_inbox(value: Any) -> dict[str, Any]:
    """``inbox()``."""
    source = _payload(value, "inbox")
    provider = source.get("provider")
    provider = "webhook" if provider is None else provider
    if provider not in _INBOX_PROVIDERS:
        raise _invalid(f"an inbox provider {provider!r}")
    inbox: dict[str, Any] = {
        "address": _string_or(source, "", "address"),
        "agentId": _text(_first(source, "agentId", "agent_id")),
        "clientId": _text(_first(source, "clientId", "client_id")),
        "createdAt": _string_or(source, "", "createdAt", "created_at"),
        "description": _text(source.get("description")),
        "id": _string_or(source, "", "id"),
        "metadata": _record(source.get("metadata")),
        "name": _string_or(source, "", "name"),
        "podId": _text(_first(source, "podId", "pod_id")),
        "provider": provider,
        "updatedAt": _string_or(source, "", "updatedAt", "updated_at", "createdAt", "created_at"),
    }
    # Optional fields older servers omit: a value of the wrong type is left out, as in TypeScript.
    configured = _optional(source, "webhookConfigured", "webhook_configured", lambda item: isinstance(item, bool))
    if configured is not None:
        inbox["webhookConfigured"] = configured
    secret = _optional(source, "webhookSecret", "webhook_secret", lambda item: isinstance(item, str))
    if secret is not None:
        inbox["webhookSecret"] = secret
    signed = _optional(source, "webhookSigned", "webhook_signed", lambda item: isinstance(item, bool))
    if signed is not None:
        inbox["webhookSigned"] = signed
    # Hosted Mail's ``createdWith``: the camelCase key wins when present, null included.
    created_key = "createdWith" if "createdWith" in source else "created_with"
    if created_key in source:
        keep, created_with = _created_with(source[created_key])
        if keep:
            inbox["createdWith"] = created_with
    # The camelCase key wins when present, null included; an absent field stays absent.
    if "webhookUrl" in source:
        inbox["webhookUrl"] = _text(source["webhookUrl"])
    elif "webhook_url" in source:
        inbox["webhookUrl"] = _text(source["webhook_url"])
    return inbox


def mail_attachment(value: Any) -> dict[str, Any]:
    """``attachment()``."""
    source = _record(value)
    size = source.get("size")
    return {
        "contentId": _text(_first(source, "contentId", "content_id")),
        "contentType": _text(_first(source, "contentType", "content_type")),
        "filename": _text(source.get("filename")),
        "id": _text(source.get("id")),
        "inline": source.get("inline") is True,
        "size": 0 if size is None else _wire_number(size, "an attachment size"),
    }


def mail_message(value: Any) -> dict[str, Any]:
    """``message()``."""
    source = _payload(value, "message")
    return {
        "attachments": [mail_attachment(item) for item in _array(source.get("attachments"))],
        "bcc": _strings(_first(source, "bcc", "bcc_addrs")),
        "cc": _strings(_first(source, "cc", "cc_addrs")),
        "clientId": _text(_first(source, "clientId", "client_id")),
        "createdAt": _string_or(source, "", "createdAt", "created_at"),
        "direction": _string_or(source, "", "direction"),
        "error": _text(source.get("error")),
        "extractedHtml": _text(_first(source, "extractedHtml", "extracted_html")),
        "extractedText": _text(_first(source, "extractedText", "extracted_text")),
        "from": _text(_first(source, "from", "from_addr")),
        "headers": _headers(source.get("headers")),
        "html": _text(source.get("html")),
        "id": _string_or(source, "", "id"),
        "inReplyTo": _text(_first(source, "inReplyTo", "in_reply_to")),
        "inboxId": _string_or(source, "", "inboxId", "inbox_id"),
        "labels": _strings(source.get("labels")),
        "messageId": _text(_first(source, "messageId", "message_id")),
        "openedAt": _text(_first(source, "openedAt", "opened_at")),
        "preview": _text(source.get("preview")),
        "read": source.get("read") is True,
        "references": _strings(source.get("references")),
        "replyTo": _text(_first(source, "replyTo", "reply_to")),
        "sesMessageId": _text(_first(source, "sesMessageId", "provider_message_id")),
        "status": _string_or(source, "", "status"),
        "subject": _text(source.get("subject")),
        "text": _text(source.get("text")),
        "threadId": _text(_first(source, "threadId", "thread_id")),
        "to": _strings(_first(source, "to", "to_addrs")),
        "updatedAt": _string_or(source, "", "updatedAt", "updated_at", "createdAt", "created_at"),
    }
