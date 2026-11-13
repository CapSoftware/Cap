#!/bin/sh
set -eu

# Runs the server as an unprivileged user. The container still starts as root,
# because the temp directory is usually a volume the host owns and has to be
# handed to that user first. When the user cannot be given what the server
# needs (its temp directory, or the GPU devices on an encoder host) the server
# keeps the user it started as and says so: a server that cannot write its
# temp files or reach its encoder is worse than one that runs as root.
# MEDIA_SERVER_RUN_AS=root keeps root on purpose.

run_as="${MEDIA_SERVER_RUN_AS:-bun}"
next=/usr/local/bin/docker-entrypoint.sh
[ -x "$next" ] || next=exec

start() {
	if [ "$next" = exec ]; then exec "$@"; fi
	exec "$next" "$@"
}

if [ "$(id -u)" != "0" ] || [ "$run_as" = "root" ]; then
	start "$@"
fi

if ! id "$run_as" >/dev/null 2>&1; then
	echo "[media-server] Running as root: there is no user named $run_as" >&2
	start "$@"
fi
if ! command -v setpriv >/dev/null 2>&1; then
	echo "[media-server] Running as root: setpriv is not installed" >&2
	start "$@"
fi

uid="$(id -u "$run_as")"
gid="$(id -g "$run_as")"
home="$(getent passwd "$run_as" | cut -d: -f6)"
temp_root="${TMPDIR:-/tmp}"

groups="$gid"
for device in /dev/nvidia* /dev/dri/*; do
	[ -c "$device" ] || continue
	device_gid="$(stat -c %g "$device")"
	case ",$groups," in
	*",$device_gid,"*) ;;
	*) groups="$groups,$device_gid" ;;
	esac
done

as_user() {
	setpriv --reuid "$uid" --regid "$gid" --groups "$groups" "$@"
}

# The GPU driver keeps its compiled kernels in CUDA_CACHE_PATH, usually a
# volume the host owns.
owned_dirs="$temp_root/cap-media-server $temp_root/cap-media-download-cache"
[ -n "${CUDA_CACHE_PATH:-}" ] && owned_dirs="$owned_dirs $CUDA_CACHE_PATH"

for dir in $owned_dirs; do
	mkdir -p "$dir" 2>/dev/null || true
	chown -R "$uid:$gid" "$dir" 2>/dev/null || true
done
as_user test -w "$temp_root" || chmod 1777 "$temp_root" 2>/dev/null || true

problem=""
for dir in "$temp_root" $owned_dirs; do
	as_user test -w "$dir" || problem="$run_as cannot write $dir"
done
for device in /dev/nvidia*; do
	[ -c "$device" ] || continue
	as_user sh -c 'test -r "$1" && test -w "$1"' sh "$device" ||
		problem="$run_as cannot open $device"
done

if [ -n "$problem" ]; then
	echo "[media-server] Running as root: $problem" >&2
	start "$@"
fi

export HOME="${home:-/tmp}"
export USER="$run_as"
if [ "$next" = exec ]; then
	exec setpriv --reuid "$uid" --regid "$gid" --groups "$groups" --no-new-privs "$@"
fi
exec setpriv --reuid "$uid" --regid "$gid" --groups "$groups" --no-new-privs "$next" "$@"
