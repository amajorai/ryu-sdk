"""Shared pieces of the service namespaces."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable, Optional
from urllib.parse import quote

from ._runtime import Binding, CallOptions
from ._service_titles import service_title
from .errors import RyuInvalidRequestError


class Resource:
    """A group of methods (``ryu.mail.messages``) bound to one service binding."""

    def __init__(self, binding: Binding) -> None:
        self._b = binding


class Namespace(Resource):
    """A service namespace (``ryu.mail``). ``with_options()`` binds per-call options."""

    def with_options(
        self,
        *,
        idempotency_key: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """The same namespace with these options applied to every call made through it.

        A bound ``idempotency_key`` is used by the first idempotent write and is
        then spent: a later write through the same bound namespace fails with
        ``idempotency_key_reused`` instead of silently replaying the first
        write's stored result. Bind a new key per operation.
        """
        return type(self)(self._b.with_options(idempotency_key=idempotency_key, headers=headers, timeout=timeout))


def call_options(
    idempotency_key: Optional[str] = None, headers: Optional[Mapping[str, str]] = None
) -> Optional[CallOptions]:
    if idempotency_key is None and not headers:
        return None
    return CallOptions(idempotency_key=idempotency_key, headers=dict(headers or {}))


def segment(service: str, value: Any, name: str) -> str:
    """A URL path segment, refusing empty, ``.`` and ``..`` ids (as ``pathSegment`` does)."""
    if not isinstance(value, str) or value in ("", ".", ".."):
        raise RyuInvalidRequestError(
            f'{service_title(service)}: {name} must be a non-empty id other than "." or "..".',
            service=service,
            code="invalid_id",
            retryable=False,
        )
    return quote(value, safe="")


def require_usage_window(service: str, window: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    missing = [name for name in ("from", "to") if not (window and isinstance(window.get(name), str) and window[name])]
    if missing:
        raise RyuInvalidRequestError(
            f"Ryu {service}.usage: pass {{from, to}}, ISO 8601 times on whole UTC hours (missing {' and '.join(missing)}).",
            service=service,
            code="invalid_request",
            details={"missing": missing},
            retryable=False,
        )
    assert window is not None
    return window


def compact(values: Mapping[str, Any]) -> dict[str, Any]:
    """``values`` without ``None`` entries (JSON bodies omit unset fields, as ``JSON.stringify`` does)."""
    return {key: value for key, value in values.items() if value is not None}


def field(name: str) -> Callable[[Any], Any]:
    """A decoder that returns ``value[name]`` (raises KeyError, which becomes RyuResponseValidationError)."""

    def decode(value: Any) -> Any:
        if not isinstance(value, dict):
            raise TypeError(f"expected an object with {name!r}")
        return value[name]

    return decode
