#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "${PYTHON_BIN:-}" ]]; then
  if command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    PYTHON_BIN="python3"
  fi
fi
OUTPUT_DIR="${1:-$SCRIPT_DIR/dist}"

bash "$SCRIPT_DIR/test.sh"

"$PYTHON_BIN" -m pip install --disable-pip-version-check --quiet build
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
"$PYTHON_BIN" -m build --wheel --outdir "$OUTPUT_DIR" "$SCRIPT_DIR"
