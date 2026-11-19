"""``ryu.connect``: Ryu Connect tool execution.

``skills.list/get``, ``tools.search/describe/exec``, ``composio.execute``,
``usage(...)`` (callable) with ``usage.iterate(...)``, and ``mcp()`` (the MCP
client config; makes no request). No Connect route deduplicates writes, so
``tools.exec`` and ``composio.execute`` are never retried.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional, cast

from ._base import Namespace, Resource, compact, require_usage_window, segment
from ._runtime import Paginated, Request, next_cursor_field
from .errors import RyuError, message_without_hint, with_ryu_error_fields
from .shapes import ConnectMcpConfig

#: Friendlier messages for codes Connect sends with no prose of their own.
CONNECT_ERROR_MESSAGES: dict[str, str] = {
    "connection_denied": "That Composio connection is not granted to this tenant.",
    "insufficient_credits": "This organization has no Ryu credits left.",
    "invalid_filters": "The tool search filters are not valid.",
    "invalid_limit": "The limit is out of range.",
    "invalid_skill_id": "The Skill id is not valid.",
    "mcp_unconfigured": "MCP is not configured on this Connect server.",
    "native_composio_unavailable": "Native Composio execution is not configured on this Connect server.",
    "provider_unavailable": "The tool provider is unavailable right now.",
    "skills_unavailable": "The Skill catalog is not available on this Connect server.",
    "tool_denied": "That tool (or its account) is not granted to this tenant.",
    "tool_unavailable": "That tool is not available on this Connect server.",
    "toolkit_denied": "That toolkit is not granted to this tenant.",
    "upstream_invalid": "The tool provider returned a response Connect could not read.",
    "upstream_unconfigured": "The tool provider is not configured on this Connect server.",
}


def decorate_connect_error(error: RyuError) -> RyuError:
    message = CONNECT_ERROR_MESSAGES.get(error.code)
    if message_without_hint(error) == error.code and message is not None:
        return with_ryu_error_fields(error, message=message)
    return error


class Skills(Resource):
    def list(self) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/skills"))

    def get(self, skill_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", f"/v1/skills/{segment('connect', skill_id, 'the skill id')}"))


class Tools(Resource):
    def search(self, *, q: Optional[str] = None, limit: Optional[int] = None, kind: Optional[str] = None) -> Any:
        """``GET /v1/tools/search``: ``q``, ``limit`` (1-25), ``kind`` (``any``, ``mcp``, ``composio``)."""
        return self._b.call(
            lambda _c: Request("GET", "/v1/tools/search", params=compact({"kind": kind, "limit": limit, "q": q}))
        )

    def describe(self, *, tool_id: str) -> Any:
        return self._b.call(lambda _c: Request("GET", "/v1/tools/describe", params={"id": tool_id}))

    def exec(self, *, tool_id: str, arguments: Optional[Mapping[str, Any]] = None) -> Any:
        """Runs a tool by its qualified id from ``tools.search``. Never retried."""
        return self._b.call(
            lambda _c: Request(
                "POST",
                "/v1/exec/tool",
                json={"arguments": dict(arguments or {}), "kind": "tool", "tool_id": tool_id},
            )
        )


class Composio(Resource):
    def execute(
        self,
        *,
        tool_id: str,
        body: Optional[Mapping[str, Any]] = None,
        expected_account_id: Optional[str] = None,
    ) -> Any:
        """Runs a Composio action (``SLACK_SEND_MESSAGE``) on the tenant's bound account. Never retried."""
        payload = compact(
            {
                "body": dict(body) if body is not None else None,
                "expectedAccountId": expected_account_id,
                "operation": "execute",
                "toolId": tool_id,
            }
        )
        return self._b.call(lambda _c: Request("POST", "/v1/composio/execute", json=payload))


def _window(
    window: Optional[Mapping[str, Any]], from_: Optional[str], to: Optional[str], limit: Optional[int]
) -> dict[str, Any]:
    merged = dict(window or {})
    if from_ is not None:
        merged["from"] = from_
    if to is not None:
        merged["to"] = to
    if limit is not None:
        merged["limit"] = limit
    return merged


class Usage(Resource):
    """``ryu.connect.usage({"from": ..., "to": ...})`` (``from_=``/``to=`` work too) and ``.iterate``."""

    def __call__(
        self,
        window: Optional[Mapping[str, Any]] = None,
        *,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Any:
        """``GET /v1/usage`` for a window of whole UTC hours (ISO 8601 ``from`` and ``to``)."""
        query = _window(window, from_, to, limit)
        if cursor is not None:
            query["cursor"] = cursor

        def op(_config: Any) -> Request:
            require_usage_window("connect", query)
            return Request(
                "GET",
                "/v1/usage",
                params=compact({key: query.get(key) for key in ("cursor", "from", "limit", "to")}),
            )

        return self._b.call(op)

    def iterate(
        self,
        window: Optional[Mapping[str, Any]] = None,
        *,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        limit: Optional[int] = None,
        max_items: Optional[int] = None,
    ) -> Paginated:
        """Every usage line in the window, oldest first, across pages (``cursor`` -> ``nextCursor``)."""
        query = _window(window, from_, to, limit)
        query.pop("cursor", None)

        def fetch(_config: Any, cursor: Optional[str]) -> Request:
            require_usage_window("connect", query)
            params = compact({key: query.get(key) for key in ("from", "limit", "to")})
            if cursor is not None:
                params["cursor"] = cursor
            return Request("GET", "/v1/usage", params=params)

        return Paginated(self._b, fetch, lambda page: page.get("lines") or [], next_cursor_field, max_items=max_items)


class ConnectNamespace(Namespace):
    """``ryu.connect``."""

    def __init__(self, binding: Any) -> None:
        super().__init__(binding)
        self.skills = Skills(binding)
        self.tools = Tools(binding)
        self.composio = Composio(binding)
        self.usage = Usage(binding)

    def mcp(self) -> ConnectMcpConfig:
        """The MCP client config for this Connect server (``{"type": "http", "url", "headers"}``)."""
        return cast(
            ConnectMcpConfig,
            self._b.sync_value(
                lambda config: {
                    "headers": {"Authorization": f"Bearer {config.api_key}"},
                    "type": "http",
                    "url": f"{config.base_url.rstrip('/')}/mcp",
                }
            ),
        )
