"""Schema inference, validation, structured output helpers, and the @tool decorator."""

from __future__ import annotations

import asyncio
import enum
import sys
from dataclasses import dataclass, field
from typing import Annotated, Dict, List, Literal, Optional, Tuple, TypedDict, Union

import pydantic
import pytest

from ryu_sdk.schema import (
    OutputContract,
    SchemaConversionError,
    SchemaIssue,
    build_repair_prompt,
    coerce_argument,
    format_schema_issues,
    is_strict_compatible_json_schema,
    json_schema_for,
    parse_json_reply,
    read_structured_reply,
    validate_json_schema,
)
from ryu_sdk.tools import RemoteTool, Tool, ToolArgumentsError, detect_elicitation, normalize_tools, ryu_tool, tool


class Color(enum.Enum):
    RED = "red"
    BLUE = "blue"


@dataclass
class Point:
    """A point."""

    x: int
    y: int = 0
    tags: List[str] = field(default_factory=list)


class Movie(TypedDict):
    title: str
    year: int


class Person(pydantic.BaseModel):
    name: str
    age: int


def test_scalars_generics_and_unions():
    assert json_schema_for(str) == {"type": "string"}
    assert json_schema_for(bool) == {"type": "boolean"}
    assert json_schema_for(Optional[int]) == {"anyOf": [{"type": "integer"}, {"type": "null"}]}
    assert json_schema_for(List[float]) == {"type": "array", "items": {"type": "number"}}
    assert json_schema_for(Dict[str, int]) == {"type": "object", "additionalProperties": {"type": "integer"}}
    assert json_schema_for(Tuple[int, str])["prefixItems"] == [{"type": "integer"}, {"type": "string"}]
    assert json_schema_for(Literal["a", "b"]) == {"enum": ["a", "b"], "type": "string"}
    assert json_schema_for(Color) == {"enum": ["red", "blue"], "type": "string"}
    assert json_schema_for(Annotated[str, "the name"]) == {"type": "string", "description": "the name"}
    assert json_schema_for(Union[int, str]) == {"anyOf": [{"type": "integer"}, {"type": "string"}]}
    assert json_schema_for(set[str]) == {"type": "array", "items": {"type": "string"}, "uniqueItems": True}


@pytest.mark.skipif(sys.version_info < (3, 10), reason="PEP 604 unions need Python 3.10")
def test_pep604_unions():
    assert json_schema_for(int | None) == {"anyOf": [{"type": "integer"}, {"type": "null"}]}
    assert coerce_argument(Color | None, "red") is Color.RED


def test_dataclass_typeddict_and_pydantic():
    point = json_schema_for(Point)
    assert point["required"] == ["x"]
    assert point["properties"]["y"] == {"type": "integer", "default": 0}
    assert point["additionalProperties"] is False
    assert point["description"] == "A point."
    assert json_schema_for(Movie)["required"] == ["title", "year"]
    person = json_schema_for(Person)
    assert person["properties"]["age"]["type"] == "integer"


def test_unsupported_types_fail_loudly():
    with pytest.raises(SchemaConversionError):
        json_schema_for(complex)


def test_validator_reports_paths_like_the_typescript_sdk():
    schema = json_schema_for(Point)
    issues = validate_json_schema(schema, {"y": "1", "tags": [1], "extra": True})
    assert format_schema_issues(issues) == "\n".join(
        [
            "- at x: required property is missing",
            "- at y: expected integer, received string",
            "- at tags[0]: expected string, received integer",
            "- at extra: unexpected property",
        ]
    )
    assert validate_json_schema({"type": "string", "minLength": 2, "pattern": "^a"}, "b") == [
        SchemaIssue((), "expected at least 2 characters"),
        SchemaIssue((), "expected to match /^a/"),
    ]
    assert validate_json_schema({"anyOf": [{"type": "integer"}, {"type": "null"}]}, None) == []
    defs = {"$defs": {"N": {"type": "integer", "minimum": 1}}, "type": "array", "items": {"$ref": "#/$defs/N"}}
    assert validate_json_schema(defs, [1, 0])[0].path == (1,)


def test_parse_json_reply_accepts_fences_and_prose():
    assert parse_json_reply('{"a": 1}') == (True, {"a": 1})
    assert parse_json_reply('Here:\n```json\n{"a": 2}\n```') == (True, {"a": 2})
    assert parse_json_reply('The list is [1, 2] ok') == (True, [1, 2])
    assert parse_json_reply("  ") == (False, "the reply was empty; expected a JSON value")
    assert parse_json_reply("nope") == (False, "the reply was not valid JSON")


def test_strict_compatibility_and_repair_prompt():
    assert is_strict_compatible_json_schema(json_schema_for(Movie))
    assert not is_strict_compatible_json_schema(json_schema_for(Point))
    prompt = build_repair_prompt([SchemaIssue(("a",), "bad")], {"type": "object"})
    assert prompt.splitlines() == [
        "Your previous reply did not satisfy the required output schema.",
        "Problems:",
        "- at a: bad",
        "",
        "Reply again with ONLY a JSON value (no prose, no code fences) that satisfies this JSON Schema:",
        '{"type":"object"}',
    ]


def test_output_contracts_return_typed_values():
    ok, value = read_structured_reply('{"name": "Ada", "age": 36}', OutputContract(Person))
    assert ok and isinstance(value, Person) and value.age == 36
    ok, issues = read_structured_reply('{"name": "Ada"}', OutputContract(Person))
    assert not ok and issues[0].path == ("age",)
    ok, point = OutputContract(Point).validate({"x": 1})
    assert ok and point == Point(x=1)
    ok, people = OutputContract(List[Person]).validate([{"name": "a", "age": 1}])
    assert ok and isinstance(people[0], Person)
    ok, raw = OutputContract({"type": "integer"}).validate(3)
    assert ok and raw == 3


def test_tool_decorator_infers_schema_from_hints_and_docstring():
    @tool(name="find_movies", needs_approval=True)
    def search(query: str, limit: int = 5, genre: Optional[Color] = None, point: Optional[Point] = None) -> list:
        """Search the catalog.

        Args:
            query: Free-text query.
            limit: Max results, between 1 and 50.
        """
        return [query, limit, genre, point]

    assert isinstance(search, Tool) and search.needs_approval
    definition = search.definition()["function"]
    assert definition["name"] == "find_movies"
    assert definition["description"] == "Search the catalog."
    params = definition["parameters"]
    assert params["required"] == ["query"]
    assert params["properties"]["query"]["description"] == "Free-text query."
    assert params["properties"]["limit"] == {"type": "integer", "description": "Max results, between 1 and 50.", "default": 5}
    out = search.invoke({"query": "jaws", "genre": "red", "point": {"x": 2}})
    assert out == ["jaws", 5, "red", {"x": 2, "y": 0, "tags": []}]
    raw = search.fn(**search._arguments({"query": "q", "genre": "blue", "point": {"x": 1}}))
    assert raw[2] is Color.BLUE and raw[3] == Point(x=1)
    with pytest.raises(ToolArgumentsError) as caught:
        search.invoke({"limit": "x"})
    assert [issue.path for issue in caught.value.issues] == [("query",), ("limit",)]
    assert search("direct") == ["direct", 5, None, None]


def test_pydantic_arguments_and_async_tools():
    @tool
    def create(person: Person) -> str:
        """Create a person."""
        return f"{person.name}:{person.age}"

    assert create.parameters["required"] == ["name", "age"]
    assert create.invoke({"name": "Ada", "age": "36"}) == "Ada:36"
    with pytest.raises(ToolArgumentsError):
        create.invoke({"name": "Ada"})

    @tool(args_schema=Person)
    def greet(name: str, age: int) -> Person:
        """Greet."""
        return Person(name=name.upper(), age=age)

    assert greet.invoke({"name": "ada", "age": 1}) == {"name": "ADA", "age": 1}

    @tool
    async def slow(x: int) -> int:
        """Slow double."""
        return x * 2

    assert slow.invoke({"x": 2}) == 4
    assert asyncio.run(slow.ainvoke({"x": 3})) == 6
    assert asyncio.run(greet.ainvoke({"name": "b", "age": 2})) == {"name": "B", "age": 2}


def test_remote_tools_and_normalization():
    remote = ryu_tool("composio.GMAIL_SEARCH_EMAILS", parameters=Movie, needs_approval=True)
    assert isinstance(remote, RemoteTool) and remote.name == "GMAIL_SEARCH_EMAILS"
    assert remote.definition()["function"]["parameters"]["required"] == ["title", "year"]

    def bare(x: int) -> int:
        """Bare."""
        return x

    tools = normalize_tools({"mail": remote, "echo": bare})
    assert tools["mail"].name == "mail" and tools["mail"].id == "composio.GMAIL_SEARCH_EMAILS"
    assert tools["echo"].definition()["function"]["name"] == "echo"
    with pytest.raises(ValueError, match="duplicate"):
        normalize_tools([bare, bare])
    with pytest.raises(ValueError):
        tool(bare, name="bad name")


def test_detect_elicitation():
    assert detect_elicitation({"__ryu_elicitation__": {"url": "u"}}).url == "u"
    assert detect_elicitation('{"__ryu_elicitation__": {"message": "m"}}').message == "m"
    assert detect_elicitation({"__ryu_elicitation__": {"url": 3}}) is None
    assert detect_elicitation("plain") is None


def test_integral_floats_reach_int_parameters_as_ints():
    @tool
    def repeat(times: int, label: Optional[int] = None) -> list:
        """Repeat."""
        return [times, label]

    raw = repeat.fn(**repeat._arguments({"times": 3.0, "label": 2.0}))
    assert raw == [3, 2] and all(type(item) is int for item in raw)
