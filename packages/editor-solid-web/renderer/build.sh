#!/usr/bin/env bash
# Builds the browser Studio renderer (the native cap-rendering crate compiled to
# WebAssembly): ./pkg for the editor preview and ./pkg-export, which adds the
# local export audio mix and Studio Sound, for the export worker. Requires
# wasm-bindgen-cli 0.2.103, binaryen, and an LLVM clang with the WebAssembly
# target for RNNoise (Homebrew `llvm` on macOS).
set -euo pipefail
cd "$(dirname "$0")"
target_dir="${CARGO_TARGET_DIR:-target}"
llvm="${LLVM_PREFIX:-$(brew --prefix llvm 2>/dev/null || echo /usr)}"
export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-$llvm/bin/clang}"
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-$llvm/bin/llvm-ar}"
export CFLAGS_wasm32_unknown_unknown="${CFLAGS_wasm32_unknown_unknown:--msimd128}"
wasm="$target_dir/wasm32-unknown-unknown/release/cap_editor_browser_renderer.wasm"

package() {
	local out="$1"
	shift
	cargo build --release --target wasm32-unknown-unknown "$@"
	wasm-bindgen --target web --out-dir "$out" "$wasm"
	wasm-opt -Oz --strip-debug --strip-producers \
		--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
		--enable-reference-types --enable-mutable-globals \
		-o "$out/cap_editor_browser_renderer_bg.wasm" "$out/cap_editor_browser_renderer_bg.wasm"
}

package pkg
package pkg-export --features export-audio
