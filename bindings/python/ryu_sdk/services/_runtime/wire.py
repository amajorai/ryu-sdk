"""Wire-level helpers: header encoding, capped error-body reads and small response readers."""

from __future__ import annotations

import datetime
import json
from typing import Any, Optional, Union

import httpx

from ..errors import MAX_ERROR_BODY_BYTES, redact_url
from ..transport import origin_of
from .constants import MAX_REFINE_BODY_BYTES

_HEADER_TOKEN = frozenset("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")


def wire_header_name(name: Any) -> Optional[str]:
    """``name`` when it is an HTTP token (as ``fetch`` requires), otherwise ``None``."""
    return name if isinstance(name, str) and name and all(char in _HEADER_TOKEN for char in name) else None


def wire_header_value(value: Any) -> Optional[Union[str, bytes]]:
    """A header value as ``fetch`` sends it: ASCII text unchanged, other Latin-1 text as its
    Latin-1 bytes (``fetch`` header values are byte strings), bytes unchanged; ``None`` for a
    value ``fetch`` refuses (a character outside Latin-1, CR, LF or NUL, or not text at all)."""
    if isinstance(value, bytes):
        return None if any(byte in value for byte in b"\r\n\x00") else value
    if not isinstance(value, str) or any(char in value for char in "\r\n\x00"):
        return None
    if value.isascii():
        return value
    try:
        return value.encode("latin-1")
    except UnicodeEncodeError:
        return None


def _keep_error_body(response: httpx.Response, chunks: list[bytes]) -> None:
    # httpx's read()/aread() return ``_content`` once it is set, so a later read of this
    # response (the Managed Agents stream loop reads its error responses) never touches the
    # discarded remainder; ``.content``/``.text``/``.json()`` serve the capped bytes.
    response._content = b"".join(chunks)


def read_error_body(response: httpx.Response) -> None:
    """Reads an error response's body up to :data:`MAX_ERROR_BODY_BYTES` plus one chunk and keeps
    it as ``response.content``; the caller closes the response, discarding the rest unread."""
    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_bytes():
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_ERROR_BODY_BYTES:
            break
    _keep_error_body(response, chunks)


async def aread_error_body(response: httpx.Response) -> None:
    """The async :func:`read_error_body`."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_ERROR_BODY_BYTES:
            break
    _keep_error_body(response, chunks)


def _json_body(content: Optional[bytes]) -> Any:
    """An error body parsed as JSON, or ``None`` when it is not JSON or larger than
    :data:`MAX_REFINE_BODY_BYTES`."""
    if not content or len(content) > MAX_REFINE_BODY_BYTES:
        return None
    try:
        return json.loads(content)
    except ValueError:
        return None


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _joined(headers: httpx.Headers, name: str) -> Optional[str]:
    values = headers.get_list(name)
    return ", ".join(values) if values else None


def _location_origin(response: httpx.Response, url: str) -> Optional[str]:
    location = response.headers.get("location")
    if location is None:
        return None
    try:
        return origin_of(str(httpx.URL(url).join(location)))
    except (httpx.InvalidURL, ValueError):
        return None


def _scrub(message: str, url: str, api_key: Optional[str]) -> str:
    scrubbed = message.replace(url, redact_url(url))
    if api_key:
        scrubbed = scrubbed.replace(api_key, "[redacted]")
    return scrubbed
