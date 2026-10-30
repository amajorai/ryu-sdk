"""Route rules ported from @ryuhq/services: capability-gated idempotency (Passport
``POST /v1/connections``), non-replay-safe writes (Messaging ``PUT .../settings``),
credential-free Messaging ``status()``, and Gateway ``error.upstream_status``.

Each test names the TypeScript test it mirrors in ``packages/services/src``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from ryu_sdk.services import AsyncRyu, Ryu, RyuConfigurationError, transport
from ryu_sdk.services._runtime import (
    CAPABILITY_AUTH_FAILURE_TTL_S,
    CAPABILITY_PROBE_TIMEOUT_S,
    CAPABILITY_TTL_S,
    MAX_REFINE_BODY_BYTES,
)
from ryu_sdk.services.errors import create_ryu_error
from ryu_sdk.services.gateway import gateway_upstream_status, refine_gateway_error

PASSPORT_URL = "https://passport.example.com"
PASSPORT_ENV = {"RYU_PASSPORT_URL": PASSPORT_URL, "RYU_PASSPORT_API_KEY": "admin"}
#: A ``passportCreatedConnectionSchema`` reply: the create is validated like TypeScript.
CONNECTION = {
    "connection": {
        "created_at": 1_760_000_000,
        "domain": "api.github.com",
        "flow_status": "IDLE",
        "id": "conn_1",
        "last_checked": 0,
        "profile_id": "work",
        "source": "manual",
        "status": "NEEDS_AUTH",
        "updated_at": 1_760_000_000,
    }
}
CREATE = {"profile_id": "work", "domain": "api.github.com"}


class Server:
    """Answers ``"METHOD /path"`` from queued answers (the last one repeats) and records requests."""

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
        if isinstance(answer, Exception):
            raise answer
        return answer(request) if callable(answer) else answer

    def sent(self, key: str) -> list[httpx.Request]:
        method, path = key.split(" ", 1)
        return [request for request in self.requests if request.method == method and request.url.path == path]

    def ryu(self, env: dict[str, str], **options: Any) -> Ryu:
        ryu = Ryu(env=env, transport=httpx.MockTransport(self), **options)
        clock = {"now": 1000.0}
        ryu._core.sleep = lambda seconds: None  # type: ignore[assignment]
        ryu._core.now = lambda: clock["now"]
        ryu.clock = clock  # type: ignore[attr-defined]
        return ryu


def capabilities(features: Any) -> httpx.Response:
    return httpx.Response(200, json={"service": "passport", "features": features})


def created() -> httpx.Response:
    return httpx.Response(201, json=CONNECTION)


def unavailable() -> httpx.Response:
    return httpx.Response(503, json={"code": "service_unavailable", "message": "busy"})


# ── route tables ─────────────────────────────────────────────────────────────


def test_capability_and_non_replay_safe_routes_match_like_typescript():
    passport = transport.SERVICE_ROUTES["passport"]
    gated = transport.match_capability_route(passport, PASSPORT_URL, "post", f"{PASSPORT_URL}/v1/connections")
    assert gated is not None and gated.capability == "idempotency_keys" and gated.required is False
    # A gated route is never a plain idempotent route, and only POST/PATCH can match.
    assert transport.match_route(passport, PASSPORT_URL, "POST", f"{PASSPORT_URL}/v1/connections") is None
    assert transport.match_capability_route(passport, PASSPORT_URL, "GET", f"{PASSPORT_URL}/v1/connections") is None
    assert (
        transport.match_capability_route(passport, PASSPORT_URL, "POST", f"{PASSPORT_URL}/v1/connections/c/login")
        is None
    )

    messaging = transport.SERVICE_ROUTES["messaging"]
    base = "https://api.ryuhq.com"
    route = transport.match_non_replay_safe_route(messaging, base, "PUT", f"{base}/api/messaging/orgs/org_1/settings")
    assert route is not None and route.path == "/orgs/{orgId}/settings" and "webhook secret" in route.reason
    assert (
        transport.match_non_replay_safe_route(messaging, base, "GET", f"{base}/api/messaging/orgs/o/settings") is None
    )
    assert (
        transport.match_non_replay_safe_route(messaging, base, "DELETE", f"{base}/api/messaging/orgs/o/opt-outs/x")
        is None
    )
    assert (
        transport.match_non_replay_safe_route(
            messaging,
            base,
            "PUT",
            "https://other.example.com/api/messaging/orgs/o/settings",
        )
        is None
    )


def test_sites_expected_revision_writes_are_never_replayed_like_typescript():
    sites = transport.SERVICE_ROUTES["sites"]
    base = "http://localhost:8021"
    put = transport.match_non_replay_safe_route(sites, base, "PUT", f"{base}/api/sites/projects/site_1/settings")
    assert put is not None and put.path == "/projects/{id}/settings" and "expectedRevision" in put.reason
    delete = transport.match_non_replay_safe_route(sites, base, "DELETE", f"{base}/api/sites/projects/site_1")
    assert delete is not None and delete.path == "/projects/{id}"
    for method, path in (
        ("GET", "/api/sites/projects/site_1"),
        ("GET", "/api/sites/projects/site_1/settings"),
        ("DELETE", "/api/sites/projects/site_1/settings"),
    ):
        assert transport.match_non_replay_safe_route(sites, base, method, f"{base}{path}") is None


# ── Passport: capability-gated create key (passport.test.ts, fetch-shim.test.ts) ──


def test_a_capable_passport_gets_a_generated_key_and_a_keyed_retry():
    server = Server(
        {
            "GET /v1/capabilities": capabilities({"idempotency_keys": True}),
            "POST /v1/connections": [unavailable(), created()],
        }
    )
    events: list[dict[str, Any]] = []
    ryu = server.ryu(PASSPORT_ENV, result="object", hooks={"on_request": events.append})
    data, error, meta = ryu.passport.connections.create(CREATE)
    assert error is None and data == CONNECTION
    creates = server.sent("POST /v1/connections")
    keys = [request.headers.get("idempotency-key") for request in creates]
    assert len(keys) == 2 and keys[0] is not None and keys[0] == keys[1]
    assert meta.idempotency_key == keys[0] and meta.attempts == 2
    # The probe is SDK-internal: sent with the administration key, unseen by hooks.
    probe = server.sent("GET /v1/capabilities")[0]
    assert probe.headers["authorization"] == "Bearer admin"
    assert all("/v1/capabilities" not in event["url"] for event in events)
    assert server.requests[0].url.path == "/v1/capabilities"


def test_the_capability_answer_is_cached_per_instance_for_five_minutes():
    server = Server(
        {
            "GET /v1/capabilities": capabilities({"idempotency_keys": True}),
            "POST /v1/connections": created(),
        }
    )
    ryu = server.ryu(PASSPORT_ENV)
    ryu.passport.connections.create(CREATE)
    ryu.passport.connections.create(CREATE)
    assert len(server.sent("GET /v1/capabilities")) == 1
    ryu.clock["now"] += CAPABILITY_TTL_S + 1  # type: ignore[attr-defined]
    ryu.passport.connections.create(CREATE)
    assert len(server.sent("GET /v1/capabilities")) == 2
    # Another instance has its own cache.
    server.ryu(PASSPORT_ENV).passport.connections.create(CREATE)
    assert len(server.sent("GET /v1/capabilities")) == 3


@pytest.mark.parametrize(
    "features",
    [{"idempotency_keys": False}, {}, {"idempotency_keys": "true"}],
    ids=["false", "absent", "non-boolean"],
)
def test_without_the_capability_the_create_has_no_key_and_is_not_retried(features):
    server = Server(
        {
            "GET /v1/capabilities": capabilities(features),
            "POST /v1/connections": unavailable(),
        }
    )
    error = server.ryu(PASSPORT_ENV, result="object").passport.connections.create(CREATE).error
    assert error.status == 503
    creates = server.sent("POST /v1/connections")
    assert len(creates) == 1 and "idempotency-key" not in creates[0].headers


def test_other_feature_values_never_turn_keyed_creates_off():
    server = Server(
        {
            "GET /v1/capabilities": capabilities({"idempotency_keys": True, "future": {"nested": [1]}}),
            "POST /v1/connections": created(),
        }
    )
    server.ryu(PASSPORT_ENV).passport.connections.create(CREATE)
    assert "idempotency-key" in server.sent("POST /v1/connections")[0].headers


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(500, json={"code": "internal_error", "message": "x"}),
        httpx.ConnectError("refused"),
        httpx.Response(200, json={"features": ["idempotency_keys"]}),
        httpx.Response(200, text="not json"),
        httpx.Response(302, headers={"location": "https://elsewhere.example.com/"}),
    ],
    ids=["5xx", "network", "features-not-object", "not-json", "redirect"],
)
def test_a_failed_probe_fails_closed_and_is_not_cached(answer):
    server = Server({"GET /v1/capabilities": answer, "POST /v1/connections": created()})
    ryu = server.ryu(PASSPORT_ENV)
    ryu.passport.connections.create(CREATE)
    ryu.passport.connections.create(CREATE)
    assert len(server.sent("GET /v1/capabilities")) == 2
    assert all("idempotency-key" not in request.headers for request in server.sent("POST /v1/connections"))


@pytest.mark.parametrize(
    ("status", "ttl"),
    [
        (404, CAPABILITY_TTL_S),
        (405, CAPABILITY_TTL_S),
        (401, CAPABILITY_AUTH_FAILURE_TTL_S),
        (403, CAPABILITY_AUTH_FAILURE_TTL_S),
    ],
)
def test_no_route_and_auth_failures_are_cached_as_no_features(status, ttl):
    server = Server(
        {
            "GET /v1/capabilities": httpx.Response(status, json={"error": "x", "code": "x"}),
            "POST /v1/connections": created(),
        }
    )
    ryu = server.ryu(PASSPORT_ENV)
    ryu.passport.connections.create(CREATE)
    ryu.passport.connections.create(CREATE)
    assert len(server.sent("GET /v1/capabilities")) == 1
    ryu.clock["now"] += ttl + 1  # type: ignore[attr-defined]
    ryu.passport.connections.create(CREATE)
    assert len(server.sent("GET /v1/capabilities")) == 2
    assert all("idempotency-key" not in request.headers for request in server.sent("POST /v1/connections"))


def test_a_caller_key_is_always_sent_once_and_spent_without_the_capability():
    server = Server(
        {
            "GET /v1/capabilities": capabilities({}),
            "POST /v1/connections": unavailable(),
        }
    )
    bound = server.ryu(PASSPORT_ENV, result="object").passport.with_options(idempotency_key="stable")
    error = bound.connections.create(CREATE).error
    creates = server.sent("POST /v1/connections")
    assert error.status == 503 and len(creates) == 1 and creates[0].headers["idempotency-key"] == "stable"
    reused = bound.connections.create(CREATE).error
    assert isinstance(reused, RyuConfigurationError) and reused.code == "idempotency_key_reused"


def test_a_caller_key_survives_a_failed_probe_so_a_manual_retry_is_deduplicated():
    server = Server(
        {
            "GET /v1/capabilities": httpx.Response(500, json={"code": "internal_error", "message": "x"}),
            "POST /v1/connections": [unavailable(), created()],
        }
    )
    ryu = server.ryu(PASSPORT_ENV, result="object")
    assert ryu.passport.with_options(idempotency_key="stable").connections.create(CREATE).error.status == 503
    assert ryu.passport.with_options(idempotency_key="stable").connections.create(CREATE).error is None
    assert [request.headers["idempotency-key"] for request in server.sent("POST /v1/connections")] == [
        "stable",
        "stable",
    ]


def test_a_raw_idempotency_key_header_is_forwarded():
    server = Server({"GET /v1/capabilities": capabilities({}), "POST /v1/connections": created()})
    ryu = server.ryu(PASSPORT_ENV, auto_idempotency=False)
    ryu.passport.with_options(headers={"Idempotency-Key": "raw-1"}).connections.create(CREATE)
    assert server.sent("POST /v1/connections")[0].headers["idempotency-key"] == "raw-1"
    assert len(server.sent("GET /v1/capabilities")) == 1


def test_no_probe_runs_when_no_key_would_be_sent():
    server = Server(
        {
            "GET /v1/capabilities": capabilities({"idempotency_keys": True}),
            "POST /v1/connections": created(),
        }
    )
    server.ryu(PASSPORT_ENV, auto_idempotency=False).passport.connections.create(CREATE)
    assert server.sent("GET /v1/capabilities") == []
    assert "idempotency-key" not in server.sent("POST /v1/connections")[0].headers
    # Other writes never probe.
    server.routes["POST /v1/connections/conn_1/login"] = [
        httpx.Response(200, json={"flow_id": "flow_1", "kind": {"kind": "hosted", "url": "https://x"}})
    ]
    server.ryu(PASSPORT_ENV).passport.connections.login("conn_1")
    assert server.sent("GET /v1/capabilities") == []


@pytest.mark.parametrize(
    ("instance", "expected"),
    [
        (60.0, CAPABILITY_PROBE_TIMEOUT_S),
        (2.0, 2.0),
        (None, CAPABILITY_PROBE_TIMEOUT_S),
    ],
)
def test_the_probe_has_its_own_short_timeout_and_ignores_the_call_timeout(instance, expected):
    server = Server({"GET /v1/capabilities": capabilities({}), "POST /v1/connections": created()})
    ryu = server.ryu(PASSPORT_ENV, timeout=instance)
    ryu.passport.with_options(timeout=120).connections.create(CREATE)
    probe = server.sent("GET /v1/capabilities")[0]
    assert probe.extensions["timeout"]["read"] == expected
    assert server.sent("POST /v1/connections")[0].extensions["timeout"]["read"] == 120


def test_the_probe_does_not_change_the_call_meta():
    server = Server(
        {
            "GET /v1/capabilities": httpx.Response(
                200,
                headers={"x-request-id": "probe-req"},
                json={"features": {"idempotency_keys": True}},
            ),
            "POST /v1/connections": httpx.Response(201, headers={"x-request-id": "create-req"}, json=CONNECTION),
        }
    )
    meta = server.ryu(PASSPORT_ENV, result="object").passport.connections.create(CREATE).meta
    assert meta.request_id == "create-req" and meta.attempts == 1


def slow(answer: Any, delay: float = 0.02) -> Any:
    """An async MockTransport answer that holds the request open so concurrent callers overlap."""

    async def respond(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(delay)
        if isinstance(answer, Exception):
            raise answer
        return answer

    return respond


def async_ryu(server: Server, env: dict[str, str] = PASSPORT_ENV, **options: Any) -> AsyncRyu:
    ryu = AsyncRyu(env=env, transport=httpx.MockTransport(server), **options)

    async def no_sleep(_seconds: float) -> None:
        return None

    ryu._core.sleep = no_sleep  # type: ignore[assignment]
    return ryu


def test_async_concurrent_cold_cache_creates_share_one_probe():
    server = Server(
        {
            "GET /v1/capabilities": slow(capabilities({"idempotency_keys": True})),
            "POST /v1/connections": created(),
        }
    )

    async def run() -> Any:
        ryu = async_ryu(server)
        try:
            await asyncio.gather(*(ryu.passport.connections.create(CREATE) for _ in range(5)))
            assert ryu._core.capability_pending == {}
        finally:
            await ryu.aclose()

    asyncio.run(run())
    assert len(server.sent("GET /v1/capabilities")) == 1
    creates = server.sent("POST /v1/connections")
    assert len(creates) == 5 and all("idempotency-key" in request.headers for request in creates)


def test_async_a_bad_key_costs_one_failed_authentication_for_concurrent_creates():
    server = Server(
        {
            "GET /v1/capabilities": slow(httpx.Response(401, json={"code": "unauthorized", "message": "x"})),
            "POST /v1/connections": created(),
        }
    )

    async def run() -> None:
        ryu = async_ryu(server)
        try:
            await asyncio.gather(*(ryu.passport.connections.create(CREATE) for _ in range(5)))
            await ryu.passport.connections.create(CREATE)
        finally:
            await ryu.aclose()

    asyncio.run(run())
    assert len(server.sent("GET /v1/capabilities")) == 1
    assert all("idempotency-key" not in request.headers for request in server.sent("POST /v1/connections"))


def test_async_a_failed_shared_probe_fails_every_waiter_closed_and_is_not_cached():
    server = Server(
        {
            "GET /v1/capabilities": slow(httpx.ConnectError("down")),
            "POST /v1/connections": created(),
        }
    )

    async def run() -> None:
        ryu = async_ryu(server)
        try:
            await asyncio.gather(*(ryu.passport.connections.create(CREATE) for _ in range(3)))
            await ryu.passport.connections.create(CREATE)
        finally:
            await ryu.aclose()

    asyncio.run(run())
    assert len(server.sent("GET /v1/capabilities")) == 2
    creates = server.sent("POST /v1/connections")
    assert len(creates) == 4 and all("idempotency-key" not in request.headers for request in creates)


def test_async_cancelling_the_probing_call_does_not_cancel_the_waiters():
    server = Server(
        {
            "GET /v1/capabilities": slow(capabilities({"idempotency_keys": True}), delay=0.05),
            "POST /v1/connections": created(),
        }
    )

    async def run() -> None:
        ryu = async_ryu(server)
        try:
            leader = asyncio.ensure_future(ryu.passport.connections.create(CREATE))
            await asyncio.sleep(0.01)
            followers = [asyncio.ensure_future(ryu.passport.connections.create(CREATE)) for _ in range(2)]
            await asyncio.sleep(0.01)
            leader.cancel()
            results = await asyncio.gather(*followers)
            assert [result["connection"]["id"] for result in results] == ["conn_1", "conn_1"]
            with pytest.raises(asyncio.CancelledError):
                await leader
            assert ryu._core.capability_pending == {}
            assert ryu._core.capability_cache == {}
        finally:
            await ryu.aclose()

    asyncio.run(run())
    assert len(server.sent("GET /v1/capabilities")) == 1
    creates = server.sent("POST /v1/connections")
    assert len(creates) == 2 and all("idempotency-key" not in request.headers for request in creates)


def test_async_probes_are_shared_per_instance_only():
    server = Server(
        {
            "GET /v1/capabilities": slow(capabilities({"idempotency_keys": True})),
            "POST /v1/connections": created(),
        }
    )

    async def run() -> None:
        first, second = async_ryu(server), async_ryu(server)
        try:
            await asyncio.gather(*(ryu.passport.connections.create(CREATE) for ryu in (first, first, second, second)))
        finally:
            await first.aclose()
            await second.aclose()

    asyncio.run(run())
    assert len(server.sent("GET /v1/capabilities")) == 2


def test_async_passport_probes_and_keys_the_create():
    server = Server(
        {
            "GET /v1/capabilities": capabilities({"idempotency_keys": True}),
            "POST /v1/connections": [unavailable(), created()],
        }
    )

    async def run() -> Any:
        ryu = AsyncRyu(env=PASSPORT_ENV, transport=httpx.MockTransport(server), result="object")

        async def no_sleep(_seconds: float) -> None:
            return None

        ryu._core.sleep = no_sleep  # type: ignore[assignment]
        try:
            return await ryu.passport.connections.create(CREATE)
        finally:
            await ryu.aclose()

    result = asyncio.run(run())
    assert result.error is None and result.meta.attempts == 2
    keys = {request.headers.get("idempotency-key") for request in server.sent("POST /v1/connections")}
    assert len(keys) == 1 and None not in keys


# ── Messaging: non-replay-safe settings, credential-free status (messaging.test.ts) ──

MESSAGING_ENV = {"RYU_API_KEY": "ryu_key", "RYU_ORGANIZATION_ID": "org_1"}
SETTINGS = "PUT /api/messaging/orgs/org_1/settings"


def test_settings_update_is_never_replayed_after_a_5xx_or_network_error():
    server = Server({SETTINGS: unavailable()})
    error = server.ryu(MESSAGING_ENV, result="object").messaging.settings.update({"webhookUrl": "https://x"}).error
    assert error.status == 503 and len(server.sent(SETTINGS)) == 1
    server = Server({SETTINGS: httpx.ConnectError("reset")})
    error = server.ryu(MESSAGING_ENV, result="object").messaging.settings.update({"webhookUrl": "https://x"}).error
    assert error.status == 0 and len(server.sent(SETTINGS)) == 1


def test_settings_update_is_still_retried_on_a_429_that_names_a_wait():
    server = Server(
        {
            SETTINGS: [
                httpx.Response(
                    429,
                    headers={"retry-after": "1"},
                    json={"error": "rate_limited", "message": "slow"},
                ),
                httpx.Response(200, json={"settings": {}, "webhookSecret": "whsec_1"}),
            ]
        }
    )
    data = server.ryu(MESSAGING_ENV).messaging.settings.update({"webhookUrl": "https://x"})
    assert data["webhookSecret"] == "whsec_1" and len(server.sent(SETTINGS)) == 2


def test_opt_out_remove_is_still_retried_as_an_idempotent_delete():
    key = "DELETE /api/messaging/orgs/org_1/opt-outs/+6591234567"
    server = Server({key: [unavailable(), httpx.Response(204)]})
    server.ryu(MESSAGING_ENV).messaging.opt_outs.remove("+6591234567")
    assert len(server.requests) == 2


@pytest.mark.parametrize(
    "env",
    [{}, {"RYU_API_KEY": "ryu_key"}, {"RYU_ORGANIZATION_ID": "org_1"}],
    ids=["none", "key-only", "org-only"],
)
def test_status_runs_without_credentials_and_sends_neither(env):
    server = Server({"GET /api/messaging/status": httpx.Response(200, json={"available": True})})
    assert server.ryu(env).messaging.status() == {"available": True}
    request = server.requests[0]
    assert "x-api-key" not in request.headers and "x-ryu-organization" not in request.headers
    assert str(request.url) == "https://api.ryuhq.com/api/messaging/status"


def test_status_on_a_configured_client_sends_both_and_other_methods_still_need_credentials():
    server = Server(
        {
            "GET /api/messaging/status": httpx.Response(200, json={"available": True}),
            "GET /api/messaging/orgs/org_1/numbers": httpx.Response(200, json={"numbers": []}),
        }
    )
    server.ryu(MESSAGING_ENV).messaging.status()
    assert server.requests[0].headers["x-api-key"] == "ryu_key"
    assert server.requests[0].headers["x-ryu-organization"] == "org_1"

    bare = server.ryu({}, result="object")
    assert bare.messaging.status().error is None
    error = bare.messaging.numbers.list().error
    assert isinstance(error, RyuConfigurationError)
    assert error.details == {"missing": ["RYU_API_KEY", "RYU_ORGANIZATION_ID"]}
    with pytest.raises(RyuConfigurationError):
        server.ryu({}).messaging.settings.get()


def test_status_without_credentials_still_rejects_a_bad_url():
    error = Ryu(env={"RYU_API_URL": "not a url"}, result="object").messaging.status().error
    assert isinstance(error, RyuConfigurationError) and error.code == "invalid_url"


@pytest.mark.parametrize(
    "value", ["127.0.0.1:48721", "localhost:8021", "sites.example.com/x", "[::1]:8021", "LOCALHOST"]
)
def test_a_url_without_its_scheme_names_the_fix_without_echoing_the_value(value: str):
    error = Ryu(env={"RYU_SITES_API_KEY": "s_k", "RYU_SITES_URL": value}, result="object").sites.projects.list().error
    assert isinstance(error, RyuConfigurationError) and error.code == "invalid_url"
    assert error.hint == "Add the scheme, for example http://127.0.0.1:8021 or https://api.example.com."
    assert str(error).endswith(f"Hint: {error.hint}")
    assert value not in str(error) and value not in repr(error.to_dict())


def test_a_url_that_is_not_a_missing_scheme_gets_no_scheme_hint():
    for value in (
        "not a url",
        "nope",
        "ftp://sites.example.com",
        "mailto:x",
        "http:127.0.0.1:8021",
        "http:/127.0.0.1:8021",
    ):
        error = (
            Ryu(env={"RYU_SITES_API_KEY": "s_k", "RYU_SITES_URL": value}, result="object").sites.projects.list().error
        )
        assert isinstance(error, RyuConfigurationError) and error.code == "invalid_url"
        assert error.hint is None


def test_async_status_runs_without_credentials():
    server = Server({"GET /api/messaging/status": httpx.Response(200, json={"available": True})})

    async def run() -> Any:
        ryu = AsyncRyu(env={}, transport=httpx.MockTransport(server))
        try:
            return await ryu.messaging.status()
        finally:
            await ryu.aclose()

    assert asyncio.run(run()) == {"available": True}
    assert "x-api-key" not in server.requests[0].headers


# ── Gateway: error.upstream_status (gateway.test.ts) ────────────────────────


def provider_error(upstream: Any) -> httpx.Response:
    error: dict[str, Any] = {
        "message": "upstream said no",
        "type": "provider_error",
        "code": "provider_error",
    }
    if upstream is not None:
        error["upstream_status"] = upstream
    return httpx.Response(502, json={"error": error})


@pytest.mark.parametrize("upstream", [400, 401, 404, 422])
def test_an_upstream_4xx_is_final_and_exposes_the_status(upstream):
    server = Server({"GET /v1/models": provider_error(upstream)})
    error = server.ryu({}, result="object").gateway.models.list().error
    assert error.status == 502 and error.retryable is False
    assert error.details["upstreamStatus"] == upstream
    assert len(server.requests) == 1


@pytest.mark.parametrize("upstream", [408, 425, 429, 500, 503, None])
def test_a_transient_or_missing_upstream_status_keeps_get_retries(upstream):
    server = Server(
        {
            "GET /v1/models": [
                provider_error(upstream),
                httpx.Response(200, json={"data": []}),
            ]
        }
    )
    assert server.ryu({}).gateway.models.list() == {"data": []}
    assert len(server.requests) == 2


@pytest.mark.parametrize("upstream", [408, 425, 429])
def test_a_transient_upstream_status_is_exposed_but_a_post_is_still_not_replayed(
    upstream,
):
    server = Server({"POST /v1/chat/completions": provider_error(upstream)})
    error = server.ryu({}, result="object").gateway.chat.completions.create(model="m", messages=[]).error
    assert error.retryable is True and error.details["upstreamStatus"] == upstream
    assert len(server.requests) == 1


def test_gateway_upstream_status_reads_only_http_error_statuses():
    assert gateway_upstream_status({"error": {"upstream_status": 404}}) == 404
    assert gateway_upstream_status({"error": {"upstream_status": 404.0}}) == 404
    for body in (
        None,
        [],
        {"error": "x"},
        {"error": {"upstream_status": "404"}},
        {"error": {"upstream_status": True}},
        {"error": {"upstream_status": 399}},
        {"error": {"upstream_status": 600}},
        {"error": {"upstream_status": 404.5}},
    ):
        assert gateway_upstream_status(body) is None


def test_refine_gateway_error_keeps_existing_details_and_the_error_class():
    error = create_ryu_error(
        "x",
        service="gateway",
        status=502,
        code="provider_error",
        details={"provider": "a"},
    )
    refined = refine_gateway_error(error, {"error": {"upstream_status": 403}})
    assert type(refined) is type(error) and refined.details == {
        "provider": "a",
        "upstreamStatus": 403,
    }
    assert refined.retryable is False
    assert refine_gateway_error(error, {"error": {}}) is error


def test_an_oversized_error_body_is_not_refined():
    padding = "x" * MAX_REFINE_BODY_BYTES
    body = {"error": {"message": padding, "code": "provider_error", "upstream_status": 404}}
    server = Server(
        {
            "GET /v1/models": [
                httpx.Response(502, json=body),
                httpx.Response(200, json={"data": []}),
            ]
        }
    )
    assert server.ryu({}).gateway.models.list() == {"data": []}


def test_refiners_only_apply_to_their_service():
    server = Server(
        {
            "GET /v1/connections": [
                provider_error(404),
                httpx.Response(200, json={"connections": []}),
            ]
        }
    )
    server.ryu(PASSPORT_ENV).passport.connections.list()
    assert len(server.requests) == 2
