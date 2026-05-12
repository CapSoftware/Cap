#!/usr/bin/env bash
set -euo pipefail

# Build the cap-muxer sidecar binary with the target-triple suffix Tauri's
# externalBin expects, and copy it into apps/desktop/src-tauri/binaries.
#
# Usage:
#   scripts/build-cap-muxer.sh                    # uses host triple
#   scripts/build-cap-muxer.sh <target-triple>    # uses given triple
#
# Example target triples:
#   aarch64-apple-darwin
#   x86_64-apple-darwin
#   x86_64-pc-windows-msvc

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
    TARGET="$(rustc -vV | sed -n 's|host: ||p')"
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARIES_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"

EXT=""
case "$TARGET" in
    *windows*) EXT=".exe" ;;
esac

echo "Building cap-muxer for $TARGET..."
cargo build --release -p cap-muxer --target "$TARGET"

mkdir -p "$BINARIES_DIR"

SRC="$REPO_ROOT/target/$TARGET/release/cap-muxer$EXT"
DEST="$BINARIES_DIR/cap-muxer-$TARGET$EXT"

if [[ ! -f "$SRC" ]]; then
    echo "error: built binary not found at $SRC" >&2
    exit 1
fi

cp "$SRC" "$DEST"
echo "Copied $(realpath "$SRC" 2>/dev/null || echo "$SRC") -> $DEST"
