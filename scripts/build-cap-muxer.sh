#!/usr/bin/env bash
set -euo pipefail

# Build desktop sidecar binaries with the target-triple suffix Tauri's
# externalBin expects, and copy them into apps/desktop/src-tauri/binaries.
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

mkdir -p "$BINARIES_DIR"

build_sidecar() {
    local package_name="$1"
    local source_binary="$2"
    local dest_binary="$3"

    echo "Building $dest_binary for $TARGET..."
    cargo build --release -p "$package_name" --target "$TARGET"

    local src="$REPO_ROOT/target/$TARGET/release/$source_binary$EXT"
    local dest="$BINARIES_DIR/$dest_binary-$TARGET$EXT"

    if [[ ! -f "$src" ]]; then
        echo "error: built binary not found at $src" >&2
        exit 1
    fi

    cp "$src" "$dest"
    echo "Copied $(realpath "$src" 2>/dev/null || echo "$src") -> $dest"
}

build_sidecar "cap-muxer" "cap-muxer" "cap-muxer"
build_sidecar "cap" "cap" "cap-exporter"
