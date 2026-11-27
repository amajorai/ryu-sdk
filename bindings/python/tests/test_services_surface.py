"""The Python client's ``ryu.<ns>.<method>`` surface: committed manifest and TypeScript parity.

``ryu_sdk/services/surface.json`` is what the public docs guard checks Python
samples against, so it must equal the live client. Every canonical
``@ryuhq/services`` path (from the vectors file) must exist here in snake_case,
except the few listed in ``OMITTED`` with the reason.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from ryu_sdk.services._surface import surface, surface_document

PACKAGE = Path(__file__).resolve().parents[1] / "ryu_sdk" / "services"
VECTORS = json.loads((Path(__file__).parent / "fixtures" / "services_vectors.json").read_text())

#: TypeScript paths the Python client deliberately does not have.
OMITTED = {
    # Runtime-visible private helpers of the TypeScript Box and Notify classes.
    "box.absoluteUrl": "private TypeScript helper",
    "box.body": "private TypeScript helper",
    "box.box": "private TypeScript helper",
    "box.json": "private TypeScript helper",
    "box.proc": "private TypeScript helper",
    "box.request": "private TypeScript helper",
    "box.socket": "private TypeScript helper",
    "box.socketUrl": "private TypeScript helper",
    "box.streamEvents": "private TypeScript helper",
    "box.withAbsoluteUrl": "private TypeScript helper",
    "mail.mintWsTicket": "private TypeScript helper; use mail.create_realtime_ticket",
    "notify.fetch": "private TypeScript helper",
    "notify.requestOptions": "private TypeScript helper",
    "managedAgents.sessions.streamConnection": "private TypeScript helper",
    # WebSocket helpers: the Python client returns the URLs (box.access_token) instead.
    "box.openTerminal": "WebSocket helper; use box.access_token",
    "box.openTunnel": "WebSocket helper; use box.access_token",
    "mail.connectRealtime": "WebSocket helper; poll mail.events.list or use a Mail webhook",
    "mail.connectRealtimeWithTicket": "WebSocket helper; use mail.create_realtime_ticket",
}

_SPECIAL = {"openAICompatible": "openai_compatible", "managedAgents": "managed_agents"}


def _snake(segment: str) -> str:
    if segment in _SPECIAL:
        return _SPECIAL[segment]
    return re.sub(r"(?<!^)([A-Z])", r"_\1", segment).lower()


def test_committed_surface_matches_the_client():
    committed = json.loads((PACKAGE / "surface.json").read_text())
    assert committed == surface_document(), (
        "surface.json is stale: run `PYTHONPATH=bindings/python python -m ryu_sdk.services._surface "
        "> bindings/python/ryu_sdk/services/surface.json`"
    )


def test_every_canonical_typescript_path_exists_in_python():
    python_paths = set(surface())
    missing = []
    for path in VECTORS["surface"]:
        if path in OMITTED:
            continue
        python_path = ".".join(_snake(segment) for segment in path.split("."))
        if python_path not in python_paths:
            missing.append(f"{path} -> {python_path}")
    assert missing == []


def test_omissions_still_exist_in_typescript():
    stale = sorted(path for path in OMITTED if path not in VECTORS["surface"])
    assert stale == []


def test_with_options_and_safe_are_on_every_namespace():
    paths = set(surface())
    for namespace in (
        "managed_agents",
        "messaging",
        "mail",
        "notify",
        "box",
        "gateway",
        "connect",
        "passport",
        "sites",
    ):
        assert f"{namespace}.with_options" in paths
    assert "safe" in paths and "webhooks.verify" in paths
