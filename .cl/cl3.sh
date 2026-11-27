#!/usr/bin/env bash
# cl3.sh <os linux|windows|mac> <out> <base bin> <head bin> [phases]: builder CL's screen-reader A/B
# for the onboarding window (welcome + every tour step + permissions). Both arms are built with debug
# assertions so CAP_GPUI_ONBOARDING_STEP can open a step. Scratch profiles, server URL on a closed
# local port: nothing reaches a Cap server.
# Phases (default "p fo t x fn"):
#   t  reader on: per step, base then head: full tree, window shot
#   x  reader on: real presses through the flow (AT-SPI DoAction / UIA Invoke, Toggle or Select /
#      AXPress), base and head, a tree after each
#   p  no reader: per step shots base/head/base/head
#   fo/fn  welcome screen 30 s, base/head/head/base, no reader (fo) or reader on (fn): app CPU
set -u
OS=$1; OUT=$2; BASE=$3; HEAD=$4; FIXTURE=""; PHASES=${5:-p fo t x fn}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT/trees" "$OUT/shots" "$OUT/logs" "$OUT/press"
RES=$OUT/result.txt
note() { echo "$*" | tee -a "$RES"; }
wait_line() { local i=0; while [ $i -lt $(( $3 * 4 )) ]; do grep -qaE "$2" $1 2>/dev/null && return 0; sleep 0.25; i=$((i + 1)); done; return 1; }

if [ "$OS" = windows ]; then W_HERE=$(cygpath -w "$HERE"); fi
ps1() { powershell -NoProfile -ExecutionPolicy Bypass -Command "$1"; }
psf() { local f=$1; shift; powershell -NoProfile -ExecutionPolicy Bypass -File "$W_HERE\\$f" "$@"; }
winp() { if [ "$OS" = windows ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# surface | extra env (space separated) | settle seconds after the first frame
SURFACES="ob-welcome|STARTUP=false|8
ob-permissions|CAP_GPUI_ONBOARDING_STEP=permissions|6
ob-overview|CAP_GPUI_ONBOARDING_STEP=overview|6
ob-instant|CAP_GPUI_ONBOARDING_STEP=instant|6
ob-studio|CAP_GPUI_ONBOARDING_STEP=studio|6
ob-screenshot|CAP_GPUI_ONBOARDING_STEP=screenshot|6
ob-toggle|CAP_GPUI_ONBOARDING_STEP=toggle|6
ob-shortcuts|CAP_GPUI_ONBOARDING_STEP=shortcuts|6
ob-faq|CAP_GPUI_ONBOARDING_STEP=faq|6"

P=""; AP=""; D=""; LOG=""
launch() { # <bin> <tag> <surface env> <settle> [more env...]
  local BIN=$1 TAG=$2 SENV=$3 SETTLE=$4; shift 4
  LOG=$OUT/logs/$TAG.log; D=$(mktemp -d)
  mkdir -p "$D/home" "$D/rec" "$D/logs" "$D/meetings"
  local onboard=false startup=true
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
  if ! wait_line "$LOG $D/logs/*" "launch render warmup finished|main window opened" 90; then
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
    linux) python3 "$HERE/atspi_press.py" "$AP" "^$1\$" > "$2" 2>&1 ;;
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
        px() { # <tag> <name>: press, then a tree
          press "$2" "$OUT/press/x-$1-$ARM.txt"; local rc=$?; sleep 2
          tree "$OUT/trees/x-$1-$ARM-after.txt"
          note "x $ARM $1 '$2' rc=$rc: $(head -1 "$OUT/press/x-$1-$ARM.txt" | tr -d '\r') | after: $(tail -1 "$OUT/trees/x-$1-$ARM-after.txt" | tr -d '\r') | headings: $(grep -aE 'heading|Heading|AXHeading' "$OUT/trees/x-$1-$ARM-after.txt" | sed 's/^ *//' | cut -d'|' -f1-2 | tr -d '\r' | tr '\n' ';')"
        }
        if open_surface "$ARM" ob-welcome "x-welcome-$ARM"; then
          px mute "Mute"; px getstarted "Get Started"
        fi
        stop_app
        if open_surface "$ARM" ob-overview "x-overview-$ARM"; then
          px continue "Continue"; px back "Back"
        fi
        stop_app
        if open_surface "$ARM" ob-toggle "x-toggle-$ARM"; then
          px radio "Studio Mode"
          note "   radios after: $(grep -aiE 'radio' "$OUT/trees/x-radio-$ARM-after.txt" | sed 's/^ *//' | tr -d '\r' | tr '\n' ';')"
        fi
        stop_app
        if open_surface "$ARM" ob-faq "x-faq-$ARM"; then
          px faq "Is Cap free to use?"
          note "   answer shown: $(grep -ac 'Cap is free for personal use' "$OUT/trees/x-faq-$ARM-after.txt") | state: $(grep -a 'Is Cap free to use' "$OUT/trees/x-faq-$ARM-after.txt" | head -1 | sed 's/^ *//' | tr -d '\r')"
        fi
        stop_app
        if open_surface "$ARM" ob-shortcuts "x-shortcuts-$ARM"; then
          px skip "Skip the tour"
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
          if open_surface "$ARM" ob-welcome "f-$MODE-$ARM-$k"; then
            c0=$(cpu_s); t0=$(date +%s); sleep 30; c1=$(cpu_s); t1=$(date +%s)
            note "f reader-$MODE $ARM run $k: welcome cpu $(awk -v a="$c0" -v b="$c1" -v s=$((t1 - t0)) 'BEGIN {if (s > 0) printf "%.1f%%", (b - a) * 100 / s; else print "n/a"}') over $((t1 - t0)) s (raw $c0 -> $c1)"
          fi
          stop_app
        done
        [ $MODE = on ] && reader_off
      done ;;
  esac
done
note "done"
