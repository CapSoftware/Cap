#!/usr/bin/env bash
# Drives a built cap-gpui through macOS UI checks that need a real desktop:
# the menu bar and tray menus, whether the recording controls let clicks
# through their transparent area, and the main and settings windows in a few
# languages. Screenshots and logs land in OUT; results.txt holds the verdicts.
#
#   scripts/ui-smoke/macos.sh <cap-gpui binary> <out dir> <label>
#
# Needs Screen Recording and Accessibility granted to the calling shell, and
# cliclick on PATH.
set -uo pipefail

APP=$1
OUT=$2
LABEL=$3
HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS=${UI_SMOKE_TOOLS:-$OUT/../tools}
mkdir -p "$OUT" "$TOOLS"
RESULTS="$OUT/results.txt"
: > "$RESULTS"

[ -x "$TOOLS/click-target" ] || swiftc -O "$HERE/click-target.swift" -o "$TOOLS/click-target"
[ -x "$TOOLS/windows" ] || swiftc -O "$HERE/windows.swift" -o "$TOOLS/windows"

result() { echo "$LABEL $1: $2" | tee -a "$RESULTS"; }
shot() { screencapture -x "$OUT/$1.png"; }
escape() { osascript -e 'tell application "System Events" to key code 53' >/dev/null 2>&1; }

sandbox() {
    local dir
    dir=$(mktemp -d)
    mkdir -p "$dir/recordings" "$dir/logs"
    cat > "$dir/store" <<'JSON'
{"general_settings":{"hasCompletedOnboarding":true,"hasCompletedStartup":true,"enableNotifications":false,"enableTelemetry":false,"recordingCountdown":0},"recording_start_safety":{"confirmBeforeRecordingWithoutMicrophone":false}}
JSON
    echo "$dir"
}

APP_PID=
launch() {
    local name=$1 dir
    shift
    dir=$(sandbox)
    env CAP_GPUI_APP_DATA_DIR="$dir" CAP_GPUI_RECORDINGS_DIR="$dir/recordings" \
        CAP_GPUI_LOG_DIR="$dir/logs" CAP_GPUI_AUTO_NO_MIC=1 \
        RUST_LOG=cap_gpui=info "$@" "$APP" > "$OUT/$name.log" 2>&1 &
    APP_PID=$!
}

quit_app() {
    [ -n "$APP_PID" ] || return
    kill "$APP_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$APP_PID" 2>/dev/null
    APP_PID=
    sleep 1
}

in_app() {
    osascript -e "tell application \"System Events\" to tell (first process whose unix id is $APP_PID) to $1" 2>&1
}

# Menus and tray, with a simulated update so the update row shows its badge.
launch menus CAP_GPUI_UPDATE_SIMULATION_VERSION=9.9.9 CAP_GPUI_TRAY_DUMP="$OUT/tray-dump.txt"
sleep 12
shot menus-00-launch
names=$(in_app 'get name of every menu bar item of menu bar 1')
result menu_bar "$names"
count=$(in_app 'count menu bar items of menu bar 1')
for index in $(seq 2 "${count:-1}"); do
    in_app "click menu bar item $index of menu bar 1" >/dev/null &
    sleep 1.5
    shot "menus-$(printf %02d "$index")"
    escape
    sleep 0.5
done
in_app 'click menu bar item 1 of menu bar 2' >/dev/null &
sleep 1.5
shot tray-00-open
osascript -e 'tell application "System Events" to key code 125' >/dev/null 2>&1
sleep 0.4
osascript -e 'tell application "System Events" to key code 124' >/dev/null 2>&1
sleep 0.6
shot tray-01-keyboard
escape
sleep 0.5
[ -s "$OUT/tray-dump.txt" ] && result tray_dump "written" || result tray_dump "missing"
grep -E "update|Update" "$OUT/menus.log" | tail -5 > "$OUT/update-log.txt"
quit_app

# Click-through: a click target fills the screen under the recording controls.
"$TOOLS/click-target" "$OUT/clicks.txt" &
TARGET_PID=$!
sleep 3
launch record CAP_GPUI_NO_TRAY=1 CAP_GPUI_NO_MENUS=1 CAP_GPUI_AUTO_RECORD=studio:90
controls=
for _ in $(seq 1 120); do
    controls=$("$TOOLS/windows" cap-gpui | awk '$3 == 320 && $4 == 150 { print; exit }')
    [ -n "$controls" ] && break
    sleep 0.5
done
if [ -z "$controls" ]; then
    result controls_window "not found"
    "$TOOLS/windows" cap-gpui > "$OUT/windows.txt"
else
    result controls_window "$controls"
    read -r x y w h _ <<< "$controls"
    sleep 3
    shot record-00-controls
    clicked() { awk -v x="$1" -v y="$2" '($1-x)^2 + ($2-y)^2 <= 9 { found = 1 } END { exit !found }' "$OUT/clicks.txt"; }

    tx=$((x + w / 2)); ty=$((y + 30))
    cliclick "m:$tx,$ty" && sleep 0.4 && cliclick "c:$tx,$ty" && sleep 0.6
    clicked "$tx" "$ty" && result transparent_area_passes_click yes || result transparent_area_passes_click no

    hx=$((x + w - 22)); hy=$((y + h - 32))
    cliclick "m:$hx,$hy" && sleep 0.4 && cliclick "c:$hx,$hy" && sleep 0.6
    clicked "$hx" "$hy" && result bar_takes_click no || result bar_takes_click yes

    cliclick "m:$tx,$ty" && sleep 0.4
    cliclick "m:$hx,$((hy - 1))" "c:$hx,$((hy - 1))" && sleep 0.6
    clicked "$hx" "$((hy - 1))" && result quick_move_and_click_on_bar "passed through" || result quick_move_and_click_on_bar "taken by bar"

    cliclick "m:$tx,$((ty + 5))" && sleep 0.4 && cliclick "c:$tx,$((ty + 5))" && sleep 0.6
    clicked "$tx" "$((ty + 5))" && result transparent_area_after_bar yes || result transparent_area_after_bar no
    shot record-01-after-clicks
fi
quit_app
kill "$TARGET_PID" 2>/dev/null

# Languages: main window plus the General settings page.
for locale in ${UI_SMOKE_LOCALES:-en de ja hi}; do
    launch "locale-$locale" CAP_GPUI_LOCALE="$locale" CAP_GPUI_LANGUAGE_PICKER=1 CAP_GPUI_AUTO_SETTINGS=general
    sleep 10
    shot "locale-$locale"
    quit_app
done

cat "$RESULTS"
