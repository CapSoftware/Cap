#!/usr/bin/env bash
# cl4.sh <os linux|windows|mac> <out> <base bin> <head bin> <fixture .cap> [phases]: builder CL's
# screen-reader A/B for named switches: the editor's six sidebar tabs (CAP_GPUI_AUTO_SIDEBAR) and the
# teleprompter. Scratch profiles, server URL on a closed local port: nothing reaches a Cap server.
# Phases (default "p fo t x fn"):
#   t  reader on: per surface, base then head: full tree, window shot
#   x  reader on: real presses on switches by name (AT-SPI DoAction / UIA Toggle / AXPress), a tree
#      after each with the switch's state
#   p  no reader: per surface shots base/head/base/head
#   fo/fn  editor playback 20 s, base/head/head/base, no reader / reader on: CPU, frame stats
set -u
OS=$1; OUT=$2; BASE=$3; HEAD=$4; FIXTURE=$5; PHASES=${6:-t x p fo fn}
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
SURFACES="ed-background|EDITOR CAP_GPUI_AUTO_SIDEBAR=background|15
ed-camera|EDITOR CAP_GPUI_AUTO_SIDEBAR=camera|15
ed-audio|EDITOR CAP_GPUI_AUTO_SIDEBAR=audio|15
ed-cursor|EDITOR CAP_GPUI_AUTO_SIDEBAR=cursor|15
ed-keyboard|EDITOR CAP_GPUI_AUTO_SIDEBAR=keyboard|15
ed-captions|EDITOR CAP_GPUI_AUTO_SIDEBAR=captions|15
teleprompter|CAP_GPUI_AUTO_TELEPROMPTER=1|6
editor|EDITOR|15"

P=""; AP=""; D=""; LOG=""
launch() { # <bin> <tag> <surface env> <settle> [more env...]
  local BIN=$1 TAG=$2 SENV=$3 SETTLE=$4; shift 4
  LOG=$OUT/logs/$TAG.log; D=$(mktemp -d)
  mkdir -p "$D/home" "$D/rec" "$D/logs" "$D/meetings"
  local onboard=true
  local -a extra=()
  for kv in $SENV; do
    case "$kv" in
      ONBOARDING) onboard=false ;;
      EDITOR) cp -R "$FIXTURE" "$D/rec/fixture.cap"; extra+=("CAP_GPUI_AUTO_EDITOR=$(winp "$D/rec/fixture.cap")") ;;
      *) extra+=("$kv") ;;
    esac
  done
  for kv in "$@"; do extra+=("$kv"); done
  [ "$OS" = linux ] && extra+=(BROWSER=/bin/true)
  printf '%s' "{\"general_settings\":{\"hasCompletedOnboarding\":$onboard,\"hasCompletedStartup\":$onboard,\"enableNotifications\":false,\"enableTelemetry\":false,\"recordingCountdown\":0,\"serverUrl\":\"http://127.0.0.1:9\"}}" > "$D/store"
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
      for S in $(echo "$SURFACES" | cut -d'|' -f1 | grep -v '^editor$'); do
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
        sw() { # <tag> <name>: the switch's line in a tree file
          grep -a -m1 -F "$2" "$1" | sed 's/^ *//' | tr -d '\r'
        }
        px() { # <tag> <name>
          tree "$OUT/trees/x-$1-$ARM-before.txt"
          press "$2" "$OUT/press/x-$1-$ARM.txt"; local rc=$?; sleep 2
          tree "$OUT/trees/x-$1-$ARM-after.txt"
          note "x $ARM $1 '$2' rc=$rc: $(head -1 "$OUT/press/x-$1-$ARM.txt" | tr -d '\r') | before: $(sw "$OUT/trees/x-$1-$ARM-before.txt" "$2") | after: $(sw "$OUT/trees/x-$1-$ARM-after.txt" "$2") | $(buttons "$OUT/trees/x-$1-$ARM-after.txt")"
        }
        if open_surface "$ARM" ed-background "x-bg-$ARM"; then px border "Border"; fi
        stop_app
        if open_surface "$ARM" ed-audio "x-audio-$ARM"; then px mute "Mute Audio"; fi
        stop_app
        if open_surface "$ARM" ed-cursor "x-cursor-$ARM"; then px cursor "Show cursor"; fi
        stop_app
        if open_surface "$ARM" teleprompter "x-tele-$ARM"; then
          press "Teleprompter settings" "$OUT/press/x-tele-open-$ARM.txt"; sleep 2
          px mirror "Mirror text"
        fi
        stop_app
      done
      reader_off ;;
    p)
      for S in $(echo "$SURFACES" | cut -d'|' -f1 | grep -v '^editor$'); do
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
          if CL_SETTLE=0 open_surface "$ARM" editor "f-$MODE-$ARM-$k" CAP_GPUI_AUTO_PLAYBACK=20 CAP_GPUI_AUTO_FRAME_STATS=20; then
            if wait_line "$LOG $D/logs/*" "auto playback: playing" 120; then
              c0=$(cpu_s); t0=$(date +%s)
              wait_line "$LOG $D/logs/*" "p99_ms" 90
              c1=$(cpu_s); t1=$(date +%s)
              sleep 2
              fs=$(cat "$LOG" "$D"/logs/* 2> /dev/null | perl -pe 's/\e\[[0-9;]*m//g' | grep -a "p99_ms" | tail -1 | grep -oE "frames=[0-9]+|p50_ms=\"?[0-9.]+|p99_ms=\"?[0-9.]+|max_ms=\"?[0-9.]+" | tr -d '"' | tr '\n' ' ')
              pb=$(cat "$LOG" "$D"/logs/* 2> /dev/null | perl -pe 's/\e\[[0-9;]*m//g' | grep -a "playback fps=" | tail -1 | grep -oE "fps=[0-9.]+ frames=[0-9]+ dropped=[0-9]+" | head -1)
              note "f reader-$MODE $ARM run $k: cpu $(awk -v a="$c0" -v b="$c1" -v s=$((t1 - t0)) 'BEGIN {if (s > 0) printf "%.1f%%", (b - a) * 100 / s; else print "n/a"}') over $((t1 - t0)) s (raw $c0 -> $c1) | $fs| playback $pb"
            else
              note "f reader-$MODE $ARM run $k: playback never started"
            fi
          fi
          stop_app
        done
        [ $MODE = on ] && reader_off
      done ;;
  esac
done
note "done"
