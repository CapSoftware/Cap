#!/usr/bin/env bash
# Usage: build.sh <exe suffix>. Builds the checked-out head, then base's apps/cli.
set -euo pipefail
exe=$1
start=$(date +%s)
cargo build --locked --profile ci-verify -p cap
cp "target/ci-verify/cap$exe" "target/ci-verify/cap-head$exe"
git fetch --depth=1 origin "$BASE_SHA"
git diff --stat "$BASE_SHA" HEAD -- . ':!.github'
git checkout "$BASE_SHA" -- apps/cli
cargo build --locked --profile ci-verify -p cap
cp "target/ci-verify/cap$exe" "target/ci-verify/cap-base$exe"
git checkout HEAD -- apps/cli
git status --short
sha256sum "target/ci-verify/cap-head$exe" "target/ci-verify/cap-base$exe" 2>/dev/null || shasum -a 256 "target/ci-verify/cap-head$exe" "target/ci-verify/cap-base$exe"
echo "build seconds: $(( $(date +%s) - start ))"
