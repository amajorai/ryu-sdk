"""``ryu.notify``: Ryu Notify (hosted at ``https://notify.ryuhq.com`` with keys Ryu provisions).

Canonical spelling ``ryu.notify.<resource>.<verb>`` as in ``@ryuhq/services``:

=============  ==============================================================
events         list, get, iterate, acknowledge, archive, unarchive, respond,
               cancel_response, stream
topics         list, publish
activities     list, get, create, update, end
destinations   list, create, update, delete, test
deliveries     list, retry
preferences    get, update
silences       list, create, delete
groups         list
=============  ==============================================================

plus the top-level ``publish``, ``request_approval``, ``analytics`` and
``usage``. Publishes (``POST /v1/events``, ``POST /v1/topics/:topic``) get an
``Idempotency-Key``; ``activities.create`` requires one (pass it, or the SDK
generates one). A replay is reported in ``meta.replayed`` from the body's
``idempotent: true``.
"""

from __future__ import annotations

import base64
import json
import math
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Optional

from ._base import Namespace, Resource, call_options, compact, field, require_usage_window, segment
from ._runtime import (
    Defer,
    Emit,
    NextFrame,
    Now,
    OpenStream,
    Paginated,
    Request,
    Sleep,
    next_cursor_field,
)
from .errors import RyuInvalidRequestError, RyuResponseValidationError

DEFAULT_APPROVAL_TIMEOUT_S = 600.0
DEFAULT_APPROVAL_POLL_INTERVAL_S = 2.0
MIN_APPROVAL_POLL_INTERVAL_S = 0.25
MAX_APPROVAL_DURATION_S = 2_147_483.647
#: TypeScript ``requestApproval`` option keys, mapped to the Python keyword argument (seconds)
#: that replaces each; ``request_approval`` refuses them in ``input``.
_APPROVAL_OPTION_KEYWORDS = {"timeoutMs": "timeout", "pollIntervalMs": "poll_interval", "waitMs": "wait"}
_APPROVED = frozenset({"approved", "yes"})


def _seg(value: Any, name: str) -> str:
    """A Notify path id; empty, ``.`` and ``..`` raise ``invalid_id`` instead of collapsing the route."""
    return segment("notify", value, name)


def _event(value: Any) -> Any:
    return field("event")(value)


class EventsResource(Resource):
    def list(self, **filters: Any) -> Any:
        """``GET /v1/events``: one page (``{"events", "nextCursor"}``)."""
        return self._b.call(lambda _c: Request("GET", "/v1/events", params=compact(filters)))

    def iterate(self, *, max_items: Optional[int] = None, **filters: Any) -> Paginated:
        """Every matching event, newest first, across pages (``before`` -> ``nextCursor``)."""
        filters = compact(filters)
        filters.pop("before", None)
        return Paginated(
            self._b,
            lambda _c, cursor: Request(
                "GET", "/v1/events", params=filters if cursor is None else dict(filters, before=cursor)
            ),
            lambda page: page.get("events") or [],
            next_cursor_field,
            max_items=max_items,
        )

    def get(self, event_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", f"/v1/events/{_seg(event_id, 'the event id')}", decode=_event))

    def _action(self, event_id: str, action: str, body: Optional[Mapping[str, Any]] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST", f"/v1/events/{_seg(event_id, 'the event id')}/{action}", json=dict(body or {}), decode=_event
            )
        )

    def acknowledge(self, event_id: str) -> Any:
        return self._action(event_id, "ack")

    def archive(self, event_id: str) -> Any:
        return self._action(event_id, "archive")

    def unarchive(self, event_id: str) -> Any:
        return self._action(event_id, "unarchive")

    def respond(self, event_id: str, answer: Mapping[str, Any]) -> Any:
        """Answers an interactive event: ``{"status": "approved"|"denied"|"yes"|"no"|"replied", "value"?}``."""
        return self._action(event_id, "respond", answer)

    def cancel_response(self, event_id: str) -> Any:
        return self._action(event_id, "cancel")

    def stream(self, **filters: Any) -> Any:
        """``GET /v1/events/stream`` (SSE): ``{"type": "notification", "event"}`` and
        ``{"type": "activity", "activity"}`` items. Raises RyuError in both modes."""
        params = compact(filters)

        def op(_config: Any) -> Any:
            stream = yield OpenStream(
                Request("GET", "/v1/events/stream", params=params, headers={"accept": "text/event-stream"})
            )
            yield Defer(stream.close)
            while True:
                frame = yield NextFrame(stream)
                if frame is None:
                    return
                payload = json.loads(frame.data)
                if frame.event == "activity":
                    yield Emit({"type": "activity", "id": frame.id or "", "activity": payload})
                else:
                    yield Emit({"type": "notification", "id": frame.id or "", "event": payload})

        return self._b.stream(op)


class TopicsResource(Resource):
    def list(self, limit: Optional[int] = None) -> Any:
        return self._b.call(
            lambda _c: Request("GET", "/v1/topics", params=compact({"limit": limit}), decode=field("topics"))
        )

    def publish(
        self,
        topic: str,
        message: str,
        options: Optional[Mapping[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        """``POST /v1/topics/:topic``: a plain-text publish (ntfy style): ``title``, ``priority``,
        ``tags``, ``click``, ``actions``. Gets an ``Idempotency-Key``. A title, tags or click URL
        with text outside Latin-1 is sent as an RFC 2047 UTF-8 encoded word, which Notify decodes."""
        options = dict(options or {})
        headers: dict[str, str] = {"content-type": "text/plain; charset=utf-8"}
        if options.get("title"):
            headers["title"] = _header_text(str(options["title"]))
        if options.get("priority"):
            headers["priority"] = str(options["priority"])
        if options.get("tags"):
            headers["tags"] = _header_text(",".join(options["tags"]))
        if options.get("click"):
            headers["click"] = _header_text(str(options["click"]))
        if options.get("actions"):
            headers["actions"] = json.dumps(options["actions"])
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"/v1/topics/{_seg(topic, 'the topic')}",
                content=message.encode("utf-8"),
                headers=headers,
                decode=_event,
            ),
            call_options(idempotency_key),
        )


def _header_text(value: str) -> str:
    """A topic header value ``fetch`` accepts, as ``@ryuhq/client`` sends it: text outside Latin-1,
    or text containing ``=?`` (which Notify would otherwise read as an RFC 2047 encoded word),
    becomes one UTF-8 encoded word (``=?UTF-8?B?...?=``). Notify decodes it exactly once, so the
    text round-trips as given. Other Latin-1 text is sent as is. Text with CR, LF or NUL, and text
    UTF-8 cannot encode (a lone surrogate), are returned unchanged, so the header check refuses
    them as ``invalid_request_header`` (``@ryuhq/client`` leaves them for ``Headers`` to refuse)."""
    if any(char in value for char in "\r\n\x00"):
        return value
    if all(ord(char) <= 0xFF for char in value) and "=?" not in value:
        return value
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        return value
    return f"=?UTF-8?B?{base64.b64encode(encoded).decode('ascii')}?="


class ActivitiesResource(Resource):
    def list(self, **filters: Any) -> Any:
        return self._b.call(
            lambda _c: Request("GET", "/v1/activities", params=compact(filters), decode=field("activities"))
        )

    def get(self, activity_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", f"/v1/activities/{_seg(activity_id, 'the activity id')}", decode=field("activity")
            )
        )

    def create(self, input: Mapping[str, Any], idempotency_key: Optional[str] = None) -> Any:
        """``POST /v1/activities``. The server requires an ``Idempotency-Key``: pass one to
        make retries of the same activity safe, or the SDK generates one."""
        return self._b.call(
            lambda _c: Request("POST", "/v1/activities", json=dict(input), decode=field("activity")),
            call_options(idempotency_key),
        )

    def update(self, activity_id: str, input: Mapping[str, Any], sequence: Optional[int] = None) -> Any:
        body = dict(input)
        if sequence is not None:
            body["sequence"] = sequence
        return self._b.call(
            lambda _c: Request(
                "PATCH", f"/v1/activities/{_seg(activity_id, 'the activity id')}", json=body, decode=field("activity")
            )
        )

    def end(self, activity_id: str, sequence: Optional[int] = None) -> Any:
        body = {} if sequence is None else {"sequence": sequence}
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"/v1/activities/{_seg(activity_id, 'the activity id')}/end",
                json=body,
                decode=field("activity"),
            )
        )


class DestinationsResource(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/destinations", decode=field("destinations")))

    def create(self, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request("POST", "/v1/destinations", json=dict(input), decode=field("destination"))
        )

    def update(self, destination_id: str, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request(
                "PATCH",
                f"/v1/destinations/{_seg(destination_id, 'the destination id')}",
                json=dict(input),
                decode=field("destination"),
            )
        )

    def delete(self, destination_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "DELETE", f"/v1/destinations/{_seg(destination_id, 'the destination id')}", decode=lambda _v: None
            )
        )

    def test(self, destination_id: str) -> Any:
        """Sends a test delivery; returns ``{"status": <the destination's HTTP status>}``."""
        return self._b.call(
            lambda _c: Request("POST", f"/v1/destinations/{_seg(destination_id, 'the destination id')}/test", json={})
        )


class DeliveriesResource(Resource):
    def list(self, **filters: Any) -> Any:
        return self._b.call(
            lambda _c: Request("GET", "/v1/deliveries", params=compact(filters), decode=field("deliveries"))
        )

    def retry(self, delivery_id: str) -> Any:
        return self._b.call(
            lambda _c: Request(
                "POST",
                f"/v1/deliveries/{_seg(delivery_id, 'the delivery id')}/retry",
                json={},
                decode=field("delivery"),
            )
        )


class PreferencesResource(Resource):
    def get(self, recipient: Optional[str] = None) -> Any:
        return self._b.call(
            lambda _c: Request(
                "GET", "/v1/preferences", params=compact({"recipient": recipient}), decode=field("preferences")
            )
        )

    def update(self, input: Mapping[str, Any]) -> Any:
        return self._b.call(
            lambda _c: Request("PATCH", "/v1/preferences", json=dict(input), decode=field("preferences"))
        )


class SilencesResource(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/silences", decode=field("silences")))

    def create(self, input: Mapping[str, Any]) -> Any:
        return self._b.call(lambda _c: Request("POST", "/v1/silences", json=dict(input), decode=field("silence")))

    def delete(self, silence_id: str) -> Any:
        return self._b.call(
            lambda _c: Request("DELETE", f"/v1/silences/{_seg(silence_id, 'the silence id')}", decode=lambda _v: None)
        )


class GroupsResource(Resource):
    def list(self, limit: Optional[int] = None) -> Any:
        return self._b.call(
            lambda _c: Request("GET", "/v1/groups", params=compact({"limit": limit}), decode=field("groups"))
        )


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return str(value.astimezone(timezone.utc).isoformat(timespec="milliseconds")).replace("+00:00", "Z")
    return str(value)


def _positive(value: Optional[float], fallback: float, name: str) -> float:
    if value is None:
        return fallback
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or (isinstance(value, float) and math.isnan(value))
        or value <= 0
    ):
        raise RyuInvalidRequestError(
            f"Ryu notify.request_approval: {name} must be a positive number of seconds.",
            service="notify",
            code="invalid_timeout",
            retryable=False,
        )
    if value > MAX_APPROVAL_DURATION_S:
        raise RyuInvalidRequestError(
            f"Ryu notify.request_approval: {name} must be at most {MAX_APPROVAL_DURATION_S} seconds.",
            service="notify",
            code="invalid_timeout",
            retryable=False,
        )
    return float(value)


def _settle(event: Mapping[str, Any], deadline_passed: bool) -> Optional[dict[str, Any]]:
    response = event.get("response")
    if not isinstance(response, dict):
        raise RyuResponseValidationError(
            "Ryu notify.request_approval: the event came back without its response object.",
            service="notify",
            status=200,
        )
    status = response.get("status")
    if status == "pending" and not deadline_passed:
        return None
    return {
        "approved": status in _APPROVED,
        "event": event,
        "status": status,
        "timed_out": status in ("expired", "pending"),
        "value": response.get("value"),
    }


class NotifyNamespace(Namespace):
    """``ryu.notify``."""

    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.events = EventsResource(binding)
        self.topics = TopicsResource(binding)
        self.activities = ActivitiesResource(binding)
        self.destinations = DestinationsResource(binding)
        self.deliveries = DeliveriesResource(binding)
        self.preferences = PreferencesResource(binding)
        self.silences = SilencesResource(binding)
        self.groups = GroupsResource(binding)

    def publish(self, input: Mapping[str, Any], *, idempotency_key: Optional[str] = None) -> Any:
        """``POST /v1/events``: publishes an event. Gets an ``Idempotency-Key``."""
        return self._b.call(
            lambda _c: Request("POST", "/v1/events", json=dict(input), decode=_event), call_options(idempotency_key)
        )

    def analytics(self) -> Any:
        """``GET /v1/analytics``: event totals by level, source and topic."""
        return self._b.call(lambda _c: Request("GET", "/v1/analytics", decode=field("analytics")))

    def usage(self, window: Mapping[str, Any]) -> Any:
        """``GET /v1/usage``: accepted events in a window of whole UTC hours (``{"from", "to"}``)."""

        def op(_config: Any) -> Request:
            normalized = {key: _iso(value) for key, value in dict(window or {}).items() if value is not None}
            checked = require_usage_window("notify", normalized)
            return Request("GET", "/v1/usage", params={"from": checked["from"], "to": checked["to"]})

        return self._b.call(op)

    def request_approval(
        self,
        input: Mapping[str, Any],
        *,
        timeout: Optional[float] = None,
        poll_interval: Optional[float] = None,
        wait: Optional[float] = None,
        idempotency_key: Optional[str] = None,
        on_published: Any = None,
    ) -> Any:
        """Publishes an interactive approval (or ``yes_no``) event that expires after ``timeout``
        seconds (default 600), then polls it until it is answered, canceled or expired.

        ``input`` is a ``publish`` body plus ``prompt``, ``responseType``
        (``"approval"`` or ``"yes_no"``), ``callbackUrl`` and ``callbackSecret``.
        ``wait`` stops polling earlier (the event stays open). Returns
        ``{"approved", "status", "value", "timed_out", "event"}``. The TypeScript
        option keys ``timeoutMs``, ``pollIntervalMs`` and ``waitMs`` are refused in
        ``input`` (``invalid_request``) rather than sent to Notify in the event body.
        """
        body = dict(input)
        misplaced = [key for key in _APPROVAL_OPTION_KEYWORDS if key in body]
        prompt = body.pop("prompt", None)
        response_type = body.pop("responseType", "approval")
        callback_url = body.pop("callbackUrl", None)
        callback_secret = body.pop("callbackSecret", None)
        body.pop("response", None)

        def op(_config: Any) -> Any:
            if misplaced:
                keywords = ", ".join(f"{_APPROVAL_OPTION_KEYWORDS[key]}=" for key in misplaced)
                raise RyuInvalidRequestError(
                    f"Ryu notify.request_approval: move {', '.join(misplaced)} out of the input dict "
                    f"and pass {keywords} (in seconds) instead.",
                    service="notify",
                    code="invalid_request",
                    retryable=False,
                    details={"fields": misplaced},
                )
            if response_type not in ("approval", "yes_no"):
                raise RyuInvalidRequestError(
                    "Ryu notify.request_approval: responseType must be approval or yes_no.",
                    service="notify",
                    code="invalid_response_type",
                    retryable=False,
                )
            timeout_s = _positive(timeout, DEFAULT_APPROVAL_TIMEOUT_S, "timeout")
            interval = max(
                MIN_APPROVAL_POLL_INTERVAL_S,
                _positive(poll_interval, DEFAULT_APPROVAL_POLL_INTERVAL_S, "poll_interval"),
            )
            wait_s = timeout_s if wait is None else min(timeout_s, _positive(wait, timeout_s, "wait"))
            started = yield Now()
            deadline = started + timeout_s
            stop_waiting_at = started + wait_s
            response: dict[str, Any] = {
                "type": response_type,
                "expiresAt": _iso(datetime.fromtimestamp(deadline, tz=timezone.utc)),
            }
            if prompt is not None:
                response["prompt"] = prompt
            if callback_url is not None:
                response["callbackUrl"] = callback_url
            if callback_secret is not None:
                response["callbackSecret"] = callback_secret
            published = yield Request("POST", "/v1/events", json=dict(body, response=response), decode=_event)
            if on_published is not None:
                on_published(published)
            first = _settle(published, False)
            if first is not None:
                return first
            while True:
                now = yield Now()
                yield Sleep(max(0.0, min(interval, stop_waiting_at - now)))
                now = yield Now()
                deadline_passed = now >= deadline
                current = yield Request("GET", f"/v1/events/{_seg(published['id'], 'the event id')}", decode=_event)
                result = _settle(current, deadline_passed)
                if result is not None:
                    return result
                now = yield Now()
                if now >= stop_waiting_at:
                    return {"approved": False, "event": current, "status": "pending", "timed_out": False, "value": None}

        return self._b.call(op, call_options(idempotency_key))
