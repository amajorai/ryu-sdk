"""Each service's display name (lockstep with ``packages/services/src/service-titles.ts``).

It lives in its own module so the errors, runtime and webhooks modules can name
a service the way hints do ("Ryu Notify", not "Ryu notify") without importing
``config``.
"""

from __future__ import annotations

#: Each service's display name, as messages and hints print it.
SERVICE_TITLES: dict[str, str] = {
    "box": "Ryu Box",
    "connect": "Ryu Connect",
    "gateway": "Ryu Gateway",
    "mail": "Ryu Mail",
    "managedAgents": "Ryu Managed Agents",
    "messaging": "Ryu Messaging",
    "notify": "Ryu Notify",
    "passport": "Ryu Passport",
    "sites": "Ryu Sites",
}


def service_title(service: str) -> str:
    """``service``'s display name, or ``Ryu <service>`` for an id outside the table."""
    return SERVICE_TITLES.get(service, f"Ryu {service}")
