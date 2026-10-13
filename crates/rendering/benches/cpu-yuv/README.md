# CPU fallback playback benchmark

The x86 NV12 and YUV420P conversion rows now share chroma arithmetic across two adjacent luma pixels and iterate over validated row slices. This reduces work in the renderer's CPU fallback without changing color coefficients, integer rounding, clamping, alpha, resolution, prefetching, frame selection, or audio timing. No new unsafe code or architecture intrinsics are required.

## Where this runs

Cap ships the Rust GPUI app in `apps/desktop-gpui`. Its editor uses `cap-editor`, FFmpeg/platform decoders, and the wgpu compositor in `cap-rendering`. The browser-based Next.js share player is a separate playback pipeline.

The relevant path is:

`GPUI EditorWindow → cap-editor playback → FrameRenderer → DisplayLayer → YuvConverter::convert_{nv12,yuv420p}_cpu → cpu_yuv`

`DisplayLayer` selects this path when CPU conversion is preferred, including software-adapter rendering; GPU conversion remains available through separate methods. Decoded buffers already share storage through `Arc`, playback already bounds its frame caches and prefetch buffers, and GPUI already exposes conversion/presentation/drop counters. Those were inspected before choosing this change. GPU-backed playback and non-x86 conversion do not receive this optimization. No end-to-end native FPS improvement has been established here.

The existing AVX2 and SSE2 entry points delegate to scalar row implementations. This change optimizes those actual row implementations. It does not claim to add explicit SIMD. Validated callers establish row extents before entry; malformed buffers continue through the original tolerant public scalar functions. Odd widths retain their final luma pixel. Each row slices only its active pixels, excluding padding and preserving output bytes beyond the requested image.

## Reproduce

This standalone harness compiles the production `cpu_yuv.rs` directly, avoiding the native decoder/GPU dependency tree. Rayon is pinned to the root workspace lockfile's version. Use the same compiler, lockfile, build flags, CPU, thread count, and runner for both revisions.

```sh
cargo +1.93.1 build --release --locked --manifest-path crates/rendering/benches/cpu-yuv/Cargo.toml
RAYON_NUM_THREADS=12 crates/rendering/benches/cpu-yuv/target/release/cpu-yuv-bench > baseline.csv
```

Build and copy the baseline executable before changing `cpu_yuv.rs`, then rebuild and write `optimized.csv`. Alternate baseline/optimized and optimized/baseline runs. Avoid builds or media encoding during timing. Repeat with one and four threads to separate row work from parallel scheduling. Five warmup frames precede 30 measured frames per format/resolution. Inputs and output storage are allocated before timing; the measurements include the production conversion entry point and Rayon scheduling, but exclude decoding, allocation, texture upload, composition, readback, and presentation. `black_box` makes the inputs and output observable; CSV writing happens outside the timed interval.

```sh
cargo +1.93.1 test --release --locked --manifest-path crates/rendering/benches/cpu-yuv/Cargo.toml
cargo +1.93.1 clippy --locked --manifest-path crates/rendering/benches/cpu-yuv/Cargo.toml --all-targets -- -D warnings
```

To convert a tightly packed even-width NV12 sequence into an RGBA reference sequence:

```sh
crates/rendering/benches/cpu-yuv/target/release/cpu-yuv-bench input.nv12 output.rgba 1280 720
```

The benchmark emits deterministic synthetic inputs. Use representative recordings and the existing `cap-editor` playback benchmarks when measuring the full pipeline on a supported native setup.

## Measured results

2026-10-13, Linux x86_64, Ryzen 5 3600 (6 cores / 12 logical CPUs), rustc 1.93.1, release + thin LTO, Rayon 1.11.0. Three paired runs per thread count, 90 samples per cell. `baseline.csv` and `optimized.csv` preserve all final samples. Early samples collected under concurrent compiler load were excluded from these final datasets; they remain in the local investigation artifacts.

Median conversion time with the default 12-thread pool:

| Format  | Resolution | Baseline ms | Optimized ms | Reduction |
| ------- | ---------- | ----------: | -----------: | --------: |
| NV12    | 1280×720   |       3.595 |        3.324 |      7.5% |
| NV12    | 1920×1080  |       1.299 |        1.134 |     12.7% |
| NV12    | 3840×2160  |       5.299 |        4.705 |     11.2% |
| YUV420P | 1280×720   |       3.738 |        3.161 |     15.4% |
| YUV420P | 1920×1080  |       1.402 |        1.096 |     21.8% |
| YUV420P | 3840×2160  |       5.632 |        4.601 |     18.3% |

720p uses the existing sequential path, so the thread count does not parallelize it. One-thread medians improve 7.1–15.5%; four-thread medians improve 4.5–16.2%. Tail latency remains sensitive to host scheduling: four-thread 4K YUV420P p95 increased in the collected samples despite its lower median, and 12-thread 1080p NV12 p95 was essentially unchanged. These measurements support lower median CPU conversion cost, not a universal tail-latency or native playback guarantee.

## Quality and browser evidence

All 11 module tests pass. Added regression coverage checks every possible 8-bit Y/U/V combination against the unchanged scalar reference with exact byte equality for both formats, odd dimensions, padded and partially padded final strides, parallel conversion, output tails, and truncated input/output fallback. Existing progress and cancellation tests also pass.

A 60-frame, 1280×720 NV12 fixture was decoded from the existing synthetic recording and converted through the frozen baseline and optimized executables. Both 221,184,000-byte RGBA sequences have SHA-256 `1609180a105e6c240659d65cc48808f80c095a56ec2420396e3569e5a3f5fde7`. H.264 browser previews encoded with identical settings also match byte-for-byte. The browser encoding is a viewing artifact; quality equivalence is established before that encoding.

The T3 shared real browser played both fixtures and exercised play, pause, resume, forward/backward seek, 2× playback, and ending. Canvas reads at 0.4, 1.4, and 0.2 seconds differ by zero bytes. Initial individual runs reported 0 versus 29 dropped frames; identical encoded files rule out an output difference, but the cause of that browser scheduling anomaly was not established. A simultaneous repeat reported zero new drops for both, with 56 newly processed frames each after four seek-predecoded frames. No browser throughput improvement is claimed: Rust conversion is performed before browser playback.

Recordings, raw sequences, initial and repeated browser metrics, and a screenshot are saved under the ignored `tmp/performance/` directory. The browser fixture was loaded into an in-memory page because the shared browser could not reach the existing local evidence server. It does not exercise Cap's web share player or GPUI's native presentation path.

`cargo fmt --all` passed. The scoped module tests and Clippy pass. `cargo check -p cap-rendering` was attempted before and after the change but fails in `ffmpeg-sys-next`: installed FFmpeg 9 lacks `/usr/include/libavcodec/avfft.h`, required by the repository's FFmpeg 7 bindings. Full compositor/editor and macOS/Windows checks are consequently unverified. No services or native app instances were started, and existing frame-kernel edits were preserved.

## Research and further measurements

Netflix tests on actual devices with tests close to SDK features and fluctuating bandwidth. For Cap, the analogous next gate is native GPUI testing on each decoder/presentation backend, including seeks across transitions, audio sync, and software fallback. Browser validation cannot replace that device coverage. [Netflix device testing](https://medium.com/netflix-techblog/automated-testing-on-devices-fc5a39f47e24)

Netflix also evaluates streaming changes through experiments that consider startup, quality, and rebuffering together. Cap should retain per-stage p50/p95/p99, time to first painted frame, starvation/drop counts, and audio drift rather than treating average throughput as the whole experience. [Netflix streaming experiments](https://medium.com/netflix-techblog/a-b-testing-and-beyond-improving-the-netflix-streaming-experience-with-experimentation-and-data-5b0ae9295bdf)

Netflix's VMAF provides perceptual quality evaluation for codec/processing changes. This optimization permits a stronger gate: exact output equality. VMAF would become useful if a later optimization changes filtering, resampling, or encoding. [Netflix VMAF](https://github.com/Netflix/vmaf)

Mux documented playback problems appearing only after 30–90 minutes when back buffers were not evicted, and recommends monitoring seek latency, rebuffering, and real-world memory. Cap already has byte budgets, but long-session RSS and backing-surface lifetime tests remain useful: a frame-count budget alone is inadequate for 4K/camera/transition data. No cache budgets were changed here. [Mux playback memory investigation](https://www.mux.com/blog/an-hls-js-cautionary-tale-qoe-and-video-player-memory)

mpv distinguishes presentation timing, delayed frames, and display synchronization from decoder throughput. Cap's rendered/presented/painted counters make the same distinction; paint calls can exceed unique presented frames. Native acceptance should measure unique painted frames and audio drift at 30/60 fps and different display refresh rates. [mpv playback statistics](https://github.com/mpv-player/mpv/blob/master/DOCS/man/mpv.rst)

Loom publishes player load-time and reliability improvements, but the consulted public material does not establish its internal playback test methodology. Its resolution-selection work is relevant to streaming bandwidth, but lowering Cap preview resolution would change the quality constraint and was not selected. [Loom reliability results](https://www.loom.com/blog/performance-and-reliability-2023), [Loom transformation design](https://www.loom.com/blog/just-in-time-transformation-to-deliver-quality-cut-cost-and-spread-joy)

Useful low-risk follow-ups to profile are output-buffer reuse, duplicate upload/readback avoidance, and Rayon oversubscription when software wgpu and decoding also use CPU workers. They are hypotheses, not measured improvements from this patch. Buffer reuse must preserve ownership until upload completion; texture reuse must preserve content identity and invalidate on seek/edit; worker tuning must be evaluated against startup and p99 starvation as well as median conversion time.

Rust slice iterators express bounded, non-overlapping output access without new unsafe pointers. `chunks` preserves odd tails, whereas `chunks_exact` intentionally excludes remainders and is used only for complete chroma/pixel units. FFmpeg documents that linesize can include padding, so tightly packed images alone are insufficient test coverage. [Rust slices](https://doc.rust-lang.org/std/primitive.slice.html), [Rust benchmark observability](https://doc.rust-lang.org/std/hint/fn.black_box.html), [FFmpeg frame layout](https://www.ffmpeg.org/doxygen/7.1/structAVFrame.html), [Rayon pool configuration](https://docs.rs/rayon-core/latest/rayon_core/struct.ThreadPoolBuilder.html)
