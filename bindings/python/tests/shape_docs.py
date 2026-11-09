"""Field-meaning docstrings for the ``TypedDict``s in ``ryu_sdk/services/shapes.py``, from OpenAPI.

The per-service OpenAPI documents (built from ``apps/web/src/lib/openapi-services``, where each
``<svc>.ts`` keeps a ``<SVC>_PROPERTY_DESCRIPTIONS`` map or Zod ``.describe()`` text, and synced to
``apps/web/public/openapi`` by ``scripts/sync-service-openapi.mjs``) describe every response
property. ``SHAPES`` maps a ``TypedDict`` to the component schema it mirrors. Each field of a
class-form ``TypedDict`` carries a PEP 257 attribute docstring (a string literal on the line after
the field), which Pylance, Jedi, PyCharm and Sphinx autodoc show; Markdown code spans become reST
literals. A field the component describes gets that description; any other field keeps its
hand-written docstring, and a hand-written ``#:`` comment above a field is turned into one.

``from`` is a Python keyword, so a shape with a ``from`` key declares it on a small functional-form
base (``FROM_BASES``) that the class-form shape inherits; there the description is a ``#:``
comment, the only form a dict literal can carry.

``tests/test_services_shape_docs.py`` fails when ``shapes.py`` drifts from the specs, in its
docstrings or its keys. Regenerate the docstrings after a spec or shape change with::

    python bindings/python/tests/shape_docs.py
"""

from __future__ import annotations

import json
import re
import sys
import textwrap
from collections.abc import Mapping
from pathlib import Path
from typing import Any

PYTHON_ROOT = Path(__file__).resolve().parents[1]
SHAPES_PATH = PYTHON_ROOT / "ryu_sdk" / "services" / "shapes.py"
SPECS = PYTHON_ROOT.parents[1] / "apps" / "web" / "public" / "openapi"

#: ``TypedDict`` name -> (spec file stem, component schema name).
SHAPES: dict[str, tuple[str, str]] = {
    "NotifyEvent": ("notify", "NotifyEvent"),
    "MailInbox": ("mail", "MailInbox"),
    "MailAttachment": ("mail", "MailAttachment"),
    "MailMessage": ("mail", "MailMessage"),
    "MailRealtimeTicket": ("mail", "MailRealtimeTicket"),
    "MailStatus": ("mail", "MailStatus"),
    "MessagingMessage": ("messaging", "MessagingMessage"),
    "MessagingMessagePage": ("messaging", "MessagingMessagePage"),
    "MessagingNumber": ("messaging", "MessagingNumber"),
    "MessagingCredit": ("messaging", "MessagingCredit"),
    "MessagingQuote": ("messaging", "MessagingQuote"),
    "MessagingStatus": ("messaging", "MessagingStatus"),
    "Box": ("box", "Box"),
    "BoxExecResult": ("box", "CommandResult"),
    "ConnectUsageReport": ("connect", "ConnectUsageReport"),
    "PassportConnection": ("passport", "Connection"),
    "PassportProfile": ("passport", "Profile"),
    "PassportProfileList": ("passport", "ProfileList"),
    "PassportConnectionList": ("passport", "ConnectionList"),
    "PassportFetchResult": ("passport", "FetchResult"),
    "SitesTool": ("sites", "SiteTool"),
    "SitesExtensions": ("sites", "SiteExtensions"),
    "SitesDomainBinding": ("sites", "SiteDomainBinding"),
    "SitesConnection": ("sites", "SiteConnection"),
    "SitesRemixSource": ("sites", "SiteRemixSource"),
    "SitesVersion": ("sites", "Version"),
    "SitesProject": ("sites", "Project"),
    "SitesStatus": ("sites", "Status"),
    "ManagedAgent": ("managed-agents", "ManagedAgent"),
    "ManagedAgentPage": ("managed-agents", "ManagedAgentList"),
    "ManagedAgentEnvironment": ("managed-agents", "ManagedAgentEnvironment"),
    "ManagedAgentEnvironmentPage": ("managed-agents", "ManagedAgentEnvironmentList"),
    "ManagedAgentSession": ("managed-agents", "ManagedAgentSession"),
    "ManagedAgentSessionPage": ("managed-agents", "ManagedAgentSessionList"),
    "ManagedAgentEvent": ("managed-agents", "ManagedAgentEvent"),
    "ManagedAgentEventPage": ("managed-agents", "ManagedAgentEventList"),
}

#: Functional-form base holding a shape's ``from`` key -> the ``SHAPES`` entry it belongs to.
FROM_BASES: dict[str, str] = {
    "_MailMessageFrom": "MailMessage",
    "_MessagingMessageFrom": "MessagingMessage",
    "_ConnectUsageReportFrom": "ConnectUsageReport",
}

LINE_WIDTH = 120
CLASS_START = re.compile(r"^class (\w+)\(")
FUNCTIONAL_START = re.compile(r"^(\w+) = TypedDict\($")
TRIPLE = '"""'
FIELD = re.compile(r"^(\s+)(?:\"(\w+)\"|(\w+))\s*:\s*\S")
CODE_SPAN = re.compile(r"(?<!`)`([^`\n]+)`(?!`)")


def load_specs(root: Path = SPECS) -> dict[str, Any]:
    """Every spec ``SHAPES`` names, by file stem."""
    return {stem: json.loads((root / f"{stem}.json").read_text()) for stem in sorted({s for s, _ in SHAPES.values()})}


def _resolve(spec: Mapping[str, Any], schema: Mapping[str, Any]) -> Mapping[str, Any]:
    reference = schema.get("$ref")
    if isinstance(reference, str):
        resolved: Mapping[str, Any] = spec["components"]["schemas"][reference.rsplit("/", 1)[-1]]
        return resolved
    return schema


def property_descriptions(spec: Mapping[str, Any], component: str) -> dict[str, str]:
    """``component``'s top-level property descriptions. A union (``oneOf``/``anyOf``/``allOf``)
    contributes a property's description only when every branch that declares it agrees."""
    schema = _resolve(spec, spec["components"]["schemas"][component])
    branches = [schema]
    for key in ("oneOf", "anyOf", "allOf"):
        branches.extend(_resolve(spec, branch) for branch in schema.get(key, []))
    found: dict[str, set[str]] = {}
    for branch in branches:
        for name, value in branch.get("properties", {}).items():
            # A description beside a `$ref` is about this property, so it wins over the target's own.
            description = value.get("description") or _resolve(spec, value).get("description")
            found.setdefault(name, set())
            if isinstance(description, str) and description.strip():
                found[name].add(" ".join(description.split()))
    return {name: next(iter(texts)) for name, texts in found.items() if len(texts) == 1}


def _wrap(text: str, first: str, rest: str, width: int = LINE_WIDTH) -> list[str]:
    return textwrap.wrap(
        text,
        width=width,
        initial_indent=first,
        subsequent_indent=rest,
        break_long_words=False,
        break_on_hyphens=False,
    )


def _comment(description: str, indent: str) -> list[str]:
    prefix = f"{indent}#: "
    return _wrap(CODE_SPAN.sub(r"``\1``", description), prefix, prefix)


def _docstring(description: str, indent: str) -> list[str]:
    text = CODE_SPAN.sub(r"``\1``", description).replace("\\", "\\\\").replace(TRIPLE, '\\"\\"\\"')
    if text.endswith('"'):
        text = text[:-1] + '\\"'
    lines = _wrap(text, f"{indent}{TRIPLE}", indent, LINE_WIDTH - len(TRIPLE))
    lines[-1] += TRIPLE
    return lines


def _string_end(lines: list[str], start: int) -> int:
    """The index after the line that closes the triple-quoted string opening on ``lines[start]``."""
    if lines[start].count(TRIPLE) >= 2:
        return start + 1
    for index in range(start + 1, len(lines)):
        if TRIPLE in lines[index]:
            return index + 1
    return len(lines)


def _block_end(lines: list[str], start: int) -> int:
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line and not line[0].isspace() and line != ")":
            return index
    return len(lines)


def _render_class(body: list[str], descriptions: Mapping[str, str]) -> list[str]:
    """A class body with every field documented by an attribute docstring: the spec's description,
    else its existing docstring, else its ``#:`` comment as one."""
    out: list[str] = []
    index = 0
    while index < len(body) and not body[index].strip():
        out.append(body[index])
        index += 1
    if index < len(body) and body[index].lstrip().startswith(TRIPLE):  # the class docstring
        end = _string_end(body, index)
        out.extend(body[index:end])
        index = end
    comment: list[str] = []
    while index < len(body):
        line = body[index]
        index += 1
        if line.lstrip().startswith("#:"):
            comment.append(line)
            continue
        field = FIELD.match(line)
        if field is None or field.group(3) is None:
            out.extend(comment)
            comment = []
            out.append(line)
            continue
        indent, key = field.group(1), field.group(3)
        existing: list[str] = []
        if index < len(body) and body[index].lstrip().startswith(TRIPLE):
            end = _string_end(body, index)
            existing = body[index:end]
            index = end
        out.append(line)
        if key in descriptions:
            out.extend(_docstring(descriptions[key], indent))
        elif existing:
            out.extend(existing)
        elif comment:
            out.extend(_docstring(" ".join(item.strip()[2:].strip() for item in comment), indent))
        comment = []
    out.extend(comment)
    return out


def _render_functional(body: list[str], descriptions: Mapping[str, str]) -> list[str]:
    """A functional-form body with each described key's ``#:`` comment set from the spec."""
    out: list[str] = []
    for line in body:
        field = FIELD.match(line)
        key: str | None = field.group(2) if field else None
        if field and key is not None and key in descriptions:
            indent = field.group(1)
            while out and out[-1].startswith(f"{indent}#:"):
                out.pop()
            out.extend(_comment(descriptions[key], indent))
        out.append(line)
    return out


def render(source: str, specs: Mapping[str, Any]) -> str:
    """``source`` (``shapes.py``) with every class field's docstring, and each ``FROM_BASES`` key's
    ``#:`` comment, set from ``specs``."""
    lines = source.split("\n")
    out: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        class_start = CLASS_START.match(line)
        functional = FUNCTIONAL_START.match(line)
        name = class_start.group(1) if class_start else functional.group(1) if functional else None
        target = FROM_BASES.get(name or "", name)
        if name is None or (functional and target not in SHAPES):
            out.append(line)
            index += 1
            continue
        descriptions: Mapping[str, str] = {}
        if target in SHAPES:
            stem, component = SHAPES[target]
            descriptions = property_descriptions(specs[stem], component)
        end = _block_end(lines, index)
        out.append(line)
        render_body = _render_class if class_start else _render_functional
        out.extend(render_body(lines[index + 1 : end], descriptions))
        index = end
    return "\n".join(out)


def main() -> None:
    SHAPES_PATH.write_text(render(SHAPES_PATH.read_text(), load_specs()))


if __name__ == "__main__":
    main()
    sys.exit(0)
