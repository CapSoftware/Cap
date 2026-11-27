#!/usr/bin/env bash
# cq.sh <os linux|windows|mac> <out> <"tag=bin ..."> [case filter regex]: builder CQ's Ask answer
# shots. Per case and build: a fresh scratch profile, the real app signed in as Cap Pro against a
# stub server (stub.py), a written meeting opened, a real Ask question sent, the stub's fixed answer
# streamed, then one screenshot. cpu-* cases take no shot: they record the app's CPU time while a
# long answer streams. Nothing reaches a Cap server.
set -u
OS=$1; OUT=$2; BINS=$3; FILTER=${4:-.}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT/shots" "$OUT/logs"
RES=$OUT/result.txt
note() { echo "$*" | tee -a "$RES"; }
wait_line() { local i=0; while [ $i -lt $(( $3 * 10 )) ]; do grep -qaE "$2" $1 2>/dev/null && return 0; sleep 0.1; i=$((i + 1)); done; return 1; }
if [ "$OS" = windows ]; then W_HERE=$(cygpath -w "$HERE"); fi
psf() { local f=$1; shift; powershell -NoProfile -ExecutionPolicy Bypass -File "$W_HERE\\$f" "$@"; }
winp() { if [ "$OS" = windows ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
PY=python3; [ "$OS" = windows ] && PY=python
PORT=8932

shot() { # <file>
  case "$OS" in
    linux)
      local id; id=$(xdotool search --onlyvisible --name "^Cap Notes\$" 2> /dev/null | tail -1)
      if [ -n "$id" ]; then import -window "$id" "$1" 2> /dev/null; else import -window root "$1" 2> /dev/null; fi ;;
    mac) screencapture -x "$1" 2>> "$OUT/shot-errors.txt" ;;
    windows) psf clgrab.ps1 -AppPid "$AP" -Out "$(cygpath -w "$1")" >> "$OUT/shot-errors.txt" 2>&1 ;;
  esac
}

cpu_ms() {
  case "$OS" in
    linux) awk '{print ($14 + $15) * 10}' "/proc/$AP/stat" 2> /dev/null ;;
    mac) ps -o time= -p "$AP" | awk '{n = split($1, a, ":"); s = a[n]; m = (n > 1) ? a[n-1] : 0; h = (n > 2) ? a[n-2] : 0; printf "%d\n", (h * 3600 + m * 60 + s) * 1000}' ;;
    windows) powershell -NoProfile -Command "[int](Get-Process -Id $AP).TotalProcessorTime.TotalMilliseconds" | tr -d '\r' ;;
  esac
}
now_ms() { $PY -c 'import time; print(int(time.time() * 1000))'; }

WIDE=1280x860; NARROW=760x720
# case | answer (none = no question) | window size | store extra
CASES="
long-wide|long|$WIDE|
long-narrow|long|$NARROW|
long-narrow-dark|long|$NARROW|\"theme\":\"dark\"
short-wide|short|$WIDE|
short-narrow|short|$NARROW|
page-wide|none|$WIDE|
page-narrow|none|$NARROW|
cpu-1|stream|$WIDE|
cpu-2|stream|$WIDE|
cpu-3|stream|$WIDE|"

P=""; AP=""; D=""; S=""
run_one() { # <bin> <tag> <case line>
  local BIN=$1 TAG=$2 LINE=$3
  local CASE ANSWER SIZE STOREX
  IFS='|' read -r CASE ANSWER SIZE STOREX <<< "$LINE"
  local name="$TAG-$CASE" LOG=$OUT/logs/$TAG-$CASE.log STUB=$OUT/logs/$TAG-$CASE.stub.jsonl
  local state="size:$SIZE,wait:500,kind:meeting,wait:1200"
  [ "$ANSWER" != none ] && state="$state,ai_ask"
  local stub_answer=$ANSWER; [ "$ANSWER" = none ] && stub_answer=short
  local general="\"hasCompletedOnboarding\":true,\"hasCompletedStartup\":true,\"enableNotifications\":false,\"enableTelemetry\":false,\"recordingCountdown\":0,\"serverUrl\":\"http://127.0.0.1:$PORT\""
  [ -n "$STOREX" ] && general="$general,$STOREX"
  local auth=",\"auth\":{\"secret\":{\"api_key\":\"cq-test-key\"},\"user_id\":\"cqtestuser0001\",\"plan\":{\"upgraded\":true,\"manual\":false,\"last_checked\":$(date +%s)},\"organizations\":[]}"
  D=$(mktemp -d); mkdir -p "$D/home" "$D/rec" "$D/logs" "$D/meetings"
  : > "$STUB"
  $PY "$HERE/stub.py" $PORT "$(winp "$STUB")" "$stub_answer" > /dev/null 2>&1 &
  S=$!
  sleep 0.5
  printf '%s' "{\"general_settings\":{$general}$auth}" > "$D/store"
  echo '{"enabled": true, "setupCompleted": true, "notifications": {"scheduled": false, "detected": false, "leadSecs": 120}, "transcription": {"engine": "local", "live": true}}' > "$D/meetings/settings.json"
  local -a extra=(CAP_GPUI_DOCS_SEED=24 CAP_GPUI_DOCS_OPEN=1 "CAP_GPUI_DOCS_STATE=$state" CAP_GPUI_TEST_SERVER_IS_CAP=1)
  [ "$OS" = linux ] && extra+=(BROWSER=/bin/true)
  env HOME="$D/home" CAP_GPUI_APP_DATA_DIR="$(winp "$D")" CAP_GPUI_RECORDINGS_DIR="$(winp "$D/rec")" \
    CAP_GPUI_LOG_DIR="$(winp "$D/logs")" CAP_GPUI_TAURI_STORE="$(winp "$D/store")" CAP_GPUI_NO_TRAY=1 \
    CAP_GPUI_LOCALE=en NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
    RUST_LOG=warn,cap_gpui=info "${extra[@]}" "$BIN" < /dev/null > "$LOG" 2>&1 &
  P=$!
  sleep 1
  if [ "$OS" = windows ]; then AP=$(cat /proc/$P/winpid 2>/dev/null); else AP=$P; fi
  if ! wait_line "$LOG $D/logs/*" "DOCS READY" 120; then
    note "$name never ready"
  elif [ "$ANSWER" = none ]; then
    sleep 4
    shot "$OUT/shots/$name.png"
    note "$name ok"
  elif ! wait_line "$STUB" "meetings/ask" 30; then
    note "$name never asked"
    shot "$OUT/shots/$name.png"
  else
    local c0 t0 c1 t1
    c0=$(cpu_ms); t0=$(now_ms)
    if wait_line "$STUB" "ask_done" 90; then
      c1=$(cpu_ms); t1=$(now_ms)
      sleep 3
      if [ "${CASE#cpu}" = "$CASE" ]; then shot "$OUT/shots/$name.png"; fi
      note "$name ok stream_ms=$((t1 - t0)) cpu_ms=$((c1 - c0)) deltas=$(grep -o '"deltas": [0-9]*' "$STUB" | grep -o '[0-9]*$')"
    else
      note "$name answer never finished"
      shot "$OUT/shots/$name.png"
    fi
  fi
  if [ "$OS" = windows ]; then taskkill //F //PID "$AP" > /dev/null 2>&1; fi
  kill "$P" 2> /dev/null; sleep 1; kill -9 "$P" 2> /dev/null; wait "$P" 2> /dev/null
  kill "$S" 2> /dev/null; wait "$S" 2> /dev/null
  cat "$D"/logs/* >> "$LOG" 2> /dev/null
  find "$D" -delete 2> /dev/null; P=""; AP=""; S=""
}

LINES=()
while IFS= read -r line; do
  [ -n "$line" ] && LINES+=("$line")
done <<< "$CASES"
for line in "${LINES[@]}"; do
  echo "${line%%|*}" | grep -qE "$FILTER" || continue
  for pair in $BINS; do
    run_one "${pair#*=}" "${pair%%=*}" "$line" < /dev/null
  done
done
note "done"
