"""The main shapes' keys are the wire's and their field docstrings the OpenAPI descriptions (``tests/shape_docs.py``)."""

from __future__ import annotations

from typing import Any

import pytest
from shape_docs import FROM_BASES, SHAPES, SHAPES_PATH, SPECS, _resolve, load_specs, property_descriptions, render

from ryu_sdk.services import shapes

pytestmark = pytest.mark.skipif(not SPECS.is_dir(), reason="the OpenAPI specs are not in this checkout")


def test_committed_shapes_carry_the_spec_descriptions() -> None:
    source = SHAPES_PATH.read_text()
    assert render(source, load_specs()) == source, (
        "shapes.py field comments drifted from the OpenAPI specs: run `python bindings/python/tests/shape_docs.py`"
    )


def test_every_mapped_shape_and_component_exists_and_is_described() -> None:
    specs = load_specs()
    source = SHAPES_PATH.read_text()
    for name, (stem, component) in SHAPES.items():
        shape = getattr(shapes, name)
        assert issubclass(shape, dict) and hasattr(shape, "__total__"), name  # a TypedDict (3.9 has no is_typeddict)
        assert component in specs[stem]["components"]["schemas"], (name, stem, component)
        described = property_descriptions(specs[stem], component).keys() & shape.__annotations__.keys()
        # A mapping that matched no field would document nothing; name the right component instead.
        assert described, (name, component)
        for key in described:
            assert f'"{key}":' in source or f"    {key}:" in source, (name, key)


def test_render_writes_attribute_docstrings_and_keeps_undescribed_ones() -> None:
    spec = {
        "components": {
            "schemas": {
                "NotifyEvent": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "The event id, a `ntf_` string."},
                        "tags": {"type": "array"},
                        "title": {"type": "string"},
                        "url": {"type": "string", "description": 'A URL "quoted"'},
                    },
                }
            }
        }
    }
    source = (
        "class NotifyEvent(TypedDict, total=False):\n"
        '    """A Notify event.\n\n    id: not a field, a docstring line.\n    """\n\n'
        "    #: Stale comment.\n"
        "    id: str\n"
        '    """Stale docstring."""\n'
        "    #: Hand-written, made a docstring.\n"
        "    tags: list[str]\n"
        "    title: str\n"
        '    """Hand-written docstring,\n    over two lines."""\n'
        "    url: str\n"
        "\n\n"
        "class Other(TypedDict):\n"
        "    #: Unmapped, made a docstring.\n"
        "    id: str\n"
    )
    rendered = render(source, {"notify": spec})
    assert '    id: str\n    """The event id, a ``ntf_`` string."""\n' in rendered
    assert "Stale" not in rendered
    assert '    tags: list[str]\n    """Hand-written, made a docstring."""\n' in rendered
    assert '    title: str\n    """Hand-written docstring,\n    over two lines."""\n' in rendered
    # A closing quote in the text is escaped so it cannot end the docstring early.
    assert '    url: str\n    """A URL "quoted\\""""' in rendered
    assert '    id: str\n    """Unmapped, made a docstring."""\n' in rendered
    assert "    id: not a field, a docstring line.\n" in rendered
    assert "#:" not in rendered
    assert render(rendered, {"notify": spec}) == rendered
    compile(rendered.replace("TypedDict", "object"), "<rendered>", "exec")


def test_render_wraps_long_docstrings_at_the_line_width() -> None:
    description = " ".join(["word"] * 60)
    spec = {"components": {"schemas": {"Box": {"properties": {"id": {"description": description}}}}}}
    rendered = render("class Box(TypedDict, total=False):\n    id: str\n", {"box": spec})
    lines = rendered.rstrip("\n").split("\n")[2:]
    assert len(lines) > 1 and all(len(line) <= 120 for line in lines)
    assert lines[0].startswith('    """word') and lines[-1].endswith('word"""')
    assert render(rendered, {"box": spec}) == rendered


def test_render_documents_a_from_base_with_a_comment_and_union_members() -> None:
    union = {
        "oneOf": [
            {"properties": {"from": {"description": "The sender."}, "quote": {"description": "SMS parts."}}},
            {"properties": {"from": {"description": "The sender."}, "quote": {"description": "Voice parts."}}},
        ]
    }
    specs = {"messaging": {"components": {"schemas": {"MessagingQuote": union, "MessagingMessage": union}}}}
    source = (
        '_MessagingMessageFrom = TypedDict(\n    "_MessagingMessageFrom",\n    {\n        "from": str,\n    },\n'
        "    total=False,\n)\n\n\nclass MessagingQuote(TypedDict, total=False):\n    quote: dict[str, Any]\n"
    )
    rendered = render(source, specs)
    assert '        #: The sender.\n        "from": str,\n' in rendered
    # The branches disagree on ``quote``, so it gets no docstring.
    assert rendered.endswith("    quote: dict[str, Any]\n")


def _spec_keys(spec: dict[str, Any], component: str) -> tuple[set[str], bool]:
    """``component``'s properties merged across its union branches, and whether it allows others."""
    schema = _resolve(spec, spec["components"]["schemas"][component])
    branches = [
        schema,
        *(_resolve(spec, branch) for key in ("oneOf", "anyOf", "allOf") for branch in schema.get(key, [])),
    ]
    keys = {name for branch in branches for name in branch.get("properties", {})}
    open_ended = any(branch.get("additionalProperties") not in (None, False) for branch in branches)
    return keys, open_ended


#: Keys the SDK adds that the wire does not carry.
SDK_ONLY_KEYS = {("MailRealtimeTicket", "url")}


def test_every_mapped_shape_has_exactly_the_wire_keys() -> None:
    specs = load_specs()
    problems = []
    for name, (stem, component) in SHAPES.items():
        keys = set(getattr(shapes, name).__annotations__)
        spec_keys, open_ended = _spec_keys(specs[stem], component)
        missing = sorted(spec_keys - keys)
        # A component with ``additionalProperties`` (``ManagedAgentEvent``'s per-type fields,
        # ``SitesStatus``'s ``<service>Available`` flags) may have documented keys beyond its properties.
        extra = sorted(key for key in keys - spec_keys if not open_ended and (name, key) not in SDK_ONLY_KEYS)
        if missing or extra:
            problems.append(f"{name} ({stem} {component}): missing {missing}, not on the wire {extra}")
    assert not problems, "\n".join(problems)


def test_sdk_only_keys_are_still_sdk_only() -> None:
    specs = load_specs()
    for name, key in SDK_ONLY_KEYS:
        stem, component = SHAPES[name]
        assert key in getattr(shapes, name).__annotations__, (name, key)
        assert key not in _spec_keys(specs[stem], component)[0], f"{name}.{key} is on the wire now; drop it here"


def test_from_bases_hold_only_from_and_shapes_inherit_them() -> None:
    source = SHAPES_PATH.read_text()
    for base_name, shape_name in FROM_BASES.items():
        assert set(getattr(shapes, base_name).__annotations__) == {"from"}, base_name
        assert base_name not in shapes.__all__
        # TypedDict classes keep no runtime record of their bases on 3.9, so read the declaration.
        assert f"class {shape_name}({base_name}, total=False):" in source, shape_name
        assert "from" in getattr(shapes, shape_name).__annotations__, shape_name


def test_class_fields_carry_docstrings_not_comments() -> None:
    # Every field comment in a class body is an attribute docstring, which IDEs show on hover;
    # ``#:`` comments remain only at module level and in the functional ``from`` bases.
    in_class = False
    for number, line in enumerate(SHAPES_PATH.read_text().split("\n"), 1):
        if line.startswith("class "):
            in_class = True
        elif line and not line[0].isspace():
            in_class = False
        assert not (in_class and line.lstrip().startswith("#:")), f"shapes.py:{number}: {line.strip()}"
