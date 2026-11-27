"""Cross-checks ryu_sdk.services against @ryuhq/services.

fixtures/services_vectors.json is produced by fixtures/services_vectors.ts,
which runs the TypeScript source (config, errors, retry, rate-limit,
deprecation, route matching and the webhook verifiers). Every vector must come
out the same here. When bun is installed the script is re-run and the
committed file must match, so a TypeScript change cannot drift silently.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest

from ryu_sdk.services import Ryu, box, gateway, transport, webhooks
from ryu_sdk.services import config as config_module
from ryu_sdk.services import errors as errors_module
from ryu_sdk.services import passport as passport_module
from ryu_sdk.services.errors import RyuError, RyuInvalidRequestError

FIXTURES = Path(__file__).parent / "fixtures"
VECTORS = json.loads((FIXTURES / "services_vectors.json").read_text())
REPO_ROOT = Path(__file__).resolve().parents[3]


def test_committed_vectors_match_the_typescript_source():
    bun = shutil.which("bun")
    if bun is None or not (REPO_ROOT / "packages/services/src/config.ts").exists():
        pytest.skip("bun or the @ryuhq/services source is not available")
    completed = subprocess.run(
        [bun, str(FIXTURES / "services_vectors.ts")],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == VECTORS, (
        "services_vectors.json is stale: run "
        "`bun bindings/python/tests/fixtures/services_vectors.ts > bindings/python/tests/fixtures/services_vectors.json`"
    )


# ── constants ────────────────────────────────────────────────────────────────


def test_env_vars_match():
    expected = VECTORS["constants"]["envVars"]
    actual = [
        {"default": row.default, "name": row.name, "role": row.role, "service": row.service}
        for row in config_module.ENV_VARS
    ]
    assert actual == expected


def test_availability_labels_match():
    assert config_module.AVAILABILITY == VECTORS["constants"]["availability"]
    assert "ryu-sites release after 0.4.0" in config_module.AVAILABILITY["sites"]


def test_default_hosts_match():
    defaults = VECTORS["constants"]["defaults"]
    assert config_module.CONTROL_PLANE_URL == defaults["controlPlane"]
    assert config_module.DEFAULT_BOX_URL == defaults["box"]
    assert config_module.DEFAULT_NOTIFY_URL == defaults["notify"]
    assert config_module.DEFAULT_GATEWAY_URL == defaults["gateway"]


def test_route_tables_match():
    expected = VECTORS["constants"]["serviceRoutes"]
    actual = {
        service: {
            "capabilityIdempotent": [
                {"method": route.method, "path": route.path, "required": route.required, "capability": route.capability}
                for route in table.capability_idempotent
            ],
            "idempotent": [
                {"method": route.method, "path": route.path, "required": route.required} for route in table.idempotent
            ],
            "mount": table.mount,
            "nonReplaySafe": [
                {"method": route.method, "path": route.path, "reason": route.reason} for route in table.non_replay_safe
            ],
            "replayedBodyField": table.replayed_body_field,
            "replayedBodyValue": table.replayed_body_value if table.replayed_body_field else None,
        }
        for service, table in transport.SERVICE_ROUTES.items()
    }
    assert actual == expected


def test_retry_constants_match():
    assert sorted(transport.NON_RETRYABLE_CODES) == VECTORS["constants"]["nonRetryableCodes"]
    assert sorted(transport.RETRYABLE_STATUSES) == VECTORS["constants"]["retryableStatuses"]
    assert sorted(errors_module.AVAILABILITY_CODES) == VECTORS["constants"]["availabilityCodes"]


def test_box_error_codes_match():
    assert list(box.BOX_ERROR_CODES) == VECTORS["constants"]["boxErrorCodes"]
    assert "idempotency_key_resource_deleted" in transport.NON_RETRYABLE_CODES


@pytest.mark.parametrize("route", ["create", "fork"])
def test_box_replay_whose_box_was_deleted_is_a_conflict_and_not_retried(route: str) -> None:
    """Mirrors box.test.ts: a 409 idempotency_key_resource_deleted is a RyuConflictError, sent once."""
    requests: list[httpx.Request] = []
    message = "The Box this Idempotency-Key created has been deleted."
    request_id = "req_0123456789abcdef0123456789abcdef"

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        code = "idempotency_key_resource_deleted"
        error = {"code": code, "message": message, "requestId": request_id, "status": 409}
        return httpx.Response(409, json={"code": code, "error": error, "message": message, "ok": False})

    ryu = Ryu(env={"RYU_BOX_API_KEY": "b"}, transport=httpx.MockTransport(handler))
    ryu._core.sleep = lambda _seconds: None
    boxes = ryu.box.with_options(idempotency_key="gone-1")
    with pytest.raises(errors_module.RyuConflictError) as raised:
        if route == "create":
            boxes.create({"name": "a"})
        else:
            boxes.fork("bx_source", {"name": "a"})
    assert raised.value.code == "idempotency_key_resource_deleted"
    assert raised.value.status == 409
    assert len(requests) == 1
    assert requests[0].headers["idempotency-key"] == "gone-1"


def test_status_codes_match():
    expected = {int(status): tuple(row) for status, row in VECTORS["constants"]["statusCodes"].items()}
    assert errors_module.STATUS_CODES == expected


def test_every_typescript_error_class_exists_in_python():
    assert sorted(errors_module.ERROR_CLASSES) == VECTORS["constants"]["errorClasses"]


def test_webhook_event_types_match():
    assert list(webhooks.MAIL_EVENT_TYPES) == VECTORS["constants"]["mailEventTypes"]
    assert list(webhooks.MESSAGING_EVENT_TYPES) == VECTORS["constants"]["messagingEventTypes"]


# ── error parsing ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("vector", VECTORS["errors"], ids=lambda v: f"{v['input']['service']}-{v['input']['status']}")
def test_error_envelopes_parse_like_typescript(vector, monkeypatch):
    now_s = 1792670400.0  # 2026-10-22T12:00:00Z, the script's fixed clock
    monkeypatch.setattr(transport.time, "time", lambda: now_s)
    item = vector["input"]
    error = errors_module.parse_error_response(
        item["service"],
        item["status"],
        item.get("headers") or {},
        item["body"],
        "post",
        "https://svc.example.com/v1/x?token=secret",
    )
    view = error.to_dict()
    expected = vector["expected"]
    for key, value in expected.items():
        assert view[key] == value, f"{key}: {view[key]!r} != {value!r}"


def test_mail_transport_error_gains_the_typescript_smtp_hint():
    error = errors_module.parse_error_response(
        "mail",
        400,
        {"content-type": "application/json"},
        json.dumps({"error": "email transport is not configured"}),
        "post",
        "http://127.0.0.1:7996/api/mail/inboxes/inbox_1/send",
    )
    assert error.hint is not None and "RYU_SMTP_HOST" in error.hint
    assert error.docs == "https://docs.ryuhq.com/docs/standalone/mail#start-the-standalone-service"
    # The wording is the TypeScript knownServerHint's, word for word.
    source = REPO_ROOT / "packages/services/src/errors.ts"
    if source.exists():
        assert error.hint in source.read_text(encoding="utf-8")
    # Other services and server-supplied hints are left alone.
    assert errors_module.known_server_hint("notify", 400, "email transport is not configured") is None
    problem = errors_module.parse_error_response(
        "mail",
        400,
        {"content-type": "application/problem+json"},
        json.dumps({"status": 400, "detail": "email transport is not configured", "hint": "Ask the operator."}),
        "post",
        "http://127.0.0.1:7996/x",
    )
    assert problem.hint == "Ask the operator."


def test_failed_authentication_429_gains_the_typescript_hint():
    message = "Too many failed authentication attempts from this address; retry after the Retry-After delay."
    error = errors_module.parse_error_response(
        "notify",
        429,
        {"content-type": "application/json", "retry-after": "60"},
        json.dumps({"error": {"code": "rate_limited", "message": message}}),
        "get",
        "https://notify.example/v1/events",
    )
    assert error.hint is not None and "refuses even a correct key" in error.hint
    assert error.docs == "https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints"
    source = REPO_ROOT / "packages/services/src/errors.ts"
    if source.exists():
        assert error.hint in source.read_text(encoding="utf-8")
    assert errors_module.known_server_hint("notify", 429, "This tenant is publishing too fast.") is None


def test_wrong_service_and_connect_lane_hints_match_typescript():
    box_problem = json.dumps(
        {
            "type": "https://docs.ryuhq.com/docs/standalone/box-api#unauthorized",
            "title": "Unauthorized",
            "status": 401,
            "code": "unauthorized",
            "hint": "Check RYU_BOX_API_KEY.",
        }
    )
    error = errors_module.parse_error_response(
        "notify", 401, {"content-type": "application/problem+json"}, box_problem, "post", "http://127.0.0.1:8090/v1/x"
    )
    # The other service's own hint and docs are replaced.
    assert error.hint is not None and error.hint.startswith("RYU_NOTIFY_URL points at Ryu Box, not Ryu Notify:")
    assert error.docs == "https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints"
    source = REPO_ROOT / "packages/services/src/errors.ts"
    if source.exists():
        assert "the error came from the other service" in source.read_text(encoding="utf-8")
    # Same-host and same-service pages are not a wrong URL.
    mail_page = {"docs": "https://docs.ryuhq.com/docs/standalone/mail-api#unauthorized"}
    assert errors_module.known_server_hint("messaging", 401, "", mail_page) is None
    fetch_page = {"type": "https://docs.ryuhq.com/docs/standalone/passport-fetch-api#x"}
    assert errors_module.known_server_hint("passport", 404, "", fetch_page) is None
    # A page that only starts like another service's is not that service.
    assert (
        errors_module.known_server_hint("notify", 401, "", {"type": "https://docs.ryuhq.com/docs/standalone/box"})
        is None
    )
    lane = errors_module.known_server_hint("connect", 503, "", {"code": "upstream_unconfigured"})
    assert lane is not None and "RYU_CONNECT_CORE_URL" in lane["hint"]
    # Native grants come first; the Core/Gateway URLs are single-tenant compatibility mode only.
    assert "native: RYU_CONNECT_MCP_SERVERS or RYU_CONNECT_COMPOSIO_BINDINGS" in lane["hint"]
    assert lane["hint"].index("RYU_CONNECT_MCP_SERVERS") < lane["hint"].index("RYU_CONNECT_CORE_URL")
    assert "compatibility mode" in lane["hint"]
    assert errors_module.known_server_hint("connect", 502, "", {"code": "upstream_unconfigured"}) is None
    # Connect's grant denials say the operator's grants, not the key, are the fix.
    for code, grant in (
        ("tool_denied", "that tool (or its account)"),
        ("toolkit_denied", "that toolkit"),
        ("connection_denied", "that Composio connection"),
    ):
        denied = errors_module.known_server_hint("connect", 403, "", {"code": code})
        assert denied is not None and denied["hint"].startswith(f"This Connect has not granted {grant} to your tenant;")
        assert "RYU_CONNECT_MCP_SERVERS" in denied["hint"] and "RYU_CONNECT_COMPOSIO_BINDINGS" in denied["hint"]
        assert denied["docs"] == "https://docs.ryuhq.com/docs/standalone/sdk/errors#default-hints"
    assert errors_module.known_server_hint("connect", 403, "", {"code": "forbidden"}) is None
    assert errors_module.known_server_hint("box", 403, "", {"code": "tool_denied"}) is None
    assert errors_module.known_server_hint("box", 503, "", {"code": "upstream_unconfigured"}) is None


@pytest.mark.parametrize("vector", VECTORS["messageHints"], ids=lambda v: repr(v["input"]))
def test_messages_end_with_the_hint_like_typescript(vector):
    item, expected = vector["input"], vector["expected"]
    assert errors_module.message_with_hint(item["message"], item["hint"]) == expected["message"]
    error = RyuError(item["message"], service="notify", status=401, code="unauthenticated", hint=item["hint"])
    assert error.message == expected["errorMessage"] and str(error) == expected["errorMessage"]
    assert error.hint == item["hint"] and error.code == "unauthenticated"
    assert errors_module.message_without_hint(error) == expected["withoutHint"]

    class Foreign:
        message = error.message
        hint = error.hint

    assert errors_module.message_without_hint(Foreign()) == expected["foreignWithoutHint"]  # type: ignore[arg-type]
    rehinted = errors_module.with_ryu_error_fields(error, message=error.message, hint="Try again later.")
    assert rehinted.message == expected["rehinted"]
    assert (
        errors_module.copy_ryu_error(error, message=error.message, hint="Try again later.").message
        == expected["rehinted"]
    )


@pytest.mark.parametrize(
    "vector", VECTORS["managedAgentsErrors"], ids=lambda v: f"managed-agents-{v['input']['status']}"
)
def test_managed_agents_errors_match_the_typescript_facade(vector, monkeypatch):
    import httpx

    from ryu_sdk.services import Ryu

    now_s = 1792670400.0
    monkeypatch.setattr(transport.time, "time", lambda: now_s)
    item = vector["input"]

    def answer(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(item["status"], content=item["body"].encode("utf-8"), headers=item.get("headers") or {})

    ryu = Ryu(api_key="ryu_key", env=False, max_retries=0, result="object", transport=httpx.MockTransport(answer))
    error = ryu.managed_agents.agents.get("magt_1").error
    view = error.to_dict()
    expected = dict(vector["expected"])
    assert (view["deprecation"] is not None) == expected.pop("deprecated")
    hint = expected.pop("hint")
    message = expected.pop("message")
    for key, value in expected.items():
        assert view[key] == value, f"{key}: {view[key]!r} != {value!r}"

    # Option names in hints follow each language's spelling (apiKey / api_key).
    camel = re.sub(r"_([a-z])", lambda match: match.group(1).upper(), view["hint"] or "")
    assert (camel or None) == hint
    # The message ends with the hint in both languages; the rest is identical.
    own = errors_module.message_without_hint(error)
    assert message == errors_module.message_with_hint(own, hint)
    assert view["message"] == errors_module.message_with_hint(own, error.hint)


def test_prose_tables_match_the_typescript_source():
    from ryu_sdk.services import managed_agents, messaging
    from ryu_sdk.services.connect import CONNECT_ERROR_MESSAGES
    from ryu_sdk.services.mail import MAIL_MESSAGE_CODES

    constants = VECTORS["constants"]
    assert [
        {"code": code, "message": message, "status": status} for status, code, message in MAIL_MESSAGE_CODES
    ] == constants["mailMessageCodes"]
    assert CONNECT_ERROR_MESSAGES == constants["connectErrorMessages"]
    assert managed_agents.PREVIEW_DOCS == constants["managedAgentsPreviewDocs"]
    assert managed_agents.PREVIEW_HINTS == constants["managedAgentsPreviewHints"]
    assert messaging.DOCS == constants["messagingDocs"]
    for row in constants["messagingAvailabilityHints"]:
        item = row["input"]
        error = errors_module.create_ryu_error(
            item["message"], service="messaging", status=item["status"], code=item["code"]
        )
        assert messaging.messaging_availability_hint(error) == row["hint"]


# ── retries and headers ──────────────────────────────────────────────────────


@pytest.mark.parametrize("vector", VECTORS["retry"], ids=lambda v: f"{v['input']['status']}-{v['input']['code']}")
def test_retry_decisions_match(vector):
    item = vector["input"]
    hints = transport.RetryHints(
        retry_after_seconds=item["retryAfterSeconds"],
        rate_limit_remaining=item["rateLimitRemaining"],
        rate_limit_reset_seconds=item["rateLimitResetSeconds"],
        body_retry_after_seconds=item["bodyRetryAfterSeconds"],
    )
    assert (
        transport.should_retry(item["status"], item["code"], hints, replay_safe=item["replaySafe"])
        is vector["expected"]["retry"]
    )
    delays = [transport.compute_delay(index, hints, lambda: 0.5) for index in (0, 1, 2, 5)]
    assert [{"ms": round(seconds * 1000), "source": source} for seconds, source in delays] == vector["expected"][
        "delays"
    ]


def test_retry_after_matches():
    now_s = 1792670400.0
    for vector in VECTORS["headers"]["retryAfter"]:
        assert transport.parse_retry_after(vector["input"], now=now_s) == vector["expected"], vector["input"]


def test_rate_limit_matches():
    for vector in VECTORS["headers"]["rateLimit"]:
        parsed = transport.read_rate_limit(*vector["input"])
        assert (parsed.to_dict() if parsed else None) == vector["expected"], vector["input"]


def test_deprecation_matches():
    for vector in VECTORS["headers"]["deprecation"]:
        lower = {key.lower(): value for key, value in vector["input"].items()}
        parsed = transport.parse_deprecation(lower.get("deprecation"), lower.get("sunset"), lower.get("link"))
        assert (parsed.to_dict() if parsed else None) == vector["expected"], vector["input"]


# ── configuration ────────────────────────────────────────────────────────────


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", r"_\1", name).lower()


def _settings(item):
    options = item.get("options") or {}
    services = {}
    top = {}
    for key, value in options.items():
        if isinstance(value, dict):
            services[key] = {_snake(inner): inner_value for inner, inner_value in value.items()}
        else:
            top[_snake(key)] = value
    return config_module.Settings(
        api_key=top.get("api_key"),
        base_url=top.get("base_url"),
        organization_id=top.get("organization_id"),
        services=services,
        env=item["env"],
    )


@pytest.mark.parametrize(
    "vector",
    VECTORS["config"],
    ids=lambda v: f"{v['input']['service']}-{sorted(v['input']['env'])}-{v['input'].get('resolution', {})}",
)
def test_configuration_resolves_like_typescript(vector):
    settings = _settings(vector["input"])
    credentials = vector["input"].get("resolution", {}).get("credentials", "required")
    if "error" in vector:
        with pytest.raises(RyuError) as raised:
            settings.resolve(vector["input"]["service"], credentials=credentials)
        assert raised.value.code == vector["error"]["code"]
        assert raised.value.details == vector["error"]["details"]
        assert raised.value.name == vector["error"]["name"]
        if vector["error"]["code"] == "invalid_url":
            # Missing-credential hints name each SDK's own option spelling, so only
            # the language-neutral invalid-URL wording is compared word for word.
            assert raised.value.hint == vector["error"]["hint"]
            assert raised.value.message == vector["error"]["message"]
        return
    resolved = settings.resolve(vector["input"]["service"], credentials=credentials)
    assert {
        "apiKey": resolved.api_key,
        "auth": resolved.auth,
        "baseUrl": resolved.base_url,
        "mailMode": resolved.mail_mode,
        "managementKey": resolved.management_key,
        "organizationId": resolved.organization_id,
        "runtimeKey": resolved.runtime_key,
    } == vector["expected"]


@pytest.mark.parametrize("vector", VECTORS["routes"], ids=lambda v: f"{v['input']['method']} {v['input']['url']}")
def test_route_matching_matches(vector):
    item = vector["input"]
    route = transport.match_route(
        transport.SERVICE_ROUTES[item["service"]], item["baseUrl"], item["method"], item["url"]
    )
    assert (route.path if route else None) == vector["expected"]
    table = transport.SERVICE_ROUTES[item["service"]]
    if "expectedCapability" in vector:
        gated = transport.match_capability_route(table, item["baseUrl"], item["method"], item["url"])
        assert (gated.capability if gated else None) == vector["expectedCapability"]
    if "expectedNonReplaySafe" in vector:
        unsafe = transport.match_non_replay_safe_route(table, item["baseUrl"], item["method"], item["url"])
        assert (unsafe.path if unsafe else None) == vector["expectedNonReplaySafe"]


def test_route_vectors_cover_capability_and_non_replay_safe_routes():
    assert any(vector.get("expectedCapability") for vector in VECTORS["routes"])
    assert any(vector.get("expectedNonReplaySafe") for vector in VECTORS["routes"])


@pytest.mark.parametrize("vector", VECTORS["gatewayUpstream"], ids=lambda v: json.dumps(v["body"]))
def test_gateway_upstream_status_refines_like_typescript(vector):
    base = errors_module.create_ryu_error(
        "upstream failed", service="gateway", status=502, code="provider_error", details={"provider": "openai"}
    )
    refined = gateway.refine_gateway_error(base, vector["body"])
    assert gateway.gateway_upstream_status(vector["body"]) == vector["expected"]["upstreamStatus"]
    assert refined.details == vector["expected"]["details"]
    assert refined.retryable == vector["expected"]["retryable"]


@pytest.mark.parametrize("vector", VECTORS["errorClassFor"], ids=lambda v: f"{v['status']}-{v['code']}")
def test_error_class_for_status_and_code_matches_typescript(vector):
    assert errors_module.error_class_for(vector["status"], vector["code"]).__name__ == vector["created"]
    created = errors_module.create_ryu_error("vector", service="box", status=vector["status"], code=vector["code"])
    assert type(created).__name__ == vector["created"]
    assert type(errors_module.copy_ryu_error(created, hint="Try again.")).__name__ == vector["copied"]


def test_error_class_vectors_cover_every_status_zero_code():
    covered = {vector["code"] for vector in VECTORS["errorClassFor"] if vector["status"] == 0}
    assert set(errors_module._STATUS_ZERO_CLASSES) <= covered


# ── webhooks ─────────────────────────────────────────────────────────────────


def _verify(item):
    common = {
        "payload": item["payload"],
        "headers": item["headers"],
        "secret": item["secret"],
        "tolerance_seconds": item.get("toleranceSeconds"),
        "now": item["now"],
    }
    verifier = item["verifier"]
    if verifier == "mail":
        return webhooks.verify_mail_webhook(scheme=item.get("scheme") or "standard", **common)
    if verifier == "messaging":
        return webhooks.verify_messaging_webhook(**common)
    if verifier == "standard":
        return webhooks.verify_standard_webhook(scheme=item.get("scheme") or "standard", **common)
    delivery = webhooks.verify_notify_webhook(
        kind=item.get("kind") or "destination",
        require_timestamp=item.get("requireTimestamp"),
        allow_body_only_signature=bool(item.get("allowBodyOnlySignature")),
        **common,
    )
    return {
        "kind": delivery.kind,
        "deliveryId": delivery.delivery_id,
        "eventId": delivery.event_id,
        "body": delivery.body,
        "replayProtected": delivery.replay_protected,
    }


@pytest.mark.parametrize("vector", VECTORS["webhooks"], ids=lambda v: v["input"]["name"])
def test_webhooks_verify_like_typescript(vector):
    item = vector["input"]
    if "error" in vector:
        with pytest.raises(RyuError) as raised:
            _verify(item)
        assert raised.value.code == vector["error"]
        return
    assert _verify(item) == vector["expected"]


def test_webhook_headers_accept_bytes_values_and_pairs():
    vector = next(v for v in VECTORS["webhooks"] if v["input"]["name"] == "mail standard ok")
    item = vector["input"]
    pairs = [(key.encode("latin-1"), value.encode("latin-1")) for key, value in item["headers"].items()]
    pairs = [(key.decode(), value) for key, value in pairs]
    event = webhooks.verify_mail_webhook(
        payload=item["payload"].encode("utf-8"), headers=pairs, secret=item["secret"], now=item["now"]
    )
    assert event == vector["expected"]


# ── Managed Agents tool approvals ────────────────────────────────────────────


def test_tool_approval_event_types_match():
    from ryu_sdk.services.managed_agents import TOOL_APPROVAL_EVENT_TYPES

    assert list(TOOL_APPROVAL_EVENT_TYPES) == VECTORS["toolApprovals"]["eventTypes"]


@pytest.mark.parametrize(
    "case", VECTORS["toolApprovals"]["keys"], ids=lambda case: f"{case['decision']}-{case['message']!r}"
)
def test_tool_approval_idempotency_keys_match(case):
    from ryu_sdk.services.managed_agents import tool_approval_idempotency_key

    assert tool_approval_idempotency_key(case["toolUseId"], case["decision"], case["message"]) == case["expected"]


@pytest.mark.parametrize("case", VECTORS["toolApprovals"]["pending"])
def test_pending_tool_approvals_match(case):
    from ryu_sdk.services.managed_agents import pending_tool_approvals

    assert [event["toolUseId"] for event in pending_tool_approvals(case["events"])] == case["expected"]


# ── hosted Mail realtime tickets ─────────────────────────────────────────────


@pytest.mark.parametrize("case", VECTORS["mailRealtimeTickets"], ids=lambda case: ",".join(sorted(case["env"])))
def test_mail_realtime_ticket_decodes_like_typescript(case):
    def answer(request: httpx.Request) -> httpx.Response:
        assert (request.method, request.url.path) == ("POST", "/api/mail/realtime/tickets")
        return httpx.Response(201, json=case["reply"])

    ryu = Ryu(env=case["env"], transport=httpx.MockTransport(answer))
    assert ryu.mail.create_realtime_ticket() == case["expected"]


# ── Mail list limits ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "case",
    VECTORS["mailListLimits"],
    ids=lambda case: f"{case['call']}:{case['id']}:{case['eventType']}:{case['limit']}",
)
def test_mail_list_limit_request_matches_typescript(case):
    sent: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"drafts": [], "events": [], "deliveries": []})

    ryu = Ryu(env={"RYU_MAIL_GATEWAY_KEY": "rgw_vectors"}, transport=httpx.MockTransport(answer)).safe
    limit = float("nan") if case["limit"] == "NaN" else case["limit"]
    if case["call"] == "drafts.list":
        result = ryu.mail.drafts.list(case["id"], limit=limit)
    elif case["call"] == "webhooks.deliveries.list":
        result = ryu.mail.webhooks.deliveries.list(case["id"], limit=limit)
    else:
        result = ryu.mail.events.list(case["id"], case["eventType"], limit=limit)
    if case["error"] is None:
        assert result.error is None and result.data == []
        assert [request.url.raw_path.decode() for request in sent] == [case["path"]]
    else:
        assert result.error is not None and result.error.code == case["error"]
        assert isinstance(result.error, RyuInvalidRequestError)
        assert sent == [] and case["path"] is None


# ── Notify topic header text (RFC 2047) ──────────────────────────────────────


@pytest.mark.parametrize("case", VECTORS["notifyHeaderText"], ids=lambda case: repr(case["title"]))
def test_notify_topic_title_header_matches_typescript(case):
    sent: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(201, json={"event": {"id": "evt_1"}})

    ryu = Ryu(env={"RYU_NOTIFY_API_KEY": "n"}, transport=httpx.MockTransport(answer))
    result = ryu.safe.notify.topics.publish("alerts", "hi", {"title": case["title"]})
    if case["header"] is None:
        assert result.error is not None and result.error.code == "invalid_request_header"
        assert sent == []
    else:
        assert [value for key, value in sent[0].headers.raw if key == b"title"] == [case["header"].encode("latin-1")]


# ── Messaging organization ids ───────────────────────────────────────────────


@pytest.mark.parametrize("case", VECTORS["messagingOrgIds"], ids=lambda case: repr(case["organizationId"]))
def test_messaging_org_id_path_matches_typescript(case):
    sent: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"numbers": []})

    ryu = Ryu(
        api_key="ryu_x",
        organization_id=case["organizationId"],
        base_url="https://api.example",
        transport=httpx.MockTransport(answer),
    )
    result = ryu.safe.messaging.numbers.list()
    if case["error"] is None:
        assert result.error is None
        assert [request.url.raw_path.decode() for request in sent] == [case["path"]]
    else:
        assert type(result.error).__name__ == case["error"]["errorClass"]
        assert result.error.code == case["error"]["code"]
        assert sent == []


# ── Sites settings (projects.updateSettings / makePublic) ────────────────────


@pytest.mark.parametrize("case", VECTORS["sitesSettings"], ids=lambda case: case["name"])
def test_sites_settings_requests_and_outcome_match_typescript(case):
    sent: list[dict[str, Any]] = []

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        sent.append({"method": request.method, "path": request.url.path, "body": body})
        if request.method == "GET":
            site = {"id": "site_1", "revision": 2, "slug": "launch-notes", "settings": case["stored"]}
            return httpx.Response(200, json=site)
        if case["put"] is not None:
            return httpx.Response(case["put"]["status"], json=case["put"]["body"])
        return httpx.Response(200, json={"id": "site_1", "revision": 3, "settings": body["settings"]})

    ryu = Ryu(
        env={"RYU_SITES_API_KEY": "s", "RYU_SITES_URL": "http://localhost:8021"},
        transport=httpx.MockTransport(answer),
        result="object",
    )
    projects = ryu.sites.projects
    if case["call"] == "makePublic":
        result = projects.make_public("site_1", expected_revision=case["expectedRevision"])
    else:
        result = projects.update_settings("site_1", case["patch"], expected_revision=case["expectedRevision"])
    assert sent == case["requests"]
    expected = case["outcome"]
    if "error" in expected:
        error = result.error
        assert error is not None
        actual = {
            "code": error.code,
            "details": error.details,
            "hint": error.hint,
            "retryable": error.retryable,
            "status": error.status,
        }
        assert actual == expected["error"]
    else:
        assert result.error is None
        assert {"revision": result.data["revision"], "settings": result.data["settings"]} == expected


# ── Passport reply decoding ─────────────────────────────────────────────────

#: Each passport/client.ts schema name in the vectors and the Python validator for it.
PASSPORT_VALIDATORS = {
    "capabilities": passport_module._capabilities,
    "connectionList": passport_module._connection_list,
    "createdConnection": passport_module._created_connection,
    "deletedConnection": passport_module._deleted_connection,
    "fetchResult": passport_module._fetch_result,
    "loginFlow": passport_module._login_flow,
    "profileList": passport_module._profile_list,
    "usageReport": passport_module._usage_report,
}


def test_passport_vectors_cover_every_validator_both_ways():
    seen = {(vector["schema"], vector["accepted"]) for vector in VECTORS["passportReplies"]}
    assert seen == {(name, verdict) for name in PASSPORT_VALIDATORS for verdict in (True, False)}


@pytest.mark.parametrize(
    "vector", VECTORS["passportReplies"], ids=lambda v: f"{v['schema']}-{json.dumps(v['body'])[:40]}"
)
def test_passport_replies_decode_like_the_typescript_schemas(vector):
    validate = PASSPORT_VALIDATORS[vector["schema"]]
    if vector["accepted"]:
        assert validate(vector["body"]) is vector["body"]
    else:
        with pytest.raises(TypeError):
            validate(vector["body"])
