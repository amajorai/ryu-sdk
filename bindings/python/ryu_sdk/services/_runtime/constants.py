"""Constants of the request engine: the SDK version, default headers and capability timings.

``scripts/release/bump-version.sh`` rewrites :data:`SDK_VERSION` in this file.
"""

from __future__ import annotations

import sys
from typing import Optional

#: The ryu-sdk version sent in the User-Agent.
SDK_VERSION = "0.5.0"

#: Sent when a request sets no ``Accept``; services that negotiate RFC 9457 answer problem+json.
DEFAULT_ACCEPT = "application/problem+json, application/json;q=0.9, */*;q=0.8"

_CREDENTIAL_HEADERS = ("authorization", "x-api-key", "x-gateway-key")
_DEPRECATION_SEEN_LIMIT = 256
_NO_BODY = object()

#: How long a definitive capability answer is trusted, in seconds (``CAPABILITY_TTL_MS``).
#: Bounded so a server rolled back to a build without the feature stops getting keyed retries.
CAPABILITY_TTL_S = 300.0
#: How long a 401/403 capability answer (no features) is kept (``CAPABILITY_AUTH_FAILURE_TTL_MS``).
CAPABILITY_AUTH_FAILURE_TTL_S = 30.0
#: The capability probe's own timeout, independent of the call's (``CAPABILITY_PROBE_TIMEOUT_MS``).
CAPABILITY_PROBE_TIMEOUT_S = 5.0
#: Largest error body a service error refiner sees (``MAX_REFINE_BODY_BYTES``).
MAX_REFINE_BODY_BYTES = 64 * 1024


def default_user_agent(extra: Optional[str] = None) -> str:
    version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    base = f"ryu-services-python/{SDK_VERSION} (python/{version})"
    return f"{base} {extra}" if extra else base
