#!/usr/bin/env bash
set -euo pipefail

profile="${1:-release}"
requested_target="${2:-${RUST_TARGET_TRIPLE:-}}"
toolchain="${CAP_GPUI_RUST_TOOLCHAIN:-1.95.0}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gpui_dir="$repo_root/apps/desktop-gpui"
binaries_dir="$repo_root/apps/desktop/src-tauri/binaries"

case "$profile" in
	debug)
		profile_dir="debug"
		;;
	release)
		profile_dir="release"
		;;
	*)
		echo "error: profile must be debug or release" >&2
		exit 1
		;;
esac

if ! rustup run "$toolchain" rustc --version >/dev/null 2>&1; then
	rustup toolchain install "$toolchain" --profile minimal
fi

if [[ -n "$requested_target" ]]; then
	target="$requested_target"
	artifact_dir="$gpui_dir/target/$target/$profile_dir"
	rustup target add "$target" --toolchain "$toolchain"
else
	target="$(cd "$gpui_dir" && rustc +"$toolchain" -vV | sed -n 's|host: ||p')"
	artifact_dir="$gpui_dir/target/$profile_dir"
fi

extension=""
if [[ "$target" == *-apple-darwin ]]; then
	MACOSX_DEPLOYMENT_TARGET="$(node "$repo_root/scripts/build-macos-packages.mjs" --deployment-target)"
	export MACOSX_DEPLOYMENT_TARGET
fi

if [[ "$target" == *windows* ]]; then
	extension=".exe"
fi

node "$repo_root/scripts/sync-desktop-versions.mjs"
"$repo_root/scripts/prepare-gpui-dependency.sh"

(
	cd "$gpui_dir"
	if [[ "$profile" == "release" && -n "$requested_target" ]]; then
		cargo +"$toolchain" build --release --target "$target"
	elif [[ "$profile" == "release" ]]; then
		cargo +"$toolchain" build --release
	elif [[ -n "$requested_target" ]]; then
		cargo +"$toolchain" build --target "$target"
	else
		cargo +"$toolchain" build
	fi
)

source_binary="$artifact_dir/cap-gpui$extension"
staged_binary="$binaries_dir/cap-gpui-$target$extension"
if [[ ! -f "$source_binary" ]]; then
	echo "error: built GPUI binary not found at $source_binary" >&2
	exit 1
fi

if [[ "$target" == *linux* ]]; then
	patchelf --set-rpath '$ORIGIN:$ORIGIN/../lib/cap' "$source_binary"
fi

mkdir -p "$binaries_dir"
cp "$source_binary" "$staged_binary"
if [[ "$extension" != ".exe" ]]; then
	chmod +x "$staged_binary"
fi
echo "Staged $source_binary -> $staged_binary"
