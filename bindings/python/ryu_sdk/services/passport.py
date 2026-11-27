"""``ryu.passport``: Ryu Passport stored logins.

Administration routes use ``RYU_PASSPORT_API_KEY``; ``runtime.connections``
uses the runtime grant ``RYU_PASSPORT_RUNTIME_KEY``, so an agent can fetch
through a stored login without holding the administration token.

No POST is retried on a network error or 5xx, except ``connections.create``
on a Passport that advertises ``features.idempotency_keys``: before a create
the SDK reads ``GET /v1/capabilities`` (cached per ``Ryu`` instance and base
URL for five minutes, with its own 5-second timeout, unseen by hooks), and only
then generates an ``Idempotency-Key`` for the create and retries it with the
same key. A key you bind with ``with_options(idempotency_key=...)`` is always
sent; without the capability it is not retried.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any, Optional, cast

from ._base import Namespace, Resource, field, require_usage_window, segment
from ._runtime import Request
from .errors import RyuConfigurationError, RyuInvalidRequestError

RUNTIME_PREFIX = "/v1/runtime/"


def _admin_key(config: Any) -> str:
    if not config.api_key:
        raise RyuConfigurationError(
            "Ryu Passport administration routes need the tenant administration token: set RYU_PASSPORT_API_KEY or "
            "pass passport={'api_key': ...}. A runtime grant only reaches ryu.passport.runtime.",
            service="passport",
            details={"missing": ["RYU_PASSPORT_API_KEY"]},
            hint="Agents should call ryu.passport.runtime.connections with RYU_PASSPORT_RUNTIME_KEY instead of holding "
            "the administration token.",
        )
    return cast(str, config.api_key)


def _runtime_key(config: Any) -> str:
    if not config.runtime_key:
        raise RyuConfigurationError(
            "Ryu Passport runtime routes need a runtime grant token: set RYU_PASSPORT_RUNTIME_KEY or pass "
            "passport={'runtime_key': ...}. The administration key is not accepted there.",
            service="passport",
            details={"missing": ["RYU_PASSPORT_RUNTIME_KEY"]},
            hint="Set RYU_PASSPORT_RUNTIME_KEY to a token from the operator's runtime grants.",
        )
    return cast(str, config.runtime_key)


def passport_capability_probe(config: Any) -> Optional[Request]:
    """The capability read for capability-gated routes: ``GET /v1/capabilities`` with the
    administration key, decoding only ``features`` (any object), so a non-boolean flag
    cannot turn keyed creates off. ``None`` without the administration key."""
    if not config.api_key:
        return None
    return Request("GET", "/v1/capabilities", auth=cast(str, config.api_key), decode=_features)


def _features(value: Any) -> Any:
    features = field("features")(value)
    if not isinstance(features, dict):
        raise TypeError("expected an object `features`")
    return features


_FLOW_STATUSES = ("IDLE", "IN_PROGRESS", "DONE", "FAILED")
_STATUSES = ("AUTHENTICATED", "NEEDS_AUTH")
_CONNECTION_NUMBERS = ("created_at", "last_checked", "updated_at")
_CONNECTION_STRINGS = ("domain", "id", "profile_id", "source")


def _is_number(value: Any) -> bool:
    """A finite JSON number, as ``z.number()`` takes it after ``JSON.parse``: NaN, an infinity and an
    int past float range (``Infinity`` once JavaScript reads it) are refused."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


def _check_connection(value: Any, where: str) -> None:
    """``passportConnectionSchema``: raises TypeError (an invalid reply) on a malformed connection."""
    if not isinstance(value, dict):
        raise TypeError(f"expected an object {where}")
    for name in _CONNECTION_NUMBERS:
        if not _is_number(value.get(name)):
            raise TypeError(f"expected a number {where}.{name}")
    for name in _CONNECTION_STRINGS:
        if not isinstance(value.get(name), str):
            raise TypeError(f"expected a string {where}.{name}")
    if value.get("flow_status") not in _FLOW_STATUSES:
        raise TypeError(f"expected {where}.flow_status to be one of {', '.join(_FLOW_STATUSES)}")
    if value.get("status") not in _STATUSES:
        raise TypeError(f"expected {where}.status to be one of {', '.join(_STATUSES)}")


def _connection_detail(value: Any) -> Any:
    """``passportConnectionDetailSchema`` (``GET /v1/connections/{id}`` and ``.../import``):
    ``connection`` plus top-level ``flow_status`` and ``status``. Unknown keys are kept."""
    if not isinstance(value, dict):
        raise TypeError("expected a connection detail object")
    _check_connection(value.get("connection"), "connection")
    if value.get("flow_status") not in _FLOW_STATUSES:
        raise TypeError(f"expected flow_status to be one of {', '.join(_FLOW_STATUSES)}")
    if value.get("status") not in _STATUSES:
        raise TypeError(f"expected status to be one of {', '.join(_STATUSES)}")
    return value


def _check_strings(value: Mapping[str, Any], names: tuple[str, ...], where: str) -> None:
    for name in names:
        if not isinstance(value.get(name), str):
            raise TypeError(f"expected a string {where}{name}")


def _check_booleans(value: Mapping[str, Any], names: tuple[str, ...], where: str) -> None:
    for name in names:
        if not isinstance(value.get(name), bool):
            raise TypeError(f"expected a boolean {where}{name}")


def _check_numbers(value: Mapping[str, Any], names: tuple[str, ...], where: str) -> None:
    for name in names:
        if not _is_number(value.get(name)):
            raise TypeError(f"expected a number {where}{name}")


def _object(value: Any, what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"expected {what} object")
    return value


def _connection_list(value: Any) -> Any:
    """``passportConnectionListSchema`` (``GET /v1/connections`` and ``/v1/runtime/connections``)."""
    connections = _object(value, "a connection list").get("connections")
    if not isinstance(connections, list):
        raise TypeError("expected an array `connections`")
    for index, connection in enumerate(connections):
        _check_connection(connection, f"connections[{index}]")
    return value


def _profile_list(value: Any) -> Any:
    """``passportProfileListSchema`` (``GET /v1/profiles``): each profile's connections are checked."""
    profiles = _object(value, "a profile list").get("profiles")
    if not isinstance(profiles, list):
        raise TypeError("expected an array `profiles`")
    for index, profile in enumerate(profiles):
        where = f"profiles[{index}]"
        if not isinstance(profile, dict):
            raise TypeError(f"expected an object {where}")
        _check_strings(profile, ("profile_id",), f"{where}.")
        connections = profile.get("connections")
        if not isinstance(connections, list):
            raise TypeError(f"expected an array {where}.connections")
        for inner, connection in enumerate(connections):
            _check_connection(connection, f"{where}.connections[{inner}]")
    return value


def _created_connection(value: Any) -> Any:
    """``passportCreatedConnectionSchema`` (``POST /v1/connections``)."""
    _check_connection(_object(value, "a created connection").get("connection"), "connection")
    return value


def _deleted_connection(value: Any) -> Any:
    """``passportDeletedConnectionSchema`` (``DELETE /v1/connections/{id}``)."""
    body = _object(value, "a deleted connection")
    _check_booleans(body, ("deleted",), "")
    _check_strings(body, ("id",), "")
    return value


def _login_flow(value: Any) -> Any:
    """``passportLoginFlowSchema`` (``POST /v1/connections/{id}/login``): ``flow_id`` plus a
    ``kind`` of ``{"kind": "hosted", "url": ...}`` or ``{"kind": "manual"}``."""
    body = _object(value, "a login flow")
    _check_strings(body, ("flow_id",), "")
    kind = _object(body.get("kind"), "a `kind`")
    if kind.get("kind") == "hosted":
        _check_strings(kind, ("url",), "kind.")
    elif kind.get("kind") != "manual":
        raise TypeError("expected kind.kind to be one of hosted, manual")
    return value


def _fetch_result(value: Any) -> Any:
    """``passportFetchResultSchema`` (``POST /v1/connections/{id}/fetch``). ``wwwAuthenticate`` may
    be absent, but when present it is an array of strings (``null`` is refused, as ``.optional()``)."""
    body = _object(value, "a fetch result")
    _check_booleans(body, ("authenticated", "truncated"), "")
    _check_strings(body, ("content",), "")
    _check_numbers(body, ("status",), "")
    if "wwwAuthenticate" in body:
        challenges = body["wwwAuthenticate"]
        if not isinstance(challenges, list) or not all(isinstance(item, str) for item in challenges):
            raise TypeError("expected an array of strings wwwAuthenticate")
    return value


def _capabilities(value: Any) -> Any:
    """``passportCapabilitiesSchema`` (``GET /v1/capabilities``): every ``features`` flag is a boolean."""
    body = _object(value, "a capabilities")
    _check_strings(body, ("api_version", "service"), "")
    features = _object(body.get("features"), "a `features`")
    for name, flag in features.items():
        if not isinstance(flag, bool):
            raise TypeError(f"expected a boolean features.{name}")
    return value


def _usage_report(value: Any) -> Any:
    """``passportUsageReportSchema`` (``GET /v1/usage``)."""
    body = _object(value, "a usage report")
    _check_strings(body, ("from", "to", "type"), "")
    _check_booleans(body, ("ok",), "")
    _check_numbers(_object(body.get("meters"), "a `meters`"), ("connectionSeconds", "fetches"), "meters.")
    return value


def _import_state_body(input: Mapping[str, Any]) -> dict[str, Any]:
    state = input.get("state") if isinstance(input, Mapping) else None
    if not isinstance(state, str):
        raise RyuInvalidRequestError(
            "Ryu Passport connections.import_state: pass {'state': ...}, the captured credential state as one string.",
            service="passport",
            code="invalid_request",
            details={"missing": ["state"]} if state is None else {"invalid": ["state"]},
            retryable=False,
        )
    return {"state": state}


def _connection(connection_id: str, action: str = "") -> str:
    path = f"/v1/connections/{segment('passport', connection_id, 'the connection id')}"
    return f"{path}/{action}" if action else path


class Connections(Resource):
    def list(self) -> Any:
        return self._b.call(lambda c: Request("GET", "/v1/connections", auth=_admin_key(c), decode=_connection_list))

    def create(self, input: Mapping[str, Any]) -> Any:
        """Creates a connection (``profile_id``, ``domain``, ``source``); it starts as ``NEEDS_AUTH``.

        On a Passport that lists ``features.idempotency_keys: true`` the create carries an
        ``Idempotency-Key`` (yours, or a UUID) and is retried with it on a network error,
        timeout or 5xx. Otherwise the SDK adds no key and never retries those failures; a key
        you bind is still sent, so before retrying against an older Passport list the
        profile's connections and reuse one for the same domain."""
        body = {key: input.get(key) for key in ("domain", "profile_id", "source") if input.get(key) is not None}
        return self._b.call(
            lambda c: Request("POST", "/v1/connections", json=body, auth=_admin_key(c), decode=_created_connection)
        )

    def get(self, connection_id: str) -> Any:
        return self._b.call(
            lambda c: Request("GET", _connection(connection_id), auth=_admin_key(c), decode=_connection_detail)
        )

    def delete(self, connection_id: str) -> Any:
        return self._b.call(
            lambda c: Request("DELETE", _connection(connection_id), auth=_admin_key(c), decode=_deleted_connection)
        )

    def login(self, connection_id: str) -> Any:
        """Starts a login flow for the connection."""
        return self._b.call(
            lambda c: Request("POST", _connection(connection_id, "login"), auth=_admin_key(c), decode=_login_flow)
        )

    def import_state(self, connection_id: str, input: Mapping[str, Any]) -> Any:
        """Seals credential state you captured yourself and marks the connection ``AUTHENTICATED``.

        ``POST /v1/connections/{id}/import`` with ``{"state": ...}`` (one string, at most 512 KiB,
        for example a cookie header). This completes a login whose ``login()`` flow kind is
        ``manual``; until then a fetch answers ``409 conflict``. The response carries status
        metadata only: Passport never returns the state. Never retried on a network error or 5xx.
        A missing or non-string ``state`` is refused before any request (``invalid_request``),
        and a reply that is not a connection detail is an ``invalid_response``.
        """
        return self._b.call(
            lambda c: Request(
                "POST",
                _connection(connection_id, "import"),
                auth=_admin_key(c),
                json=_import_state_body(input),
                decode=_connection_detail,
            )
        )

    def fetch(self, connection_id: str, input: Mapping[str, Any]) -> Any:
        """Fetches ``input["url"]`` through the stored login, with the administration key."""
        return self._b.call(
            lambda c: Request(
                "POST",
                _connection(connection_id, "fetch"),
                json=dict(input),
                auth=_admin_key(c),
                decode=_fetch_result,
            )
        )


class RuntimeConnections(Resource):
    def list(self) -> Any:
        return self._b.call(
            lambda c: Request("GET", f"{RUNTIME_PREFIX}connections", auth=_runtime_key(c), decode=_connection_list)
        )

    def fetch(self, connection_id: str, input: Mapping[str, Any]) -> Any:
        """Fetches ``input["url"]`` through the stored login, with the runtime grant.

        ``credentialHeaders`` values may name ``vault:<domain>`` to splice in the stored credential.
        """
        return self._b.call(
            lambda c: Request(
                "POST",
                _connection(connection_id, "fetch"),
                json=dict(input),
                auth=_runtime_key(c),
                decode=_fetch_result,
            )
        )

    def has_runtime_grant(self) -> bool:
        """Whether a runtime key is configured (no request)."""
        return bool(self._b.sync_value(lambda c: c.runtime_key))

    def is_configured(self) -> bool:
        """Same as :meth:`has_runtime_grant`."""
        return self.has_runtime_grant()


class Runtime(Resource):
    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.connections = RuntimeConnections(binding)


class Profiles(Resource):
    def list(self) -> Any:
        return self._b.call(lambda c: Request("GET", "/v1/profiles", auth=_admin_key(c), decode=_profile_list))


class PassportNamespace(Namespace):
    """``ryu.passport``."""

    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.connections = Connections(binding)
        self.profiles = Profiles(binding)
        self.runtime = Runtime(binding)

    def capabilities(self) -> Any:
        return self._b.call(lambda c: Request("GET", "/v1/capabilities", auth=_admin_key(c), decode=_capabilities))

    def usage(self, window: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> Any:
        query = {**dict(window or {}), **kwargs}

        def op(config: Any) -> Request:
            checked = require_usage_window("passport", query)
            return Request(
                "GET",
                "/v1/usage",
                params={"from": checked["from"], "to": checked["to"]},
                auth=_admin_key(config),
                decode=_usage_report,
            )

        return self._b.call(op)
