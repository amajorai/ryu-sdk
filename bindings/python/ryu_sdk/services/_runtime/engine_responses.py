"""The engine's response side: response metadata, decoding, error decoration and the
stream helpers the Managed Agents loop uses (transport rule 8)."""

from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from .._service_titles import service_title
from ..config import default_error_hint, transport_failure_hint
from ..errors import (
    RyuAbortError,
    RyuConfigurationError,
    RyuConnectionError,
    RyuError,
    RyuResponseValidationError,
    RyuTimeoutError,
    redact_url,
    with_ryu_error_fields,
)
from ..result import ResponseMeta
from ..transport import parse_deprecation, read_rate_limit, relative_service_path, route_template
from .constants import _DEPRECATION_SEEN_LIMIT
from .engine_base import EngineBase
from .steps import CallContext, Request, _Outcome, normalize_timeout
from .wire import _joined, _scrub


class EngineResponses(EngineBase):
    """The response side of :class:`~ryu_sdk.services._runtime.engine.Engine`."""

    def _is_replayed(self, response: httpx.Response, route: Any, streaming: bool) -> bool:
        if response.headers.get("idempotent-replayed") == "true":
            return True
        field_name = self.routes.replayed_body_field
        if field_name is None or route is None or streaming or not response.is_success:
            return False
        if "json" not in response.headers.get("content-type", ""):
            return False
        try:
            body = json.loads(response.content or b"null")
        except ValueError:
            return False
        return isinstance(body, dict) and body.get(field_name) == self.routes.replayed_body_value

    def _record(
        self,
        ctx: CallContext,
        response: httpx.Response,
        attempt: int,
        key: Optional[str],
        route: Any,
        path: Optional[str],
        method: str,
        url: str,
        streaming: bool,
    ) -> None:
        headers = response.headers
        rate_limit = read_rate_limit(_joined(headers, "ratelimit"), _joined(headers, "ratelimit-policy"))
        deprecation = parse_deprecation(
            _joined(headers, "deprecation"),
            _joined(headers, "sunset"),
            _joined(headers, "link"),
        )
        ctx.last_failure = None
        previous = ctx.meta
        replayed = self._is_replayed(response, route, streaming)
        ctx.meta = ResponseMeta(
            attempts=attempt,
            deprecation=deprecation,
            idempotency_key=key if key is not None else (previous.idempotency_key if previous else None),
            rate_limit=rate_limit,
            replayed=replayed or (previous.replayed if previous else False),
            request_id=headers.get("x-request-id"),
            status=response.status_code,
        )
        if deprecation is not None and self.owner.hooks.get("on_deprecation"):
            template = route.path if route is not None else route_template(path or redact_url(url))
            route_key = f"{method} {template}"
            seen = self.owner.deprecation_seen
            if route_key not in seen:
                seen.append(route_key)
                if len(seen) > _DEPRECATION_SEEN_LIMIT:
                    seen.pop(0)
                event: dict[str, Any] = {
                    "method": method,
                    "service": self.service,
                    "url": redact_url(url),
                }
                event.update(
                    {
                        "deprecated_at": deprecation.deprecated_at,
                        "policy_url": deprecation.policy_url,
                        "successor_url": deprecation.successor_url,
                        "sunset_at": deprecation.sunset_at,
                    }
                )
                self._hook("on_deprecation", event)

    def _decode(self, request: Request, response: httpx.Response, method: str, url: str) -> Any:
        if request.raw == "response":
            return response
        if request.raw:
            value: Any = response.content
        else:
            text = response.text
            if text.strip() == "":
                value = None
            else:
                try:
                    value = json.loads(text)
                except ValueError as error:
                    raise self._invalid_response(f"the response is not JSON: {error}", response, method, url) from error
        if request.decode is None:
            return value
        try:
            return request.decode(value)
        except RyuError:
            raise
        except (KeyError, TypeError, ValueError, AttributeError, IndexError) as error:
            raise self._invalid_response(
                f"the response did not match the expected shape: {error}",
                response,
                method,
                url,
            ) from error

    def _invalid_response(self, detail: str, response: httpx.Response, method: str, url: str) -> RyuError:
        return RyuResponseValidationError(
            f"The {self.service} response {detail}",
            service=self.service,
            status=0,
            envelope="client",
            method=method,
            url=url,
            request_id=response.headers.get("x-request-id"),
        )

    def decorate(self, error: RyuError, ctx: Optional[CallContext] = None) -> RyuError:
        """The service's own decoration, then the default hint and the last request id
        (the order of ``completeError`` in the TypeScript facade)."""
        decorator = self.owner.decorators.get(self.service)
        if decorator is not None:
            error = decorator(error)
        overrides: dict[str, Any] = {}
        if error.hint is None:
            hint = default_error_hint(error.status, error.code, error.url, self.config)
            if hint is not None:
                overrides["hint"] = hint
        raised_after_response = error.status == 0 and not isinstance(
            error,
            (RyuConnectionError, RyuTimeoutError, RyuAbortError, RyuConfigurationError),
        )
        last_request_id = ctx.meta.request_id if ctx is not None and ctx.meta is not None else None
        if error.request_id is None and raised_after_response and last_request_id is not None:
            overrides["request_id"] = last_request_id
        return with_ryu_error_fields(error, **overrides) if overrides else error

    # ── requests sent by a wrapped client (the Managed Agents stream loop) ──

    def timeout_seconds(self, ctx: CallContext) -> Optional[float]:
        return normalize_timeout(ctx.options.timeout if ctx.options.timeout is not None else self.owner.timeout)

    def stream_request(self, method: str, url: str, headers: dict[str, str], ctx: CallContext) -> httpx.Request:
        """A long-lived stream request under the services header rules, with the per-attempt
        timeout until headers arrive and no read timeout between events."""
        merged = {name.lower(): value for name, value in headers.items()}
        self._apply_auth(merged, None)
        merged.setdefault("accept", "text/event-stream")
        if self.owner.user_agent:
            merged["user-agent"] = self.owner.user_agent
        for name, value in ctx.options.headers.items():
            merged[name.lower()] = value
        timeout = httpx.Timeout(self.timeout_seconds(ctx), read=None)
        return self._build(method, url, merged, None, timeout)

    def stream_started(self, request: httpx.Request, attempt: int) -> dict[str, Any]:
        event = {
            "attempt": attempt,
            "method": request.method,
            "service": self.service,
            "url": redact_url(str(request.url)),
            "started": self.owner.now(),
        }
        self._hook(
            "on_request",
            {key: value for key, value in event.items() if key != "started"},
        )
        return event

    def stream_finished(
        self,
        request: httpx.Request,
        response: httpx.Response,
        event: dict[str, Any],
        attempt: int,
        ctx: CallContext,
    ) -> None:
        started = event.pop("started")
        self._hook(
            "on_response",
            dict(
                event,
                duration_ms=round((self.owner.now() - started) * 1000),
                request_id=response.headers.get("x-request-id"),
                status=response.status_code,
            ),
        )
        url = str(request.url)
        path = relative_service_path(self.config.base_url, self.routes.mount, url)
        self._record(ctx, response, attempt, None, None, path, request.method, url, True)

    def _transport_error(
        self,
        outcome: _Outcome,
        method: str,
        url: str,
        attempt: int,
        key: Optional[str],
        timeout_s: Optional[float],
    ) -> RyuError:
        common: dict[str, Any] = {
            "service": self.service,
            "status": 0,
            "method": method,
            "url": url,
            "idempotency_key": key,
            "attempts": attempt,
        }
        if outcome.kind == "timeout":
            error: RyuError = RyuTimeoutError(
                f"{service_title(self.service)}: {method} got no response within {timeout_s} s.",
                hint=transport_failure_hint(self.service, "timeout", url),
                **common,
            )
        else:
            detail = _scrub(str(outcome.error), url, self.config.api_key)
            error = RyuConnectionError(
                f"{service_title(self.service)}: {method} request failed before a response: {detail}",
                hint=transport_failure_hint(self.service, "connection_error", url),
                **common,
            )
        error.__cause__ = outcome.error
        return error
