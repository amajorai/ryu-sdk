"""The engine's request side: auth headers, idempotency keys, capability probes and building
the wire request (transport rules 2, 3 and 5)."""

from __future__ import annotations

import contextlib
import json
from collections.abc import Mapping
from typing import Any, Callable, Optional, Union

import httpx

from ..._transport import join_url
from .._service_titles import service_title
from ..config import ResolvedConfig
from ..errors import RyuConfigurationError, RyuInvalidRequestError, redact_url
from ..transport import SERVICE_ROUTES, new_idempotency_key
from .client_state import ClientState
from .constants import (
    _CREDENTIAL_HEADERS,
    CAPABILITY_AUTH_FAILURE_TTL_S,
    CAPABILITY_PROBE_TIMEOUT_S,
    CAPABILITY_TTL_S,
    DEFAULT_ACCEPT,
)
from .steps import CallContext, Request, _Send, _SharedProbe, normalize_timeout
from .wire import _json_default, wire_header_name, wire_header_value


class EngineBase:
    """The request side of :class:`~ryu_sdk.services._runtime.engine.Engine`."""

    def __init__(self, owner: ClientState, config: ResolvedConfig) -> None:
        self.owner = owner
        self.config = config
        self.routes = SERVICE_ROUTES[config.service]
        self.service = config.service

    # ── helpers ──

    def _hook(self, name: str, event: dict[str, Any]) -> None:
        hook = self.owner.hooks.get(name)
        if hook is None:
            return
        # Hooks are observers and must not fail the request.
        with contextlib.suppress(Exception):
            hook(event)

    def _apply_auth(self, headers: dict[str, str], override: Optional[str]) -> None:
        existing_api_key = headers.get("x-api-key")
        for name in _CREDENTIAL_HEADERS:
            headers.pop(name, None)
        config = self.config
        if config.auth == "x-gateway-key":
            key = override or config.api_key
            if key:
                headers["x-gateway-key"] = key
        elif config.auth == "x-api-key":
            key = existing_api_key or override or config.api_key
            if key:
                headers["x-api-key"] = key
            if config.organization_id:
                headers["x-ryu-organization"] = config.organization_id
        else:
            key = override or config.api_key
            if key:
                headers["authorization"] = f"Bearer {key}"

    def _choose_key(
        self,
        headers: dict[str, str],
        route: Any,
        ctx: CallContext,
        supported: bool = True,
    ) -> Optional[str]:
        """Rule 5: a caller key (bound or a header) is sent on any matched route; an SDK-generated
        key only when the route is ``supported`` (a capability-gated route whose capability is
        false or unknown is not)."""
        existing = headers.get("idempotency-key")
        if route is None:
            return existing
        key = existing
        if ctx.options.idempotency_key and not ctx.caller_key_used:
            if ctx.bound_key is not None and ctx.bound_key.get("spent"):
                raise RyuConfigurationError(
                    f"{service_title(self.service)}: the idempotency key bound with with_options(idempotency_key=...) was already "
                    "used by a write through this namespace, and the server would answer this write with that write's "
                    "stored result. Bind a new key per operation; to retry the same operation, call "
                    "with_options(idempotency_key=...) again.",
                    service=self.service,
                    code="idempotency_key_reused",
                )
            key = ctx.options.idempotency_key
            ctx.caller_key_used = True
            if ctx.bound_key is not None:
                ctx.bound_key["spent"] = True
        elif key is None and supported and (self.owner.auto_idempotency or route.required):
            # A route whose server rejects a keyless write (`required`) always gets one,
            # as the TypeScript clients do even with autoIdempotency: false.
            key = new_idempotency_key()
        if key is not None:
            headers["idempotency-key"] = key
        return key

    def _would_send_key(self, headers: dict[str, str], ctx: CallContext) -> bool:
        """Whether a keyed route would carry an ``Idempotency-Key`` for this request."""
        return (
            "idempotency-key" in headers
            or (bool(ctx.options.idempotency_key) and not ctx.caller_key_used)
            or self.owner.auto_idempotency
        )

    def _capability(self, name: str) -> Any:
        """Generator: whether the server advertises feature ``name`` (``True`` only).

        The answer comes from the instance's cache (keyed by service and base URL) or
        a fresh probe; on ``AsyncRyu`` concurrent cold-cache calls share one in-flight
        probe. A successful probe and a 404/405 (no capabilities route, so an
        older build) are cached for :data:`CAPABILITY_TTL_S`, a 401/403 for
        :data:`CAPABILITY_AUTH_FAILURE_TTL_S`; any other failure answers ``False``
        for this call only, so the caller fails closed and a later call probes again.
        """
        probe = self.owner.capability_probes.get(self.service)
        if probe is None:
            return False
        cache = self.owner.capability_cache
        cache_key = f"{self.service} {self.config.base_url}"
        cached = cache.get(cache_key)
        if cached is not None and cached[0] > self.owner.now():
            features = cached[1]
        else:
            features, ttl = yield _SharedProbe(cache_key, self._probe_capabilities(probe))
            if ttl is None:
                cache.pop(cache_key, None)
            else:
                cache[cache_key] = (self.owner.now() + ttl, features)
        return isinstance(features, dict) and features.get(name) is True

    def _probe_capabilities(self, probe: Callable[[ResolvedConfig], Optional[Request]]) -> Any:
        """Generator: ``(features or None, ttl or None)`` from one capability read.

        SDK-internal, as in TypeScript: no hooks, no retries, no per-call options or
        response metadata, and its own timeout of at most :data:`CAPABILITY_PROBE_TIMEOUT_S`.
        """
        request = probe(self.config)
        if request is None:
            return None, None
        owner = self.owner
        headers = dict(request.headers)
        self._apply_auth(headers, request.auth)
        headers.setdefault("accept", DEFAULT_ACCEPT)
        if owner.user_agent:
            headers["user-agent"] = owner.user_agent
        instance_timeout = normalize_timeout(owner.timeout)
        timeout = httpx.Timeout(
            CAPABILITY_PROBE_TIMEOUT_S
            if instance_timeout is None
            else min(instance_timeout, CAPABILITY_PROBE_TIMEOUT_S)
        )
        url = join_url(self.config.base_url, request.path)
        outcome = yield _Send(
            self._build(request.method, url, headers, None, timeout),
            False,
            timeout,
        )
        response = outcome.response
        if response is None:
            return None, None
        status = response.status_code
        if response.is_success:
            try:
                value = json.loads(response.content or b"null")
                features = request.decode(value) if request.decode is not None else value
            except (KeyError, TypeError, ValueError, AttributeError):
                return None, None
            return (features, CAPABILITY_TTL_S) if isinstance(features, dict) else (None, None)
        if status in (404, 405):
            return None, CAPABILITY_TTL_S
        if status in (401, 403):
            return None, CAPABILITY_AUTH_FAILURE_TTL_S
        return None, None

    def _build(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        content: Optional[bytes],
        timeout: Optional[httpx.Timeout],
    ) -> httpx.Request:
        """``owner.build_request`` with the headers in their wire form (:func:`wire_header_value`):
        a header ``fetch`` would refuse fails as a typed ``invalid_request_header``, never a raw
        ``UnicodeEncodeError``, so object mode still returns a :class:`Result`."""
        wire: dict[str, Union[str, bytes]] = {}
        for name, value in headers.items():
            encoded = wire_header_name(name), wire_header_value(value)
            if encoded[0] is None or encoded[1] is None:
                raise RyuInvalidRequestError(
                    f"{service_title(self.service)}: header {name!r} has an invalid value: header names are ASCII "
                    "tokens and values are Latin-1 text without CR, LF or NUL.",
                    service=self.service,
                    code="invalid_request_header",
                    method=method,
                    url=redact_url(url),
                    details={"header": name if isinstance(name, str) else repr(name)},
                    retryable=False,
                )
            wire[encoded[0]] = encoded[1]
        return self.owner.build_request(method, url, wire, content, timeout)

    def _encode_json(self, body: Any, method: str, url: str) -> bytes:
        """``body`` as JSON; ``datetime``/``date`` become ISO 8601 strings (as ``JSON.stringify`` does
        for a ``Date``), and any other value JSON cannot hold fails as a typed error, never a raw
        ``TypeError``, so object mode still returns a :class:`Result`."""
        try:
            return json.dumps(body, default=_json_default).encode("utf-8")
        except (TypeError, ValueError) as error:
            raised = RyuInvalidRequestError(
                f"{service_title(self.service)}: the {method} body is not JSON-serializable: {error}",
                service=self.service,
                code="invalid_request_body",
                method=method,
                url=url,
                retryable=False,
            )
            raised.__cause__ = error
            raise raised from error
