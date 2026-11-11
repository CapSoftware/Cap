# Preset preview benchmark

The editor generates nine 216×122 color-preset tiles synchronously through
`EditorWindow::preset_image` on their first paint and caches them for the process.
Preparing filter coefficients once per tile removes repeated saturation, sepia,
and hue-rotation setup from the pixel loop. Each filter still clamps its output
before the next filter, with the original floating-point operation order.

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
| 1             |     11.994 ms |     8.774 ms |  12.069 ms |  8.832 ms |   1.37× |
| 2             |     12.060 ms |     8.773 ms |  12.340 ms |  8.897 ms |   1.37× |
| 3             |     12.073 ms |     8.773 ms |  12.256 ms |  9.290 ms |   1.38× |

The three runs are retained in `results.csv`. Individual filtered tiles improve
by 1.24–1.72×. The unfiltered tile is 8–9 µs slower (about 2–3%); the full
catalog saves 3.22–3.30 ms. An initial comparison with the unmodified production
kernel measured 12.034 ms for the reference and 12.190 ms for production (0.99×),
providing a control for the benchmark harness.

Tests compare every BGRA byte for all nine presets at six sizes, including zero
dimensions, single-row and single-column images, and double-resolution tiles.
They also compare 18,522 filter outputs bit for bit and exercise extreme filter
chains with overlays, vignette, and grain to protect per-filter clamping.

These measurements cover CPU tile generation on first paint. Cached tiles do
not rerender, and this is not an end-to-end app startup, frame-rate, GPU-upload,
or recording benchmark. Native macOS and Linux timings were not measured.
The full `cargo check -p cap-gpui-kernels` was attempted but cannot resolve this
checkout's missing `../zed-cap/crates/gpui/Cargo.toml`; the isolated check, debug
and release tests, and all-target Clippy pass against the actual texture source.
