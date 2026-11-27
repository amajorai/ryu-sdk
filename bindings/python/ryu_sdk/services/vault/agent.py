"""The machine-token client for ``/api/vault/agent/*`` (CI runners, workloads, agents).

It sends only ``x-ryu-vault-token``: a machine never needs the node bearer.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Optional

import httpx

from ._http import TtlValue, VaultResponse, VaultTransport, compact, query, segment, wrap_ttl_headers
from .engines import LeasesResource, TransitOps
from .tokens import token_request

_AGENT = "/api/vault/agent"


class VaultAgentClient:
    """Vault calls made with a machine token (from :meth:`VaultClient.auth` logins or ``tokens.create``)."""

    def __init__(
        self,
        url: str,
        vault_token: str,
        *,
        timeout: float = 30.0,
        http_client: Optional[httpx.Client] = None,
        transport: Optional[VaultTransport] = None,
    ) -> None:
        self._owns_transport = transport is None
        self._t = transport or VaultTransport(url, timeout=timeout, http_client=http_client)
        self._vault_token = vault_token
        self.transit = TransitOps(self._send, f"{_AGENT}/transit")
        self.leases = LeasesResource(self._send, f"{_AGENT}/leases")

    @classmethod
    def from_login(cls, url: str, login: Mapping[str, Any], **options: Any) -> VaultAgentClient:
        """A client for the token in a login reply (``{"token": {"token": "rvt_.", ...}}``)."""
        return cls(url, str(login["token"]["token"]), **options)

    def __repr__(self) -> str:
        return f"VaultAgentClient(url={self._t.url!r}, vault_token='[redacted]')"

    def close(self) -> None:
        """Close the HTTP client this agent opened (a client from :meth:`VaultClient.agent` shares its parent's)."""
        if self._owns_transport:
            self._t.close()

    def __enter__(self) -> VaultAgentClient:  # noqa: PYI034 (runtime-evaluable annotations)
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _send(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        headers: Optional[Mapping[str, str]] = None,
        sensitive: bool = False,
    ) -> VaultResponse:
        return self._t.machine(method, path, body, vault_token=self._vault_token, headers=headers, sensitive=sensitive)

    # --- The token itself ---------------------------------------------------------------

    def self_(self) -> VaultResponse:
        """The token's principal (``{"token": {"accessor", "identityId", "policies", ...}}``)."""
        return self._send("GET", f"{_AGENT}/self")

    def lookup_self(self) -> VaultResponse:
        return self._send("GET", f"{_AGENT}/self/lookup")

    def renew_self(self, *, increment_secs: Optional[int] = None) -> VaultResponse:
        return self._send("POST", f"{_AGENT}/self/renew", compact({"incrementSecs": increment_secs}))

    def revoke_self(self) -> VaultResponse:
        return self._send("POST", f"{_AGENT}/self/revoke")

    def create_child(self, **request: Any) -> VaultResponse:
        """Mint a narrower child token (policy subset; TTL capped by the parent)."""
        return self._send("POST", f"{_AGENT}/self/child", token_request(**request))

    # --- Values -------------------------------------------------------------------------

    def secret(self, name: str, *, environment: Optional[str] = None, path: Optional[str] = None) -> VaultResponse:
        """Read one node-scoped value (``{"value": ...}``)."""
        suffix = query({"environment": environment, "path": path})
        return self._send("GET", f"{_AGENT}/secrets/{segment(name, 'name')}{suffix}")

    def wrap_secret(
        self, name: str, ttl: TtlValue, *, environment: Optional[str] = None, path: Optional[str] = None
    ) -> VaultResponse:
        """:meth:`secret`, wrapped behind a single-use token by Core."""
        suffix = query({"environment": environment, "path": path})
        return self._send("GET", f"{_AGENT}/secrets/{segment(name, 'name')}{suffix}", headers=wrap_ttl_headers(ttl))

    def export(
        self,
        *,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        format: Optional[str] = None,
        names: Optional[Sequence[str]] = None,
        project_id: Optional[str] = None,
    ) -> VaultResponse:
        """Export the node-scoped values the token may read (``content`` is never printed)."""
        body = compact(
            {
                "environment": environment,
                "path": path,
                "format": format,
                "names": None if names is None else list(names),
                "projectId": project_id,
            }
        )
        return self._send("POST", f"{_AGENT}/export", body)

    def wrap(self, data: Mapping[str, Any], *, ttl: Optional[TtlValue] = None) -> VaultResponse:
        return self._send("POST", f"{_AGENT}/wrapping/wrap", dict(data), headers=wrap_ttl_headers(ttl))

    # --- Engines ------------------------------------------------------------------------

    def issue_dynamic(self, role: str, *, ttl_secs: Optional[int] = None) -> VaultResponse:
        body = {} if ttl_secs is None else {"ttlSecs": ttl_secs}
        return self._send("POST", f"{_AGENT}/dynamic/{segment(role, 'role')}", body)

    def pki(self, op: str, role: str, request: Mapping[str, Any]) -> VaultResponse:
        """``op`` is ``issue`` or ``sign``; ``request`` is the camelCase ``VaultPkiIssueInput``."""
        if op not in ("issue", "sign"):
            raise ValueError("op must be 'issue' or 'sign'")
        return self._send("POST", f"{_AGENT}/pki/{op}/{segment(role, 'role')}", dict(request))

    def ssh_sign(self, role: str, request: Mapping[str, Any]) -> VaultResponse:
        return self._send("POST", f"{_AGENT}/ssh/sign/{segment(role, 'role')}", dict(request))

    # --- Cubbyhole ----------------------------------------------------------------------

    def cubbyhole_list(self) -> VaultResponse:
        return self._send("GET", f"{_AGENT}/cubbyhole")

    def cubbyhole_get(self, key: str) -> VaultResponse:
        return self._send("GET", f"{_AGENT}/cubbyhole/{segment(key, 'key')}")

    def cubbyhole_put(self, key: str, value: Any) -> VaultResponse:
        return self._send("PUT", f"{_AGENT}/cubbyhole/{segment(key, 'key')}", value)

    def cubbyhole_delete(self, key: str) -> VaultResponse:
        return self._send("DELETE", f"{_AGENT}/cubbyhole/{segment(key, 'key')}")
