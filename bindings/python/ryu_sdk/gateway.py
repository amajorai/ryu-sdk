"""Gateway configuration and the egress rule, for the pure-Python SDK.

Every model call routes through the Ryu Gateway; direct provider base URLs are
rejected so SDK code can never leak provider credentials or bypass policy. When
the native UniFFI module is built, its ``assert_allowed_egress`` (the shared
Rust kernel, ``crates/sdk/core/src/gateway.rs``) is the authority. Without it,
the same blocklist is applied here; ``test_python_sdk.py`` keeps the two lists
in lockstep.
"""

from __future__ import annotations

import os
import re
from typing import Callable, Optional

#: Default base URL for the local Ryu gateway (matches Core's DEFAULT_GATEWAY_URL).
DEFAULT_GATEWAY_URL = "http://127.0.0.1:7981"
#: Env var pointing the SDK at the gateway base URL (no trailing ``/v1``).
ENV_GATEWAY_URL = "RYU_GATEWAY_URL"
#: Env var carrying an optional gateway bearer token.
ENV_GATEWAY_TOKEN = "RYU_GATEWAY_TOKEN"
#: Env var pointing the SDK at a Core node.
ENV_CORE_URL = "RYU_CORE_URL"
#: The older Core bearer-token variable; still read, after :data:`ENV_CORE_TOKENS`' first name.
ENV_CORE_TOKEN = "RYU_TOKEN"
#: The Core bearer-token variables, in the order they are read (matches ``@ryuhq/sdk``,
#: ``ryu install``, ``ryu-cli`` and ``ryu-mcp``).
ENV_CORE_TOKENS = ("RYU_CORE_TOKEN", ENV_CORE_TOKEN)

#: Mirrors ``BLOCKED_PROVIDER_PATTERNS`` in ``crates/sdk/core/src/gateway.rs``.
BLOCKED_PROVIDER_PATTERNS = (
    r"api\.openai\.com",
    r"api\.anthropic\.com",
    r"generativelanguage\.googleapis\.com",
    r"api\.cohere\.ai",
    r"api\.mistral\.ai",
    r"openrouter\.ai",
    r"api\.groq\.com",
    r"api\.together\.xyz",
    r"api\.replicate\.com",
    r"api\.perplexity\.ai",
)

_BLOCKED = tuple(re.compile(pattern, re.IGNORECASE) for pattern in BLOCKED_PROVIDER_PATTERNS)


class EgressNotAllowedError(ValueError):
    """Raised when a base URL points at a blocked direct-provider endpoint."""


def _env(name: str) -> Optional[str]:
    value = os.environ.get(name, "").strip()
    return value or None


def resolve_gateway_url() -> str:
    """``RYU_GATEWAY_URL`` when set and non-empty, else :data:`DEFAULT_GATEWAY_URL`."""
    return _env(ENV_GATEWAY_URL) or DEFAULT_GATEWAY_URL


def resolve_gateway_token() -> Optional[str]:
    """``RYU_GATEWAY_TOKEN`` when set and non-empty."""
    return _env(ENV_GATEWAY_TOKEN)


def resolve_core_url() -> str:
    """``RYU_CORE_URL`` when set, else the local Core (``http://127.0.0.1:7980``)."""
    return _env(ENV_CORE_URL) or "http://127.0.0.1:7980"


def pick_core_url(base_url: Optional[str], node_url: Optional[str] = None) -> Optional[str]:
    """The Core URL from ``base_url``, else the deprecated ``node_url``, without a trailing slash.

    Blank values count as unset; ``None`` when neither is given. Passing both with
    different values (after trimming and dropping trailing slashes) raises
    :class:`ValueError`, so a stale ``node_url`` cannot silently lose to
    ``base_url``. Matches ``pickCoreUrl`` in ``@ryuhq/sdk``.
    """
    base = (base_url or "").strip().rstrip("/") or None
    node = (node_url or "").strip().rstrip("/") or None
    if base is not None and node is not None and base != node:
        raise ValueError("pass the Core URL as base_url or node_url, not both with different values")
    return base if base is not None else node


def resolve_core_token() -> Optional[str]:
    """``RYU_CORE_TOKEN``, then ``RYU_TOKEN``; ``None`` when neither is set and non-empty."""
    for name in ENV_CORE_TOKENS:
        value = _env(name)
        if value is not None:
            return value
    return None


def _native_assert() -> Optional[Callable[[str], None]]:
    try:
        from .ryu_sdk import assert_allowed_egress
    except (ImportError, OSError):
        return None
    native: Callable[[str], None] = assert_allowed_egress
    return native


def _message(url: str) -> str:
    return (
        f'[ryu-sdk] direct provider egress is not allowed: "{url}". All model calls must '
        f"route through the Ryu gateway. Set {ENV_GATEWAY_URL} to your gateway base URL, or "
        f"omit base_url to use the default ({DEFAULT_GATEWAY_URL}). Provider credentials "
        "belong in the gateway, not in SDK config."
    )


def assert_allowed_egress(base_url: str) -> None:
    """Raise :class:`EgressNotAllowedError` when ``base_url`` is a direct provider."""
    native = _native_assert()
    if native is not None:
        try:
            native(base_url)
        except Exception as error:  # the generated RyuError
            raise EgressNotAllowedError(_message(base_url)) from error
        return
    for pattern in _BLOCKED:
        if pattern.search(base_url):
            raise EgressNotAllowedError(_message(base_url))
