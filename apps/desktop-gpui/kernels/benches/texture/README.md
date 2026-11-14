# Preset preview benchmark

The editor generates nine 216×122 color-preset tiles synchronously through
`EditorWindow::preset_image` on their first paint and caches them for the process.
Preparing filter coefficients once per tile removes repeated saturation, sepia,
and hue-rotation setup from the pixel loop. Gradient trigonometry, gradient
lengths, vignette radii, and vignette peak opacity are also prepared once per
tile. Row iteration lets the compiler reuse row-invariant calculations. These
additions stay inside the existing renderer and add 27 net production lines to
the coefficient-only implementation, without a new public API or cached tables.
Each filter still clamps its output before the next filter, with the original
floating-point operation order, including division in gradient evaluation.

This standalone workspace compiles the production `kernels/src/texture.rs` by
path with the app's locked image version. It needs neither GPUI nor FFmpeg, so
the benchmark and pixel-equivalence tests can run without native media setup.
`src/reference.rs` freezes the original filter implementation from
`5ae1568462677cde77221154b212b376984d9ae2`; `reference_preview` retains the
original pixel pipeline. Preset fixtures mirror `src/editor_color.rs`'s catalog.

From this directory:

```sh
cargo check --locked -p cap-gpui-texture-bench
cargo test --locked
cargo test --locked --release
cargo clippy --locked --all-targets -- -D warnings
cargo bench --locked --bench preset_preview
```

The benchmark checks every output pixel before timing, discards 10 warmup pairs,
and collects 101 pairs with alternating before/after order. Each timed call
allocates, renders, and drops the complete image. It reports median and p95
milliseconds for the full catalog and each individual preset. It has no timing
assertions that could fail on a busy CI host.

Measured on Windows x86_64, AMD Ryzen 5 6600H, Rust 1.98.1, optimized bench
profile with thin LTO and one codegen unit:

| Nine-tile run | Before median | After median | Before p95 | After p95 | Speedup |
| ------------- | ------------: | -----------: | ---------: | --------: | ------: |
| 1             |     12.494 ms |     7.881 ms |  16.818 ms | 10.191 ms |   1.59× |
| 2             |     12.167 ms |     7.593 ms |  12.845 ms |  8.276 ms |   1.60× |
| 3             |     13.338 ms |     8.106 ms |  19.889 ms | 11.874 ms |   1.65× |

These runs are retained in `extended-results.csv`. The complete catalog uses
37–39% less CPU time than the unchanged main-branch pixel pipeline, saving
4.57–5.23 ms per first render. Every individual preset improves in all three
runs, including the unfiltered tile. Host load varied during these measurements,
especially during individual-preset workloads; compare each paired workload
rather than adding individual medians or comparing timings across runs.

The original coefficient-only results remain in `results.csv` (1.37–1.38×).
A fresh run of that implementation at `8ea766ec18f7dce3fa8edd6bca9021d232c9c5d6`
is retained in `original-pr-control.csv`: 12.123 ms reference, 8.860 ms candidate
median, 1.37×. That control and the extension runs were separate invocations,
so they do not constitute a paired estimate of the incremental improvement.
Reproduce the control by running the same benchmark at that commit. The texture
pipeline and preset catalog were unchanged on the new base `f2f338b90`.

Tests compare every BGRA byte for all nine presets at six sizes, including zero
dimensions, single-row and single-column images, and double-resolution tiles.
They also compare 18,522 filter outputs bit for bit and exercise extreme filter
chains with overlays, vignette, and grain to protect per-filter clamping.
Another 300 image comparisons cover ten overlay angles (including cardinal,
negative, fractional, and large angles), five vignette strengths (including
negative and near-zero values), and six image shapes with grain enabled.

These measurements cover CPU tile generation on first paint. Cached tiles do
not rerender, and this is not an end-to-end app startup, frame-rate, GPU-upload,
or recording benchmark. Native macOS and Linux timings were not measured.
The full `cargo check -p cap-gpui-kernels` was attempted but cannot resolve this
checkout's missing `../zed-cap/crates/gpui/Cargo.toml`; the isolated check, debug
and release tests, and all-target Clippy pass against the actual texture source.
