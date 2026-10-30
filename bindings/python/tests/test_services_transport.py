"""Transport rules of ryu_sdk.services (auth, idempotency, retries, redirects, errors, modes)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from ryu_sdk.services import (
    Result,
    Ryu,
    RyuAuthenticationError,
    RyuConfigurationError,
    RyuConnectionError,
    RyuError,
    RyuRateLimitError,
    RyuRedirectError,
    RyuResponseValidationError,
    RyuTimeoutError,
    RyuUnavailableError,
    message_without_hint,
)


class Recorder:
    """An httpx.MockTransport that answers from a list (or a function) and records requests."""

    def __init__(self, *responses: Any) -> None:
        self.responses: list[Any] = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if callable(answer):
            return answer(request)
        if isinstance(answer, Exception):
            raise answer
        return answer

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def make(recorder: Recorder, env: dict[str, str], **options: Any) -> Ryu:
    ryu = Ryu(env=env, transport=recorder.transport, **options)
    sleeps: list[float] = []
    ryu._core.sleep = sleeps.append  # type: ignore[assignment]
    ryu.sleeps = sleeps  # type: ignore[attr-defined]
    return ryu


NOTIFY_ENV = {"RYU_NOTIFY_API_KEY": "notify-key"}
EVENT = {"event": {"id": "evt_1", "title": "Deployed"}}


# ── auth per service ─────────────────────────────────────────────────────────


def test_notify_sends_its_bearer_and_the_sdk_headers():
    recorder = Recorder(httpx.Response(201, json=EVENT))
    ryu = make(recorder, NOTIFY_ENV)
    assert ryu.notify.publish({"title": "Deployed"}) == {"id": "evt_1", "title": "Deployed"}
    request = recorder.requests[0]
    assert str(request.url) == "https://notify.ryuhq.com/v1/events"
    assert request.headers["authorization"] == "Bearer notify-key"
    assert request.headers["accept"].startswith("application/problem+json")
    assert request.headers["user-agent"].startswith("ryu-services-python/")
    assert json.loads(request.content) == {"title": "Deployed"}


def test_user_agent_can_be_extended_or_turned_off():
    recorder = Recorder(httpx.Response(201, json=EVENT))
    make(recorder, NOTIFY_ENV, user_agent="my-app/1.0").notify.publish({"title": "x"})
    assert recorder.requests[0].headers["user-agent"].endswith(" my-app/1.0")
    recorder = Recorder(httpx.Response(201, json=EVENT))
    make(recorder, NOTIFY_ENV, user_agent=False).notify.publish({"title": "x"})
    assert not recorder.requests[0].headers["user-agent"].startswith("ryu-services-python/")


def test_managed_agents_sends_x_api_key_and_organization_only():
    recorder = Recorder(httpx.Response(200, json={"data": [], "nextCursor": None}))
    ryu = make(recorder, {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"})
    ryu.managed_agents.agents.list(limit=5)
    request = recorder.requests[0]
    assert str(request.url) == "https://api.ryuhq.com/api/v1/managed-agents/agents?limit=5"
    assert request.headers["x-api-key"] == "ryu_key"
    assert request.headers["x-ryu-organization"] == "org_1"
    assert "authorization" not in request.headers


def test_hosted_mail_uses_the_gateway_key_before_the_ryu_key():
    recorder = Recorder(httpx.Response(200, json={"inboxes": []}))
    ryu = make(recorder, {"RYU_API_KEY": "ryu_key", "RYU_MAIL_GATEWAY_KEY": "gw_key"})
    assert ryu.mail.inboxes.list() == []
    request = recorder.requests[0]
    assert str(request.url) == "https://api.ryuhq.com/api/mail/inboxes"
    assert request.headers["x-gateway-key"] == "gw_key"
    assert "x-api-key" not in request.headers and "authorization" not in request.headers


def test_hosted_mail_on_a_ryu_key_sends_x_api_key_and_organization():
    recorder = Recorder(httpx.Response(200, json={"inboxes": []}))
    make(recorder, {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}).mail.inboxes.list()
    headers = recorder.requests[0].headers
    assert headers["x-api-key"] == "ryu_key" and headers["x-ryu-organization"] == "org_1"


def test_self_hosted_mail_never_receives_the_ryu_key():
    recorder = Recorder(httpx.Response(200, json={"inboxes": []}))
    ryu = make(recorder, {"RYU_API_KEY": "ryu_key", "RYU_MAIL_URL": "https://mail.example.com"})
    result = ryu.safe.mail.inboxes.list()
    assert isinstance(result.error, RyuConfigurationError)
    assert result.error.details == {"missing": ["RYU_MAIL_API_KEY"]}
    assert recorder.requests == []


def test_a_gateway_error_keeps_its_x_request_id():
    # apps/gateway/src/api/http_conventions.rs sends x-request-id on every response, errors included.
    recorder = Recorder(
        httpx.Response(
            404,
            json={"error": {"code": "model_not_found", "message": "gpt-9", "type": "model_not_found"}},
            headers={"x-request-id": "req_gw_err_1"},
        )
    )
    with pytest.raises(RyuError) as raised:
        make(recorder, {}, max_retries=0).gateway.models.list()
    assert raised.value.request_id == "req_gw_err_1"
    assert raised.value.code == "model_not_found"


def test_gateway_without_a_token_sends_no_credential():
    recorder = Recorder(httpx.Response(200, json={"status": "ok"}))
    make(recorder, {}).gateway.health()
    request = recorder.requests[0]
    assert str(request.url) == "http://127.0.0.1:7981/health"
    assert "authorization" not in request.headers


def test_options_win_over_environment_variables():
    recorder = Recorder(httpx.Response(201, json=EVENT))
    ryu = make(recorder, NOTIFY_ENV, notify={"api_key": "option-key", "base_url": "https://notify.example.com"})
    ryu.notify.publish({"title": "x"})
    request = recorder.requests[0]
    assert str(request.url) == "https://notify.example.com/v1/events"
    assert request.headers["authorization"] == "Bearer option-key"


def test_unknown_service_options_are_refused():
    with pytest.raises(RyuConfigurationError) as raised:
        Ryu(env=False, notify={"apiKey": "camelCase"})
    assert raised.value.code == "invalid_option"


def test_is_configured_reports_without_sending():
    ryu = Ryu(env=NOTIFY_ENV)
    assert ryu.is_configured("notify") is True
    assert ryu.is_configured("passport") is False


# ── idempotency ──────────────────────────────────────────────────────────────


def test_idempotency_key_is_added_once_and_reused_on_retries():
    recorder = Recorder(
        httpx.Response(503, json={"ok": False, "type": "notify.error", "error": {"code": "busy", "message": "busy"}}),
        httpx.Response(201, json={**EVENT, "idempotent": True}),
    )
    ryu = make(recorder, NOTIFY_ENV, result="object")
    data, error, meta = ryu.notify.publish({"title": "x"})
    assert error is None and data["id"] == "evt_1"
    keys = [request.headers["idempotency-key"] for request in recorder.requests]
    assert len(keys) == 2 and keys[0] == keys[1]
    assert meta.idempotency_key == keys[0]
    assert meta.attempts == 2 and meta.replayed is True
    assert len(ryu.sleeps) == 1 and 0.25 <= ryu.sleeps[0] <= 0.5


def test_caller_idempotency_key_is_sent():
    recorder = Recorder(httpx.Response(201, json=EVENT))
    make(recorder, NOTIFY_ENV).notify.publish({"title": "x"}, idempotency_key="deploy-4821")
    assert recorder.requests[0].headers["idempotency-key"] == "deploy-4821"


def test_non_route_writes_get_no_key_and_are_not_retried():
    recorder = Recorder(httpx.Response(503, json={"code": "busy", "message": "busy"}))
    ryu = make(recorder, NOTIFY_ENV)
    with pytest.raises(RyuUnavailableError):
        ryu.notify.events.acknowledge("evt_1")
    assert len(recorder.requests) == 1
    assert "idempotency-key" not in recorder.requests[0].headers


def test_auto_idempotency_can_be_turned_off():
    recorder = Recorder(httpx.Response(201, json=EVENT))
    make(recorder, NOTIFY_ENV, auto_idempotency=False).notify.publish({"title": "x"})
    assert "idempotency-key" not in recorder.requests[0].headers


def test_bound_key_is_spent_by_the_first_write():
    recorder = Recorder(httpx.Response(201, json=EVENT))
    bound = make(recorder, NOTIFY_ENV).notify.with_options(idempotency_key="deploy-1")
    bound.publish({"title": "first"})
    with pytest.raises(RyuConfigurationError) as raised:
        bound.publish({"title": "second"})
    assert raised.value.code == "idempotency_key_reused"
    assert len(recorder.requests) == 1
    assert recorder.requests[0].headers["idempotency-key"] == "deploy-1"


def test_with_options_headers_and_reads_do_not_spend_the_key():
    recorder = Recorder(httpx.Response(200, json=EVENT))
    bound = make(recorder, NOTIFY_ENV).notify.with_options(idempotency_key="k-1", headers={"X-Trace": "t1"})
    bound.events.get("evt_1")
    bound.publish({"title": "x"})
    assert recorder.requests[0].headers["x-trace"] == "t1"
    assert "idempotency-key" not in recorder.requests[0].headers
    assert recorder.requests[1].headers["idempotency-key"] == "k-1"


# ── retries ──────────────────────────────────────────────────────────────────


def test_get_is_retried_on_503_with_backoff():
    recorder = Recorder(httpx.Response(503, text=""), httpx.Response(503, text=""), httpx.Response(200, json=EVENT))
    ryu = make(recorder, NOTIFY_ENV)
    ryu._core.random = lambda: 0.5
    assert ryu.notify.events.get("evt_1")["id"] == "evt_1"
    assert ryu.sleeps == [0.375, 0.75]


def test_retries_stop_after_max_retries():
    recorder = Recorder(httpx.Response(502, text="bad gateway"))
    ryu = make(recorder, NOTIFY_ENV, max_retries=1)
    with pytest.raises(RyuError) as raised:
        ryu.notify.events.get("evt_1")
    assert len(recorder.requests) == 2
    assert raised.value.attempts == 2 and raised.value.code == "bad_gateway"


def test_429_is_retried_for_any_method_when_the_server_says_how_long():
    recorder = Recorder(
        httpx.Response(429, json={"code": "rate_limited", "message": "slow"}, headers={"retry-after": "2"}),
        httpx.Response(200, json=EVENT),
    )
    ryu = make(recorder, NOTIFY_ENV)
    ryu.notify.events.acknowledge("evt_1")
    assert ryu.sleeps == [2.0]


def test_429_without_a_hint_is_not_retried():
    recorder = Recorder(httpx.Response(429, json={"code": "rate_limited", "message": "slow"}))
    ryu = make(recorder, NOTIFY_ENV)
    with pytest.raises(RyuRateLimitError):
        ryu.notify.events.get("evt_1")
    assert len(recorder.requests) == 1


def test_a_longer_server_wait_is_surfaced_not_slept():
    recorder = Recorder(
        httpx.Response(
            429,
            json={"code": "rate_limited", "message": "slow"},
            headers={"RateLimit": '"burst";r=0;t=120', "RateLimit-Policy": '"burst";q=10;w=60'},
        )
    )
    ryu = make(recorder, NOTIFY_ENV, max_retry_delay=30)
    with pytest.raises(RyuRateLimitError) as raised:
        ryu.notify.events.get("evt_1")
    assert ryu.sleeps == []
    assert raised.value.retry_after_seconds == 120
    assert raised.value.rate_limit.limit == 10 and raised.value.rate_limit.remaining == 0


def test_non_retryable_codes_are_never_retried():
    recorder = Recorder(httpx.Response(503, json={"code": "not_configured", "message": "off"}))
    ryu = make(recorder, NOTIFY_ENV)
    with pytest.raises(RyuUnavailableError) as raised:
        ryu.notify.events.get("evt_1")
    assert raised.value.retryable is False and len(recorder.requests) == 1


def test_retry_hooks_fire_and_a_raising_hook_is_ignored():
    events: list[dict[str, Any]] = []

    def broken(_event: dict[str, Any]) -> None:
        raise RuntimeError("hook bug")

    recorder = Recorder(
        httpx.Response(500, text=""), httpx.Response(200, json=EVENT, headers={"x-request-id": "req_9"})
    )
    ryu = make(
        recorder,
        NOTIFY_ENV,
        hooks={"on_retry": events.append, "on_response": events.append, "on_request": broken},
    )
    ryu.notify.events.get("evt_1")
    retry = next(event for event in events if "delay_ms" in event)
    assert retry["code"] == "internal_error" and retry["service"] == "notify" and retry["attempt"] == 1
    assert events[-1]["request_id"] == "req_9" and events[-1]["status"] == 200


# ── redirects, origins, transport failures ───────────────────────────────────


def test_redirects_are_refused_and_the_location_is_reduced_to_its_origin():
    recorder = Recorder(httpx.Response(302, headers={"location": "https://evil.example.com/login?token=abc"}))
    ryu = make(recorder, NOTIFY_ENV)
    with pytest.raises(RyuRedirectError) as raised:
        ryu.notify.events.get("evt_1")
    assert raised.value.details == {"location": "https://evil.example.com"}
    assert raised.value.retryable is False
    assert len(recorder.requests) == 1


def test_requests_to_another_origin_carry_no_credentials():
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.ryuhq.com":
            return httpx.Response(200, json={"url": "https://files.example.com/signed?sig=1"})
        return httpx.Response(200, content=b"PDF")

    recorder = Recorder(answer)
    ryu = make(recorder, {"RYU_MAIL_GATEWAY_KEY": "gw_key"})
    assert ryu.mail.messages.download_attachment("ibx_1", "msg_1", "att_1") == b"PDF"
    signed = recorder.requests[1]
    assert signed.url.host == "files.example.com"
    assert not any(name in signed.headers for name in ("authorization", "x-api-key", "x-gateway-key"))


def test_timeouts_and_connection_failures_are_typed_and_scrubbed():
    recorder = Recorder(httpx.ConnectTimeout("timed out"))
    ryu = make(recorder, NOTIFY_ENV, max_retries=0)
    with pytest.raises(RyuTimeoutError) as raised:
        ryu.notify.events.get("evt_1")
    assert raised.value.status == 0 and "RYU_NOTIFY_URL" in (raised.value.hint or "")
    # Messages name the service by its title, as hints do (not by the SDK id "notify").
    assert raised.value.message.startswith("Ryu Notify: GET got no response within ")

    recorder = Recorder(httpx.ConnectError("refused for notify-key at https://notify.ryuhq.com/v1/events/evt_1?x=1"))
    ryu = make(recorder, NOTIFY_ENV, max_retries=1)
    with pytest.raises(RyuConnectionError) as raised:
        ryu.notify.events.get("evt_1")
    assert len(recorder.requests) == 2
    assert "notify-key" not in raised.value.message
    assert raised.value.message.startswith("Ryu Notify: GET request failed before a response: ")
    assert "Could not reach Ryu Notify at https://notify.ryuhq.com" in raised.value.hint


def test_a_2xx_that_is_not_json_is_a_validation_error():
    recorder = Recorder(httpx.Response(200, text="<html>"))
    ryu = make(recorder, NOTIFY_ENV, result="object")
    result = ryu.notify.events.get("evt_1")
    assert isinstance(result.error, RyuResponseValidationError)
    assert result.error.code == "invalid_response"


# ── result modes, errors ─────────────────────────────────────────────────────


def test_object_mode_returns_results_and_configuration_errors():
    ryu = Ryu(env=False, result="object")
    result = ryu.notify.publish({"title": "Hello"})
    assert isinstance(result, Result)
    assert result.data is None and result.meta is None
    assert result.error.code == "configuration_error"
    assert result.error.details == {"missing": ["RYU_NOTIFY_API_KEY"]}
    with pytest.raises(RyuConfigurationError):
        result.unwrap()


def test_throw_mode_raises_and_safe_returns():
    recorder = Recorder(
        httpx.Response(401, json={"code": "unauthorized", "message": "bad key"}, headers={"www-authenticate": "Bearer"})
    )
    ryu = make(recorder, NOTIFY_ENV)
    with pytest.raises(RyuAuthenticationError) as raised:
        ryu.notify.events.get("evt_1")
    error = raised.value
    assert error.auth_challenge == "Bearer"
    assert error.hint == "Ryu Notify did not accept the credentials. Check RYU_NOTIFY_API_KEY (or notify.api_key)."
    safe = ryu.safe.notify.events.get("evt_1")
    assert safe.ok is False and safe.error.status == 401 and safe.meta.status == 401


def test_error_to_dict_has_the_typescript_shape_and_no_query():
    recorder = Recorder(
        httpx.Response(404, json={"code": "not_found", "message": "nope"}, headers={"x-request-id": "req_1"})
    )
    ryu = make(recorder, NOTIFY_ENV, result="object")
    error = ryu.notify.events.list(topic="secret-token").error
    view = error.to_dict()
    assert view["name"] == "RyuNotFoundError" and view["requestId"] == "req_1"
    assert view["url"] == "https://notify.ryuhq.com/v1/events"
    assert set(view) >= {"retryAfterSeconds", "rateLimit", "envelope", "idempotencyKey", "attempts"}


def test_managed_agents_preview_errors_get_the_preview_hint():
    recorder = Recorder(
        httpx.Response(403, json={"error": {"code": "feature_disabled", "message": "off", "requestId": "req_1"}})
    )
    ryu = make(recorder, {"RYU_API_KEY": "ryu_key"}, result="object")
    error = ryu.managed_agents.sessions.list().error
    assert error.envelope == "managed-agents"
    assert error.hint.startswith("Managed Agents is a preview")
    assert error.docs == "https://docs.ryuhq.com/docs/standalone/managed-agents"


def test_connect_codes_without_prose_get_a_message():
    recorder = Recorder(httpx.Response(403, json={"code": "tool_denied"}))
    ryu = make(
        recorder, {"RYU_CONNECT_URL": "https://connect.example.com", "RYU_CONNECT_API_KEY": "c"}, result="object"
    )
    error = ryu.connect.tools.exec(tool_id="composio.X").error
    assert error.code == "tool_denied"
    assert message_without_hint(error) == "That tool (or its account) is not granted to this tenant."
    assert error.message == f"That tool (or its account) is not granted to this tenant. Hint: {error.hint}"
    # The message and the hint agree: a grant, not the key, is missing.
    assert error.hint is not None and "a different key will not help" in error.hint
    assert "scopes" not in error.hint
    assert error.docs == "https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints"


def test_another_connect_403_gets_no_key_and_scopes_hint():
    recorder = Recorder(httpx.Response(403, json={"code": "forbidden", "error": "Forbidden", "ok": False}))
    ryu = make(
        recorder, {"RYU_CONNECT_URL": "https://connect.example.com", "RYU_CONNECT_API_KEY": "c"}, result="object"
    )
    error = ryu.connect.skills.list().error
    assert error.status == 403
    assert error.hint is None


def test_meta_reports_rate_limit_and_deprecation_once_per_route():
    seen: list[dict[str, Any]] = []
    headers = {
        "Deprecation": "@1790000000",
        "Link": '<https://docs.ryuhq.com/policy>; rel="deprecation"',
        "RateLimit": '"default";r=9;t=30',
    }
    recorder = Recorder(httpx.Response(200, json=EVENT, headers=headers))
    ryu = make(recorder, NOTIFY_ENV, result="object", hooks={"on_deprecation": seen.append})
    first = ryu.notify.events.get("evt_1")
    ryu.notify.events.get("evt_2")
    assert first.meta.rate_limit.remaining == 9
    assert first.meta.deprecation.policy_url == "https://docs.ryuhq.com/policy"
    assert len(seen) == 1 and seen[0]["url"] == "https://notify.ryuhq.com/v1/events/evt_1"


def test_mail_prose_errors_get_a_code_and_are_not_retried():
    prose = "the mail provider did not confirm this send, so it may have been sent; check this inbox's sent messages before sending it again"
    recorder = Recorder(httpx.Response(502, json={"error": prose}))
    ryu = make(recorder, {"RYU_MAIL_GATEWAY_KEY": "gw"}, result="object")
    error = ryu.mail.messages.send("ibx_1", {"to": ["a@example.com"], "text": "hi"}).error
    assert error.code == "outcome_unknown" and error.retryable is False
    assert len(recorder.requests) == 1


def test_context_manager_closes_the_client():
    recorder = Recorder(httpx.Response(201, json=EVENT))
    with make(recorder, NOTIFY_ENV) as ryu:
        ryu.notify.publish({"title": "x"})
        client = ryu._core.http
    assert client.is_closed


def test_is_configured_needs_an_explicit_setting():
    assert Ryu(env={}).is_configured("gateway") is False
    assert Ryu(env={"RYU_GATEWAY_URL": "http://127.0.0.1:7981"}).is_configured("gateway") is True
    assert Ryu(env={}, api_key="ryu_k").is_configured("managed_agents") is True
    assert Ryu(env={"RYU_API_KEY": "ryu_k"}).is_configured("mail") is True


def test_required_key_routes_send_a_key_even_with_auto_idempotency_off():
    from ryu_sdk.services.transport import SERVICE_ROUTES, match_route

    recorder = Recorder(httpx.Response(200, json={}))
    env = {
        "RYU_API_KEY": "ryu_key",
        "RYU_ORGANIZATION_ID": "org_1",
        "RYU_BOX_API_KEY": "b",
        "RYU_NOTIFY_API_KEY": "n",
    }
    ryu = make(recorder, env, auto_idempotency=False, result="object", max_retries=0)
    ryu.messaging.sms.send({"to": "+15550100", "body": "hi"})
    ryu.messaging.mms.send({"to": "+15550100", "mediaUrls": []})
    ryu.messaging.voice.send({"to": "+15550100"})
    ryu.messaging.whatsapp.send({"to": "+15550100"})
    ryu.messaging.numbers.buy({"phoneNumber": "+15550100"})
    ryu.box.create({})
    ryu.box.fork("box_1")
    ryu.notify.activities.create({"title": "deploy"})
    # Optional-key routes stay keyless when the caller turned auto idempotency off.
    ryu.notify.publish({"title": "x"})

    required = {
        (service, route.method, route.path)
        for service, table in SERVICE_ROUTES.items()
        for route in table.idempotent
        if route.required
    }
    sent = set()
    for request in recorder.requests:
        for service, table in SERVICE_ROUTES.items():
            config = ryu._core.engine(service).config if ryu.is_configured(service) else None
            if config is None:
                continue
            route = match_route(table, config.base_url, request.method, str(request.url))
            if route is None:
                continue
            if route.required:
                assert request.headers.get("idempotency-key"), (service, route.path)
                sent.add((service, route.method, route.path))
            else:
                assert "idempotency-key" not in request.headers, (service, route.path)
    assert sent == required


@pytest.mark.parametrize("name", sorted(__import__("ryu_sdk.services.errors", fromlist=["x"]).ERROR_CLASSES))
def test_every_error_class_survives_pickle_and_deepcopy(name):
    import copy
    import pickle

    from ryu_sdk.services.errors import ERROR_CLASSES, message_without_hint
    from ryu_sdk.services.transport import RateLimit

    cls = ERROR_CLASSES[name]
    error = cls(
        "slow down",
        service="notify",
        status=429,
        code="rate_limited",
        request_id="req_1",
        retry_after_seconds=3,
        rate_limit=RateLimit(limit=10, policy=None, remaining=0, reset_seconds=3, window_seconds=60),
        details={"why": "burst"},
        hint="wait",
        method="POST",
        url="https://notify.ryuhq.com/v1/events?token=x",
        idempotency_key="k-1",
        attempts=2,
    )
    for copied in (pickle.loads(pickle.dumps(error)), copy.deepcopy(error), copy.copy(error)):
        assert type(copied) is cls
        assert copied.message == "slow down. Hint: wait" and str(copied) == "slow down. Hint: wait"
        assert message_without_hint(copied) == "slow down" and copied.hint == "wait"
        assert copied._fields() == error._fields()
        assert copied.to_dict() == error.to_dict()


def test_is_configured_refuses_an_unknown_name():
    ryu = Ryu(env=NOTIFY_ENV)
    for name in ("bogus", "managed-agents", "managedagents"):
        with pytest.raises(RyuConfigurationError) as raised:
            ryu.is_configured(name)
        assert raised.value.code == "invalid_option"
    assert ryu.is_configured("managedAgents") is False


def test_the_user_agent_version_matches_pyproject():
    import re
    from pathlib import Path

    from ryu_sdk.services._runtime import SDK_VERSION

    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    version = re.search(r'^version = "([^"]+)"', pyproject, re.MULTILINE)
    assert version is not None and SDK_VERSION == version.group(1)


def test_object_mode_encodes_dates_and_returns_unserializable_bodies_as_errors():
    import datetime
    import decimal

    recorder = Recorder(httpx.Response(201, json=EVENT))
    ryu = make(recorder, NOTIFY_ENV, result="object")
    moment = datetime.datetime(2026, 10, 22, 12, 0, tzinfo=datetime.timezone.utc)
    result = ryu.notify.publish({"title": "x", "at": moment, "day": datetime.date(2026, 10, 22)})
    assert result.error is None
    assert json.loads(recorder.requests[0].content) == {
        "title": "x",
        "at": "2026-10-22T12:00:00+00:00",
        "day": "2026-10-22",
    }
    result = ryu.notify.publish({"title": "x", "amount": decimal.Decimal("1.5")})
    assert result.data is None and len(recorder.requests) == 1
    assert result.error.code == "invalid_request_body" and result.error.retryable is False
    assert result.error.name == "RyuInvalidRequestError"
    with pytest.raises(RyuError):
        make(recorder, NOTIFY_ENV).notify.publish({"title": "x", "amount": decimal.Decimal("1.5")})


def test_a_body_that_cannot_be_decoded_is_a_connection_error():
    recorder = Recorder(
        lambda _request: httpx.Response(
            200, stream=httpx.ByteStream(b"definitely not gzip"), headers={"content-encoding": "gzip"}
        )
    )
    ryu = make(recorder, NOTIFY_ENV, result="object", max_retries=0)
    result = ryu.notify.events.get("evt_1")
    assert result.data is None
    assert isinstance(result.error, RyuConnectionError)


def test_ryu_error_hint_is_read_only_and_a_copy_rehints_the_message():
    from ryu_sdk.services.errors import RyuAuthenticationError, message_without_hint, with_ryu_error_fields

    error = RyuAuthenticationError("bad key", service="notify", status=401, hint="Check A.")
    with pytest.raises(AttributeError, match="with_ryu_error_fields"):
        error.hint = "Check B."  # type: ignore[misc]
    assert error.hint == "Check A." and str(error) == "bad key. Hint: Check A."
    copied = with_ryu_error_fields(error, hint="Check B.")
    assert copied.hint == "Check B." and str(copied) == "bad key. Hint: Check B."
    assert message_without_hint(copied) == "bad key"
