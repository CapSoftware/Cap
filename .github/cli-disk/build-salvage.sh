#!/usr/bin/env bash
# Usage: build-salvage.sh <exe suffix>. Head, base (main's apps/cli), and head with a held-back Stop (diag).
set -euo pipefail
exe=$1
py="$(command -v python3 || command -v python)"
start=$(date +%s)
cargo build --locked --profile ci-verify -p cap
cp "target/ci-verify/cap$exe" "target/ci-verify/cap-head$exe"
git fetch --depth=1 origin "$BASE_SHA"
git checkout "$BASE_SHA" -- apps/cli
cargo build --locked --profile ci-verify -p cap
cp "target/ci-verify/cap$exe" "target/ci-verify/cap-base$exe"
git checkout HEAD -- apps/cli
"$py" .github/cli-disk/diag_patch.py
cargo build --locked --profile ci-verify -p cap
cp "target/ci-verify/cap$exe" "target/ci-verify/cap-diag$exe"
git checkout HEAD -- crates/recording
git status --short
echo "build seconds: $(( $(date +%s) - start ))"
