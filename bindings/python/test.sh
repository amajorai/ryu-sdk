#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    PYTHON_BIN="python3"
  fi
fi
case "$(uname -s)" in
  Darwin) LIB_NAME="libryu_sdk_uniffi.dylib" ;;
  MINGW*|MSYS*|CYGWIN*) LIB_NAME="ryu_sdk_uniffi.dll" ;;
  *) LIB_NAME="libryu_sdk_uniffi.so" ;;
esac
LIB_PATH="$REPO_ROOT/target/release/$LIB_NAME"

cargo build --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml"
mkdir -p "$SCRIPT_DIR/ryu_sdk"
cargo run --release --manifest-path "$REPO_ROOT/crates/sdk/uniffi/Cargo.toml" --bin uniffi-bindgen -- \
  generate --library "$LIB_PATH" --language python --out-dir "$SCRIPT_DIR/ryu_sdk"
cp "$LIB_PATH" "$SCRIPT_DIR/ryu_sdk/"

cd "$SCRIPT_DIR"
# The pure-Python surface needs httpx; its tests use pytest, pydantic and mypy
# (the ryu_sdk.services typing gate) and the `lint` extra's pinned ruff (the
# services/tests lint gate; keep it equal to pyproject.toml, which
# tests/test_pyproject_ruff.py checks). With bun on PATH the parity-fixture
# drift tests also regenerate the TypeScript fixtures.
"$PYTHON_BIN" -m pip install --disable-pip-version-check --quiet "httpx>=0.24,<1" "pydantic>=2.4.0,<3" "pytest>=9.0.3; python_version >= '3.10'" "pytest>=7; python_version < '3.10'" "mypy>=1.8" "ruff==0.17.1"
PYTHONPATH=. "$PYTHON_BIN" -m pytest -q tests
PYTHONPATH=. "$PYTHON_BIN" -m unittest -v test_sdk.py
PYTHONPATH=. "$PYTHON_BIN" smoke_test.py
PYTHONPATH=. "$PYTHON_BIN" example.py
