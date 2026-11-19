"""Dynamic credentials, leases and transit (encryption as a service)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable, Optional, Union

from ._http import VaultResponse, b64, compact, query, segment

Send = Callable[..., VaultResponse]
Data = Union[str, bytes]


def _ttl_body(ttl_secs: Optional[int]) -> dict[str, Any]:
    return {} if ttl_secs is None else {"ttlSecs": ttl_secs}


def _op_options(
    associated_data: Optional[Data],
    context: Optional[Data],
    key_version: Optional[int],
    signature_algorithm: Optional[str] = None,
) -> dict[str, Any]:
    return compact(
        {
            "associatedData": None if associated_data is None else b64(associated_data),
            "context": None if context is None else b64(context),
            "keyVersion": key_version,
            "signatureAlgorithm": signature_algorithm,
        }
    )


class TransitOps:
    """The transit operations. ``plaintext``, ``input``, ``context`` and ``associated_data`` are base64:
    pass ``bytes`` to have them encoded, or an already-encoded ``str``. Results are returned as Core sends
    them (``decrypt`` and ``datakey`` plaintext stays base64)."""

    def __init__(self, send: Send, prefix: str) -> None:
        self._send = send
        self._prefix = prefix

    def _op(self, op: str, name: str, body: Mapping[str, Any]) -> VaultResponse:
        return self._send("POST", f"{self._prefix}/{op}/{segment(name, 'key')}", dict(body))

    def encrypt(
        self,
        name: str,
        plaintext: Data,
        *,
        associated_data: Optional[Data] = None,
        context: Optional[Data] = None,
        key_version: Optional[int] = None,
    ) -> VaultResponse:
        options = _op_options(associated_data, context, key_version)
        return self._op("encrypt", name, {**options, "plaintext": b64(plaintext)})

    def decrypt(
        self,
        name: str,
        ciphertext: str,
        *,
        associated_data: Optional[Data] = None,
        context: Optional[Data] = None,
    ) -> VaultResponse:
        options = _op_options(associated_data, context, None)
        return self._op("decrypt", name, {**options, "ciphertext": ciphertext})

    def rewrap(
        self, name: str, ciphertext: str, *, context: Optional[Data] = None, key_version: Optional[int] = None
    ) -> VaultResponse:
        options = _op_options(None, context, key_version)
        return self._op("rewrap", name, {**options, "ciphertext": ciphertext})

    def sign(
        self,
        name: str,
        input: Data,
        *,
        key_version: Optional[int] = None,
        signature_algorithm: Optional[str] = None,
        context: Optional[Data] = None,
    ) -> VaultResponse:
        options = _op_options(None, context, key_version, signature_algorithm)
        return self._op("sign", name, {**options, "input": b64(input)})

    def verify(
        self,
        name: str,
        input: Data,
        *,
        signature: Optional[str] = None,
        hmac: Optional[str] = None,
        signature_algorithm: Optional[str] = None,
        context: Optional[Data] = None,
    ) -> VaultResponse:
        """Verify a ``signature`` or an ``hmac`` over ``input`` (``{"valid": bool}``)."""
        options = _op_options(None, context, None, signature_algorithm)
        return self._op(
            "verify", name, {**options, **compact({"signature": signature, "hmac": hmac}), "input": b64(input)}
        )

    def hmac(self, name: str, input: Data, *, key_version: Optional[int] = None) -> VaultResponse:
        return self._op("hmac", name, {**_op_options(None, None, key_version), "input": b64(input)})

    def datakey(self, name: str) -> VaultResponse:
        """A fresh data key: ``{"plaintext", "ciphertext"}`` (the plaintext is never printed)."""
        return self._op("datakey", name, {})


class TransitResource(TransitOps):
    """``vault.transit``: key management plus the operations, with the node bearer."""

    def list_keys(self) -> VaultResponse:
        return self._send("GET", "/api/vault/transit/keys")

    def create_key(self, name: str, *, type: Optional[str] = None) -> VaultResponse:
        return self._send("POST", "/api/vault/transit/keys", compact({"name": name, "type": type}))

    def configure_key(
        self,
        name: str,
        *,
        allow_plaintext_backup: Optional[bool] = None,
        auto_rotate_period_secs: Optional[int] = None,
        deletion_allowed: Optional[bool] = None,
        exportable: Optional[bool] = None,
        min_decryption_version: Optional[int] = None,
        min_encryption_version: Optional[int] = None,
    ) -> VaultResponse:
        body = compact(
            {
                "allowPlaintextBackup": allow_plaintext_backup,
                "autoRotatePeriodSecs": auto_rotate_period_secs,
                "deletionAllowed": deletion_allowed,
                "exportable": exportable,
                "minDecryptionVersion": min_decryption_version,
                "minEncryptionVersion": min_encryption_version,
            }
        )
        return self._send("PATCH", f"/api/vault/transit/keys/{segment(name, 'key')}", body)

    def delete_key(self, name: str) -> VaultResponse:
        return self._send("DELETE", f"/api/vault/transit/keys/{segment(name, 'key')}")

    def rotate(self, name: str) -> VaultResponse:
        return self._op("rotate", name, {})


class DynamicResource:
    """``vault.dynamic``: dynamic-credential roles and issuing a credential under a lease."""

    def __init__(self, send: Send) -> None:
        self._send = send

    def list_roles(self) -> VaultResponse:
        return self._send("GET", "/api/vault/dynamic/roles")

    def put_role(
        self,
        name: str,
        provider: Mapping[str, Any],
        *,
        default_ttl_secs: Optional[int] = None,
        max_ttl_secs: Optional[int] = None,
    ) -> VaultResponse:
        """Create or replace a role. ``provider`` is the camelCase provider object (``{"kind": "postgres", ...}``)."""
        body = compact({"defaultTtlSecs": default_ttl_secs, "maxTtlSecs": max_ttl_secs, "provider": dict(provider)})
        return self._send("PUT", f"/api/vault/dynamic/roles/{segment(name, 'role')}", body)

    def delete_role(self, name: str) -> VaultResponse:
        return self._send("DELETE", f"/api/vault/dynamic/roles/{segment(name, 'role')}")

    def revoke_all(self, name: str) -> VaultResponse:
        """Revoke every live lease of a role (``{"revoked": n}``)."""
        return self._send("POST", f"/api/vault/dynamic/roles/{segment(name, 'role')}/revoke-all")

    def issue(self, role: str, *, ttl_secs: Optional[int] = None) -> VaultResponse:
        """``{"credential": {"data", "lease"}}``. ``data`` is returned once and never printed."""
        return self._send("POST", f"/api/vault/dynamic/issue/{segment(role, 'role')}", _ttl_body(ttl_secs))


class LeasesResource:
    """``vault.leases``: list, renew and revoke dynamic-credential leases."""

    def __init__(self, send: Send, prefix: str = "/api/vault/leases") -> None:
        self._send = send
        self._prefix = prefix

    def list(self, *, role: Optional[str] = None, include_revoked: Optional[bool] = None) -> VaultResponse:
        return self._send("GET", f"{self._prefix}{query({'role': role, 'includeRevoked': include_revoked})}")

    def renew(self, lease_id: str, *, ttl_secs: Optional[int] = None) -> VaultResponse:
        return self._send("POST", f"{self._prefix}/{segment(lease_id, 'lease id')}/renew", _ttl_body(ttl_secs))

    def revoke(self, lease_id: str) -> VaultResponse:
        return self._send("POST", f"{self._prefix}/{segment(lease_id, 'lease id')}/revoke", {})
