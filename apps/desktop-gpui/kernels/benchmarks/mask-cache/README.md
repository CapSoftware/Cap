# Screenshot mask cache benchmark

Run from the repository root:

```sh
cargo +stable run --locked --release \
  --manifest-path apps/desktop-gpui/kernels/benchmarks/mask-cache/Cargo.toml \
  --example screenshot-mask-cache-benchmark
```

This standalone package compiles the production `mask_cache.rs` and `screenshot.rs` directly. It requires Rust and the `image` crate, with a committed lockfile matching the desktop workspace's image/filter dependencies. It does not build GPUI, audio, FFmpeg, or platform libraries, and can run on Linux x86_64 as well as macOS arm64. The same example is also available through `cargo run -p cap-gpui-kernels --release --example screenshot-mask-cache-benchmark` in the desktop workspace, when its full dependency prerequisites are installed.

The fixture is a deterministic, nonuniform 3840 × 2160 RGBA image with varying alpha. Each workload has 1, 4, 8, or 16 masks of 640 × 360 pixels at level 16, using either blur or pixelate. One mask moves one pixel per event; the others stay fixed. Each workload primes the cache, runs 12 warmup pairs, then measures 120 drag events. The old path filters every mask on every update. The new path calls the production cache diff and filters only changed masks. Both paths call the unchanged production `mask_filter`.

Execution order alternates between old-first and new-first to reduce order bias. Every overlay's request and all of its output bytes are compared after every warmup and measured event, outside the timed intervals. A mismatch or unexpected filter-call count fails the run. Filter-call counts in the table cover the 120 measured events only; cache priming and warmup are excluded. The speedup is the ratio of means. The median is the average of the two middle samples.

Timings include cache diffing, region extraction/filtering, image allocation, `Arc` ownership, and release of retired CPU images. Request/geometry construction and correctness comparisons are outside timing. The benchmark excludes GPUI image conversion, task scheduling/cancellation, GPU atlas uploads, painting, and screenshot export. It measures completed CPU preparation work, not pointer-event latency or application FPS. One mask is a control case: it has no reusable image during a drag. A replaced frame invalidates every mask and is not expected to benefit. Overlapping masks, deletion, reordering, style changes, frame/layout invalidation, and fractional/clipped rectangles are covered by the production module's unit tests.

Run the portable tests and lint checks:

```sh
cargo +stable test --locked \
  --manifest-path apps/desktop-gpui/kernels/benchmarks/mask-cache/Cargo.toml \
  --all-targets
cargo +stable clippy --locked \
  --manifest-path apps/desktop-gpui/kernels/benchmarks/mask-cache/Cargo.toml \
  --all-targets -- -D warnings
```

Run the release command at least twice on an otherwise idle machine. Keep the full output, CPU model, operating system, Rust version, and power mode with results. Compare both means and medians, including the one-mask control. Cross-architecture results should use the same lockfile and workload.

## Recorded results

Two consecutive release runs on Apple M4 Pro, macOS 27.2, Rust 1.97.0, battery power with automatic power mode, October 13, 2026. All overlay bytes matched after every event in both runs. These are CPU overlay-preparation measurements with the exclusions described above.

Run 1:

| Mode | Masks | Old mean ms | New mean ms | Old median ms | New median ms | Mean speedup | Old calls | New calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| blur | 1 | 1.637 | 1.631 | 1.630 | 1.621 | 1.00x | 120 | 120 |
| blur | 4 | 6.701 | 1.687 | 6.697 | 1.688 | 3.97x | 480 | 120 |
| blur | 8 | 13.266 | 1.664 | 13.291 | 1.660 | 7.97x | 960 | 120 |
| blur | 16 | 26.504 | 1.688 | 26.494 | 1.685 | 15.70x | 1920 | 120 |
| pixelate | 1 | 0.805 | 0.812 | 0.804 | 0.804 | 0.99x | 120 | 120 |
| pixelate | 4 | 3.310 | 0.828 | 3.306 | 0.826 | 4.00x | 480 | 120 |
| pixelate | 8 | 6.938 | 0.900 | 6.956 | 0.902 | 7.71x | 960 | 120 |
| pixelate | 16 | 13.723 | 0.911 | 13.605 | 0.878 | 15.07x | 1920 | 120 |

Run 2:

| Mode | Masks | Old mean ms | New mean ms | Old median ms | New median ms | Mean speedup | Old calls | New calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| blur | 1 | 1.600 | 1.600 | 1.585 | 1.589 | 1.00x | 120 | 120 |
| blur | 4 | 6.569 | 1.657 | 6.548 | 1.651 | 3.96x | 480 | 120 |
| blur | 8 | 13.384 | 1.713 | 13.293 | 1.672 | 7.82x | 960 | 120 |
| blur | 16 | 26.587 | 1.708 | 26.138 | 1.661 | 15.57x | 1920 | 120 |
| pixelate | 1 | 0.790 | 0.789 | 0.791 | 0.791 | 1.00x | 120 | 120 |
| pixelate | 4 | 3.252 | 0.812 | 3.234 | 0.809 | 4.00x | 480 | 120 |
| pixelate | 8 | 6.749 | 0.862 | 6.664 | 0.857 | 7.83x | 960 | 120 |
| pixelate | 16 | 13.750 | 0.888 | 13.766 | 0.883 | 15.48x | 1920 | 120 |
