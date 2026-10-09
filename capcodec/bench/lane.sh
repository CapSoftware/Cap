#!/usr/bin/env bash
set -euo pipefail
SOCKET="${BENCH_LANE_SOCKET:-bench}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cmd="${1:-status}"
server_pid() { tmux -L "$SOCKET" display-message -p '#{pid}' 2>/dev/null || true; }
outside_threads() {
	ps -e -L -o pid=,ppid=,lwp=,ni=,uid= | awk -v root="$1" -v uid="$(id -u)" '
		{ pid[NR] = $1; ppid[$1] = $2; lwp[NR] = $3; ni[NR] = $4; u[NR] = $5 }
		END {
			for (i = 1; i <= NR; i++) {
				if (u[i] != uid || ni[i] >= 19) continue
				p = pid[i]; inlane = 0
				for (d = 0; d < 64 && p > 1; d++) { if (p == root) { inlane = 1; break } p = ppid[p] }
				if (!inlane) print lwp[i]
			}
		}'
}
case "$cmd" in
start)
	tmux -L "$SOCKET" has-session -t bench 2>/dev/null || tmux -L "$SOCKET" new-session -d -s bench -c "$ROOT" -- bash -l
	"$0" demote
	;;
demote)
	sp="$(server_pid)"
	[ -n "$sp" ] || { echo "no bench lane"; exit 1; }
	tids="$(outside_threads "$sp" | tr '\n' ' ')"
	n=0
	if [ -n "${tids// /}" ]; then
		renice -n 19 -p $tids >/dev/null 2>&1 || true
		n=$(echo "$tids" | wc -w)
	fi
	echo "lane server $sp at nice $(ps -o ni= -p "$sp" | tr -d ' '); demoted $n threads to nice 19"
	;;
watch)
	while sleep "${2:-30}"; do "$0" demote >/dev/null; done
	;;
run)
	shift
	[ -n "$(server_pid)" ] || { echo "no bench lane; run $0 start"; exit 1; }
	tmux -L "$SOCKET" new-window -d -t bench -c "$ROOT" -- bash -lc "$*"
	;;
status)
	sp="$(server_pid)"
	if [ -n "$sp" ]; then
		echo "lane server $sp nice $(ps -o ni= -p "$sp" | tr -d ' '); threads below nice 19 outside the lane: $(outside_threads "$sp" | wc -l)"
	else
		echo "no bench lane"
	fi
	;;
esac
