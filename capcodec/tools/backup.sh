#!/usr/bin/env bash
set -euo pipefail
DEST="${CAPCODEC_BACKUP:-/cursor/stores/self/backups}"
mkdir -p "$DEST"
cd "$(dirname "$0")/.."
git bundle create "$DEST/capcodec.bundle" --all >/dev/null 2>&1
git -C "$HOME/work/tov" bundle create "$DEST/tov-encoder-features.bundle" --branches >/dev/null 2>&1 || true
CAP="${CAP_REPO:-/workspace}"
if git -C "$CAP" rev-parse --verify -q cursor/capcodec-integration-aa45 >/dev/null; then
  git -C "$CAP" bundle create "$DEST/cap-integration.bundle" origin/main..cursor/capcodec-integration-aa45 >/dev/null 2>&1 || true
fi
cp PROGRESS.md "$DEST/PROGRESS.md"
date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/last_backup.txt"
ls -la "$DEST"
