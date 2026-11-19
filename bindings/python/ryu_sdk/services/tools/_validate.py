"""Argument validation for the service tools, matching the TypeScript zod schemas.

The JSON Schema in ``manifest.json`` is what zod emits for each tool's input
(``z.toJSONSchema(schema, { io: "input" })``); :func:`parse_arguments` checks a
model's arguments against it the way zod would: unknown keys of an object are
dropped, defaults are filled in, and each issue carries zod's ``code``
(``invalid_type``, ``too_small``, ``too_big``, ``invalid_format``,
``invalid_value``, ``custom``) and a dotted ``path``. The cross-field rules
zod cannot express in JSON Schema (``.refine``) are ported in ``_REFINEMENTS``.
``tests/test_services_tools_registry.py`` runs the TypeScript-generated cases in
``tests/fixtures/services_tools_vectors.json`` through it.

String lengths count UTF-16 code units, as JavaScript's do.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import Any, Callable, Optional, Union

try:  # Python 3.8+
    from typing import TypedDict
except ImportError:  # pragma: no cover
    from typing_extensions import TypedDict


class ToolInputIssue(TypedDict):
    """One argument problem, as a tool error reports it in ``details.issues``."""

    code: str
    message: str
    #: The argument path, e.g. ``to.0`` or ``idempotencyKey``; empty for the whole input.
    path: str


Path = tuple[Union[str, int], ...]

_PATTERNS: dict[str, re.Pattern[str]] = {}

#: The characters JavaScript's `\s` matches (WhiteSpace plus LineTerminator), as the body of a
#: character class. Python's `\s` differs both ways: under `re.ASCII` it misses U+00A0, U+FEFF and
#: the other Unicode spaces, and without it it adds U+001C-U+001F and U+0085.
_JS_WHITESPACE = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"


def _js_whitespace_classes(source: str) -> str:
    """Spell a JavaScript pattern's `\\s` and `\\S` as the explicit classes JavaScript means."""
    out: list[str] = []
    in_class = False
    index = 0
    while index < len(source):
        char = source[index]
        if char == "\\" and index + 1 < len(source):
            escaped = source[index + 1]
            if escaped == "s":
                out.append(_JS_WHITESPACE if in_class else f"[{_JS_WHITESPACE}]")
            elif escaped == "S" and not in_class:
                out.append(f"[^{_JS_WHITESPACE}]")
            elif escaped == "S":
                # No tool schema puts `\\S` inside a class; refuse it rather than guess.
                raise ValueError(f"Unsupported `\\S` inside a character class: {source!r}")
            else:
                out.append(source[index : index + 2])
            index += 2
            continue
        if char == "[" and not in_class:
            in_class = True
        elif char == "]" and in_class:
            in_class = False
        out.append(char)
        index += 1
    return "".join(out)


def _pattern(source: str) -> re.Pattern[str]:
    compiled = _PATTERNS.get(source)
    if compiled is None:
        # JavaScript's `$` (no `m` flag) matches only at the very end; Python's also before a final
        # newline. `\d` is ASCII-only in a JavaScript `u` regex, and `\s`/`\S` mean JavaScript's
        # Unicode whitespace set.
        translated = source[:-1] + r"\Z" if source.endswith("$") and not source.endswith("\\$") else source
        compiled = re.compile(_js_whitespace_classes(translated), re.ASCII)
        _PATTERNS[source] = compiled
    return compiled


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, Mapping):
        return "object"
    return type(value).__name__


def _matches_type(expected: str, value: Any) -> bool:
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool) and not math.isnan(value)
    if expected == "integer":
        if isinstance(value, bool):
            return False
        return isinstance(value, int) or (isinstance(value, float) and value.is_integer())
    if expected == "array":
        return isinstance(value, (list, tuple))
    if expected == "object":
        return isinstance(value, Mapping)
    if expected == "null":
        return value is None
    return True


class _Checker:
    def __init__(self) -> None:
        self.issues: list[ToolInputIssue] = []

    def add(self, code: str, path: Path, message: str) -> None:
        self.issues.append({"code": code, "path": ".".join(str(part) for part in path), "message": message})

    def check(self, schema: Mapping[str, Any], value: Any, path: Path) -> Any:
        """Returns the parsed value (defaults filled, unknown keys dropped); records issues."""
        if "anyOf" in schema:
            return self._any_of(schema["anyOf"], value, path)
        expected = schema.get("type")
        if isinstance(expected, str) and not _matches_type(expected, value):
            what = "integer" if expected == "integer" and _type_name(value) == "number" else expected
            self.add("invalid_type", path, f"Invalid input: expected {what}, received {_type_name(value)}.")
            return value
        if "enum" in schema and value not in schema["enum"]:
            allowed = ", ".join(repr(item) for item in schema["enum"])
            self.add("invalid_value", path, f"Invalid option: expected one of {allowed}.")
            return value
        if isinstance(value, str):
            return self._string(schema, value, path)
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            self._number(schema, value, path)
            return int(value) if expected == "integer" else value
        if isinstance(value, (list, tuple)):
            return self._array(schema, value, path)
        if isinstance(value, Mapping):
            return self._object(schema, value, path)
        return value

    def _any_of(self, branches: Sequence[Mapping[str, Any]], value: Any, path: Path) -> Any:
        for branch in branches:
            attempt = _Checker()
            parsed = attempt.check(branch, value, path)
            if not attempt.issues:
                return parsed
        self.add("invalid_union", path, "Invalid input: it matches none of the allowed shapes.")
        return value

    def _string(self, schema: Mapping[str, Any], value: str, path: Path) -> str:
        length = _utf16_length(value)
        if "minLength" in schema and length < schema["minLength"]:
            self.add("too_small", path, f"Too small: expected at least {schema['minLength']} characters.")
        if "maxLength" in schema and length > schema["maxLength"]:
            self.add("too_big", path, f"Too big: expected at most {schema['maxLength']} characters.")
        if "pattern" in schema and _pattern(schema["pattern"]).search(value) is None:
            self.add("invalid_format", path, f"Invalid string: must match pattern /{schema['pattern']}/.")
        if schema.get("format") == "uri":
            if not _is_url(value):
                self.add("invalid_format", path, "Invalid URL.")
                return value
            # zod parses the trimmed URL and returns it trimmed.
            return value.strip()
        return value

    def _number(self, schema: Mapping[str, Any], value: float, path: Path) -> None:
        if "minimum" in schema and value < schema["minimum"]:
            self.add("too_small", path, f"Too small: expected a number >= {schema['minimum']}.")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            self.add("too_small", path, f"Too small: expected a number > {schema['exclusiveMinimum']}.")
        if "maximum" in schema and value > schema["maximum"]:
            self.add("too_big", path, f"Too big: expected a number <= {schema['maximum']}.")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            self.add("too_big", path, f"Too big: expected a number < {schema['exclusiveMaximum']}.")

    def _array(self, schema: Mapping[str, Any], value: Sequence[Any], path: Path) -> list[Any]:
        if "minItems" in schema and len(value) < schema["minItems"]:
            self.add("too_small", path, f"Too small: expected at least {schema['minItems']} items.")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            self.add("too_big", path, f"Too big: expected at most {schema['maxItems']} items.")
        items = schema.get("items")
        if not isinstance(items, Mapping):
            return list(value)
        return [self.check(items, item, (*path, index)) for index, item in enumerate(value)]

    def _object(self, schema: Mapping[str, Any], value: Mapping[str, Any], path: Path) -> dict[str, Any]:
        properties = schema.get("properties")
        extra = schema.get("additionalProperties")
        out: dict[str, Any] = {}
        if isinstance(properties, Mapping):
            required = schema.get("required") or []
            for name, child in properties.items():
                if name in value:
                    out[name] = self.check(child, value[name], (*path, name))
                elif "default" in child:
                    out[name] = child["default"]
                elif name in required:
                    expected = child.get("type", "value")
                    self.add("invalid_type", (*path, name), f"Invalid input: expected {expected}, received undefined.")
        if isinstance(extra, Mapping):
            names = schema.get("propertyNames")
            for key, item in value.items():
                if isinstance(properties, Mapping) and key in properties:
                    continue
                if isinstance(names, Mapping):
                    before = len(self.issues)
                    self.check(names, key, (*path, key))
                    if len(self.issues) > before:
                        del self.issues[before:]
                        self.add("invalid_key", (*path, key), "Invalid key in record.")
                        continue
                out[key] = self.check(extra, item, (*path, key))
        return out


#: Schemes the WHATWG URL parser gives a host it requires (``file`` may have an empty host).
_SPECIAL_SCHEMES = frozenset({"http", "https", "ws", "wss", "ftp"})
#: Characters a domain may not contain after percent-decoding (WHATWG "forbidden domain code points").
_FORBIDDEN_DOMAIN = frozenset(" #%/:<>?@[\\]^|\x7f") | frozenset(chr(code) for code in range(0x20))
_URL_START = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*):(.*)\Z", re.DOTALL)
_PERCENT = re.compile(r"%([0-9A-Fa-f]{2})")
_IPV4_PART = re.compile(r"(0[xX][0-9A-Fa-f]*|[0-9]+)\Z")


def _ipv4_ok(host: str) -> Optional[bool]:
    """``None`` when ``host`` is not IPv4-shaped (its last label is not a number); else whether the
    WHATWG IPv4 parser accepts it (``1.2.3.256`` and ``1.2.3.4.5`` fail)."""
    labels = host[:-1].split(".") if host.endswith(".") and host != "." else host.split(".")
    if not labels or _IPV4_PART.match(labels[-1]) is None:
        return None
    if len(labels) > 4 or any(_IPV4_PART.match(label) is None for label in labels):
        return False
    numbers = []
    for label in labels:
        if label[:2] in ("0x", "0X"):
            numbers.append(int(label[2:] or "0", 16))
        elif len(label) > 1 and label.startswith("0"):
            if any(digit not in "01234567" for digit in label):
                return False
            numbers.append(int(label, 8))
        else:
            numbers.append(int(label))
    if any(number > 255 for number in numbers[:-1]):
        return False
    return bool(numbers[-1] < 256 ** (5 - len(numbers)))


def _host_ok(host: str) -> bool:
    if host.startswith("["):
        inner = host[1:-1] if host.endswith("]") else None
        return bool(inner) and all(char in "0123456789abcdefABCDEF:." for char in inner)  # type: ignore[union-attr]
    if not host:
        return False
    try:
        decoded = _PERCENT.sub(lambda match: chr(int(match.group(1), 16)), host)
    except ValueError:  # pragma: no cover - the pattern only matches hex
        return False
    if any(char in _FORBIDDEN_DOMAIN for char in decoded):
        return False
    ipv4 = _ipv4_ok(decoded)
    return True if ipv4 is None else ipv4


def _is_url(value: str) -> bool:
    """Whether zod's ``z.url()`` accepts ``value``: whether ``new URL(value.trim())`` parses.

    A port of the WHATWG URL parser's failure cases: a scheme is required; the special schemes
    (``http``, ``https``, ``ws``, ``wss``, ``ftp``) need a valid host and a numeric port at most
    65535; ``file:`` and every other scheme (``mailto:``, ``javascript:``, ``foo:``) parse with
    anything after the colon.
    """
    text = re.sub(r"[\t\n\r]", "", value.strip().strip("".join(chr(code) for code in range(0x21))))
    match = _URL_START.match(text)
    if match is None:
        return False
    scheme, rest = match.group(1).lower(), match.group(2)
    if scheme not in _SPECIAL_SCHEMES:
        return True
    authority = re.split(r"[/\\?#]", rest.lstrip("/\\"), maxsplit=1)[0]
    host_port = authority.rpartition("@")[2]
    if host_port.startswith("["):
        host, _bracket, after = host_port.partition("]")
        host, port = host + "]", after.removeprefix(":")
        if after and not after.startswith(":"):
            return False
    else:
        host, _colon, port = host_port.partition(":")
    if port and (not port.isascii() or not port.isdigit() or int(port) > 65535):
        return False
    return _host_ok(host)


# ── Refinements (the TypeScript schemas' .refine rules) ───────────────────────

Refinement = Callable[[dict[str, Any], "_Checker", Sequence[str]], None]

_MAIL_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}\Z", re.ASCII)


def _field_ok(failed: Sequence[str], name: str) -> bool:
    return name not in failed


def _mail_send(value: dict[str, Any], checker: _Checker, failed: Sequence[str]) -> None:
    sender = value.get("from")
    if _field_ok(failed, "from") and isinstance(sender, str) and "@" not in sender and not _MAIL_ID.search(sender):
        checker.add("custom", ("from",), "from is a sender address or an inbox id (letters, digits, `_` and `-`).")
    key = value.get("idempotencyKey")
    if _field_ok(failed, "idempotencyKey") and isinstance(key, str) and key.strip() == "":
        checker.add("custom", ("idempotencyKey",), "idempotencyKey must not be blank.")


def _mail_send_object(value: dict[str, Any], checker: _Checker, _failed: Sequence[str]) -> None:
    if ("text" in value) == ("html" in value):
        checker.add("custom", ("text",), "Give exactly one of text or html.")


def _messaging_send_sms(value: dict[str, Any], checker: _Checker, failed: Sequence[str]) -> None:
    from ._manifest import CONSTANTS

    limit = CONSTANTS["MESSAGING_METADATA_MAX_ENTRIES"]
    metadata = value.get("metadata")
    if _field_ok(failed, "metadata") and isinstance(metadata, Mapping) and len(metadata) > limit:
        checker.add("custom", ("metadata",), f"metadata holds at most {limit} entries.")


def _notify_usage_object(value: dict[str, Any], checker: _Checker, _failed: Sequence[str]) -> None:
    if ("from" in value) != ("to" in value):
        checker.add("custom", ("to",), "Pass both from and to, or neither.")


def _sites_deploy_object(value: dict[str, Any], checker: _Checker, _failed: Sequence[str]) -> None:
    if ("html" in value) == ("versionId" in value):
        checker.add("custom", ("html",), "Give exactly one of html or versionId.")


_SITES_SETTINGS_FIELDS = ("audience", "viewers", "workspaceId", "optionalSignIn", "allowRemix")


def _sites_update_settings_object(value: dict[str, Any], checker: _Checker, _failed: Sequence[str]) -> None:
    if not any(field in value for field in _SITES_SETTINGS_FIELDS):
        checker.add("custom", ("audience",), f"Give at least one of {', '.join(_SITES_SETTINGS_FIELDS)}.")


#: tool name -> (field refinements, run when that field parsed; object refinements, run when all did).
_REFINEMENTS: dict[str, tuple[Optional[Refinement], Optional[Refinement]]] = {
    "mail_send": (_mail_send, _mail_send_object),
    "messaging_send_sms": (_messaging_send_sms, None),
    "notify_usage": (None, _notify_usage_object),
    "sites_deploy": (None, _sites_deploy_object),
    "sites_update_settings": (None, _sites_update_settings_object),
}

#: The tools whose zod schema has a refinement ported here (the registry test checks the list).
REFINED_TOOLS = frozenset(_REFINEMENTS)


def parse_arguments(
    tool_name: str, schema: Mapping[str, Any], arguments: Any
) -> tuple[Optional[dict[str, Any]], list[ToolInputIssue]]:
    """Parses ``arguments`` (``None`` reads as ``{}``) with a tool's schema.

    Returns ``(value, [])`` on success, ``(None, issues)`` otherwise.
    """
    checker = _Checker()
    value = checker.check(schema, {} if arguments is None else arguments, ())
    if not isinstance(value, dict):
        return None, checker.issues
    field_rule, object_rule = _REFINEMENTS.get(tool_name, (None, None))
    if field_rule is not None:
        field_rule(value, checker, [issue["path"].split(".")[0] for issue in checker.issues])
    if object_rule is not None and not checker.issues:
        object_rule(value, checker, ())
    if checker.issues:
        # zod reports an object's issues in property order; a field rule's issue joins its field.
        order = {name: index for index, name in enumerate(schema.get("properties") or {})}
        checker.issues.sort(key=lambda issue: order.get(issue["path"].split(".")[0], len(order)))
        return None, checker.issues
    return value, []
