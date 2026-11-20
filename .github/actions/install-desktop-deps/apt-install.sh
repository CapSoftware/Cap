#!/usr/bin/env bash
# Installs Ubuntu packages on GitHub-hosted runners without getting stuck on a
# slow mirror.
#
# GitHub's hosted Ubuntu runners read their mirrors from
# /etc/apt/apt-mirrors.txt, and apt's mirror method only moves to the next
# mirror on an error, never on a slow one. On some days one official mirror
# serves package files at tens of kB/s to a whole region of runners, and a
# 135 MB install then takes longer than the job. So this script:
#   1. times a short download from each candidate mirror and lists the fastest
#      first (every candidate is an official Ubuntu archive, so the indexes and
#      the packages they resolve to are the same);
#   2. downloads the packages with a time limit, and when a mirror stalls,
#      moves it to the end of the list and downloads the rest from the next;
#   3. installs from the downloaded files.
# Runners without that mirror list (Blacksmith) keep their own mirrors and only
# get the time limits.
#
# Usage: apt-install.sh <package>...
set -euo pipefail

mirrors=/etc/apt/apt-mirrors.txt
# A file in the release pocket, which never changes or goes away.
probe_path=pool/main/l/llvm-toolchain-18/libllvm18_18.1.3-1_amd64.deb
attempt_seconds=${APT_ATTEMPT_SECONDS:-300}

write_mirrors() {
	local priority=1 mirror
	for mirror in "$@"; do
		printf '%s\tpriority:%d\n' "$mirror" "$priority"
		priority=$((priority + 1))
	done | sudo tee "$mirrors" >/dev/null
}

rank_mirrors() {
	local -a candidates=() ranked=()
	local mirror host seen=" " code speed
	while read -r mirror _; do
		if [ -n "$mirror" ]; then
			candidates+=("${mirror%/}/")
		fi
	done <"$mirrors"
	candidates+=(http://archive.ubuntu.com/ubuntu/ http://azure.archive.ubuntu.com/ubuntu/)

	local results
	results=$(mktemp)
	for mirror in "${candidates[@]}"; do
		host=${mirror#*://}
		host=${host%%/*}
		if [[ "$seen" == *" $host "* ]]; then
			continue
		fi
		seen="$seen$host "
		# A transfer cut off by --max-time still reports its speed; an error
		# page does not count, however fast it came back.
		read -r code speed < <(curl -s -o /dev/null -r 0-8388607 --connect-timeout 3 --max-time 4 \
			-w '%{http_code} %{speed_download}\n' "$mirror$probe_path" || true) || true
		case "${code:-}" in
		200 | 206) speed=${speed%%.*} ;;
		*) speed=0 ;;
		esac
		echo "apt mirror $mirror: $((${speed:-0} / 1024)) kB/s"
		echo "${speed:-0} $mirror" >>"$results"
	done
	mapfile -t ranked < <(sort -rn "$results" | awk '{print $2}')
	rm -f "$results"
	if [ "${#ranked[@]}" -gt 0 ]; then
		write_mirrors "${ranked[@]}"
	fi
}

demote_first_mirror() {
	local -a list=()
	local mirror
	while read -r mirror _; do
		if [ -n "$mirror" ]; then
			list+=("$mirror")
		fi
	done <"$mirrors"
	[ "${#list[@]}" -gt 1 ] || return 0
	echo "::warning::apt stalled on ${list[0]} for ${attempt_seconds}s; moving it to the end of the mirror list"
	write_mirrors "${list[@]:1}" "${list[0]}"
}

# Runs an apt-get command that only downloads, giving each mirror
# $attempt_seconds before moving on. Files already downloaded are kept, so a
# retry only fetches what is missing.
fetch() {
	local status
	for _ in 1 2 3; do
		status=0
		sudo timeout "$attempt_seconds" apt-get "$@" || status=$?
		[ "$status" -eq 0 ] && return 0
		if [ "$status" -ne 124 ] || [ ! -f "$mirrors" ]; then
			[ "$status" -eq 124 ] && echo "::error::apt-get $1 took longer than ${attempt_seconds}s"
			return "$status"
		fi
		demote_first_mirror
	done
	echo "::error::apt-get $1 stalled on every mirror"
	return 1
}

if [ -f "$mirrors" ]; then
	rank_mirrors
fi

fetch update
fetch install -y --no-install-recommends --download-only "$@"
# Everything is downloaded, so this only unpacks and configures. It must not be
# interrupted, or dpkg is left half-configured.
sudo apt-get install -y --no-install-recommends "$@"
