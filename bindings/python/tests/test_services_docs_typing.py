"""The Python samples on the public SDK pages pass ``mypy --strict``.

Every ``python`` fence under ``apps/fumadocs/content/docs/standalone/sdk`` is
written to its own module and type-checked in one mypy run against this
package, with the generated UniFFI module treated as untyped (pyproject.toml).
A reader who copies a sample into a strict project must not hit a type error
that comes from the sample itself, such as indexing ``data`` from a
``(data, error, meta)`` result before narrowing it with ``elif data:``.

Many untitled fences continue an earlier one on the same page (they use the
``ryu`` client or a ``request`` that a previous block or the reader's framework
defines), so in those names that are not defined in the fence
(``name-defined``) are not reported. The ``ryu`` client is the exception: an
untitled fence that uses ``ryu`` without binding it gets a typed preamble
(``ryu: Ryu``, ``ObjectRyu``, ``AsyncRyu`` or ``AsyncObjectRyu``, from the last
module-level ``ryu = ...Ryu(...)`` in an earlier fence on the page, else from the fence's own
``await`` and ``data, error, meta`` use), so its calls are type-checked too. A
fence with a ``title="file.py"`` is a standalone file a reader copies whole, so
an undefined name there is an error.
A web handler's top-level ``await`` (``top-level-await``) is never reported;
every other error is.

Samples that import ``openai`` are only meaningful against the real ``openai``
types, so they are checked in their own test, which is skipped (not silently
treated as untyped) when ``openai`` is not installed. Other third-party
imports (``fastapi``, a reader's own ``state`` module) stay untyped when they
are missing.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

import pytest

PYTHON_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PYTHON_ROOT / "pyproject.toml"
DOCS = PYTHON_ROOT.parents[1] / "apps/fumadocs/content/docs/standalone/sdk"
HAS_MYPY = importlib.util.find_spec("mypy") is not None
HAS_OPENAI = importlib.util.find_spec("openai") is not None
FENCE = re.compile(r"^```(?:python|py)\b([^\n]*)\n(.*?)^```\s*$", re.MULTILINE | re.DOTALL)
IMPORTS_OPENAI = re.compile(r"^\s*(?:from|import)\s+openai\b", re.MULTILINE)
# Never reported: a web handler's top-level await; see the module docstring.
DISABLED_ERRORS = ("top-level-await",)
# Reported only in titled (standalone) fences; untitled ones continue another block.
CONTINUATION_ERROR = "[name-defined]"


# Binds ``ryu`` at module level: ``ryu = Ryu(...)``, ``ryu: ObjectRyu = ...`` or ``with Ryu() as ryu:``.
BINDS_RYU = re.compile(r"^(?:ryu\s*[:=]|(?:async\s+)?with\b.*\bas\s+ryu\b)", re.MULTILINE)
USES_RYU = re.compile(r"\bryu\b(?!_)")
# The head of a module-level client construction, ``Ryu(`` or ``AsyncRyu(``, assigned to or opened as
# ``ryu``; its arguments are read with balanced parentheses (``_call_arguments``). One inside a function
# (a web handler's ``async with AsyncRyu() as ryu:``) is local to it.
CONSTRUCTS_RYU = re.compile(r"^(?:ryu\s*(?::[^=\n]*)?=\s*|(?:async\s+)?with\s+)(Async)?Ryu\(", re.MULTILINE)
WITH_AS_RYU = re.compile(r"\s+as\s+ryu\b")
OBJECT_MODE = re.compile(r"\bresult\s*=\s*['\"]object['\"]")
USES_AWAIT = re.compile(r"\bawait\s+ryu\b|\basync\s+(?:for|with)\b[^\n]*\bryu\b")
USES_RESULT = re.compile(r"^\s*\w+\s*,\s*error\s*,\s*\w+\s*=", re.MULTILINE)
PREAMBLE_TYPES = {
    (False, False): "Ryu",
    (False, True): "ObjectRyu",
    (True, False): "AsyncRyu",
    (True, True): "AsyncObjectRyu",
}


class Fence(NamedTuple):
    page: str
    line: int
    titled: bool
    body: str
    preamble: str = ""


def _call_arguments(text: str, start: int) -> tuple[str, int]:
    """The argument text of the call whose ``(`` is at ``text[start - 1]``, and the index past its ``)``.
    Parentheses inside string literals are not balanced; the docs' constructors have none."""
    depth = 1
    for index in range(start, len(text)):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return text[start:index], index + 1
    return text[start:], len(text)


def _constructions(text: str) -> list[tuple[bool, bool]]:
    """``(is_async, is_object)`` for each module-level ``ryu`` client construction in ``text``."""
    found = []
    for match in CONSTRUCTS_RYU.finditer(text):
        arguments, end = _call_arguments(text, match.end())
        if match.group(0).lstrip().startswith(("with", "async")) and not WITH_AS_RYU.match(text, end):
            continue
        found.append((bool(match.group(1)), bool(OBJECT_MODE.search(arguments))))
    return found


def _ryu_preamble(body: str, earlier: list[str]) -> str:
    """The typed ``ryu`` declaration an untitled fence continues from, or ``""`` when it needs none."""
    if not USES_RYU.search(body) or BINDS_RYU.search(body):
        return ""
    constructions = [found for text in earlier for found in _constructions(text)]
    if constructions:
        is_async, is_object = constructions[-1]
    else:
        is_async = bool(USES_AWAIT.search(body))
        is_object = bool(USES_RESULT.search(body))
    name = PREAMBLE_TYPES[(is_async, is_object)]
    return f"from ryu_sdk.services import {name} as _Docs{name}\nryu: _Docs{name}\n"


def _fences() -> list[Fence]:
    found: list[Fence] = []
    for page in sorted(DOCS.rglob("*.mdx")):
        content = page.read_text()
        earlier: list[str] = []
        for match in FENCE.finditer(content):
            line = content.count("\n", 0, match.start()) + 1
            titled = "title=" in match.group(1)
            body = match.group(2)
            preamble = "" if titled else _ryu_preamble(body, earlier)
            found.append(Fence(page.relative_to(DOCS).as_posix(), line, titled, body, preamble))
            earlier.append(body)
    return found


def _mypy_problems(fences: list[Fence], tmp_path: Path) -> list[str]:
    origins: dict[str, Fence] = {}
    for index, fence in enumerate(fences):
        name = f"sample_{index:03d}.py"
        (tmp_path / name).write_text(fence.preamble + fence.body)
        origins[name] = fence
    disabled = [argument for code in DISABLED_ERRORS for argument in ("--disable-error-code", code)]
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "mypy",
            "--strict",
            "--no-incremental",
            "--cache-dir",
            str(tmp_path / ".mypy_cache"),
            "--config-file",
            str(PYPROJECT),
            "--ignore-missing-imports",
            "--no-error-summary",
            *disabled,
            *origins,
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
        env={"PYTHONPATH": str(PYTHON_ROOT), "PATH": "/usr/bin:/bin"},
    )
    # 0 is clean and 1 is "errors found"; anything else is a mypy crash or usage error.
    assert completed.returncode in (0, 1), completed.stdout + completed.stderr
    problems = []
    for output in completed.stdout.splitlines():
        sample = output.split(":", 1)[0]
        origin = origins.get(sample)
        if ": error:" not in output or origin is None:
            continue
        if output.endswith(CONTINUATION_ERROR) and not origin.titled:
            continue
        # Name the page and the fence's opening line (and the line in the fence, past any preamble),
        # not the scratch module.
        offset = int(output.split(":", 2)[1]) - origin.preamble.count("\n")
        problems.append(f"{origin.page}:{origin.line} (+{offset}): {output.split(': error: ', 1)[1]}")
    if completed.returncode == 1:
        assert problems or any(line.endswith(CONTINUATION_ERROR) for line in completed.stdout.splitlines()), (
            completed.stdout + completed.stderr
        )
    return problems


def test_the_pages_have_python_samples() -> None:
    if not DOCS.exists():
        pytest.skip("the fumadocs content is not in this checkout")
    pages = {fence.page for fence in _fences()}
    # The service pages and the cross-cutting pages each show Python.
    assert {"index.mdx", "notify.mdx", "box.mdx", "errors.mdx", "agent-tools.mdx"} <= pages


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_every_python_sample_passes_mypy_strict(tmp_path: Path) -> None:
    if not DOCS.exists():
        pytest.skip("the fumadocs content is not in this checkout")
    fences = [fence for fence in _fences() if not IMPORTS_OPENAI.search(fence.body)]
    problems = _mypy_problems(fences, tmp_path)
    assert not problems, "\n".join(problems)


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
@pytest.mark.skipif(not HAS_OPENAI, reason="openai is not installed, so its samples cannot be typed")
def test_openai_samples_pass_mypy_strict_against_openai(tmp_path: Path) -> None:
    if not DOCS.exists():
        pytest.skip("the fumadocs content is not in this checkout")
    fences = [fence for fence in _fences() if IMPORTS_OPENAI.search(fence.body)]
    assert fences, "agent-tools.mdx shows an OpenAI tool loop"
    problems = _mypy_problems(fences, tmp_path)
    assert not problems, "\n".join(problems)


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_only_titled_samples_report_undefined_names(tmp_path: Path) -> None:
    # The docs' anthropic_tools.py with `import json` dropped: a standalone file that breaks on copy.
    body = "def dump(value: object) -> str:\n    return str(json.dumps(value))\n"
    titled = Fence("agent-tools.mdx", 1, True, body)
    continuation = Fence("agent-tools.mdx", 9, False, body)
    problems = _mypy_problems([titled, continuation], tmp_path)
    assert len(problems) == 1, problems
    assert problems[0].startswith("agent-tools.mdx:1 ")
    assert "json" in problems[0]


def test_the_preamble_types_ryu_from_the_page_or_the_fence() -> None:
    sync_object = 'ryu = Ryu(result="object")\n'
    assert "ObjectRyu" in _ryu_preamble("ryu.notify.publish({})\n", [sync_object])
    # The last module-level construction wins; a handler's local client does not count.
    handler = "async def handler() -> None:\n    async with AsyncRyu() as ryu:\n        pass\n"
    assert "import ObjectRyu as" in _ryu_preamble("ryu.notify.publish({})\n", [sync_object, handler])
    assert "import AsyncRyu as" in _ryu_preamble("x = 1\nprint(ryu)\n", ["async with AsyncRyu() as ryu:\n    pass\n"])
    # Without an earlier construction, the fence's own await and Result unpacking decide.
    assert "import Ryu as" in _ryu_preamble("ryu.box.list()\n", [])
    assert "import AsyncObjectRyu as" in _ryu_preamble("data, error, meta = await ryu.box.list()\n", [])
    # A fence that binds ryu itself, or never names it, needs none.
    assert _ryu_preamble("ryu = Ryu()\nryu.box.list()\n", []) == ""
    assert _ryu_preamble("with Ryu() as ryu:\n    ryu.box.list()\n", []) == ""
    assert _ryu_preamble("ryu_key = 1\n", []) == ""


def test_the_preamble_reads_the_whole_constructor_call() -> None:
    use = "ryu.box.list()\n"
    # A nested call before ``result=`` does not cut the arguments short.
    nested = 'ryu = Ryu(\n    hooks={"on_request": lambda r: print(r)},\n    result="object",\n)\n'
    assert "import ObjectRyu as" in _ryu_preamble(use, [nested])
    # Any quoting and spacing of ``result="object"``.
    assert "import ObjectRyu as" in _ryu_preamble(use, ["ryu = Ryu(result='object')\n"])
    assert "import AsyncObjectRyu as" in _ryu_preamble(use, ['ryu = AsyncRyu(timeout=(5), result = "object")\n'])
    assert "import ObjectRyu as" in _ryu_preamble(use, ['with Ryu(api_key=key(), result="object") as ryu:\n    pass\n'])
    # A nested call alone, or a ``result`` that is not object mode, is throw mode.
    assert "import Ryu as" in _ryu_preamble(use, ['ryu = Ryu(hooks={"x": print("y")})\n'])
    assert "import Ryu as" in _ryu_preamble(use, ['ryu = Ryu(result="throw")\n'])
    # A ``with Ryu(...)`` that binds another name does not count.
    assert "import Ryu as" in _ryu_preamble(use, ["ryu = Ryu()\n", 'with Ryu(result="object") as other:\n    pass\n'])


def test_most_continuation_fences_get_a_typed_ryu() -> None:
    if not DOCS.exists():
        pytest.skip("the fumadocs content is not in this checkout")
    continued = [fence for fence in _fences() if fence.preamble]
    assert len(continued) >= 20, len(continued)
    assert all(not fence.titled for fence in continued)


@pytest.mark.skipif(not HAS_MYPY, reason="mypy is not installed")
def test_a_continuation_fence_reports_a_misspelt_method_on_ryu(tmp_path: Path) -> None:
    body = "for box in ryu.box.lst():\n    print(box)\n"
    fence = Fence("box.mdx", 40, False, body, _ryu_preamble(body, []))
    problems = _mypy_problems([fence], tmp_path)
    assert len(problems) == 1, problems
    assert problems[0].startswith("box.mdx:40 (+1): ")
    assert '"lst"' in problems[0]
