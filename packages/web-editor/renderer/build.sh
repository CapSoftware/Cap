#!/usr/bin/env bash
# Builds the browser editor's WebAssembly packages:
#   renderer/pkg          the Studio renderer (cap-rendering compiled to wasm)
#   renderer/pkg-export   the same plus the export audio mix and Studio Sound
#                         (RNNoise), loaded only by the export worker
#   image-decoder/pkg     background and overlay image decoding
#
# Toolchain (checked below): Rust 1.88.0 from rust-toolchain.toml with the
# wasm32-unknown-unknown target, wasm-bindgen-cli 0.2.103 (must equal the
# wasm-bindgen crate in Cargo.lock), binaryen wasm-opt 123, and an LLVM clang
# with the WebAssembly target for RNNoise (Homebrew `llvm` on macOS, the
# distribution clang on Linux).
#
#   rustup target add wasm32-unknown-unknown --toolchain 1.88.0
#   cargo install wasm-bindgen-cli --version 0.2.103 --locked
#
# Size knobs, for measuring only: WASM_OPT_LEVEL (default s) and WASM_OPT_FLAGS
# (default -Oz). The shipped packages use the defaults.
set -euo pipefail
cd "$(dirname "$0")"
repo_dir=$(cd ../../.. && pwd)
out_renderer_dir=$PWD
out_decoder_dir=$(cd ../image-decoder && pwd)

# Builds from a fixed directory with CARGO_HOME remapped, so every Linux
# checkout produces the same wasm: Cargo hashes the absolute path of the
# ../../../crates dependencies into symbol names (which renumbers closures in
# the glue), and panic messages embed registry source paths.
stage="${CAP_WASM_STAGE:-/tmp/cap-wasm-src}"
mkdir -p "$stage/packages/web-editor" "$stage/apps"
rsync -a --delete --exclude target "$repo_dir/crates" "$repo_dir/vendor" "$stage/"
rsync -a --delete --exclude target "$repo_dir/apps/cli" "$stage/apps/"
cp "$repo_dir/Cargo.toml" "$repo_dir/Cargo.lock" "$repo_dir/rust-toolchain.toml" "$stage/"
rsync -a --delete --exclude target --exclude 'pkg*' \
	"$out_renderer_dir" "$out_decoder_dir" "$stage/packages/web-editor/"
renderer_dir="$stage/packages/web-editor/renderer"
decoder_dir="$stage/packages/web-editor/image-decoder"
remap="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"

require_version() {
	local tool="$1" want="$2" have
	have=$("$tool" --version 2>/dev/null | head -n1 || true)
	if [[ "$have" != *"$want"* ]]; then
		echo "$tool $want is required, found: ${have:-none}" >&2
		exit 1
	fi
}
require_version wasm-bindgen 0.2.103
require_version wasm-opt "version 123"

if [[ "$(uname)" == "Darwin" ]]; then
	llvm="${LLVM_PREFIX:-$(brew --prefix llvm)}"
	export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-$llvm/bin/clang}"
	export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-$llvm/bin/llvm-ar}"
else
	export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-clang}"
	export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-llvm-ar}"
fi
export CFLAGS_wasm32_unknown_unknown="${CFLAGS_wasm32_unknown_unknown:--msimd128}"
export CARGO_PROFILE_RELEASE_OPT_LEVEL="${WASM_OPT_LEVEL:-s}"
wasm_opt_flags=(${WASM_OPT_FLAGS:--Oz})

package() {
	local crate_dir="$1" name="$2" out_dir="$3" out="$4"
	shift 4
	local target_dir="${CARGO_TARGET_DIR:-$crate_dir/target}"
	(cd "$crate_dir" && cargo build --locked --release --target wasm32-unknown-unknown \
		--config "target.wasm32-unknown-unknown.rustflags=[\"$remap\"]" "$@")
	rm -rf "$out_dir/$out.tmp"
	wasm-bindgen --target web --out-dir "$out_dir/$out.tmp" \
		"$target_dir/wasm32-unknown-unknown/release/$name.wasm"
	wasm-opt "${wasm_opt_flags[@]}" --strip-debug --strip-producers \
		--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
		--enable-reference-types --enable-mutable-globals \
		-o "$out_dir/$out.tmp/${name}_bg.wasm" "$out_dir/$out.tmp/${name}_bg.wasm"
	rm -f "$out_dir/$out.tmp/.gitignore"
	rm -rf "${out_dir:?}/$out"
	mv "$out_dir/$out.tmp" "$out_dir/$out"
}

package "$renderer_dir" cap_editor_browser_renderer "$out_renderer_dir" pkg
package "$renderer_dir" cap_editor_browser_renderer "$out_renderer_dir" pkg-export --features export-audio
package "$decoder_dir" cap_editor_image_decoder "$out_decoder_dir" pkg
