"""The tool registry's data, loaded from ``manifest.json``.

``manifest.json`` is exported from the TypeScript registry
(``packages/services/src/tools``) by ``bindings/python/tests/fixtures/services_tools.ts``,
so a tool's name, title, description, annotations, default approval, input
JSON Schema and output JSON Schema are the same in both SDKs. ``tests/test_services_tools_registry.py``
regenerates it when bun is installed and fails when the committed file is stale.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_MANIFEST_PATH = Path(__file__).with_name("manifest.json")


@dataclass(frozen=True)
class ToolAnnotations:
    """What calling a tool does, in MCP's annotation vocabulary (all four are always set)."""

    #: It can destroy or overwrite something (a Box, a file, what a Site serves).
    destructive_hint: bool
    #: Repeating the same call has no further effect.
    idempotent_hint: bool
    #: It reaches people or systems outside Ryu (sends email or SMS, runs a model, fetches a site).
    open_world_hint: bool
    #: It changes nothing. The adapters expose only these tools unless ``read_only=False``.
    read_only_hint: bool

    def to_dict(self) -> dict[str, bool]:
        """The MCP / TypeScript shape (camelCase keys)."""
        return {
            "readOnlyHint": self.read_only_hint,
            "destructiveHint": self.destructive_hint,
            "idempotentHint": self.idempotent_hint,
            "openWorldHint": self.open_world_hint,
        }


@dataclass(frozen=True)
class ToolSpec:
    """One registry tool as data: everything but its body."""

    #: ``<service prefix>_<verb>`` in snake_case, e.g. ``notify_publish``. Stable across releases.
    name: str
    #: The service id the tool calls (``"managedAgents"``, ``"mail"``, ...).
    service: str
    #: A short human title, e.g. "Publish a Notify event".
    title: str
    #: What the tool does, written for a model choosing between tools.
    description: str
    annotations: ToolAnnotations
    #: The default approval: not read-only, or open-world.
    default_needs_approval: bool
    #: The JSON Schema of the tool's arguments (root ``type: "object"``).
    input_schema: dict[str, Any]
    #: The JSON Schema of a successful result, ``{"data", "meta"}`` with ``data`` typed per tool:
    #: the MCP ``outputSchema`` ``ryu-services mcp`` declares. The adapters' compact result adds
    #: ``"error": None`` on success; on a tool error ``data`` is ``None`` and this does not apply.
    output_schema: dict[str, Any]
    #: Its route needs no credential (``mail_status``, ``messaging_status``): the call runs, and
    #: sends no key, when ``ryu.can_call_without_credentials(service)`` holds although the service
    #: is not configured. The adapters still expose a tool only for configured services; the
    #: ``ryu-services mcp`` server registers these for unconfigured ones.
    credential_free: bool = False


def _load() -> Mapping[str, Any]:
    with _MANIFEST_PATH.open(encoding="utf-8") as handle:
        loaded: Mapping[str, Any] = json.load(handle)
    return loaded


_DOCUMENT = _load()


def _spec(raw: Mapping[str, Any]) -> ToolSpec:
    annotations = raw["annotations"]
    return ToolSpec(
        name=raw["name"],
        service=raw["service"],
        title=raw["title"],
        description=raw["description"],
        annotations=ToolAnnotations(
            destructive_hint=bool(annotations["destructiveHint"]),
            idempotent_hint=bool(annotations["idempotentHint"]),
            open_world_hint=bool(annotations["openWorldHint"]),
            read_only_hint=bool(annotations["readOnlyHint"]),
        ),
        default_needs_approval=bool(raw["needsApproval"]),
        input_schema=raw["inputSchema"],
        output_schema=raw["outputSchema"],
        credential_free=bool(raw.get("credentialFree", False)),
    )


#: Every tool spec, in registry order.
TOOL_SPECS: tuple[ToolSpec, ...] = tuple(_spec(raw) for raw in _DOCUMENT["tools"])
#: The service ids that have tools, in registry order. Connect has none: it is an MCP server itself.
TOOL_SERVICES: tuple[str, ...] = tuple(_DOCUMENT["services"])
#: The tool-name prefix of each service id.
TOOL_PREFIXES: Mapping[str, str] = dict(_DOCUMENT["prefixes"])
#: Numbers the TypeScript tool bodies use, exported with the registry.
CONSTANTS: Mapping[str, int] = dict(_DOCUMENT["constants"])
