#!/usr/bin/env bash
set -euo pipefail

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
    shift 2
    local dest_binaries=("$@")

    echo "Building ${dest_binaries[*]} for $TARGET..."
    cargo build --release -p "$package_name" --target "$TARGET"

    local src="$REPO_ROOT/target/$TARGET/release/$source_binary$EXT"

    if [[ ! -f "$src" ]]; then
        echo "error: built binary not found at $src" >&2
        exit 1
    fi

    for dest_binary in "${dest_binaries[@]}"; do
        local dest="$BINARIES_DIR/$dest_binary-$TARGET$EXT"
        cp "$src" "$dest"
        echo "Copied $(realpath "$src" 2>/dev/null || echo "$src") -> $dest"
    done
}

build_sidecar "cap-muxer" "cap-muxer" "cap-muxer"
build_sidecar "cap" "cap" "cap-cli" "cap-exporter"
