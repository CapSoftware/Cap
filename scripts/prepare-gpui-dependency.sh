#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zed_dir="$repo_root/../zed-cap"
patch_files=(
	"$repo_root/apps/desktop-gpui/patches/zed-gpui.patch"
	"$repo_root/apps/desktop-gpui/patches/zed-windows.patch"
	"$repo_root/apps/desktop-gpui/patches/zed-linux.patch"
)
base_revision="5d1f83d9f27a19bec1fb241dc33b42238af9cf8d"
remote="https://github.com/wingleeio/zed.git"

verify_checkout() (
	if ! git -C "$zed_dir" merge-base --is-ancestor "$base_revision" HEAD; then
		echo "error: $zed_dir does not contain GPUI base $base_revision" >&2
		exit 1
	fi
	verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/cap-gpui-verify.XXXXXX")"
	trap 'rm -rf -- "$verification_dir"' EXIT
	git init --quiet "$verification_dir"
	git -C "$zed_dir" apply --numstat -z "${patch_files[@]}" > "$verification_dir/patch-paths"
	while IFS=$'\t' read -r -d '' added removed patched_path; do
		if [[ -e "$zed_dir/$patched_path" ]]; then
			mkdir -p "$verification_dir/$(dirname "$patched_path")"
			cp -p "$zed_dir/$patched_path" "$verification_dir/$patched_path"
		fi
	done < "$verification_dir/patch-paths"
	for ((patch_index=${#patch_files[@]}-1; patch_index>=0; patch_index--)); do
		patch_file="${patch_files[patch_index]}"
		if ! git -C "$verification_dir" apply --reverse --unidiff-zero "$patch_file"; then
			echo "error: $zed_dir does not contain Cap's pinned GPUI patch: $patch_file" >&2
			exit 1
		fi
	done
)

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
for patch_file in "${patch_files[@]}"; do
	git -C "$temporary_dir" apply --unidiff-zero "$patch_file"
done
mv "$temporary_dir" "$zed_dir"
trap - EXIT
verify_checkout
