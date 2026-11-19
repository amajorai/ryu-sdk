"""Secret values: ``/api/vault/secrets`` (list, reveal, put, delete, versions, rollback, restore, destroy)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Optional

from ._http import VaultResponse, VaultTransport, compact, query, segment, wrap_ttl_headers


def coords(
    scope: str,
    scope_id: Optional[str] = None,
    environment: Optional[str] = None,
    path: Optional[str] = None,
    binding_id: Optional[str] = None,
) -> dict[str, Any]:
    """A value's coordinates as Core reads them (``environment`` defaults to ``default``, ``path`` to ``/``)."""
    return compact(
        {
            "scope": scope,
            "scopeId": scope_id,
            "environment": environment,
            "path": path,
            "binding": None if binding_id is None else {"id": binding_id, "kind": "mcp"},
        }
    )


def _secret_path(name: str, suffix: str = "") -> str:
    return f"/api/vault/secrets/{segment(name, 'name')}{suffix}"


class SecretsResource:
    """``vault.secrets``: values a human (node bearer) reads and writes."""

    def __init__(self, transport: VaultTransport) -> None:
        self._t = transport

    def list(
        self,
        *,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        recursive: Optional[bool] = None,
        include_deleted: Optional[bool] = None,
    ) -> VaultResponse:
        """Metadata of every visible value (never the values)."""
        suffix = query(
            {"environment": environment, "path": path, "recursive": recursive, "includeDeleted": include_deleted}
        )
        return self._t.human("GET", f"/api/vault/secrets{suffix}")

    def get(
        self,
        name: str,
        *,
        scope: str,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
        version: Optional[int] = None,
    ) -> VaultResponse:
        """Reveal a value (``{"value": ...}``; requires ``read`` and is audited). Omit ``version`` for the current one."""
        body = {**coords(scope, scope_id, environment, path, binding_id), **compact({"version": version})}
        return self._t.human("POST", _secret_path(name, "/reveal"), body)

    def wrap(
        self,
        name: str,
        ttl: Any,
        *,
        scope: str,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
        version: Optional[int] = None,
    ) -> VaultResponse:
        """Reveal a value behind a single-use wrapping token: the plaintext never reaches this client."""
        body = {**coords(scope, scope_id, environment, path, binding_id), **compact({"version": version})}
        return self._t.human("POST", _secret_path(name, "/reveal"), body, headers=wrap_ttl_headers(ttl))

    def put(
        self,
        name: str,
        *,
        scope: str,
        value: Optional[str] = None,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        expected_version: Optional[int] = None,
    ) -> VaultResponse:
        """Write a value (omit ``value`` for a metadata-only update). A protected environment answers with a
        ``changeRequest`` instead of a ``secret``."""
        body = {
            **coords(scope, scope_id, environment, path, binding_id),
            **compact(
                {"value": value, "metadata": dict(metadata) if metadata else None, "expectedVersion": expected_version}
            ),
        }
        return self._t.human("PUT", _secret_path(name), body)

    def delete(
        self,
        name: str,
        *,
        scope: str,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
    ) -> VaultResponse:
        """Soft-delete (restorable). Core takes the coordinates as a JSON body."""
        return self._t.human("DELETE", _secret_path(name), coords(scope, scope_id, environment, path, binding_id))

    def versions(
        self,
        name: str,
        *,
        scope: str,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
    ) -> VaultResponse:
        """``{"versions": [...]}``: version metadata, never values."""
        suffix = query(
            {"scope": scope, "scopeId": scope_id, "mcpId": binding_id, "environment": environment, "path": path}
        )
        return self._t.human("GET", f"{_secret_path(name, '/versions')}{suffix}")

    def rollback(
        self,
        name: str,
        version: int,
        *,
        scope: str,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
    ) -> VaultResponse:
        body = {**coords(scope, scope_id, environment, path, binding_id), "version": version}
        return self._t.human("POST", _secret_path(name, "/rollback"), body)

    def restore(
        self,
        name: str,
        *,
        scope: str,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
    ) -> VaultResponse:
        body = coords(scope, scope_id, environment, path, binding_id)
        return self._t.human("POST", _secret_path(name, "/restore"), body)

    def destroy(
        self,
        name: str,
        *,
        scope: str,
        versions: Optional[Sequence[int]] = None,
        scope_id: Optional[str] = None,
        environment: Optional[str] = None,
        path: Optional[str] = None,
        binding_id: Optional[str] = None,
    ) -> VaultResponse:
        """Permanently destroy versions (all when ``versions`` is omitted)."""
        body = {
            **coords(scope, scope_id, environment, path, binding_id),
            **compact({"versions": list(versions) if versions is not None else None}),
        }
        return self._t.human("POST", _secret_path(name, "/destroy"), body)
