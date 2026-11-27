"""Transport, errors and redaction shared by the Secret Vault client.

The wire contract is Core's ``/api/vault/*`` (the same one
``packages/core-client/src/vault`` speaks): camelCase JSON, the node bearer in
``Authorization`` (plus the optional ``x-ryu-user-jwt``) on human routes, and
only ``x-ryu-vault-token`` on the public machine routes (``/api/vault/auth/*``,
``/api/vault/agent/*`` and the wrapping unwrap/lookup/rewrap routes).
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any, Optional, Union
from urllib.parse import quote, urlencode

import httpx

from ..errors import (
    RyuAuthenticationError,
    RyuConflictError,
    RyuConnectionError,
    RyuError,
    RyuInvalidRequestError,
    RyuNotFoundError,
    RyuPermissionError,
    RyuRateLimitError,
    RyuResponseValidationError,
    RyuServerError,
    RyuTimeoutError,
    RyuUnavailableError,
)

SERVICE = "vault"
#: Header carrying a machine vault token (``rvt_.``) on the public routes.
VAULT_TOKEN_HEADER = "x-ryu-vault-token"
#: Header asking Core to wrap a response (``300``, ``300s``, ``5m`` or ``1h``).
VAULT_WRAP_TTL_HEADER = "x-ryu-wrap-ttl"
#: Header carrying the end user's JWT beside the node bearer.
USER_JWT_HEADER = "x-ryu-user-jwt"
REDACTED = "[redacted]"

#: Response fields whose value is secret material whatever its type.
_SECRET_FIELDS = frozenset(
    {
        "value",
        "data",
        "plaintext",
        "secretId",
        "privateKey",
        "password",
        "signingSecret",
        "secretAccessKey",
        "content",
    }
)
#: Response fields that are secret when they hold a string (``token`` is also an info object).
_SECRET_STRING_FIELDS = frozenset({"token"})

Json = Any
TtlValue = Union[str, int]


def _redact(value: Any, key: Optional[str] = None) -> Any:
    if key in _SECRET_FIELDS and value is not None:
        return REDACTED
    if key in _SECRET_STRING_FIELDS and isinstance(value, str):
        return REDACTED
    if isinstance(value, Mapping):
        return {name: _redact(item, name) for name, item in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


class VaultResponse(dict):  # type: ignore[type-arg]
    """A decoded vault reply: a plain ``dict`` whose ``repr``/``str`` never show secret values.

    Read fields as usual (``reply["value"]``); only printing and logging are
    redacted. ``sensitive=True`` (unwrapped responses) redacts every field.
    """

    def __init__(self, data: Mapping[str, Any], *, sensitive: bool = False) -> None:
        super().__init__(data)
        self._sensitive = sensitive

    def __repr__(self) -> str:
        if self._sensitive:
            return f"VaultResponse({{{', '.join(f'{key!r}: {REDACTED!r}' for key in self)}}})"
        return f"VaultResponse({_redact(dict(self))!r})"

    __str__ = __repr__


def segment(value: str, name: str) -> str:
    """One URL path segment, refusing empty, ``.`` and ``..`` ids (as ``encodeURIComponent`` callers do)."""
    if not isinstance(value, str) or value in ("", ".", ".."):
        raise RyuInvalidRequestError(
            f'Ryu Secret Vault: {name} must be a non-empty id other than "." or "..".',
            service=SERVICE,
            code="invalid_id",
            retryable=False,
        )
    return quote(value, safe="")


def query(params: Mapping[str, Any]) -> str:
    """``?a=b`` for the set params (booleans as ``true``/``false``, as ``String(true)`` does)."""
    pairs = []
    for key, value in params.items():
        if value is None:
            continue
        pairs.append((key, ("true" if value else "false") if isinstance(value, bool) else str(value)))
    return f"?{urlencode(pairs)}" if pairs else ""


def compact(values: Mapping[str, Any]) -> dict[str, Any]:
    """``values`` without ``None`` entries (JSON bodies omit unset fields)."""
    return {key: value for key, value in values.items() if value is not None}


def b64(value: Union[str, bytes]) -> str:
    """Transit inputs are base64: bytes are encoded, strings are sent as given."""
    return base64.b64encode(value).decode("ascii") if isinstance(value, bytes) else value


def wrap_ttl_headers(ttl: Optional[TtlValue]) -> dict[str, str]:
    return {} if ttl is None else {VAULT_WRAP_TTL_HEADER: str(ttl)}


_STATUS_ERRORS: dict[int, type[RyuError]] = {
    400: RyuInvalidRequestError,
    401: RyuAuthenticationError,
    403: RyuPermissionError,
    404: RyuNotFoundError,
    409: RyuConflictError,
    422: RyuInvalidRequestError,
    429: RyuRateLimitError,
    503: RyuUnavailableError,
}


def _server_error(text: str) -> tuple[Optional[str], Optional[str]]:
    """Core's ``{error: "text"}``, ``{error: {code, message}}`` or ``{code, error}`` reply."""
    try:
        body = json.loads(text) if text else None
    except ValueError:
        return None, None
    if not isinstance(body, dict):
        return None, None
    code = body.get("code") if isinstance(body.get("code"), str) else None
    error = body.get("error")
    if isinstance(error, str):
        return code, error
    if isinstance(error, dict):
        inner = error.get("code")
        message = error.get("message")
        return (inner if isinstance(inner, str) else code), (message if isinstance(message, str) else None)
    return code, None


def api_error(method: str, path: str, status: int, text: str) -> RyuError:
    """The typed error for a non-2xx vault reply. The body is never echoed beyond Core's message."""
    code, message = _server_error(text)
    cls = _STATUS_ERRORS.get(status, RyuServerError if status >= 500 else RyuInvalidRequestError)
    return cls(
        f"{path} failed: {status}" + (f" ({message})" if message else ""),
        service=SERVICE,
        status=status,
        code=code,
        method=method,
        url=path,
        retryable=status in (429, 503) or status >= 500,
    )


class VaultTransport:
    """One node URL plus its credentials. Human calls send the bearer; machine calls never do."""

    def __init__(
        self,
        url: str,
        *,
        token: Optional[str] = None,
        user_jwt: Optional[str] = None,
        timeout: float = 30.0,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        if not url:
            raise RyuInvalidRequestError(
                "Ryu Secret Vault: pass the node url.", service=SERVICE, code="configuration_error", retryable=False
            )
        self.url = url.rstrip("/")
        self._token = token
        self._user_jwt = user_jwt
        self._client = http_client or httpx.Client(timeout=timeout)
        self._owns_client = http_client is None

    def __repr__(self) -> str:
        return f"VaultTransport(url={self.url!r}, token={'<set>' if self._token else None})"

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def human_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        bearer = self._token or (self._user_jwt if self._user_jwt and self._user_jwt.strip() else None)
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        if self._user_jwt:
            headers[USER_JWT_HEADER] = self._user_jwt
        return headers

    @staticmethod
    def machine_headers(vault_token: Optional[str] = None) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if vault_token:
            headers[VAULT_TOKEN_HEADER] = vault_token
        return headers

    def send(
        self,
        method: str,
        path: str,
        *,
        headers: Mapping[str, str],
        body: Json = None,
        has_body: bool = False,
        sensitive: bool = False,
    ) -> VaultResponse:
        content = json.dumps(body).encode("utf-8") if has_body or body is not None else None
        try:
            response = self._client.request(method, f"{self.url}{path}", headers=dict(headers), content=content)
        except httpx.TimeoutException as error:
            raise RyuTimeoutError(
                f"{path} timed out.", service=SERVICE, method=method, url=path, retryable=True
            ) from error
        except httpx.HTTPError as error:
            raise RyuConnectionError(
                f"{path} could not reach the node.", service=SERVICE, method=method, url=path, retryable=True
            ) from error
        text = response.text
        if not response.is_success:
            raise api_error(method, path, response.status_code, text)
        if not text:
            return VaultResponse({}, sensitive=sensitive)
        try:
            decoded = json.loads(text)
        except ValueError as error:
            raise RyuResponseValidationError(
                f"{path} returned invalid JSON.", service=SERVICE, status=response.status_code, url=path
            ) from error
        if not isinstance(decoded, dict):
            raise RyuResponseValidationError(
                f"{path} returned {type(decoded).__name__}, not an object.",
                service=SERVICE,
                status=response.status_code,
                url=path,
            )
        return VaultResponse(decoded, sensitive=sensitive)

    def human(
        self,
        method: str,
        path: str,
        body: Json = None,
        *,
        has_body: bool = False,
        headers: Optional[Mapping[str, str]] = None,
    ) -> VaultResponse:
        return self.send(
            method, path, headers={**self.human_headers(), **(headers or {})}, body=body, has_body=has_body
        )

    def machine(
        self,
        method: str,
        path: str,
        body: Json = None,
        *,
        vault_token: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        sensitive: bool = False,
    ) -> VaultResponse:
        merged = {**(headers or {}), **self.machine_headers(vault_token)}
        return self.send(method, path, headers=merged, body=body, sensitive=sensitive)
