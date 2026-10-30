"""Guards for the ruff formatting config in bindings/python/pyproject.toml."""

import re
from pathlib import Path

import pytest

tomllib = pytest.importorskip("tomllib")

PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def _pyproject() -> dict:
    with (PACKAGE_ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_ruff_target_version_follows_requires_python() -> None:
    config = _pyproject()
    match = re.fullmatch(r">=\s*3\.(\d+)", config["project"]["requires-python"].strip())
    assert match, "requires-python must stay a plain >=3.N floor for this guard"
    assert config["tool"]["ruff"]["target-version"] == f"py3{match.group(1)}"


def test_ruff_line_length_is_120() -> None:
    assert _pyproject()["tool"]["ruff"]["line-length"] == 120


def test_ruff_excludes_name_existing_files() -> None:
    # A stale entry would silently hide nothing; drop entries once reformatted or removed.
    excludes = _pyproject()["tool"]["ruff"].get("extend-exclude", [])
    missing = [entry for entry in excludes if not (PACKAGE_ROOT / entry).is_file()]
    assert missing == []


def _pinned_ruff_version() -> str:
    pins = [dep for dep in _pyproject()["project"]["optional-dependencies"]["lint"] if dep.startswith("ruff==")]
    assert len(pins) == 1, "the lint extra must pin exactly one ruff version"
    return pins[0].split("==", 1)[1]


def test_ci_installs_the_pinned_ruff() -> None:
    # Without it the lint gate below skips in CI (`.github/workflows/sdk-bindings.yml` runs test.sh).
    script = (PACKAGE_ROOT / "test.sh").read_text(encoding="utf-8")
    assert f'"ruff=={_pinned_ruff_version()}"' in script


def test_ruff_check_is_clean_on_the_services_and_tests() -> None:
    # The rule set is the pinned ruff's defaults (no `select`), so only that version can vouch for it.
    import subprocess

    ruff = pytest.importorskip("ruff.__main__")
    binary = ruff.find_ruff_bin()
    version = subprocess.run([binary, "--version"], capture_output=True, text=True, check=True).stdout.split()[-1]
    pinned = _pinned_ruff_version()
    if version != pinned:
        pytest.skip(f"ruff {version} is installed; the lint extra pins {pinned}")
    result = subprocess.run(
        [binary, "check", "--no-cache", "--output-format", "concise", "ryu_sdk/services", "tests"],
        cwd=PACKAGE_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
