"""The engine for one resolved service: the HTTP step that applies the transport rules."""

from __future__ import annotations

import math
from typing import Any, Optional

import httpx

from ..._transport import clean_params, join_url
from .._service_titles import service_title
from ..errors import (
    RyuRedirectError,
    copy_ryu_error,
    message_without_hint,
    parse_error_response,
    redact_url,
)
from ..transport import (
    RetryHints,
    compute_delay,
    is_replay_safe,
    is_retryable_failure,
    match_capability_route,
    match_non_replay_safe_route,
    match_route,
    origin_of,
    parse_retry_after,
    relative_service_path,
    should_retry,
)
from .constants import _CREDENTIAL_HEADERS, _NO_BODY, DEFAULT_ACCEPT
from .engine_responses import EngineResponses
from .steps import CallContext, Request, Sleep, _Send, normalize_timeout
from .wire import _json_body, _location_origin


class Engine(EngineResponses):
    """The transport for one resolved service of one ``Ryu`` instance."""

    def http(self, request: Request, ctx: CallContext, stream: bool = False) -> Any:
        """Generator: sends ``request`` under the transport rules and returns its decoded value
        (or the open ``httpx.Response`` when ``stream``)."""
        config = self.config
        owner = self.owner
        base_url = request.url or join_url(config.base_url, request.path)
        url = str(httpx.URL(base_url, params=clean_params(request.params))) if request.params else base_url
        method = request.method
        headers = dict(request.headers)
        content = request.content
        if request.json is not _NO_BODY:
            content = self._encode_json(request.json, method, base_url)
            headers.setdefault("content-type", "application/json")
        timeout_s = normalize_timeout(ctx.options.timeout if ctx.options.timeout is not None else owner.timeout)

        service_origin = origin_of(config.base_url)
        if service_origin is None or origin_of(url) != service_origin:
            # Rule 1: another origin gets the bare request, minus any credential.
            for name in _CREDENTIAL_HEADERS:
                headers.pop(name, None)
            bare_timeout = httpx.Timeout(timeout_s)
            outcome = yield _Send(
                self._build(method, url, headers, content, bare_timeout),
                False,
                bare_timeout,
            )
            if outcome.response is None:
                raise self._transport_error(outcome, method, url, 1, None, timeout_s)
            response = outcome.response
            if not response.is_success:
                raise parse_error_response(
                    self.service,
                    response.status_code,
                    response.headers,
                    response.content,
                    method,
                    url,
                )
            return response if stream else self._decode(request, response, method, url)

        path = relative_service_path(config.base_url, self.routes.mount, url)
        self._apply_auth(headers, request.auth)
        headers.setdefault("accept", DEFAULT_ACCEPT)
        if owner.user_agent:
            headers["user-agent"] = owner.user_agent
        for name, value in ctx.options.headers.items():
            headers[name.lower()] = value
        route: Any = match_route(self.routes, config.base_url, method, url)
        supported = route is not None
        if route is None:
            gated = match_capability_route(self.routes, config.base_url, method, url)
            if gated is not None and self._would_send_key(headers, ctx):
                # A capability-gated route whose capability is false or unknown still
                # forwards a caller key, but gets no SDK key and is never replayed.
                route = gated
                supported = yield from self._capability(gated.capability)
        key = self._choose_key(headers, route, ctx, supported)
        is_stream = stream or "text/event-stream" in headers.get("accept", "")
        replay_safe = match_non_replay_safe_route(self.routes, config.base_url, method, url) is None and is_replay_safe(
            method, supported and route is not None and key is not None
        )
        max_attempts = 1 if is_stream else 1 + max(0, owner.max_retries)
        timeout = httpx.Timeout(timeout_s, read=None) if is_stream else httpx.Timeout(timeout_s)
        redacted = redact_url(url)

        attempt = 0
        while True:
            attempt += 1
            event = {
                "attempt": attempt,
                "method": method,
                "service": self.service,
                "url": redacted,
            }
            self._hook("on_request", event)
            started = owner.now()
            outcome = yield _Send(
                self._build(method, url, headers, content, timeout),
                is_stream,
                timeout,
            )
            failed_response: Optional[httpx.Response] = None
            hints = RetryHints()
            if outcome.response is None:
                failure = self._transport_error(outcome, method, url, attempt, key, timeout_s)
            else:
                response = outcome.response
                self._hook(
                    "on_response",
                    dict(
                        event,
                        duration_ms=round((owner.now() - started) * 1000),
                        request_id=response.headers.get("x-request-id"),
                        status=response.status_code,
                    ),
                )
                if response.is_success:
                    self._record(ctx, response, attempt, key, route, path, method, url, is_stream)
                    return response if is_stream else self._decode(request, response, method, url)
                if 300 <= response.status_code < 400:
                    self._record(ctx, response, attempt, key, route, path, method, url, is_stream)
                    raise RyuRedirectError(
                        f"{service_title(self.service)}: {method} was redirected ({response.status_code}); the SDK never follows "
                        "redirects, so check the base URL.",
                        service=self.service,
                        status=response.status_code,
                        details={"location": _location_origin(response, url)},
                        envelope="empty",
                        method=method,
                        url=url,
                        idempotency_key=key,
                        attempts=attempt,
                        request_id=response.headers.get("x-request-id"),
                    )
                failure = parse_error_response(
                    self.service,
                    response.status_code,
                    response.headers,
                    response.content,
                    method,
                    url,
                    attempts=attempt,
                    idempotency_key=key,
                )
                refine = owner.refiners.get(self.service)
                refined = refine(failure.status, message_without_hint(failure)) if refine is not None else None
                if refined is not None and refined != failure.code:
                    failure = copy_ryu_error(
                        failure,
                        code=refined,
                        retryable=is_retryable_failure(failure.status, refined),
                    )
                refine_error = owner.error_refiners.get(self.service)
                if refine_error is not None:
                    failure = refine_error(failure, _json_body(response.content))
                header_retry_after = parse_retry_after(response.headers.get("retry-after"))
                rate_limit = failure.rate_limit
                hints = RetryHints(
                    retry_after_seconds=header_retry_after,
                    rate_limit_remaining=rate_limit.remaining if rate_limit else None,
                    rate_limit_reset_seconds=rate_limit.reset_seconds if rate_limit else None,
                    body_retry_after_seconds=failure.retry_after_seconds if header_retry_after is None else None,
                )
                failed_response = response

            retry = (
                attempt < max_attempts
                and failure.retryable
                and should_retry(failure.status, failure.code, hints, replay_safe=replay_safe)
            )
            delay: Optional[tuple[float, str]] = compute_delay(attempt - 1, hints, owner.random) if retry else None
            if delay is not None and delay[0] <= owner.max_retry_delay:
                self._hook(
                    "on_retry",
                    dict(
                        event,
                        code=failure.code,
                        delay_ms=round(delay[0] * 1000),
                        status=failure.status,
                    ),
                )
                yield Sleep(delay[0])
                continue
            if delay is not None and delay[1] != "backoff" and failure.retry_after_seconds is None:
                # The server asked for a longer wait than max_retry_delay: surface it instead.
                failure = copy_ryu_error(failure, retry_after_seconds=math.ceil(delay[0]))
            if failed_response is not None:
                convert = owner.response_errors.get(self.service)
                if convert is not None:
                    # A service whose TypeScript client raises its own error type
                    # (Managed Agents) reports the reply the way that type does.
                    failure = convert(failure, failed_response, self.config)
                self._record(
                    ctx,
                    failed_response,
                    attempt,
                    key,
                    route,
                    path,
                    method,
                    url,
                    is_stream,
                )
                ctx.last_failure = failure
            raise failure
