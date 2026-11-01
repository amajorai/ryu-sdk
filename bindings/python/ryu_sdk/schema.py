"""JSON Schema inference, validation, and structured-output helpers.

Mirrors ``packages/sdk/src/schema/`` for Python:

- :func:`json_schema_for` turns a type hint (builtins, ``typing`` generics,
  ``Literal``, ``Enum``, dataclasses, ``TypedDict``, ``Annotated`` descriptions,
  or a pydantic model when pydantic is installed) into JSON Schema.
- :func:`validate_json_schema` checks a value against the JSON Schema subset the
  SDK emits and reports :class:`SchemaIssue` paths the way the TypeScript SDK
  does.
- :class:`OutputContract` normalizes an ``output_schema`` (pydantic model, type
  hint, or JSON Schema dict) into a wire schema plus a validator, and
  :func:`read_structured_reply` / :func:`build_repair_prompt` implement the
  parse, validate, and re-ask cycle of the agent loop.

pydantic is optional. When it is installed, pydantic models and any type that
contains one validate through pydantic (so callers get model instances back);
everything else validates with the built-in JSON Schema checker.
"""

from __future__ import annotations

import collections.abc as cabc
import dataclasses
import datetime
import decimal
import enum
import inspect
import json
import re
import sys
import typing
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

try:  # pragma: no cover - exercised when pydantic is installed
    import pydantic as pydantic  # explicit re-export: tools.py reads `schema.pydantic`

    _PYDANTIC_V2 = hasattr(pydantic, "TypeAdapter")
except ImportError:  # pragma: no cover - exercised without pydantic
    pydantic = None  # type: ignore[assignment]
    _PYDANTIC_V2 = False

JsonSchema = Dict[str, Any]

#: Default number of times the model is re-asked after an invalid reply.
DEFAULT_MAX_REPAIR_ATTEMPTS = 2
#: Stable code carried by structured-output failures.
STRUCTURED_OUTPUT_ERROR_CODE = "structured_output_invalid"


class SchemaConversionError(TypeError):
    """A type hint has no JSON Schema equivalent."""


@dataclass(frozen=True)
class SchemaIssue:
    """One validation problem: where it is and what is wrong."""

    path: Tuple[Union[str, int], ...]
    message: str


def format_schema_issues(issues: Sequence[SchemaIssue]) -> str:
    """Render issues one per line (same text as the TypeScript SDK)."""
    lines = []
    for issue in issues:
        if not issue.path:
            location = "(root)"
        else:
            parts = []
            for index, segment in enumerate(issue.path):
                if isinstance(segment, int):
                    parts.append(f"[{segment}]")
                else:
                    parts.append(segment if index == 0 else f".{segment}")
            location = "".join(parts)
        lines.append(f"- at {location}: {issue.message}")
    return "\n".join(lines)


# ── Type hint → JSON Schema ───────────────────────────────────────────────────

_NONE_TYPE = type(None)


def is_pydantic_model(value: Any) -> bool:
    """True for a pydantic ``BaseModel`` subclass (False when pydantic is absent)."""
    return pydantic is not None and inspect.isclass(value) and issubclass(value, pydantic.BaseModel)


def _is_typeddict(tp: Any) -> bool:
    return inspect.isclass(tp) and issubclass(tp, dict) and hasattr(tp, "__annotations__") and hasattr(tp, "__total__")


def _annotated_parts(tp: Any) -> Tuple[Any, List[Any]]:
    if typing.get_origin(tp) is typing.Annotated:
        args = typing.get_args(tp)
        return args[0], list(args[1:])
    return tp, []


def _metadata_description(metadata: Sequence[Any]) -> Optional[str]:
    for item in metadata:
        if isinstance(item, str):
            return item
        description = getattr(item, "description", None)
        if isinstance(description, str):
            return description
    return None


def _type_hints(obj: Any) -> Dict[str, Any]:
    try:
        return typing.get_type_hints(obj, include_extras=True)
    except Exception as error:  # unresolved forward reference
        raise SchemaConversionError(f"cannot resolve type hints of {obj!r}: {error}") from error


def _object_schema(properties: Dict[str, JsonSchema], required: List[str]) -> JsonSchema:
    schema: JsonSchema = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = required
    return schema


def _json_default(value: Any) -> Tuple[bool, Any]:
    if isinstance(value, enum.Enum):
        value = value.value
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False, None
    return True, value


def _dataclass_schema(tp: Any) -> JsonSchema:
    hints = _type_hints(tp)
    properties: Dict[str, JsonSchema] = {}
    required: List[str] = []
    for item in dataclasses.fields(tp):
        if not item.init:
            continue
        properties[item.name] = json_schema_for(hints.get(item.name, Any))
        has_default = (
            item.default is not dataclasses.MISSING or item.default_factory is not dataclasses.MISSING  # type: ignore[misc, unused-ignore]
        )
        if not has_default:
            required.append(item.name)
        elif item.default is not dataclasses.MISSING:
            ok, value = _json_default(item.default)
            if ok:
                properties[item.name] = {**properties[item.name], "default": value}
    schema = _object_schema(properties, required)
    if tp.__doc__ and not tp.__doc__.startswith(f"{tp.__name__}("):
        schema["description"] = inspect.cleandoc(tp.__doc__)
    return schema


def _typeddict_schema(tp: Any) -> JsonSchema:
    hints = _type_hints(tp)
    required_keys = getattr(tp, "__required_keys__", frozenset(hints) if tp.__total__ else frozenset())
    properties = {name: json_schema_for(hint) for name, hint in hints.items()}
    return _object_schema(properties, [name for name in hints if name in required_keys])


def _pydantic_schema(tp: Any) -> JsonSchema:
    schema: JsonSchema
    if _PYDANTIC_V2:
        schema = tp.model_json_schema()
    else:  # pragma: no cover - pydantic v1
        schema = json.loads(tp.schema_json())
    return schema


def _union_schema(args: Sequence[Any]) -> JsonSchema:
    options = [json_schema_for(arg) for arg in args]
    return {"anyOf": options}


def _literal_schema(values: Sequence[Any]) -> JsonSchema:
    resolved = [value.value if isinstance(value, enum.Enum) else value for value in values]
    schema: JsonSchema = {"enum": resolved}
    kinds = {type(value) for value in resolved}
    if len(kinds) == 1:
        kind = next(iter(kinds))
        name = _SCALARS.get(kind)
        if name is not None:
            schema["type"] = name
    return schema


_SCALARS: Dict[type, str] = {
    str: "string",
    bool: "boolean",
    int: "integer",
    float: "number",
    _NONE_TYPE: "null",
}

_FORMATS: Dict[type, JsonSchema] = {
    datetime.datetime: {"type": "string", "format": "date-time"},
    datetime.date: {"type": "string", "format": "date"},
    datetime.time: {"type": "string", "format": "time"},
    uuid.UUID: {"type": "string", "format": "uuid"},
    decimal.Decimal: {"type": "number"},
    bytes: {"type": "string", "contentEncoding": "base64"},
}

_SEQUENCE_ORIGINS = {list, tuple, set, frozenset}


def _generic_schema(tp: Any, origin: Any, args: Tuple[Any, ...]) -> Optional[JsonSchema]:
    """Schema for a parametrized generic, or None when ``origin`` is not one."""
    if origin is Union or (sys.version_info >= (3, 10) and _is_union_type(origin)):
        return _union_schema(args)
    if origin is typing.Literal:
        return _literal_schema(args)
    if origin is tuple and args and not (len(args) == 2 and args[1] is Ellipsis):
        items = [json_schema_for(arg) for arg in args]
        return {
            "type": "array",
            "prefixItems": items,
            "minItems": len(items),
            "maxItems": len(items),
        }
    container = origin if inspect.isclass(origin) else None
    if container is not None and (issubclass(container, dict) or container in (cabc.Mapping, cabc.MutableMapping)):
        value = args[1] if len(args) == 2 else Any
        schema: JsonSchema = {"type": "object"}
        value_schema = json_schema_for(value)
        schema["additionalProperties"] = value_schema if value_schema else True
        return schema
    if container is not None and (container in _SEQUENCE_ORIGINS or _is_abc_sequence(container)):
        item = args[0] if args else Any
        schema = {"type": "array", "items": json_schema_for(item)}
        if container in (set, frozenset) or _is_abc_set(container):
            schema["uniqueItems"] = True
        return schema
    return None


def _is_union_type(origin: Any) -> bool:
    import types

    union_type = getattr(types, "UnionType", None)  # PEP 604 `X | Y` (3.10+)
    return union_type is not None and origin is union_type


def _is_abc_sequence(container: type) -> bool:
    return container in (cabc.Sequence, cabc.MutableSequence, cabc.Iterable, cabc.Collection)


def _is_abc_set(container: type) -> bool:
    return container in (cabc.Set, cabc.MutableSet)


def json_schema_for(tp: Any) -> JsonSchema:
    """Convert a Python type hint to JSON Schema.

    Raises :class:`SchemaConversionError` for a type with no JSON form.
    """
    tp, metadata = _annotated_parts(tp)
    schema = _json_schema_core(tp)
    description = _metadata_description(metadata)
    if description:
        schema = {**schema, "description": description}
    return schema


def _json_schema_core(tp: Any) -> JsonSchema:
    if tp is Any or tp is object or tp is inspect.Parameter.empty:
        return {}
    if tp is None or tp is _NONE_TYPE:
        return {"type": "null"}
    if isinstance(tp, dict):
        return dict(tp)
    if is_pydantic_model(tp):
        return _pydantic_schema(tp)
    if inspect.isclass(tp):
        if issubclass(tp, enum.Enum):
            return _literal_schema([member.value for member in tp])
        if tp in _SCALARS:
            return {"type": _SCALARS[tp]}
        if tp in _FORMATS:
            return dict(_FORMATS[tp])
        if dataclasses.is_dataclass(tp):
            return _dataclass_schema(tp)
        if _is_typeddict(tp):
            return _typeddict_schema(tp)
        if tp in (list, tuple, set, frozenset):
            schema: JsonSchema = {"type": "array"}
            if tp in (set, frozenset):
                schema["uniqueItems"] = True
            return schema
        if tp is dict:
            return {"type": "object"}
    origin = typing.get_origin(tp)
    if origin is not None:
        generic = _generic_schema(tp, origin, typing.get_args(tp))
        if generic is not None:
            return generic
    raise SchemaConversionError(f"no JSON Schema for type {tp!r}")


# ── Docstrings ────────────────────────────────────────────────────────────────

_SECTION = re.compile(
    r"^\s*(Args|Arguments|Parameters|Params|Returns|Raises|Yields|Example|Examples|Note|Notes)\s*:\s*$"
)
_ARG_LINE = re.compile(r"^\s*\*{0,2}([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:\s*(.*)$")


def parse_docstring(doc: Optional[str]) -> Tuple[str, Dict[str, str]]:
    """Split a Google-style docstring into a summary and per-argument text."""
    if not doc:
        return "", {}
    lines = inspect.cleandoc(doc).splitlines()
    summary: List[str] = []
    args: Dict[str, str] = {}
    section: Optional[str] = None
    current: Optional[str] = None
    for line in lines:
        header = _SECTION.match(line)
        if header:
            section = header.group(1).lower()
            current = None
            continue
        if section is None:
            summary.append(line)
            continue
        if section in ("args", "arguments", "parameters", "params"):
            match = _ARG_LINE.match(line)
            if match and (len(line) - len(line.lstrip())) <= 4:
                current = match.group(1)
                args[current] = match.group(2).strip()
            elif current and line.strip():
                args[current] = f"{args[current]} {line.strip()}".strip()
    text = "\n".join(summary).strip()
    return text, args


def function_parameters_schema(fn: Callable[..., Any], skip: Sequence[str] = ()) -> JsonSchema:
    """The JSON Schema object describing ``fn``'s keyword arguments."""
    signature = inspect.signature(fn)
    hints = _type_hints(fn)
    _, arg_docs = parse_docstring(inspect.getdoc(fn))
    properties: Dict[str, JsonSchema] = {}
    required: List[str] = []
    for name, parameter in signature.parameters.items():
        if name in skip or name in ("self", "cls"):
            continue
        if parameter.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        hint = hints.get(name, Any)
        try:
            schema = json_schema_for(hint)
        except SchemaConversionError as error:
            raise SchemaConversionError(f"parameter {name!r} of {fn.__name__}: {error}") from error
        if "description" not in schema and name in arg_docs:
            schema = {**schema, "description": arg_docs[name]}
        if parameter.default is inspect.Parameter.empty:
            required.append(name)
        else:
            ok, value = _json_default(parameter.default)
            if ok and value is not None:
                schema = {**schema, "default": value}
        properties[name] = schema
    return _object_schema(properties, required)


# ── JSON Schema validation ────────────────────────────────────────────────────

_TYPE_CHECKS: Dict[str, Callable[[Any], bool]] = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer()),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def _json_type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _resolve_ref(root: JsonSchema, ref: str) -> JsonSchema:
    if not ref.startswith("#/"):
        raise SchemaConversionError(f"only local $ref is supported, got {ref!r}")
    node: Any = root
    for part in ref[2:].split("/"):
        node = node[part.replace("~1", "/").replace("~0", "~")]
    resolved: JsonSchema = node
    return resolved


def validate_json_schema(schema: Any, value: Any) -> List[SchemaIssue]:
    """Validate ``value`` against ``schema`` (a practical JSON Schema subset).

    Supports ``type``, ``enum``, ``const``, ``properties``, ``required``,
    ``additionalProperties``, ``items``, ``prefixItems``, ``anyOf``/``oneOf``/
    ``allOf``, string/array/number bounds, ``pattern``, ``uniqueItems``, and local
    ``$ref``. Returns an empty list when the value is valid.
    """
    issues: List[SchemaIssue] = []
    _validate(schema if isinstance(schema, dict) else {}, value, (), schema, issues)
    return issues


def _validate(schema: Any, value: Any, path: Tuple[Any, ...], root: Any, issues: List[SchemaIssue]) -> None:
    if schema is True or schema == {}:
        return
    if schema is False:
        issues.append(SchemaIssue(path, "no value is allowed here"))
        return
    if not isinstance(schema, dict):
        return
    if "$ref" in schema:
        _validate(_resolve_ref(root, schema["$ref"]), value, path, root, issues)
        return
    for sub in schema.get("allOf", []):
        _validate(sub, value, path, root, issues)
    for key in ("anyOf", "oneOf"):
        if key in schema:
            options = schema[key]
            matches = [option for option in options if not validate_json_schema_at(option, value, root)]
            if not matches:
                issues.append(SchemaIssue(path, f"value does not match any allowed shape ({_short(value)})"))
                return
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        if not any(_TYPE_CHECKS.get(name, lambda _v: True)(value) for name in names):
            issues.append(SchemaIssue(path, f"expected {' or '.join(names)}, received {_json_type_name(value)}"))
            return
    if "const" in schema and value != schema["const"]:
        issues.append(SchemaIssue(path, f"expected {json.dumps(schema['const'])}"))
    if "enum" in schema and value not in schema["enum"]:
        allowed = ", ".join(json.dumps(option) for option in schema["enum"])
        issues.append(SchemaIssue(path, f"expected one of {allowed}"))
    if isinstance(value, str):
        _validate_string(schema, value, path, issues)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        _validate_number(schema, value, path, issues)
    elif isinstance(value, list):
        _validate_array(schema, value, path, root, issues)
    elif isinstance(value, dict):
        _validate_object(schema, value, path, root, issues)


def validate_json_schema_at(schema: Any, value: Any, root: Any) -> List[SchemaIssue]:
    issues: List[SchemaIssue] = []
    _validate(schema, value, (), root, issues)
    return issues


def _short(value: Any) -> str:
    text = json.dumps(value, default=str)
    return text if len(text) <= 60 else f"{text[:57]}..."


def _validate_string(schema: JsonSchema, value: str, path: Tuple[Any, ...], issues: List[SchemaIssue]) -> None:
    if "minLength" in schema and len(value) < schema["minLength"]:
        issues.append(SchemaIssue(path, f"expected at least {schema['minLength']} characters"))
    if "maxLength" in schema and len(value) > schema["maxLength"]:
        issues.append(SchemaIssue(path, f"expected at most {schema['maxLength']} characters"))
    if "pattern" in schema and not re.search(schema["pattern"], value):
        issues.append(SchemaIssue(path, f"expected to match /{schema['pattern']}/"))


def _validate_number(schema: JsonSchema, value: float, path: Tuple[Any, ...], issues: List[SchemaIssue]) -> None:
    checks: Tuple[Tuple[str, Callable[[float], bool], str], ...] = (
        ("minimum", lambda bound: value >= bound, ">="),
        ("maximum", lambda bound: value <= bound, "<="),
        ("exclusiveMinimum", lambda bound: value > bound, ">"),
        ("exclusiveMaximum", lambda bound: value < bound, "<"),
    )
    for key, ok, symbol in checks:
        bound = schema.get(key)
        if isinstance(bound, (int, float)) and not isinstance(bound, bool) and not ok(bound):
            issues.append(SchemaIssue(path, f"expected a number {symbol} {bound}"))


def _validate_array(
    schema: JsonSchema, value: List[Any], path: Tuple[Any, ...], root: Any, issues: List[SchemaIssue]
) -> None:
    if "minItems" in schema and len(value) < schema["minItems"]:
        issues.append(SchemaIssue(path, f"expected at least {schema['minItems']} items"))
    if "maxItems" in schema and len(value) > schema["maxItems"]:
        issues.append(SchemaIssue(path, f"expected at most {schema['maxItems']} items"))
    if schema.get("uniqueItems"):
        seen = [json.dumps(item, sort_keys=True, default=str) for item in value]
        if len(seen) != len(set(seen)):
            issues.append(SchemaIssue(path, "expected unique items"))
    prefix = schema.get("prefixItems", [])
    for index, item in enumerate(value):
        if index < len(prefix):
            _validate(prefix[index], item, (*path, index), root, issues)
        elif "items" in schema:
            _validate(schema["items"], item, (*path, index), root, issues)


def _validate_object(
    schema: JsonSchema, value: Dict[str, Any], path: Tuple[Any, ...], root: Any, issues: List[SchemaIssue]
) -> None:
    properties = schema.get("properties", {})
    for name in schema.get("required", []):
        if name not in value:
            issues.append(SchemaIssue((*path, name), "required property is missing"))
    extra = schema.get("additionalProperties", True)
    for key, item in value.items():
        if key in properties:
            _validate(properties[key], item, (*path, key), root, issues)
        elif extra is False:
            issues.append(SchemaIssue((*path, key), "unexpected property"))
        elif isinstance(extra, dict):
            _validate(extra, item, (*path, key), root, issues)


# ── Structured output ─────────────────────────────────────────────────────────

_FENCED_BLOCK = re.compile(r"```(?:json|JSON)?\s*\n?([\s\S]*?)```")


def parse_json_reply(text: str) -> Tuple[bool, Any]:
    """Parse JSON from a model reply.

    Accepts a bare JSON document, a fenced ```json block, or one object/array
    embedded in prose. Returns ``(True, value)`` or ``(False, error_message)``.
    """
    trimmed = text.strip()
    if not trimmed:
        return False, "the reply was empty; expected a JSON value"
    candidates = [trimmed]
    fenced = _FENCED_BLOCK.search(trimmed)
    if fenced and fenced.group(1).strip():
        candidates.append(fenced.group(1).strip())
    for open_char, close_char in (("{", "}"), ("[", "]")):
        start = trimmed.find(open_char)
        end = trimmed.rfind(close_char)
        if start != -1 and end > start:
            candidates.append(trimmed[start : end + 1])
    for candidate in candidates:
        try:
            return True, json.loads(candidate)
        except ValueError:
            continue
    return False, "the reply was not valid JSON"


def _child_schemas(node: JsonSchema) -> List[Any]:
    children: List[Any] = []
    for key in ("properties", "$defs", "definitions"):
        value = node.get(key)
        if isinstance(value, dict):
            children.extend(value.values())
    for key in ("anyOf", "allOf", "oneOf", "prefixItems"):
        value = node.get(key)
        if isinstance(value, list):
            children.extend(value)
    if "items" in node:
        items = node["items"]
        children.extend(items if isinstance(items, list) else [items])
    return children


def is_strict_compatible_json_schema(schema: Any) -> bool:
    """Whether a schema satisfies OpenAI-style strict structured outputs."""
    if not isinstance(schema, dict):
        return isinstance(schema, bool)
    raw_properties = schema.get("properties")
    properties: Dict[str, Any] = raw_properties if isinstance(raw_properties, dict) else {}
    if schema.get("type") == "object" or isinstance(raw_properties, dict):
        raw_required = schema.get("required")
        required: List[Any] = raw_required if isinstance(raw_required, list) else []
        if schema.get("additionalProperties") is not False or any(key not in required for key in properties):
            return False
    return all(is_strict_compatible_json_schema(child) for child in _child_schemas(schema))


def build_repair_prompt(issues: Sequence[SchemaIssue], json_schema: JsonSchema) -> str:
    """The user turn that asks the model to correct an invalid structured reply."""
    return "\n".join(
        [
            "Your previous reply did not satisfy the required output schema.",
            "Problems:",
            format_schema_issues(issues),
            "",
            "Reply again with ONLY a JSON value (no prose, no code fences) that satisfies this JSON Schema:",
            json.dumps(json_schema, separators=(",", ":")),
        ]
    )


def describe_structured_output_failure(issues: Sequence[SchemaIssue], attempts: int) -> str:
    plural = "" if attempts == 1 else "s"
    return (
        f"model did not return valid structured JSON output after {attempts} attempt{plural}:\n"
        f"{format_schema_issues(issues)}"
    )


class StructuredOutputError(Exception):
    """The final reply never satisfied ``output_schema`` after every repair attempt."""

    code = STRUCTURED_OUTPUT_ERROR_CODE

    def __init__(self, message: str, issues: Sequence[SchemaIssue], attempts: int, text: str) -> None:
        super().__init__(message)
        self.issues = list(issues)
        self.attempts = attempts
        self.text = text


def _pydantic_issues(error: Any) -> List[SchemaIssue]:
    issues = []
    for item in error.errors():
        location = tuple(part for part in item.get("loc", ()) if part != "__root__")
        issues.append(SchemaIssue(location, str(item.get("msg", "invalid value"))))
    return issues or [SchemaIssue((), str(error))]


def _contains_pydantic(tp: Any) -> bool:
    if is_pydantic_model(tp):
        return True
    return any(_contains_pydantic(arg) for arg in typing.get_args(tp))


def _build_dataclass(tp: Any, value: Any) -> Any:
    """Construct a dataclass (recursively) from a validated JSON object."""
    if not (dataclasses.is_dataclass(tp) and isinstance(value, dict)):
        return value
    hints = _type_hints(tp)
    kwargs = {}
    for item in dataclasses.fields(tp):
        if item.name in value:
            inner, _ = _annotated_parts(hints.get(item.name, Any))
            kwargs[item.name] = _build_dataclass(inner, value[item.name])
    return typing.cast(Any, tp)(**kwargs)


class OutputContract:
    """A normalized output schema: the wire JSON Schema plus a validator.

    ``schema`` may be a pydantic model, any type hint :func:`json_schema_for`
    understands, or a JSON Schema ``dict``. :meth:`validate` returns
    ``(True, value)`` with the parsed value (a model or dataclass instance when
    the schema is one), or ``(False, issues)``.
    """

    def __init__(self, schema: Any) -> None:
        self.source = schema
        if isinstance(schema, dict):
            self.json_schema: JsonSchema = dict(schema)
            self._adapter = None
        else:
            self.json_schema = json_schema_for(schema)
            self._adapter = pydantic.TypeAdapter(schema) if _PYDANTIC_V2 and _contains_pydantic(schema) else None

    def validate(self, value: Any) -> Tuple[bool, Any]:
        if self._adapter is not None:
            try:
                return True, self._adapter.validate_python(value)
            except pydantic.ValidationError as error:
                return False, _pydantic_issues(error)
        issues = validate_json_schema(self.json_schema, value)
        if issues:
            return False, issues
        source, _ = _annotated_parts(self.source)
        return True, _build_dataclass(source, value)


def to_output_contract(schema: Any) -> Optional[OutputContract]:
    if schema is None:
        return None
    return schema if isinstance(schema, OutputContract) else OutputContract(schema)


def read_structured_reply(reply: Any, contract: OutputContract) -> Tuple[bool, Any]:
    """Parse + validate a reply (text or decoded JSON) against ``contract``.

    Returns ``(True, value)`` or ``(False, issues)``.
    """
    value = reply
    if isinstance(reply, str):
        ok, parsed = parse_json_reply(reply)
        if not ok:
            return False, [SchemaIssue((), parsed)]
        value = parsed
    return contract.validate(value)


def _services_result_fields(value: Any) -> Optional[Dict[str, Any]]:
    """A services ``Result``'s ``{data, error, meta}``, or ``None`` for any other value."""
    # Imported lazily: ``ryu_sdk.services`` is optional for ``schema`` users.
    try:
        from .services.result import Result
    except ImportError:  # pragma: no cover - the services package ships with the SDK
        return None
    return value._asdict() if isinstance(value, Result) else None


def to_jsonable(value: Any) -> Any:
    """Convert pydantic models, dataclasses, and enums into plain JSON values."""
    if pydantic is not None and isinstance(value, pydantic.BaseModel):
        return value.model_dump(mode="json") if _PYDANTIC_V2 else json.loads(value.json())
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {key: to_jsonable(item) for key, item in dataclasses.asdict(value).items()}
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    # A services ``Result`` is a ``(data, error, meta)`` tuple; keep its keys.
    result_fields = _services_result_fields(value) if isinstance(value, tuple) else None
    if result_fields is not None:
        return {key: to_jsonable(item) for key, item in result_fields.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_jsonable(item) for item in value]
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time, uuid.UUID)):
        return str(value) if isinstance(value, uuid.UUID) else value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    return value


def coerce_argument(hint: Any, value: Any) -> Any:
    """Turn a validated JSON argument into the value a Python parameter expects.

    pydantic types validate through pydantic; otherwise ``Optional``/``Union``
    members, enums, dataclasses, and lists/dicts of them are rebuilt.
    """
    inner, _ = _annotated_parts(hint)
    if inner is Any or value is None:
        return value
    if _PYDANTIC_V2 and _contains_pydantic(inner):
        return pydantic.TypeAdapter(inner).validate_python(value)
    origin = typing.get_origin(inner)
    args = typing.get_args(inner)
    if origin is Union or _is_union_type(origin):
        for member in args:
            if member is _NONE_TYPE:
                continue
            if not validate_json_schema(json_schema_for(member), value):
                return coerce_argument(member, value)
        return value
    if origin in (list, tuple, set, frozenset) and isinstance(value, list) and args:
        if origin is tuple and not (len(args) == 2 and args[1] is Ellipsis):
            return tuple(coerce_argument(arg, item) for arg, item in zip(args, value))
        items = [coerce_argument(args[0], item) for item in value]
        return items if origin is list else origin(items)
    if origin is dict and isinstance(value, dict) and len(args) == 2:
        return {key: coerce_argument(args[1], item) for key, item in value.items()}
    if inspect.isclass(inner) and issubclass(inner, enum.Enum):
        return inner(value)
    if inner is int and isinstance(value, float) and value.is_integer():
        # JSON Schema "integer" accepts 3.0; hand the function the int it declared.
        return int(value)
    return _build_dataclass(inner, value)
