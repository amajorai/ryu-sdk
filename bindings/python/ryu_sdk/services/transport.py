"""Transport rules shared by every service client.

Pure functions, mirroring ``packages/services/src/transport/*.ts`` and
``packages/services/src/<svc>/routes.ts`` so the Python and TypeScript SDKs
make the same decisions:

- ``Retry-After`` (delta-seconds or HTTP-date) and the IETF RateLimit fields
  (``RateLimit: "<name>";r=<n>;t=<s>``, ``RateLimit-Policy: "<name>";q=<n>;w=<s>``);
- deprecation signalling (``Deprecation``, ``Sunset``, ``Link`` rels);
- the replay-safety rule and the retry decision (408/425/500/502/503/504 and
  network failures only when replay-safe; 429 for any method only when the
  server said how long to wait; 409 ``idempotency_in_progress``; never the
  codes in :data:`NON_RETRYABLE_CODES` or a 402);
- backoff (``min(8s, 0.5s * 2**n)`` with jitter in [0.5, 1]);
- the idempotent route tables (``Idempotency-Key`` only on these POST/PATCH
  routes), the capability-gated routes (keyed only once the server advertised
  a feature flag), the non-replay-safe writes, and their matchers.
"""

from __future__ import annotations

import email.utils
import math
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional, TypeVar
from urllib.parse import urlsplit

# ── Retry-After and RateLimit ─────────────────────────────────────────────────

_DELTA_SECONDS = re.compile(r"^\d+$")
_HAS_LETTER = re.compile(r"[a-z]", re.IGNORECASE)
_SF_INTEGER = re.compile(r"^-?\d+$")


def _http_date(value: str) -> Optional[datetime]:
    if not _HAS_LETTER.search(value):
        return None
    try:
        moment = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def parse_retry_after(value: Optional[str], now: Optional[float] = None) -> Optional[int]:
    """``Retry-After`` in whole seconds from now; ``None`` when absent or unparseable, 0 for a past date."""
    if value is None:
        return None
    trimmed = value.strip()
    if trimmed == "":
        return None
    if _DELTA_SECONDS.match(trimmed):
        return int(trimmed)
    moment = _http_date(trimmed)
    if moment is None:
        return None
    current = time.time() if now is None else now
    return max(0, math.ceil(moment.timestamp() - current))


@dataclass(frozen=True)
class RateLimit:
    """A rate-limit snapshot from one response (``RateLimit`` joined with ``RateLimit-Policy``)."""

    limit: Optional[int]
    policy: Optional[str]
    remaining: Optional[int]
    reset_seconds: Optional[int]
    window_seconds: Optional[int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "limit": self.limit,
            "policy": self.policy,
            "remaining": self.remaining,
            "resetSeconds": self.reset_seconds,
            "windowSeconds": self.window_seconds,
        }


def _read_sf_string(text: str, start: int) -> tuple[str, int]:
    value = []
    index = start + 1
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            value.append(text[index + 1])
            index += 2
            continue
        if char == '"':
            return "".join(value), index + 1
        value.append(char)
        index += 1
    return "".join(value), index


def _split_members(text: str) -> list[str]:
    members: list[str] = []
    current = ""
    index = 0
    while index < len(text):
        char = text[index]
        if char == '"':
            _, end = _read_sf_string(text, index)
            current += text[index:end]
            index = end
            continue
        if char == ",":
            members.append(current)
            current = ""
        else:
            current += char
        index += 1
    members.append(current)
    return [member.strip() for member in members if member.strip()]


def _parse_sf_item(member: str) -> Optional[tuple[str, dict[str, str]]]:
    if member.startswith('"'):
        value, index = _read_sf_string(member, 0)
    else:
        semicolon = member.find(";")
        index = len(member) if semicolon == -1 else semicolon
        value = member[:index].strip()
    if value == "":
        return None
    params: dict[str, str] = {}
    for part in member[index:].split(";"):
        trimmed = part.strip()
        if trimmed == "":
            continue
        equals = trimmed.find("=")
        key = (trimmed if equals == -1 else trimmed[:equals]).strip().lower()
        raw = "?1" if equals == -1 else trimmed[equals + 1 :].strip()
        params[key] = _read_sf_string(raw, 0)[0] if raw.startswith('"') else raw
    return value, params


def _sf_integer(value: Optional[str]) -> Optional[int]:
    if value is None or not _SF_INTEGER.match(value):
        return None
    return int(value)


def _parse_sf_list(header: Optional[str]) -> list[tuple[str, dict[str, str]]]:
    if not header:
        return []
    items = []
    for member in _split_members(header):
        item = _parse_sf_item(member)
        if item is not None:
            items.append(item)
    return items


def parse_rate_limit(header: Optional[str]) -> list[dict[str, Any]]:
    """Every item of a ``RateLimit`` field."""
    return [
        {"policy": name, "remaining": _sf_integer(params.get("r")), "reset_seconds": _sf_integer(params.get("t"))}
        for name, params in _parse_sf_list(header)
    ]


def parse_rate_limit_policy(header: Optional[str]) -> list[dict[str, Any]]:
    """Every item of a ``RateLimit-Policy`` field."""
    return [
        {"policy": name, "quota": _sf_integer(params.get("q")), "window_seconds": _sf_integer(params.get("w"))}
        for name, params in _parse_sf_list(header)
    ]


def read_rate_limit(ratelimit: Optional[str], policy_header: Optional[str]) -> Optional[RateLimit]:
    """The first ``RateLimit`` item joined with the policy of the same name; ``None`` when neither field is present."""
    limits = parse_rate_limit(ratelimit)
    policies = parse_rate_limit_policy(policy_header)
    current = limits[0] if limits else None
    if current is not None:
        policy = next((item for item in policies if item["policy"] == current["policy"]), None)
    else:
        policy = policies[0] if policies else None
    if current is None and policy is None:
        return None
    return RateLimit(
        limit=policy["quota"] if policy else None,
        policy=current["policy"] if current else (policy["policy"] if policy else None),
        remaining=current["remaining"] if current else None,
        reset_seconds=current["reset_seconds"] if current else None,
        window_seconds=policy["window_seconds"] if policy else None,
    )


# ── Deprecation ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Deprecation:
    """What a response said about its route's deprecation."""

    deprecated_at: Optional[datetime]
    policy_url: Optional[str]
    successor_url: Optional[str]
    sunset_at: Optional[datetime]

    def to_dict(self) -> dict[str, Any]:
        def iso(value: Optional[datetime]) -> Optional[str]:
            if value is None:
                return None
            return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        return {
            "deprecatedAt": iso(self.deprecated_at),
            "policyUrl": self.policy_url,
            "successorUrl": self.successor_url,
            "sunsetAt": iso(self.sunset_at),
        }


_SF_DATE = re.compile(r"^@(-?\d+)$")
_LINK_VALUE = re.compile(r"^<([^>]*)>(.*)$", re.DOTALL)


def parse_deprecation_date(value: Optional[str]) -> Optional[datetime]:
    """``Deprecation``: ``@<unix seconds>`` or an HTTP-date."""
    if not value:
        return None
    trimmed = value.strip()
    match = _SF_DATE.match(trimmed)
    if match:
        return datetime.fromtimestamp(int(match.group(1)), tz=timezone.utc)
    return _http_date(trimmed)


def _split_link_values(header: str) -> list[str]:
    values: list[str] = []
    current = ""
    in_url = False
    in_quote = False
    for char in header:
        if char == "<" and not in_quote:
            in_url = True
        elif char == ">" and not in_quote:
            in_url = False
        elif char == '"' and not in_url:
            in_quote = not in_quote
        if char == "," and not (in_url or in_quote):
            values.append(current)
            current = ""
            continue
        current += char
    values.append(current)
    return [value.strip() for value in values if value.strip()]


def _unquote(value: str) -> str:
    trimmed = value.strip()
    if trimmed.startswith('"') and trimmed.endswith('"') and len(trimmed) > 1:
        return re.sub(r"\\(.)", r"\1", trimmed[1:-1])
    return trimmed


def parse_link_header(header: Optional[str]) -> list[dict[str, Any]]:
    """Parses an RFC 8288 Link field into ``{url, rels, params}`` dicts."""
    if not header:
        return []
    links = []
    for value in _split_link_values(header):
        match = _LINK_VALUE.match(value)
        if not match:
            continue
        params: dict[str, str] = {}
        for part in match.group(2).split(";"):
            equals = part.find("=")
            if equals == -1:
                continue
            key = part[:equals].strip().lower()
            if key:
                params[key] = _unquote(part[equals + 1 :])
        links.append(
            {
                "params": params,
                "rels": [rel for rel in params.get("rel", "").lower().split() if rel],
                "url": match.group(1).strip(),
            }
        )
    return links


def parse_deprecation(deprecation: Optional[str], sunset: Optional[str], link: Optional[str]) -> Optional[Deprecation]:
    """The deprecation state a response announces, or ``None`` without ``Deprecation`` or ``Sunset``."""
    if deprecation is None and sunset is None:
        return None
    links = parse_link_header(link)

    def rel(name: str) -> Optional[str]:
        return next((item["url"] for item in links if name in item["rels"]), None)

    return Deprecation(
        deprecated_at=parse_deprecation_date(deprecation),
        policy_url=rel("deprecation"),
        successor_url=rel("successor-version"),
        sunset_at=_http_date(sunset.strip()) if sunset else None,
    )


# ── Retry policy ──────────────────────────────────────────────────────────────

#: Codes that a retry cannot fix (lockstep with packages/services/src/transport/retry.ts).
NON_RETRYABLE_CODES = frozenset(
    {
        "quota_exceeded",
        "insufficient_credits",
        "spend_limit_reached",
        "managed_agents_disabled",
        "feature_disabled",
        "not_configured",
        "metering_unavailable",
        "outcome_unknown",
        "provider_refused",
        "too_many_streams",
        "stream_limit_reached",
        "address_change_cooldown",
        "backend_disabled",
        "secrets_unavailable",
        "driver_not_safe",
        "upstream_unconfigured",
        "upstream_invalid",
        "skills_unavailable",
        "idempotency_key_resource_deleted",
    }
)

#: Statuses retried when the request is replay-safe.
RETRYABLE_STATUSES = frozenset({408, 425, 500, 502, 503, 504})

_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})

#: The code a server sends while the first request with the same key is still running.
IDEMPOTENCY_IN_PROGRESS = "idempotency_in_progress"

_MAX_BACKOFF_S = 8.0
_BASE_BACKOFF_S = 0.5


def is_replay_safe(method: str, has_route_idempotency_key: bool, replayable_body: bool = True) -> bool:
    """Whether sending this request twice cannot have a different effect from sending it once."""
    return (method.upper() in _IDEMPOTENT_METHODS or has_route_idempotency_key) and replayable_body


def is_retryable_failure(status: int, code: Optional[str]) -> bool:
    """Whether the status and code describe a failure worth retrying at all (ignoring replay safety)."""
    if code is not None and code in NON_RETRYABLE_CODES:
        return False
    if status == 402:
        return False
    if status == 0 or status == 429 or status in RETRYABLE_STATUSES:
        return True
    return status == 409 and code == IDEMPOTENCY_IN_PROGRESS


@dataclass(frozen=True)
class RetryHints:
    """Server hints that say how long to wait, all in seconds."""

    retry_after_seconds: Optional[float] = None
    rate_limit_remaining: Optional[int] = None
    rate_limit_reset_seconds: Optional[float] = None
    body_retry_after_seconds: Optional[float] = None

    def exhausted_reset(self) -> Optional[float]:
        return self.rate_limit_reset_seconds if self.rate_limit_remaining == 0 else None


def should_retry(
    status: int,
    code: Optional[str],
    hints: RetryHints,
    *,
    replay_safe: bool,
    replayable_body: bool = True,
) -> bool:
    """Whether the transport should send this request again."""
    if not is_retryable_failure(status, code):
        return False
    if status == 429:
        hinted = (
            hints.retry_after_seconds is not None
            or hints.exhausted_reset() is not None
            or hints.body_retry_after_seconds is not None
        )
        return hinted and replayable_body
    return replay_safe


def compute_delay(retry_index: int, hints: RetryHints, random: Callable[[], float]) -> tuple[float, str]:
    """``(seconds, source)`` before retry number ``retry_index`` (0 for the first retry).

    First match wins: ``Retry-After``, then the RateLimit reset when ``r=0``,
    then the body hint, then backoff with jitter.
    """
    if hints.retry_after_seconds is not None:
        return float(hints.retry_after_seconds), "retry-after"
    reset = hints.exhausted_reset()
    if reset is not None:
        return float(reset), "ratelimit"
    if hints.body_retry_after_seconds is not None:
        return float(hints.body_retry_after_seconds), "body"
    base = min(_MAX_BACKOFF_S, _BASE_BACKOFF_S * (2**retry_index))
    jitter = 0.5 + random() * 0.5
    return round(base * jitter, 3), "backoff"


# ── Idempotent routes ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IdempotentRoute:
    """One route whose writes the server deduplicates by ``Idempotency-Key``."""

    method: str
    path: str
    required: bool


@dataclass(frozen=True)
class CapabilityIdempotentRoute(IdempotentRoute):
    """An idempotent route that only some server builds deduplicate.

    The transport keys it (and so may retry it) only after the server
    advertised ``capability`` as ``true``; when that is unknown or false the
    route gets no generated key and is never replayed (a caller's key is
    still forwarded).
    """

    capability: str = ""


@dataclass(frozen=True)
class NonReplaySafeRoute:
    """A write never resent after a network error, timeout or 5xx, although its
    method is idempotent (a ``PUT`` whose reply carries a one-time secret)."""

    method: str
    path: str
    reason: str


@dataclass(frozen=True)
class RouteTable:
    """A service's mount and its idempotent routes."""

    service: str
    mount: str
    idempotent: tuple[IdempotentRoute, ...]
    #: A top-level JSON body field that marks a replayed write (Notify, Box).
    replayed_body_field: Optional[str] = None
    replayed_body_value: Any = True
    #: Routes keyed only when the server advertises a capability.
    capability_idempotent: tuple[CapabilityIdempotentRoute, ...] = ()
    #: Writes never replayed after a network error, timeout or 5xx.
    non_replay_safe: tuple[NonReplaySafeRoute, ...] = ()


#: The ``features`` flag Passport sets when it honours ``Idempotency-Key`` on ``POST /v1/connections``.
PASSPORT_IDEMPOTENCY_CAPABILITY = "idempotency_keys"


def _routes(*rows: tuple[str, str, bool]) -> tuple[IdempotentRoute, ...]:
    return tuple(IdempotentRoute(method, path, required) for method, path, required in rows)


#: Every service's route table, keyed by service (lockstep with ``SERVICE_ROUTES``).
SERVICE_ROUTES: dict[str, RouteTable] = {
    "box": RouteTable(
        "box",
        "",
        _routes(("POST", "/v1/boxes", True), ("POST", "/v1/boxes/{id}/fork", True)),
        replayed_body_field="type",
        replayed_body_value="box.existing",
    ),
    "connect": RouteTable("connect", "", ()),
    "gateway": RouteTable("gateway", "", ()),
    "mail": RouteTable(
        "mail",
        "/api/mail",
        _routes(
            ("POST", "/inboxes/{id}/send", False),
            ("POST", "/inboxes/{id}/messages/{messageId}/reply", False),
            ("POST", "/inboxes/{id}/messages/{messageId}/reply-all", False),
            ("POST", "/inboxes/{id}/messages/{messageId}/forward", False),
            ("POST", "/inboxes/{id}/drafts/{draftId}/send", False),
            # Hosted-only rows (self-hosted Mail has no send approval or agent routes); one table serves both.
            ("POST", "/drafts/{id}/approve", False),
            ("POST", "/agents/{agentId}/send", False),
            ("POST", "/agents/{agentId}/messages/{messageId}/reply", False),
        ),
    ),
    "managedAgents": RouteTable(
        "managedAgents",
        "/api/v1/managed-agents",
        _routes(
            ("POST", "/agents", False),
            ("PATCH", "/agents/{id}", False),
            ("POST", "/environments", False),
            ("PATCH", "/environments/{id}", False),
            ("POST", "/credentials", False),
            ("POST", "/sessions", False),
            ("POST", "/sessions/{id}/events", False),
        ),
    ),
    "messaging": RouteTable(
        "messaging",
        "/api/messaging",
        _routes(
            ("POST", "/orgs/{orgId}/numbers", True),
            ("POST", "/orgs/{orgId}/sms", True),
            ("POST", "/orgs/{orgId}/mms", True),
            ("POST", "/orgs/{orgId}/voice", True),
            ("POST", "/orgs/{orgId}/whatsapp", True),
        ),
        non_replay_safe=(
            NonReplaySafeRoute(
                "PUT",
                "/orgs/{orgId}/settings",
                "The reply that first sets a webhook URL carries the new webhook secret once; a replay after a lost "
                "reply answers without it.",
            ),
        ),
    ),
    "notify": RouteTable(
        "notify",
        "",
        _routes(
            ("POST", "/v1/events", False),
            ("POST", "/v1/topics/{topic}", False),
            ("POST", "/v1/activities", True),
        ),
        replayed_body_field="idempotent",
    ),
    "passport": RouteTable(
        "passport",
        "",
        (),
        capability_idempotent=(
            CapabilityIdempotentRoute("POST", "/v1/connections", False, PASSPORT_IDEMPOTENCY_CAPABILITY),
        ),
    ),
    "sites": RouteTable(
        "sites",
        "/api/sites",
        (),
        non_replay_safe=(
            NonReplaySafeRoute(
                "PUT",
                "/projects/{id}/settings",
                "The write carries expectedRevision and moves it; a replay after a lost reply answers 409 conflict "
                "although the change applied.",
            ),
            NonReplaySafeRoute(
                "DELETE",
                "/projects/{id}",
                "The write carries expectedRevision and moves it before the Space database is removed; a replay "
                "answers 409 conflict, or can never succeed after a partial failure.",
            ),
        ),
    ),
}


def new_idempotency_key() -> str:
    """A fresh idempotency key (a UUID satisfies every service's key grammar)."""
    return str(uuid.uuid4())


def _template_matches(template: str, path: str) -> bool:
    expected = template.split("/")
    actual = path.split("/")
    if len(expected) != len(actual):
        return False
    for segment, value in zip(expected, actual):
        if segment.startswith("{") and segment.endswith("}"):
            if value == "":
                return False
        elif segment != value:
            return False
    return True


def origin_of(url: str) -> Optional[str]:
    """``scheme://host[:port]`` of an absolute URL, lower-cased, or ``None``."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if not (parts.scheme and parts.netloc) or parts.scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower()
    if not host:
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    default = {"http": 80, "https": 443}[parts.scheme]
    if ":" in host:
        host = f"[{host}]"
    return f"{parts.scheme}://{host}" if port in (None, default) else f"{parts.scheme}://{host}:{port}"


def relative_service_path(base_url: str, mount: str, request_url: str) -> Optional[str]:
    """The request path relative to the service mount, or ``None`` outside the service."""
    base_origin = origin_of(base_url)
    if base_origin is None or base_origin != origin_of(request_url):
        return None
    base_path = urlsplit(base_url).path.rstrip("/")
    prefix = f"{base_path}{mount}"
    path = urlsplit(request_url).path.rstrip("/") or "/"
    if prefix == "":
        return path
    if path == prefix:
        return "/"
    return path[len(prefix) :] if path.startswith(f"{prefix}/") else None


_RouteT = TypeVar("_RouteT", IdempotentRoute, CapabilityIdempotentRoute, NonReplaySafeRoute)


def _find_route(
    routes: tuple[_RouteT, ...], table: RouteTable, base_url: str, method: str, request_url: str
) -> Optional[_RouteT]:
    if not routes:
        return None
    upper = method.upper()
    path = relative_service_path(base_url, table.mount, request_url)
    if path is None:
        return None
    return next((route for route in routes if route.method == upper and _template_matches(route.path, path)), None)


def _is_keyable_method(method: str) -> bool:
    return method.upper() in ("POST", "PATCH")


def match_route(table: RouteTable, base_url: str, method: str, request_url: str) -> Optional[IdempotentRoute]:
    """The idempotent route ``method`` + ``request_url`` hits. Only POST and PATCH can match."""
    if not _is_keyable_method(method):
        return None
    return _find_route(table.idempotent, table, base_url, method, request_url)


def match_capability_route(
    table: RouteTable, base_url: str, method: str, request_url: str
) -> Optional[CapabilityIdempotentRoute]:
    """The capability-gated idempotent route ``method`` + ``request_url`` hits (POST and PATCH only).

    The caller decides whether the server advertised its capability.
    """
    if not _is_keyable_method(method):
        return None
    return _find_route(table.capability_idempotent, table, base_url, method, request_url)


def match_non_replay_safe_route(
    table: RouteTable, base_url: str, method: str, request_url: str
) -> Optional[NonReplaySafeRoute]:
    """The route-table entry that forbids replaying ``method`` + ``request_url``, or ``None``."""
    return _find_route(table.non_replay_safe, table, base_url, method, request_url)


def route_template(path: str) -> str:
    """A request path with resource ids folded to ``{id}``, so deprecation hooks fire once per route."""
    folded = []
    for segment in path.split("/"):
        is_version = re.match(r"^v\d+$", segment) is not None
        if not is_version and (re.search(r"\d", segment) or len(segment) >= 20 or "%" in segment):
            folded.append("{id}")
        else:
            folded.append(segment)
    return "/".join(folded)
