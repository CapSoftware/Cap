#!/usr/bin/env bash
# cl6.sh <os linux|windows|mac> <out> <base bin> <head bin> [phases]: builder CL's A/B for the Notes
# sidebar as one tab list per section (places, recent, folders, trash). Both arms are built with debug
# assertions (Notes hooks). Seeded synthetic notes, scratch profiles, server URL on a closed local port.
# Phases (default "p fo t x v fn"):
#   t  reader on: tree of the Notes window, base then head
#   x  reader on: real presses Trash -> Hiring -> Interview questions -> All notes (AT-SPI / UIA Select or
#      Invoke / AXPress), the selected state (and set position on Linux) of each item after every press
#   v  macOS only: VoiceOver's own cursor stepped through the sidebar, what it says at each item
#   p  no reader: shots base/head/base/head
#   fo/fn  Notes window idle 30 s, base/head/head/base, no reader / reader on: app CPU
set -u
OS=$1; OUT=$2; BASE=$3; HEAD=$4; FIXTURE=""; PHASES=${5:-p fo t x v fn}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT/trees" "$OUT/shots" "$OUT/logs" "$OUT/press"
RES=$OUT/result.txt
note() { echo "$*" | tee -a "$RES"; }
wait_line() { local i=0; while [ $i -lt $(( $3 * 4 )) ]; do grep -qaE "$2" $1 2>/dev/null && return 0; sleep 0.25; i=$((i + 1)); done; return 1; }

if [ "$OS" = windows ]; then W_HERE=$(cygpath -w "$HERE"); fi
ps1() { powershell -NoProfile -ExecutionPolicy Bypass -Command "$1"; }
psf() { local f=$1; shift; powershell -NoProfile -ExecutionPolicy Bypass -File "$W_HERE\\$f" "$@"; }
winp() { if [ "$OS" = windows ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

SURFACES="notes|CAP_GPUI_DOCS_SEED=40 CAP_GPUI_DOCS_OPEN=1|5"

P=""; AP=""; D=""; LOG=""
launch() { # <bin> <tag> <surface env> <settle> [more env...]
  local BIN=$1 TAG=$2 SENV=$3 SETTLE=$4; shift 4
  LOG=$OUT/logs/$TAG.log; D=$(mktemp -d)
  mkdir -p "$D/home" "$D/rec" "$D/logs" "$D/meetings"
  local onboard=true startup=true
  local -a extra=()
  for kv in $SENV; do
    case "$kv" in
      STARTUP=false) startup=false ;;
      *) extra+=("$kv") ;;
    esac
  done
  for kv in "$@"; do extra+=("$kv"); done
  [ "$OS" = linux ] && extra+=(BROWSER=/bin/true)
  printf '%s' "{\"general_settings\":{\"hasCompletedOnboarding\":$onboard,\"hasCompletedStartup\":$startup,\"enableNotifications\":false,\"enableTelemetry\":false,\"recordingCountdown\":0,\"serverUrl\":\"http://127.0.0.1:9\"}}" > "$D/store"
  env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$(winp "$D")" CAP_GPUI_RECORDINGS_DIR="$(winp "$D/rec")" \
    CAP_GPUI_LOG_DIR="$(winp "$D/logs")" CAP_GPUI_TAURI_STORE="$(winp "$D/store")" CAP_GPUI_NO_TRAY=1 \
    CAP_GPUI_LOCALE=en HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 RUST_LOG=warn,cap_gpui=info \
    ${extra[@]+"${extra[@]}"} "$BIN" < /dev/null > "$LOG" 2>&1 &
  P=$!
  sleep 1
  if [ "$OS" = windows ]; then AP=$(cat /proc/$P/winpid 2>/dev/null); else AP=$P; fi
  printf '%s' '{"enabled": true, "setupCompleted": true}' > "$D/meetings/settings.json"
  if ! wait_line "$LOG $D/logs/*" "DOCS READY" 150; then
    note "[$TAG] app never came up"; return 1
  fi
  sleep "${CL_SETTLE:-$SETTLE}"
  return 0
}
stop_app() {
  if [ "$OS" = windows ]; then taskkill //F //PID "$AP" > /dev/null 2>&1; fi
  kill "$P" 2> /dev/null; sleep 1; kill -9 "$P" 2> /dev/null; wait "$P" 2> /dev/null
  cat "$D"/logs/* >> "$LOG" 2> /dev/null
  find "$D" -delete 2> /dev/null; P=""; AP=""
}
cpu_s() {
  case "$OS" in
    linux) awk '{printf "%.2f", ($14 + $15) / 100}' "/proc/$AP/stat" 2> /dev/null ;;
    mac) ps -o time= -p "$AP" 2> /dev/null | awk -F: '{ if (NF == 3) print $1*3600 + $2*60 + $3; else print $1*60 + $2 }' ;;
    windows) ps1 "(Get-Process -Id $AP).TotalProcessorTime.TotalSeconds" | tr -d '\r' ;;
  esac
}
tree() { # <file>
  case "$OS" in
    linux) python3 "$HERE/atspi.py" tree "$AP" > "$1" 2>&1 ;;
    mac) "$HERE/cdax" tree "$AP" > "$1" 2>&1 ;;
    windows) psf uia.ps1 tree "$AP" "$(cygpath -w "$1")" > /dev/null 2>&1 ;;
  esac
}
press() { # <name> <file>
  case "$OS" in
    linux) CL_EXACT=1 python3 "$HERE/atspi_press.py" "$AP" "$1" > "$2" 2>&1 ;;
    mac) "$HERE/cdax" press "$AP" "$1" > "$2" 2>&1 ;;
    windows) psf clinvoke.ps1 -AppPid "$AP" -Name "$1" > "$2" 2>&1 ;;
  esac
}
shot() { # <file>
  case "$OS" in
    linux) import -window root "$1" 2> /dev/null ;;
    mac) screencapture -x "$1" 2>> "$OUT/shot-errors.txt" ;;
    windows) psf clgrab.ps1 -AppPid "$AP" -Out "$(cygpath -w "$1")" >> "$OUT/shot-errors.txt" 2>&1 ;;
  esac
}
READER=""
reader_pid() {
  if [ "$OS" = linux ]; then pgrep -x orca
  elif [ "$OS" = mac ]; then pgrep -x VoiceOver
  else ps1 '(Get-Process Narrator -ErrorAction SilentlyContinue).Id' | tr -d '\r'; fi
}
reader_on() {
  case "$OS" in
    linux)
      gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set \
        org.a11y.Status IsEnabled "<true>" > /dev/null 2>&1
      gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set \
        org.a11y.Status ScreenReaderEnabled "<true>" > /dev/null 2>&1
      orca --replace >> "$OUT/orca.log" 2>&1 & READER=$!; sleep 8 ;;
    mac)
      defaults write com.apple.VoiceOverTraining doNotShowSplashScreen -bool YES
      defaults write com.apple.VoiceOver4/default SCREnableAppleScript -bool YES
      open -a VoiceOver || /System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter &
      sleep 10; pkill -f VoiceOverQuickstart; pkill -f "VoiceOver Quickstart"; sleep 2 ;;
    windows) ps1 "Start-Process \"\$env:WINDIR\\System32\\Narrator.exe\""; sleep 10 ;;
  esac
  note "reader on: $(reader_pid | tr '\n' ' ')"
}
reader_off() {
  case "$OS" in
    linux) kill "$READER" 2> /dev/null; pkill -f "orca --replace" 2> /dev/null
      for k in ScreenReaderEnabled IsEnabled; do
        gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set \
          org.a11y.Status $k "<false>" > /dev/null 2>&1
      done ;;
    mac) pkill -x VoiceOver ;;
    windows) ps1 "Stop-Process -Name Narrator -Force -ErrorAction SilentlyContinue" ;;
  esac
  sleep 4
}
arm_bin() { [ "$1" = base ] && echo "$BASE" || echo "$HEAD"; }
surface_env() { echo "$SURFACES" | awk -F'|' -v s="$1" '$1 == s {print $2}'; }
surface_settle() { echo "$SURFACES" | awk -F'|' -v s="$1" '$1 == s {print $3}'; }
open_surface() { # <arm> <surface> <tag> [more env]
  local ARM=$1 S=$2 TAG=$3; shift 3
  launch "$(arm_bin "$ARM")" "$TAG" "$(surface_env "$S")" "$(surface_settle "$S")" "$@"
}
buttons() { # <tree file>: named and unnamed buttons, pressable named buttons
  python3 "$HERE/cl2count.py" "$OS" "$1"
}

for PH in $PHASES; do
  case $PH in
    t)
      reader_on
      for S in $(echo "$SURFACES" | cut -d'|' -f1); do
        for ARM in base head; do
          if open_surface "$ARM" "$S" "t-$S-$ARM"; then
            tree "$OUT/trees/t-$S-$ARM.txt"; shot "$OUT/shots/t-$S-$ARM.png"
            note "t $S $ARM: $(buttons "$OUT/trees/t-$S-$ARM.txt")"
          fi
          stop_app
        done
      done
      reader_off ;;
    x)
      reader_on
      for ARM in base head; do
        st() { # <name>: what the reader reads about it
          case "$OS" in
            linux) python3 "$HERE/atspi_state.py" "$AP" "$1" 2>&1 | head -1 ;;
            mac) "$HERE/cdax" attrs "$AP" "$1" 2>&1 | head -1 | cut -d'|' -f1,2,3,5,6,8 ;;
            windows) psf uiastate.ps1 -TargetPid "$AP" -Name "$1" 2>&1 | tr -d '\r' | sed 's/^\xef\xbb\xbf//' | head -1 ;;
          esac | tr -d '\r' | cut -c1-150
        }
        if open_surface "$ARM" notes "x-$ARM"; then
          for name in "All notes" "Trash" "Hiring" "Interview questions"; do note "x $ARM start | $(st "$name")"; done
          for P_NAME in "Trash" "Hiring" "Interview questions" "All notes"; do
            press "$P_NAME" "$OUT/press/x-$ARM-$P_NAME.txt"; rc=$?; sleep 2
            note "x $ARM press '$P_NAME' rc=$rc: $(head -1 "$OUT/press/x-$ARM-$P_NAME.txt" | tr -d '\r' | cut -c1-100)"
            for name in "All notes" "Trash" "Hiring" "Interview questions"; do note "     $(st "$name")"; done
          done
        fi
        stop_app
      done
      reader_off ;;
    v)
      [ "$OS" = mac ] || continue
      reader_on
      defaults write com.apple.VoiceOver4/default SCREnableAppleScript -bool YES
      for ARM in base head; do
        if open_surface "$ARM" notes "v-$ARM"; then
          "$HERE/cdax" front "$AP" > /dev/null
          osascript -e 'tell application "VoiceOver" to tell vo cursor to move to (first window of (first application process whose unix id is '$AP'))' > /dev/null 2>&1
          for k in $(seq 1 18); do
            osascript -e 'tell application "VoiceOver" to tell vo cursor to move right' > /dev/null 2>&1; sleep 0.8
            note "v $ARM step $k: $(osascript -e 'tell application "VoiceOver" to return text under cursor of vo cursor' 2>&1 | tr '\n' ' ' | cut -c1-110)"
          done
        fi
        stop_app
      done
      reader_off ;;
    p)
      for S in $(echo "$SURFACES" | cut -d'|' -f1); do
        k=0
        for ARM in base head base head; do
          k=$((k + 1))
          open_surface "$ARM" "$S" "p-$S-$ARM-$k" && shot "$OUT/shots/p-$S-$ARM-$k.png"
          stop_app
        done
      done ;;
    fo|fn)
      for MODE in $([ $PH = fo ] && echo off || echo on); do
        [ $MODE = on ] && reader_on
        k=0
        for ARM in base head head base; do
          k=$((k + 1))
          if open_surface "$ARM" notes "f-$MODE-$ARM-$k"; then
            sleep 5; c0=$(cpu_s); t0=$(date +%s); sleep 30; c1=$(cpu_s); t1=$(date +%s)
            note "f reader-$MODE $ARM run $k: notes idle cpu $(awk -v a="$c0" -v b="$c1" -v s=$((t1 - t0)) 'BEGIN {if (s > 0) printf "%.2f%%", (b - a) * 100 / s; else print "n/a"}') over $((t1 - t0)) s (raw $c0 -> $c1)"
          fi
          stop_app
        done
        [ $MODE = on ] && reader_off
      done ;;
  esac
done
note "done"
