#!/usr/bin/env bash
# Records once, then exports that recording to MP4 ROUNDS times, each in a
# fresh Cap. A crashed Cap leaves a core in /out/cores (the host sets
# kernel.core_pattern); its backtrace is written next to it.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
out=${HARNESS_OUT:-/out}
rounds=${ROUNDS:-60}

bash "$here/scenario-start-stop.sh" >/dev/null
recorded=$(sed -n 's/^attempt1_finished=//p' "$out/result.txt")
mv "$out/result.txt" "$out/recording-result.txt"
: >"$out/result.txt"
echo "recorded=${recorded:-no}" >>"$out/result.txt"
[[ $recorded == yes ]] || exit 0

eval "$(systemctl --user show-environment | grep -E "^(WAYLAND_DISPLAY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP|LIBGL_ALWAYS_SOFTWARE)=" | sed 's/^/export /')"
mkdir -p "$out/cores"
ulimit -c unlimited
# Some hosts leave kernel.core_pattern at `core`: a file in the crashing
# process's working directory.
cd "$out/cores"
echo "core limit: $(ulimit -c), pattern: $(cat /proc/sys/kernel/core_pattern)" >>"$out/actions.log"

completed=0 crashed=0 other=0
for round in $(seq "$rounds"); do
  name=stress-$round
  rm -f "$out/export.mp4"
  pid=$(bash "$here/launch-cap.sh" "$name" CAP_GPUI_AUTO_EDITOR=1 CAP_GPUI_AUTO_EXPORT="$out/export.mp4")
  state=timeout
  for _ in $(seq 480); do
    if grep -aq "editor export completed" "$out/$name.log" 2>/dev/null; then
      state=completed
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      state=exited
      break
    fi
    sleep 0.25
  done
  if [[ $state == exited ]] && grep -aq "native crash" "$out/profile/logs/cap-gpui.log.stderr" 2>/dev/null; then
    state=crashed
    sleep 3
    for core in "$out"/cores/core*; do
      [[ -f $core && $core != *.txt ]] || continue
      DEBUGINFOD_URLS=https://debuginfod.ubuntu.com timeout 900 gdb -q -batch \
        -iex 'set debuginfod enabled on' \
        -ex 'info registers rip' -ex 'bt full 30' -ex 'info sharedlibrary' -ex 'thread apply all bt 40' \
        "$CAP_BIN" "$core" >"$out/cores/round-$round.bt.txt" 2>&1
      rm -f "$core"
    done
  fi
  kill "$pid" 2>/dev/null
  for _ in $(seq 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null
  case $state in
    completed) completed=$((completed + 1)); rm -f "$out/$name.log" ;;
    crashed) crashed=$((crashed + 1)) ;;
    *) other=$((other + 1)) ;;
  esac
  echo "round $round: $state" >>"$out/actions.log"
done
echo "completed=$completed" >>"$out/result.txt"
echo "crashed=$crashed" >>"$out/result.txt"
echo "other=$other" >>"$out/result.txt"

cat "$out/result.txt"
