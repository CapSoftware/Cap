#!/usr/bin/env bash
# Vercel "Ignored Build Step" for cap-web: exit 0 skips the deployment, any
# other exit builds it. The project setting reads this file from main, so
# every branch runs the current version. When in doubt it builds.

repo=https://github.com/CapSoftware/Cap
head=${VERCEL_GIT_COMMIT_SHA:-}
prev=${VERCEL_GIT_PREVIOUS_SHA:-}
paths=(apps/web packages patches 'bun*' ':(glob)*.json')
fetch=(git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch -q --depth=1 "$repo")

[ -n "$head" ] || exit 1
cd "$(git rev-parse --show-toplevel)" || exit 1

web_diff() {
	git diff --quiet "$1" "$2" -- "${paths[@]}"
	echo $?
}

merge_base() {
	node -e '
const sha = process.argv[1];
fetch(`https://api.github.com/repos/CapSoftware/Cap/compare/main...${sha}?per_page=1`, {
	headers: { accept: "application/vnd.github+json", "user-agent": "cap-web-ignore-build" },
	signal: AbortSignal.timeout(10000),
})
	.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
	.then((j) => {
		const base = j?.merge_base_commit?.sha ?? "";
		if (!/^[0-9a-f]{40}$/.test(base)) process.exit(1);
		console.log(base);
	})
	.catch(() => process.exit(1));
' "$1"
}

own_changes_skip_web() {
	local base rc
	base=$(merge_base "$1") || return 1
	"${fetch[@]}" "$base" || return 1
	rc=$(web_diff "$base" "$1")
	[ "$rc" = 0 ]
}

"${fetch[@]}" "${prev:-main}" || exit 1
last=$(git rev-parse FETCH_HEAD) || exit 1
[ "$last" != "$head" ] || exit 1
rc=$(web_diff "$last" "$head")
[ "$rc" = 0 ] && exit 0
[ "$rc" = 1 ] || exit 1

# Previews of branches that never touch web are skipped even after main is
# merged in. The last deployment must qualify too, or a reverted web change
# would leave a stale preview up.
[ "${VERCEL_ENV:-}" = preview ] || exit 1
own_changes_skip_web "$head" || exit 1
[ -z "$prev" ] || own_changes_skip_web "$last" || exit 1
exit 0
