"""Python client for Ryu Core's Secret Vault (the Python form of ``@ryu/core-client``'s ``vault``).

::

    from ryu_sdk.services.vault import VaultClient, VaultAgentClient

    vault = VaultClient("http://127.0.0.1:7980", token=node_token)
    login = vault.auth.approle(role_id, secret_id)
    agent = VaultAgentClient.from_login("http://127.0.0.1:7980", login)
    agent.secret("DB_URL")["value"]

Replies are :class:`VaultResponse` dicts with Core's camelCase fields; their
``repr``/``str`` redact secret values. Failures raise the ``RyuError``
subclasses from :mod:`ryu_sdk.services.errors` with ``service == "vault"``.
"""

from ._http import REDACTED, USER_JWT_HEADER, VAULT_TOKEN_HEADER, VAULT_WRAP_TTL_HEADER, VaultResponse
from .agent import VaultAgentClient
from .client import VaultClient
from .secrets import coords
from .tokens import token_request

__all__ = [
    "REDACTED",
    "USER_JWT_HEADER",
    "VAULT_TOKEN_HEADER",
    "VAULT_WRAP_TTL_HEADER",
    "VaultAgentClient",
    "VaultClient",
    "VaultResponse",
    "coords",
    "token_request",
]
