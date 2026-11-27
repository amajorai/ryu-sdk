#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# The vault client is pure Go: test it before (and without) the Rust FFI.
(cd "$SCRIPT_DIR" && CGO_ENABLED=0 go vet ./ryusdk/vault/... && CGO_ENABLED=0 go test ./ryusdk/vault/...)

cargo build --release --manifest-path "$REPO_ROOT/crates/sdk/ffi/Cargo.toml"
cd "$SCRIPT_DIR"
case "$(uname -s)" in
  Darwin) export DYLD_LIBRARY_PATH="$REPO_ROOT/target/release${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" ;;
  Linux) export LD_LIBRARY_PATH="$REPO_ROOT/target/release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  MINGW*|MSYS*|CYGWIN*) export PATH="$REPO_ROOT/target/release:$PATH" ;;
esac
go test ./...
go run ./example
