#!/usr/bin/env bash
# Vercel "Ignored Build Step" for cap-web: exit 0 skips the deployment, any
# other exit builds it. The project setting reads this file from main, so
# every branch runs the current version. When in doubt it builds.

repo=https://github.com/CapSoftware/Cap
head=${VERCEL_GIT_COMMIT_SHA:-}
paths=(apps/web packages patches 'bun*' ':(glob)*.json')

[ -n "$head" ] || exit 1
cd "$(git rev-parse --show-toplevel)" || exit 1

# Prints 0 when nothing web-related changed between $1 and the build commit,
# 1 when something did, anything else on error.
web_diff() {
	git diff --quiet "$1" "$head" -- "${paths[@]}"
	echo $?
}

# Changes since the last deployment of this branch (or main).
git fetch -q --depth=1 "$repo" "${VERCEL_GIT_PREVIOUS_SHA:-main}" || exit 1
[ "$(git rev-parse FETCH_HEAD)" != "$head" ] || exit 1
rc=$(web_diff FETCH_HEAD)
[ "$rc" = 0 ] && exit 0
[ "$rc" = 1 ] || exit 1

# Previews: skip when the branch's own changes, measured from where it left
# main, don't touch web. Merging main into a branch doesn't count.
[ "${VERCEL_ENV:-}" = preview ] || exit 1
base=$(node -e '
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
' "$head") || exit 1
git fetch -q --depth=1 "$repo" "$base" || exit 1
rc=$(web_diff "$base")
[ "$rc" = 0 ] && exit 0
exit 1
