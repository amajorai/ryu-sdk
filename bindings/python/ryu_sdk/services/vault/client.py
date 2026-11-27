"""``VaultClient``: the human (node bearer) side of Core's Secret Vault."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional

import httpx

from ._http import VaultResponse, VaultTransport
from .agent import VaultAgentClient
from .engines import DynamicResource, LeasesResource, TransitResource
from .secrets import SecretsResource
from .tokens import AuthResource, MachinesResource, TokensResource, WrappingResource


class VaultClient:
    """Core's Secret Vault for a node URL and its bearer.

    ::

        vault = VaultClient("http://127.0.0.1:7980", token=node_token)
        vault.secrets.put("DB_URL", scope="node", value="postgres://...")
        reply = vault.secrets.get("DB_URL", scope="node")
        reply["value"]  # the value; print(reply) shows [redacted]

    ``auth`` logins and the wrapping ``unwrap``/``lookup``/``rewrap`` calls are
    public routes and never send the bearer. :meth:`agent` returns a client for
    a machine token on the same node.
    """

    def __init__(
        self,
        url: str,
        *,
        token: Optional[str] = None,
        user_jwt: Optional[str] = None,
        timeout: float = 30.0,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self._t = VaultTransport(url, token=token, user_jwt=user_jwt, timeout=timeout, http_client=http_client)
        self.secrets = SecretsResource(self._t)
        self.dynamic = DynamicResource(self._send)
        self.leases = LeasesResource(self._send)
        self.transit = TransitResource(self._send, "/api/vault/transit")
        self.tokens = TokensResource(self._t)
        self.wrapping = WrappingResource(self._t)
        self.machines = MachinesResource(self._t)
        self.auth = AuthResource(self._t)

    def __repr__(self) -> str:
        return f"VaultClient({self._t!r})"

    def _send(
        self, method: str, path: str, body: Any = None, *, headers: Optional[Mapping[str, str]] = None
    ) -> VaultResponse:
        return self._t.human(method, path, body, headers=headers)

    def agent(self, vault_token: str) -> VaultAgentClient:
        """A machine-token client for this node, sharing this client's HTTP connection pool."""
        return VaultAgentClient(self._t.url, vault_token, transport=self._t)

    def close(self) -> None:
        self._t.close()

    def __enter__(self) -> VaultClient:  # noqa: PYI034 (runtime-evaluable annotations)
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
