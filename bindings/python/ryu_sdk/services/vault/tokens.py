"""Vault tokens, token roles, response wrapping, machine identities and machine login."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Optional

from ._http import TtlValue, VaultResponse, VaultTransport, compact, query, segment, wrap_ttl_headers


def token_request(
    *,
    policies: Optional[Sequence[str]] = None,
    ttl_secs: Optional[int] = None,
    explicit_max_ttl_secs: Optional[int] = None,
    period_secs: Optional[int] = None,
    num_uses: Optional[int] = None,
    renewable: Optional[bool] = None,
    orphan: Optional[bool] = None,
    role: Optional[str] = None,
    bound_cidrs: Optional[Sequence[str]] = None,
) -> dict[str, Any]:
    """The camelCase ``VaultTokenRequest`` body."""
    return compact(
        {
            "policies": None if policies is None else list(policies),
            "ttlSecs": ttl_secs,
            "explicitMaxTtlSecs": explicit_max_ttl_secs,
            "periodSecs": period_secs,
            "numUses": num_uses,
            "renewable": renewable,
            "orphan": orphan,
            "role": role,
            "boundCidrs": None if bound_cidrs is None else list(bound_cidrs),
        }
    )


def _token_path(accessor: str, suffix: str = "") -> str:
    return f"/api/vault/tokens/{segment(accessor, 'accessor')}{suffix}"


class TokensResource:
    """``vault.tokens``: tokens by accessor and token roles (node bearer)."""

    def __init__(self, transport: VaultTransport) -> None:
        self._t = transport

    def list(self, *, identity: Optional[str] = None) -> VaultResponse:
        return self._t.human("GET", f"/api/vault/tokens{query({'identity': identity})}")

    def create(self, identity: str, **request: Any) -> VaultResponse:
        """Mint a token for a machine identity. The ``rvt_.`` token is shown once (``reply["token"]["token"]``)."""
        return self._t.human("POST", "/api/vault/tokens", {**token_request(**request), "identity": identity})

    def lookup(self, accessor: str) -> VaultResponse:
        return self._t.human("GET", _token_path(accessor))

    def renew(self, accessor: str, *, increment_secs: Optional[int] = None) -> VaultResponse:
        return self._t.human("POST", _token_path(accessor, "/renew"), compact({"incrementSecs": increment_secs}))

    def revoke(self, accessor: str) -> VaultResponse:
        """Revoke a token and its children."""
        return self._t.human("POST", _token_path(accessor, "/revoke"))

    def revoke_orphan(self, accessor: str) -> VaultResponse:
        """Revoke a token but keep its children as orphans."""
        return self._t.human("POST", _token_path(accessor, "/revoke-orphan"))

    def list_roles(self) -> VaultResponse:
        return self._t.human("GET", "/api/vault/token-roles")

    def get_role(self, name: str) -> VaultResponse:
        return self._t.human("GET", f"/api/vault/token-roles/{segment(name, 'role')}")

    def put_role(self, name: str, role: Mapping[str, Any]) -> VaultResponse:
        """Create or replace a token role from its camelCase fields (``allowedPolicies``, ``ttlSecs``, ...)."""
        return self._t.human("PUT", f"/api/vault/token-roles/{segment(name, 'role')}", dict(role))

    def delete_role(self, name: str) -> VaultResponse:
        return self._t.human("DELETE", f"/api/vault/token-roles/{segment(name, 'role')}")


class WrappingResource:
    """``vault.wrapping``: single-use wrapping tokens. Only ``wrap`` needs the bearer; ``unwrap``,
    ``lookup`` and ``rewrap`` are public and authenticate with the wrapping token itself."""

    def __init__(self, transport: VaultTransport) -> None:
        self._t = transport

    def wrap(self, data: Mapping[str, Any], *, ttl: Optional[TtlValue] = None) -> VaultResponse:
        """Wrap a JSON object (``{"wrapInfo": {"token", ...}}``). ``ttl`` defaults to Core's wrap TTL."""
        return self._t.human("POST", "/api/vault/sys/wrapping/wrap", dict(data), headers=wrap_ttl_headers(ttl))

    def unwrap(self, wrap_token: str) -> VaultResponse:
        """Unwrap once and return the original response (every field is redacted from ``repr``)."""
        return self._t.machine("POST", "/api/vault/sys/wrapping/unwrap", {"token": wrap_token}, sensitive=True)

    def lookup(self, wrap_token: str) -> VaultResponse:
        """Describe a wrapping token without consuming it."""
        return self._t.machine("POST", "/api/vault/sys/wrapping/lookup", {"token": wrap_token})

    def rewrap(self, wrap_token: str) -> VaultResponse:
        """Move a wrapped response to a new token (consumes the old one)."""
        return self._t.machine("POST", "/api/vault/sys/wrapping/rewrap", {"token": wrap_token})


class MachinesResource:
    """``vault.machines``: machine identities and their AppRole secret ids (node bearer)."""

    def __init__(self, transport: VaultTransport) -> None:
        self._t = transport

    def list(self) -> VaultResponse:
        return self._t.human("GET", "/api/vault/machines")

    def create(
        self,
        name: str,
        auth: Mapping[str, Any],
        *,
        policies: Optional[Sequence[str]] = None,
        token_ttl_secs: Optional[int] = None,
    ) -> VaultResponse:
        """``auth`` is ``{"kind": "approle", "roleId": ...}`` or ``{"kind": "jwt", "issuer": ...}``."""
        body = compact(
            {
                "auth": dict(auth),
                "name": name,
                "policies": None if policies is None else list(policies),
                "tokenTtlSecs": token_ttl_secs,
            }
        )
        return self._t.human("POST", "/api/vault/machines", body)

    def update(
        self,
        machine_id: str,
        *,
        disabled: Optional[bool] = None,
        policies: Optional[Sequence[str]] = None,
        token_ttl_secs: Optional[int] = None,
    ) -> VaultResponse:
        body = compact(
            {
                "disabled": disabled,
                "policies": None if policies is None else list(policies),
                "tokenTtlSecs": token_ttl_secs,
            }
        )
        return self._t.human("PATCH", f"/api/vault/machines/{segment(machine_id, 'machine id')}", body)

    def delete(self, machine_id: str) -> VaultResponse:
        return self._t.human("DELETE", f"/api/vault/machines/{segment(machine_id, 'machine id')}")

    def list_secret_ids(self, machine_id: str) -> VaultResponse:
        return self._t.human("GET", f"/api/vault/machines/{segment(machine_id, 'machine id')}/secret-ids")

    def issue_secret_id(
        self, machine_id: str, *, ttl_secs: Optional[int] = None, uses: Optional[int] = None
    ) -> VaultResponse:
        """Issue an AppRole secret id (``{"info", "secretId"}``; the value is returned exactly once)."""
        body = compact({"ttlSecs": ttl_secs, "uses": uses})
        return self._t.human("POST", f"/api/vault/machines/{segment(machine_id, 'machine id')}/secret-ids", body)

    def revoke_secret_id(self, accessor: str) -> VaultResponse:
        return self._t.human("DELETE", f"/api/vault/secret-ids/{segment(accessor, 'accessor')}")


class AuthResource:
    """``vault.auth``: public machine logins. No node bearer is sent; each answers ``{"token": {...}}``
    with the ``rvt_.`` token shown once."""

    def __init__(self, transport: VaultTransport) -> None:
        self._t = transport

    def _login(self, method: str, body: Mapping[str, Any]) -> VaultResponse:
        return self._t.machine("POST", f"/api/vault/auth/{method}/login", dict(body))

    def approle(self, role_id: str, secret_id: str) -> VaultResponse:
        return self._login("approle", {"roleId": role_id, "secretId": secret_id})

    def jwt(self, identity: str, jwt: str) -> VaultResponse:
        """Exchange an OIDC JWT (for example a GitHub Actions ID token)."""
        return self._login("jwt", {"identity": identity, "jwt": jwt})

    def kubernetes(self, identity: str, jwt: str) -> VaultResponse:
        """Exchange a Kubernetes service-account token (checked with a TokenReview)."""
        return self._login("kubernetes", {"identity": identity, "jwt": jwt})

    def cert(self, identity: str, certificate_pem: str, proof: str) -> VaultResponse:
        """Log in with a TLS client certificate and a proof-of-possession JWT."""
        return self._login("cert", {"identity": identity, "certificatePem": certificate_pem, "proof": proof})

    def aws(
        self,
        identity: str,
        *,
        iam_request_url: str,
        iam_request_body: str,
        iam_request_headers: str,
        iam_http_request_method: str = "POST",
    ) -> VaultResponse:
        """Log in with a presigned ``sts:GetCallerIdentity`` request (each field base64, as Core expects)."""
        return self._login(
            "aws",
            {
                "identity": identity,
                "iamHttpRequestMethod": iam_http_request_method,
                "iamRequestUrl": iam_request_url,
                "iamRequestBody": iam_request_body,
                "iamRequestHeaders": iam_request_headers,
            },
        )
