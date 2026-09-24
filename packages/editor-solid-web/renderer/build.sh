#!/usr/bin/env bash
# Builds the browser Studio renderer (the native cap-rendering crate compiled to
# WebAssembly) into ./pkg. Requires wasm-bindgen-cli 0.2.103 and binaryen.
set -euo pipefail
cd "$(dirname "$0")"
target_dir="${CARGO_TARGET_DIR:-target}"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg \
	"$target_dir/wasm32-unknown-unknown/release/cap_editor_browser_renderer.wasm"
wasm-opt -Oz --strip-debug --strip-producers \
	--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
	--enable-reference-types --enable-mutable-globals \
	-o pkg/cap_editor_browser_renderer_bg.wasm pkg/cap_editor_browser_renderer_bg.wasm
