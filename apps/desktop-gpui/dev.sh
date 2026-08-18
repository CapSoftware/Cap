#!/usr/bin/env bash
# Save-to-relaunch dev loop: rebuilds on change and swaps the running app only
# when the build succeeds, so the old UI stays up through compile errors. The
# app persists its window state through CAP_GPUI_DEV_RESTORE and reopens where
# it was, and the swap waits out an in-flight recording (see dev_restore.rs).
set -uo pipefail
cd "$(dirname "$0")"

STATE_FILE="$PWD/target/dev-restore.json"
BIN="$PWD/target/debug/cap-gpui"
BUILD=cargo
command -v cinder >/dev/null 2>&1 && BUILD=cinder

# Cargo.toml turns incremental off to keep the dep tree's caches off a full
# disk, but deps never rebuild in this loop -- the cache this creates is the
# app crate's only, and it takes a warm rebuild from ~41s to 3-23s.
export CARGO_INCREMENTAL=1

WATCH_PATHS=(src assets Cargo.toml)
[ -d resources ] && WATCH_PATHS+=(resources)
for crate in camera scap-targets recording timestamp utils project rendering editor export; do
	[ -d "../../crates/$crate/src" ] && WATCH_PATHS+=("../../crates/$crate/src")
done
for crate in gpui gpui_platform gpui_tokio; do
	[ -d "../../../zed-cap/crates/$crate/src" ] && WATCH_PATHS+=("../../../zed-cap/crates/$crate/src")
done

fingerprint() {
	find "${WATCH_PATHS[@]}" -type f \
		! -name '.DS_Store' ! -name '*.swp' ! -name '*~' \
		-exec stat -f '%N %m %z' {} + 2>/dev/null | md5
}

APP_PID=""

stop_app() {
	[ -n "$APP_PID" ] || return 0
	if ! kill -0 "$APP_PID" 2>/dev/null; then
		APP_PID=""
		return 0
	fi
	while kill -0 "$APP_PID" 2>/dev/null && grep -q '"recording":true' "$STATE_FILE" 2>/dev/null; do
		echo "[dev] recording in progress; waiting to swap..."
		sleep 2
	done
	kill "$APP_PID" 2>/dev/null
	wait "$APP_PID" 2>/dev/null
	APP_PID=""
}

start_app() {
	CAP_GPUI_DEV_RESTORE="$STATE_FILE" RUST_LOG="${RUST_LOG:-cap_gpui=info}" "$BIN" &
	APP_PID=$!
	echo "[dev] app running (pid $APP_PID)"
}

cleanup() {
	stop_app
	exit 0
}
trap cleanup INT TERM

pkill -f "$BIN" 2>/dev/null && sleep 0.5

echo "[dev] build: $BUILD | watching: ${WATCH_PATHS[*]}"
LAST=""
while true; do
	CURRENT=$(fingerprint)
	if [ "$CURRENT" != "$LAST" ]; then
		LAST="$CURRENT"
		echo "[dev] building..."
		if "$BUILD" build; then
			stop_app
			start_app
		else
			echo "[dev] build failed; keeping the previous app running"
		fi
	fi
	sleep 0.5
done
