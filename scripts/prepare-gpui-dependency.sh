#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zed_dir="$repo_root/../zed-cap"
patch_file="$repo_root/apps/desktop-gpui/patches/zed-gpui.patch"
base_revision="5d1f83d9f27a19bec1fb241dc33b42238af9cf8d"
remote="https://github.com/wingleeio/zed.git"

verify_checkout() {
	if ! git -C "$zed_dir" merge-base --is-ancestor "$base_revision" HEAD; then
		echo "error: $zed_dir does not contain GPUI base $base_revision" >&2
		exit 1
	fi
	if ! git -C "$zed_dir" apply --reverse --check --unidiff-zero "$patch_file"; then
		echo "error: $zed_dir does not contain Cap's pinned GPUI patch" >&2
		exit 1
	fi
}

if [[ -e "$zed_dir/.git" ]]; then
	verify_checkout
	exit 0
fi

if [[ -e "$zed_dir" ]]; then
	echo "error: $zed_dir exists but is not a Git checkout" >&2
	exit 1
fi

temporary_dir="$(mktemp -d "$zed_dir.tmp.XXXXXX")"
cleanup() {
	rm -rf "$temporary_dir"
}
trap cleanup EXIT

git init --quiet "$temporary_dir"
git -C "$temporary_dir" remote add origin "$remote"
git -C "$temporary_dir" fetch --quiet --depth 1 origin "$base_revision"
git -C "$temporary_dir" checkout --quiet --detach FETCH_HEAD
git -C "$temporary_dir" apply --unidiff-zero "$patch_file"
mv "$temporary_dir" "$zed_dir"
trap - EXIT
verify_checkout
