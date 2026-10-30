"""The service tools' bodies, ported from ``packages/services/src/tools/<service>.ts``.

Each body is a generator ``body(api, args)``: ``api`` is the client's object-mode
view (``ryu.safe``), ``args`` the parsed arguments. A body yields each service
call (a :class:`~ryu_sdk.services.result.Result` on ``Ryu``, a coroutine of one
on ``AsyncRyu``) and gets the ``Result`` back, so one body runs on both
clients. It returns a ``Result`` (its ``meta`` becomes the tool result's meta)
or plain data. ``_ok(result)`` raises the call's RyuError, which the runner
turns into the tool's error.

A body that drains a stream yields :class:`Collect`, which the runner bounds by
count and time on either client.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Generator, Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from ..errors import RyuError, with_ryu_error_fields
from ..managed_agents import TOOL_APPROVAL_EVENT_TYPES, pending_tool_approvals
from ..result import Result
from ..shapes import NotifyUsageWindow
from . import _mail
from ._manifest import CONSTANTS

#: A body: yields service calls (or :class:`Collect`) and returns a Result or plain data.
Body = Callable[[Any, dict[str, Any]], Generator[Any, Any, Any]]


class Collect:
    """Drain ``open()`` (an iterator, or an async iterator on ``AsyncRyu``) until it ends,
    ``max_events`` items arrive, or ``timeout`` seconds pass. The body gets a
    :class:`Collected` back."""

    def __init__(self, open: Callable[[], Any], max_events: int, timeout: float) -> None:
        self.open = open
        self.max_events = max_events
        self.timeout = timeout


class Collected:
    """What :class:`Collect` gathered."""

    def __init__(self, events: list[Any], done: bool, timed_out: bool) -> None:
        self.events = events
        #: The stream ended on its own.
        self.done = done
        #: The time bound elapsed first.
        self.timed_out = timed_out


def _ok(result: Any) -> Any:
    """``result.data``, or raise ``result.error``."""
    if result.error is not None:
        raise result.error
    return result.data


def _mapped(result: Any, data: Any) -> Result[Any]:
    """``result`` with ``data`` in place of its data, keeping its meta."""
    _ok(result)
    return Result(data, None, result.meta)


def _without(args: Mapping[str, Any], *names: str) -> dict[str, Any]:
    return {key: value for key, value in args.items() if key not in names}


# ── Mail ──────────────────────────────────────────────────────────────────────


# ``ryu.mail`` answers raw JSON; the Mail tools answer the record the TypeScript client
# normalizes it into (``_mail``), which is what their output schemas describe.


def mail_status(api: Any, _args: dict[str, Any]) -> Generator[Any, Any, Any]:
    # Credential-free on hosted Mail: without a Mail key it sends none.
    result = yield api.mail.status()
    return _mapped(result, _mail.mail_status(_ok(result)))


def mail_list_inboxes(api: Any, _args: dict[str, Any]) -> Generator[Any, Any, Any]:
    result = yield api.mail.inboxes.list()
    return _mapped(result, [_mail.mail_inbox(item) for item in _ok(result) or []])


def mail_list_messages(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    result = yield api.mail.messages.list(args["inboxId"], _without(args, "inboxId"))
    return _mapped(result, [_mail.mail_message(item) for item in _ok(result) or []])


def mail_get_message(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    result = yield api.mail.messages.get(args["messageId"])
    return _mapped(result, _mail.mail_message(_ok(result)))


def mail_create_inbox(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    result = yield api.mail.inboxes.create(args)
    return _mapped(result, _mail.mail_inbox(_ok(result)))


def mail_send(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    result = yield api.mail.send(_without(args, "idempotencyKey"), idempotency_key=args["idempotencyKey"])
    return _mapped(result, _mail.mail_message(_ok(result)))


# ── Messaging ─────────────────────────────────────────────────────────────────


def messaging_status(api: Any, _args: dict[str, Any]) -> Generator[Any, Any, Any]:
    # Credential-free: without the full key and organization it sends neither.
    return (yield api.messaging.status())


def messaging_quote(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.messaging.quote({"channel": "sms", **args}))


def messaging_send_sms(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.messaging.sms.send(_without(args, "idempotencyKey"), idempotency_key=args["idempotencyKey"]))


def messaging_list_messages(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.messaging.messages.list(**args))


def messaging_get_message(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.messaging.messages.get(args["messageId"]))


def messaging_list_numbers(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    # `all` is the deprecated alias of `includeReleased` (the list is one page).
    if args.get("includeReleased") is True or args.get("all") is True:
        return (yield api.messaging.numbers.list(status="all"))
    return (yield api.messaging.numbers.list())


# ── Notify ────────────────────────────────────────────────────────────────────

_HOUR_S = 3600


def _js_iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def default_notify_usage_window(now: datetime) -> NotifyUsageWindow:
    """The window ``notify_usage`` reads without ``from``/``to``: the 24 whole UTC hours before
    the next hour boundary, so the current hour is included (``defaultNotifyUsageWindow``)."""
    moment = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    floor = moment.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = floor + timedelta(seconds=_HOUR_S)
    return {"from": _js_iso(end - timedelta(hours=24)), "to": _js_iso(end)}


def notify_publish(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.notify.publish(_without(args, "idempotencyKey"), idempotency_key=args.get("idempotencyKey")))


#: The hint a keyed ``notify_request_approval`` retry's 409 ``idempotency_conflict`` gets
#: (``APPROVAL_KEY_REUSED_HINT`` in tools/notify.ts). Every publish carries a new
#: ``response.expiresAt`` and Notify hashes the body under the key, so a retry cannot replay.
APPROVAL_KEY_REUSED_HINT = (
    "An approval request was already published under this idempotencyKey, and a retry cannot "
    "replay it because each call sets a new deadline. Poll notify_get_event with the event.id "
    "from the first call (or find the event with notify_list_events) instead of calling "
    "notify_request_approval again; use a new key only to ask again."
)


def _with_approval_key_hint(result: Any) -> Any:
    error = result.error
    if (
        isinstance(error, RyuError)
        and error.status == 409
        and error.code == "idempotency_conflict"
        and error.hint is None
    ):
        return Result(None, with_ryu_error_fields(error, hint=APPROVAL_KEY_REUSED_HINT), result.meta)
    return result


def notify_request_approval(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    timeout_ms = args.get("timeoutMs", CONSTANTS["DEFAULT_APPROVAL_TOOL_TIMEOUT_MS"])
    # The helper needs a positive wait; 0 means one read right after publishing.
    wait_ms = max(1, args.get("waitMs", CONSTANTS["DEFAULT_APPROVAL_WAIT_MS"]))
    result = yield api.notify.request_approval(
        _without(args, "idempotencyKey", "timeoutMs", "waitMs"),
        timeout=timeout_ms / 1000,
        wait=wait_ms / 1000,
        idempotency_key=args.get("idempotencyKey"),
    )
    if args.get("idempotencyKey") is not None:
        result = _with_approval_key_hint(result)
    answer = _ok(result)
    data: dict[str, Any] = {"approved": answer.get("approved"), "status": answer.get("status")}
    # Always set, null when the answer carries none, as in TypeScript.
    data["value"] = answer.get("value")
    data["timedOut"] = answer.get("timed_out")
    data["event"] = answer.get("event")
    return _mapped(result, data)


def notify_list_events(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.notify.events.list(**args))


def notify_get_event(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.notify.events.get(args["eventId"]))


def notify_ack_event(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.notify.events.acknowledge(args["eventId"]))


def notify_usage(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    window: Mapping[str, Any]
    if "from" in args and "to" in args:
        window = {"from": args["from"], "to": args["to"]}
    else:
        window = default_notify_usage_window(datetime.now(timezone.utc))
    return (yield api.notify.usage(window))


# ── Box ───────────────────────────────────────────────────────────────────────

#: The service's default command timeout, in seconds (apps/box contracts).
DEFAULT_COMMAND_TIMEOUT_SECS = CONSTANTS["DEFAULT_COMMAND_TIMEOUT_SECS"]
#: Extra request time beyond the command's own timeout, for queueing and the reply.
EXEC_TIMEOUT_MARGIN_SECS = CONSTANTS["EXEC_TIMEOUT_MARGIN_MS"] / 1000


def _utf16_units(text: str) -> bytes:
    return text.encode("utf-16-le", errors="surrogatepass")


def utf16_length(text: str) -> int:
    """``text.length`` in JavaScript: UTF-16 code units, so an emoji counts 2."""
    return len(_utf16_units(text)) // 2


def utf16_slice(text: str, limit: int) -> str:
    """``text.slice(0, limit)`` in JavaScript: the first ``limit`` UTF-16 code units (a cut through a
    surrogate pair keeps the lone high surrogate, as JavaScript does)."""
    return _utf16_units(text)[: 2 * limit].decode("utf-16-le", errors="surrogatepass")


def box_list(api: Any, _args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.box.list())


def box_get(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.box.get(args["boxId"]))


def default_tool_box_name(idempotency_key: Optional[str]) -> str:
    """The name ``box_create`` gives a Box when the model passes none (``defaultToolBoxName``
    in tools/box.ts). With a key it is derived from the key, so a retried tool call sends a
    byte-identical create body and Box replays the first Box instead of answering
    ``idempotency_conflict``; without one it is random."""
    if idempotency_key is None:
        return f"mcp-{uuid.uuid4().hex[:12]}"
    return f"mcp-{hashlib.sha256(idempotency_key.encode('utf-8')).hexdigest()[:12]}"


def box_create(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    body = _without(args, "idempotencyKey")
    body["name"] = args.get("name") or default_tool_box_name(args.get("idempotencyKey"))
    return (yield api.box.create(body, idempotency_key=args.get("idempotencyKey")))


def box_exec(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    timeout = args.get("timeoutSecs", DEFAULT_COMMAND_TIMEOUT_SECS) + EXEC_TIMEOUT_MARGIN_SECS
    return (yield api.box.with_options(timeout=timeout).exec(args["boxId"], _without(args, "boxId")))


def box_read_file(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    result = yield api.box.files.read_text(args["boxId"], args["path"])
    text: str = _ok(result)
    limit = args.get("maxChars", CONSTANTS["DEFAULT_BOX_READ_CHARS"])
    total = utf16_length(text)
    return _mapped(
        result,
        {
            "path": args["path"],
            "content": utf16_slice(text, limit) if total > limit else text,
            "truncated": total > limit,
            "totalChars": total,
        },
    )


def box_write_file(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.box.files.write(args["boxId"], args["path"], args["content"]))


def box_stop(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.box.stop(args["boxId"]))


def box_resume(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.box.resume(args["boxId"]))


def box_delete(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.box.delete(args["boxId"]))


# ── Gateway ───────────────────────────────────────────────────────────────────


def gateway_chat_body(args: Mapping[str, Any]) -> dict[str, Any]:
    """The Chat Completions body for one prompt and an optional system message (``gatewayChatBody``)."""
    messages: list[dict[str, str]] = []
    if args.get("system") is not None:
        messages.append({"content": args["system"], "role": "system"})
    messages.append({"content": args["prompt"], "role": "user"})
    body: dict[str, Any] = {"messages": messages, "model": args["model"]}
    if args.get("maxTokens") is not None:
        body["max_tokens"] = args["maxTokens"]
    if args.get("temperature") is not None:
        body["temperature"] = args["temperature"]
    return body


def gateway_list_models(api: Any, _args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.gateway.models.list())


def gateway_chat(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.gateway.chat.completions.create({**gateway_chat_body(args), "stream": False}))


# ── Passport ──────────────────────────────────────────────────────────────────


def _uses_runtime_grant(api: Any) -> bool:
    return api.passport.runtime.connections.has_runtime_grant() is True


def passport_list_profiles(api: Any, _args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.passport.profiles.list())


def passport_list_connections(api: Any, _args: dict[str, Any]) -> Generator[Any, Any, Any]:
    if _uses_runtime_grant(api):
        return (yield api.passport.runtime.connections.list())
    return (yield api.passport.connections.list())


def passport_fetch(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    body = {**_without(args, "connectionId"), "method": "GET"}
    if _uses_runtime_grant(api):
        return (yield api.passport.runtime.connections.fetch(args["connectionId"], body))
    return (yield api.passport.connections.fetch(args["connectionId"], body))


# ── Sites ─────────────────────────────────────────────────────────────────────


def sites_list(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    scope = args.get("scope", "all")
    if scope != "all":
        return (yield api.sites.projects.list(scope=scope))
    owned = _ok((yield api.sites.projects.list(scope="owned")))
    shared = _ok((yield api.sites.projects.list(scope="shared")))
    return [*owned, *shared]


#: Site ids are UUIDs; a UUID is never mistaken for a slug.
_SITE_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.ASCII | re.IGNORECASE)
#: The Sites slug rules (``sites_create``'s ``slug``).
_SITE_SLUG = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", re.ASCII)
_SITE_SLUG_MIN = 5
_SITE_SLUG_MAX = 48


def _could_be_slug(value: str) -> bool:
    return (
        _SITE_SLUG.match(value) is not None
        and _SITE_SLUG_MIN <= len(value) <= _SITE_SLUG_MAX
        and _SITE_UUID.match(value) is None
    )


def site_id_slug_hint(value: str) -> str:
    """The hint a 404 gets when ``siteId`` looks like a slug (``siteIdSlugHint``)."""
    return (
        "siteId takes the Site id from sites_list or sites_get, not its slug. "
        f"If {json.dumps(value)} is a slug, find the Site with that slug in sites_list and pass its id."
    )


def _site_result(result: Any, value: str) -> Any:
    """``result`` with the slug hint on its 404 when ``value`` looks like a slug (``siteCall``)."""
    error = result.error
    # Deploy's ``GET /api/sites/status`` 404 means a wrong RYU_SITES_URL, not a wrong siteId.
    step = error.details.get("step") if isinstance(error, RyuError) and isinstance(error.details, dict) else None
    if (
        isinstance(error, RyuError)
        and error.status == 404
        and error.hint is None
        and step != "status"
        and _could_be_slug(value)
    ):
        return Result(None, with_ryu_error_fields(error, hint=site_id_slug_hint(value)), result.meta)
    return result


def sites_get(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return _site_result((yield api.sites.projects.get(args["siteId"])), args["siteId"])


def sites_create(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    """Creates a private Site; ``description`` is sent as the brief (``prompt``)."""
    body: dict[str, Any] = {"name": args["name"].strip(), "slug": args["slug"]}
    if args.get("template") is not None:
        body["template"] = args["template"]
    if args.get("description") is not None:
        body["prompt"] = args["description"]
    return (yield api.sites.projects.create(body))


def sites_deploy_body(args: Mapping[str, Any]) -> dict[str, Any]:
    """The ``sites.deploy`` body for the tool's arguments (``deployBody``)."""
    if "html" in args:
        body: dict[str, Any] = {"projectId": args["siteId"], "html": args["html"]}
        if "message" in args:
            body["message"] = args["message"]
        body["expectedRevision"] = args["expectedRevision"]
        return body
    return {
        "projectId": args["siteId"],
        "versionId": args.get("versionId", ""),
        "expectedRevision": args["expectedRevision"],
    }


def sites_deploy(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return _site_result((yield api.sites.deploy(sites_deploy_body(args))), args["siteId"])


def sites_update_settings(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    """Changes only the given settings; ``workspaceId: None`` clears it, as ``null`` does in TypeScript."""
    result = yield api.sites.projects.update_settings(
        args["siteId"],
        _without(args, "siteId", "expectedRevision"),
        expected_revision=args["expectedRevision"],
    )
    return _site_result(result, args["siteId"])


# ── Managed Agents ────────────────────────────────────────────────────────────

_TERMINAL_STATUSES = frozenset({"completed", "failed", "canceled"})
_APPROVAL_PAGE_LIMIT = CONSTANTS["APPROVAL_PAGE_LIMIT"]
#: At most this many filtered pages are read (10,000 approval-related events).
_APPROVAL_MAX_PAGES = CONSTANTS["APPROVAL_MAX_PAGES"]
_DEFAULT_WAIT_MS = CONSTANTS["DEFAULT_WAIT_MS"]
_ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$", re.ASCII)


def _parse_time(value: Any) -> Optional[datetime]:
    """An RFC 3339 time, or ``None`` when it does not parse (``Date.parse`` gives NaN)."""
    match = _ISO.match(value) if isinstance(value, str) else None
    if match is None:
        return None
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    offset = timedelta(0)
    if zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        offset = sign * timedelta(hours=int(zone[1:3]), minutes=int(zone[4:6]))
    try:
        moment = datetime(
            int(year),
            int(month),
            int(day),
            int(hour),
            int(minute),
            int(second),
            int((fraction or "0")[:6].ljust(6, "0")),
            tzinfo=timezone(offset),
        )
    except ValueError:
        return None
    return moment


def _text_message(text: str) -> dict[str, Any]:
    return {"type": "user.message", "content": [{"type": "text", "text": text}]}


def managed_agents_list_agents(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (
        yield api.managed_agents.agents.list(
            cursor=args.get("cursor"), include_archived=args.get("includeArchived"), limit=args.get("limit")
        )
    )


def managed_agents_list_environments(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (
        yield api.managed_agents.environments.list(
            cursor=args.get("cursor"), include_archived=args.get("includeArchived"), limit=args.get("limit")
        )
    )


def managed_agents_create_session(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    body = _without(args, "message", "idempotencyKey")
    if "message" in args:
        body["initialEvents"] = [_text_message(args["message"])]
    return (yield api.managed_agents.sessions.create(body, idempotency_key=args.get("idempotencyKey")))


def managed_agents_send_message(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (
        yield api.managed_agents.sessions.send(
            args["sessionId"], [_text_message(args["text"])], idempotency_key=args.get("idempotencyKey")
        )
    )


def managed_agents_get_session(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield api.managed_agents.sessions.get(args["sessionId"]))


def list_pending_approvals(api: Any, session_id: str) -> Generator[Any, Any, dict[str, Any]]:
    """The open approval requests of a session (``listPendingApprovals``): the SDK's ledger over
    the log filtered to the approval event types, without requests past ``expiresAt`` the session
    no longer lists, each joined with its ``agent.tool_use`` input."""
    session = _ok((yield api.managed_agents.sessions.get(session_id)))
    pending_ids = set(session.get("pendingToolUseIds") or [])
    base = {
        "sessionStatus": session.get("status"),
        "stopReason": session.get("stopReason"),
        "answerWith": "managed_agents_answer_approval",
    }
    if session.get("status") in _TERMINAL_STATUSES:
        # A terminal session accepts no answers (409 session_closed).
        return {**base, "data": [], "complete": True}
    events: list[dict[str, Any]] = []
    after = 0
    complete = False
    page = 0
    while not complete and page < _APPROVAL_MAX_PAGES:
        result = _ok(
            (
                yield api.managed_agents.sessions.events(
                    session_id, after=after, limit=_APPROVAL_PAGE_LIMIT, types=list(TOOL_APPROVAL_EVENT_TYPES)
                )
            )
        )
        events.extend(result.get("data") or [])
        next_after = result.get("nextAfter")
        next_after = next_after if isinstance(next_after, int) else after
        complete = not result.get("hasMore") or next_after <= after
        after = next_after
        page += 1
    tool_uses = {event.get("toolUseId"): event for event in events if event.get("type") == "agent.tool_use"}
    now = datetime.now(timezone.utc)
    data: list[dict[str, Any]] = []
    for request in pending_tool_approvals(events):
        expires = _parse_time(request.get("expiresAt"))
        if expires is not None and expires <= now and request.get("toolUseId") not in pending_ids:
            continue
        tool_use = tool_uses.get(request.get("toolUseId"))
        data.append(
            {
                "toolUseId": request.get("toolUseId"),
                "name": request.get("name"),
                "source": request.get("source"),
                "server": request.get("server"),
                "expiresAt": request.get("expiresAt"),
                "requestSeq": request.get("seq"),
                "input": tool_use.get("input") if tool_use is not None else None,
                "inputTruncated": bool(tool_use.get("inputTruncated")) if tool_use is not None else False,
            }
        )
    return {**base, "data": data, "complete": complete}


def managed_agents_list_pending_approvals(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    return (yield from list_pending_approvals(api, args["sessionId"]))


def managed_agents_answer_approval(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    sessions = api.managed_agents.sessions
    answer = sessions.approve_tool if args["decision"] == "allow" else sessions.deny_tool
    return (yield answer(args["sessionId"], args["toolUseId"], message=args.get("message")))


def _approval_wait(events: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """When the last status in ``events`` is a ``requires_action`` idle: its pending ids and the
    tool that lists them."""
    status = next((event for event in reversed(events) if event.get("type") == "session.status"), None)
    if status is None or status.get("stopReason") != "requires_action" or not status.get("pendingToolUseIds"):
        return {}
    return {
        "requiresAction": True,
        "pendingToolUseIds": status.get("pendingToolUseIds"),
        "next": "managed_agents_list_pending_approvals",
    }


def managed_agents_list_events(api: Any, args: dict[str, Any]) -> Generator[Any, Any, Any]:
    session_id = args["sessionId"]
    if args.get("wait") is not True:
        return (
            yield api.managed_agents.sessions.events(
                session_id, after=args.get("after"), limit=args.get("limit", CONSTANTS["DEFAULT_EVENTS_PAGE"])
            )
        )
    collected: Collected = yield Collect(
        lambda: api.managed_agents.sessions.follow(session_id, after=args.get("after", 0)),
        max_events=args.get("maxEvents", CONSTANTS["DEFAULT_MAX_EVENTS"]),
        timeout=args.get("timeoutMs", _DEFAULT_WAIT_MS) / 1000,
    )
    return {
        "data": collected.events,
        "turnEnded": collected.done,
        "timedOut": collected.timed_out,
        **_approval_wait(collected.events),
    }


#: Every tool body by tool name. The registry test checks it against manifest.json.
BODIES: dict[str, Body] = {
    "managed_agents_list_agents": managed_agents_list_agents,
    "managed_agents_list_environments": managed_agents_list_environments,
    "managed_agents_create_session": managed_agents_create_session,
    "managed_agents_send_message": managed_agents_send_message,
    "managed_agents_get_session": managed_agents_get_session,
    "managed_agents_list_pending_approvals": managed_agents_list_pending_approvals,
    "managed_agents_answer_approval": managed_agents_answer_approval,
    "managed_agents_list_events": managed_agents_list_events,
    "messaging_status": messaging_status,
    "messaging_quote": messaging_quote,
    "messaging_send_sms": messaging_send_sms,
    "messaging_list_messages": messaging_list_messages,
    "messaging_get_message": messaging_get_message,
    "messaging_list_numbers": messaging_list_numbers,
    "mail_status": mail_status,
    "mail_list_inboxes": mail_list_inboxes,
    "mail_list_messages": mail_list_messages,
    "mail_get_message": mail_get_message,
    "mail_create_inbox": mail_create_inbox,
    "mail_send": mail_send,
    "notify_publish": notify_publish,
    "notify_request_approval": notify_request_approval,
    "notify_list_events": notify_list_events,
    "notify_get_event": notify_get_event,
    "notify_ack_event": notify_ack_event,
    "notify_usage": notify_usage,
    "box_list": box_list,
    "box_get": box_get,
    "box_create": box_create,
    "box_exec": box_exec,
    "box_read_file": box_read_file,
    "box_write_file": box_write_file,
    "box_stop": box_stop,
    "box_resume": box_resume,
    "box_delete": box_delete,
    "gateway_list_models": gateway_list_models,
    "gateway_chat": gateway_chat,
    "passport_list_profiles": passport_list_profiles,
    "passport_list_connections": passport_list_connections,
    "passport_fetch": passport_fetch,
    "sites_list": sites_list,
    "sites_get": sites_get,
    "sites_create": sites_create,
    "sites_deploy": sites_deploy,
    "sites_update_settings": sites_update_settings,
}
