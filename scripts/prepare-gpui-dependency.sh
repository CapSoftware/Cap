#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zed_dir="$repo_root/../zed-cap"
patch_paths=(
	"apps/desktop-gpui/patches/zed-gpui.patch"
	"apps/desktop-gpui/patches/zed-windows.patch"
	"apps/desktop-gpui/patches/zed-linux.patch"
	"apps/desktop-gpui/patches/zed-idle-frames.patch"
	"apps/desktop-gpui/patches/zed-streaming-image.patch"
	"apps/desktop-gpui/patches/zed-wayland-visibility.patch"
	"apps/desktop-gpui/patches/zed-wayland-activation.patch"
	"apps/desktop-gpui/patches/zed-closed-window-events.patch"
	"apps/desktop-gpui/patches/zed-glass.patch"
)
patch_files=("${patch_paths[@]/#/$repo_root/}")
base_revision="5d1f83d9f27a19bec1fb241dc33b42238af9cf8d"
remote="https://github.com/wingleeio/zed.git"

copy_patched_paths() {
	local destination="$1" path_list="$2" added removed patched_path
	while IFS=$'\t' read -r -d '' added removed patched_path; do
		if [[ -e "$zed_dir/$patched_path" ]]; then
			mkdir -p "$destination/$(dirname "$patched_path")"
			cp -p "$zed_dir/$patched_path" "$destination/$patched_path"
		fi
	done < "$path_list"
}

verify_checkout() (
	if ! git -C "$zed_dir" merge-base --is-ancestor "$base_revision" HEAD; then
		echo "error: $zed_dir does not contain GPUI base $base_revision" >&2
		exit 1
	fi
	verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/cap-gpui-verify.XXXXXX")"
	trap 'rm -rf -- "$verification_dir"' EXIT
	git init --quiet "$verification_dir"
	git -C "$zed_dir" apply --numstat -z "${patch_files[@]}" > "$verification_dir/patch-paths"
	copy_patched_paths "$verification_dir" "$verification_dir/patch-paths"
	for ((patch_index=${#patch_files[@]}-1; patch_index>=0; patch_index--)); do
		patch_file="${patch_files[patch_index]}"
		if ! git -C "$verification_dir" apply --reverse --unidiff-zero "$patch_file"; then
			echo "error: $zed_dir does not contain Cap's pinned GPUI patch: $patch_file" >&2
			exit 1
		fi
	done
)

# A checkout prepared before the patches last changed still carries an earlier
# committed version of the stack. When one matches, swap it for the current
# stack on a scratch copy and only write files back once every patch applied.
# Anything else (local edits, a different base) is left for verify to reject.
update_stale_checkout() (
	git -C "$repo_root" rev-parse --verify --quiet HEAD > /dev/null || exit 1
	work_dir="$(mktemp -d "${TMPDIR:-/tmp}/cap-gpui-update.XXXXXX")"
	trap 'rm -rf -- "$work_dir"' EXIT
	revisions="$(git -C "$repo_root" log --format=%H -n 50 -- "${patch_paths[@]}")"
	for revision in $revisions; do
		candidate_dir="$work_dir/$revision"
		mkdir -p "$candidate_dir/patches"
		previous_files=()
		unchanged=1
		for patch_path in "${patch_paths[@]}"; do
			previous_file="$candidate_dir/patches/$(basename "$patch_path")"
			git -C "$repo_root" show "$revision:$patch_path" > "$previous_file" 2> /dev/null || true
			if [[ -s "$previous_file" ]]; then
				previous_files+=("$previous_file")
			fi
			if ! cmp -s "$previous_file" "$repo_root/$patch_path"; then
				unchanged=0
			fi
		done
		if [[ "$unchanged" == 1 || ${#previous_files[@]} == 0 ]]; then
			continue
		fi
		scratch_dir="$candidate_dir/tree"
		git init --quiet "$scratch_dir"
		if ! git -C "$zed_dir" apply --numstat -z "${previous_files[@]}" "${patch_files[@]}" > "$candidate_dir/patch-paths" 2> /dev/null; then
			continue
		fi
		copy_patched_paths "$scratch_dir" "$candidate_dir/patch-paths"
		applied=1
		for ((patch_index=${#previous_files[@]}-1; patch_index>=0; patch_index--)); do
			if ! git -C "$scratch_dir" apply --reverse --unidiff-zero "${previous_files[patch_index]}" 2> /dev/null; then
				applied=0
				break
			fi
		done
		if [[ "$applied" == 1 ]]; then
			for patch_file in "${patch_files[@]}"; do
				if ! git -C "$scratch_dir" apply --unidiff-zero "$patch_file" 2> /dev/null; then
					applied=0
					break
				fi
			done
		fi
		if [[ "$applied" == 0 ]]; then
			continue
		fi
		while IFS=$'\t' read -r -d '' added removed patched_path; do
			if [[ -e "$scratch_dir/$patched_path" ]]; then
				if ! cmp -s "$scratch_dir/$patched_path" "$zed_dir/$patched_path"; then
					mkdir -p "$zed_dir/$(dirname "$patched_path")"
					cp "$scratch_dir/$patched_path" "$zed_dir/$patched_path"
				fi
			elif [[ -e "$zed_dir/$patched_path" ]]; then
				rm -- "$zed_dir/$patched_path"
			fi
		done < "$candidate_dir/patch-paths"
		echo "Updated $zed_dir from Cap's GPUI patches at ${revision:0:12} to the current ones" >&2
		exit 0
	done
	exit 1
)

if [[ -e "$zed_dir/.git" ]]; then
	if ! verify_checkout 2> /dev/null; then
		update_stale_checkout || true
		verify_checkout
	fi
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
