#!/usr/bin/env bash
# Demo + validation for bounty #1540 (deeplinks + Raycast extension)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Cap Bounty #1540 — Validation Demo ==="
echo "Branch: $(git branch --show-current)"
echo "Commit: $(git rev-parse --short HEAD)"
echo

echo "=== 1. Raycast extension typecheck ==="
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" 2>/dev/null || true
if command -v nvm >/dev/null 2>&1; then nvm use 20 >/dev/null 2>&1 || nvm use 18 >/dev/null 2>&1 || true; fi
(cd apps/raycast && npm install --silent && npx tsc --noEmit)
echo "✓ TypeScript OK"
echo

echo "=== 2. Deeplink routes (new path-based API) ==="
cat <<'ROUTES'
cap-desktop://record/start?mode=studio   → Start studio recording (saved settings)
cap-desktop://record/start?mode=instant  → Start instant recording
cap-desktop://record/stop                → Stop recording
cap-desktop://record/pause               → Pause recording
cap-desktop://record/resume              → Resume recording
cap-desktop://record/toggle-pause        → Toggle pause
cap-desktop://device/microphone?label=X  → Switch microphone
cap-desktop://device/microphone?off=true → Disable microphone
cap-desktop://device/camera?model_id=X   → Switch camera by model ID
cap-desktop://device/camera?off=true     → Disable camera
ROUTES
echo

echo "=== 3. Legacy action deeplink (works on stock Cap today) ==="
LEGACY='cap-desktop://action?value=%7B%22open_settings%22%3A%7B%22page%22%3A%22general%22%7D%7D'
echo "Opening: $LEGACY"
open "$LEGACY" || true
sleep 2
echo

echo "=== 4. New path deeplinks (require Cap built from this PR) ==="
if [[ "${SKIP_DEEPLINK_OPEN:-}" != "1" ]]; then
  for url in \
    "cap-desktop://record/pause" \
    "cap-desktop://record/resume" \
    "cap-desktop://record/toggle-pause"; do
    echo "Opening: $url"
    open "$url" || true
    sleep 1
  done
fi
echo

echo "=== 5. Rust unit tests (when Cap build env is ready) ==="
echo "  cd apps/desktop/src-tauri && cargo test deeplink_actions"
echo "  Requires: pnpm cap-setup, pnpm build:sidecar, Rust 1.88+, cmake, llvm"
echo

echo "=== Done ==="
echo "Raycast dev mode: cd apps/raycast && npx @raycast/api@latest develop"
