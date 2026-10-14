# Auto-zoom cluster benchmark results

On the synthetic ten-minute 1080p recording, a paused edit at 9:48 takes 20.74 ms before and 12.34 ms after, a 40.5% latency reduction. These are medians of five run medians. The ranges are 18.53–21.43 ms before and 8.86–15.06 ms after.

The improvement concerns long auto-zoom segments. Shorter recordings and four-second zoom controls have overlapping run ranges and do not establish a performance difference.

## Measurement

The baseline is upstream `34036657845bf063c875e66a10ad537afa415f35`, which includes #2557. Both binaries use the GPUI workspace release profile, Rust 1.97.1, and the same native FFmpeg libraries. The machine is an Apple M5 with ten logical cores and macOS 27.0.1.

The existing GPUI `live-edit-benchmark` sends a padding change to `EditorInstance`, requests the paused frame, and awaits the matching frame callback. It uses two Tokio workers, a 1248×702 preview, 60 fps, and the app's `BgraSurface` output on macOS. The timer includes project publication, zoom reconstruction and simulation, decoding, rendering, and frame delivery. It excludes editor startup, the first warmup frame, and window composition.

Each fixture runs five times per binary. The binary order reverses between pairs. Each run completes 30 edits at each of the 2%, 50%, and 98% playhead positions. The 60 successful runs complete 5,400 timed edits with no terminal failures, renderer errors, or warnings. The runner checks the loaded duration, zoom count, and exact playhead positions.

The machine has other desktop applications running. The initial one-minute load average is 8.47. Compilation and profiling finish before the timed comparisons. Interleaving limits the effect of background activity, and the ranges below retain its variation.

The primary H.264 recording is 1920×1080 at 30 fps, with 18,000 video frames. A second suite uses 320×180 video. Cursor events arrive at 60 Hz. The cursor moves smoothly between x=0.1 and x=0.9 over a 3.2-second cycle, with a slower vertical oscillation. Cursor smoothing remains enabled. The recording has no audio or camera. The long case sets one continuous 2× auto-zoom segment. This is a supported manually extended segment, rather than output from the click generator. The control contains four-second zooms every 30 seconds.

## Results

Each cell gives the median of five run medians, followed by their minimum and maximum, in milliseconds. The [raw CSV](zoom-clusters.csv) contains every run and region, plus process CPU time and error counts.

| 1080p fixture                  | Playhead |               Before |               After |
| ------------------------------ | -------: | -------------------: | ------------------: |
| 600 seconds, continuous zoom   |       2% |    6.58 [4.38, 9.14] |   5.16 [4.95, 7.31] |
| 600 seconds, continuous zoom   |      50% | 18.00 [17.21, 18.05] |  9.63 [8.53, 10.44] |
| 600 seconds, continuous zoom   |      98% | 20.74 [18.53, 21.43] | 12.34 [8.86, 15.06] |
| 600 seconds, four-second zooms |       2% |    8.26 [5.95, 8.31] |   8.24 [5.93, 8.31] |
| 600 seconds, four-second zooms |      50% |    3.50 [3.33, 4.65] |   3.41 [3.25, 3.56] |
| 600 seconds, four-second zooms |      98% |    4.10 [3.89, 5.23] |   4.08 [4.00, 4.20] |

| 320×180 fixture                | Playhead |               Before |                After |
| ------------------------------ | -------: | -------------------: | -------------------: |
| 30 seconds, continuous zoom    |       2% |    6.01 [5.98, 8.40] |    6.07 [4.95, 8.39] |
| 30 seconds, continuous zoom    |      50% |    7.31 [6.41, 8.47] |    7.73 [5.09, 8.14] |
| 30 seconds, continuous zoom    |      98% |    7.87 [7.52, 9.15] |   7.96 [7.03, 10.57] |
| 120 seconds, continuous zoom   |       2% |    6.04 [5.02, 6.11] |    6.05 [5.94, 8.33] |
| 120 seconds, continuous zoom   |      50% |    8.44 [7.77, 9.71] |    7.30 [6.30, 8.99] |
| 120 seconds, continuous zoom   |      98% |  10.34 [7.04, 10.88] |    9.06 [8.00, 9.79] |
| 600 seconds, continuous zoom   |       2% |    7.83 [5.60, 9.39] |    5.22 [3.98, 9.78] |
| 600 seconds, continuous zoom   |      50% | 18.20 [18.14, 18.44] |  11.02 [7.89, 11.94] |
| 600 seconds, continuous zoom   |      98% | 20.70 [19.50, 22.53] | 12.18 [11.83, 12.62] |
| 600 seconds, four-second zooms |       2% |    8.37 [6.12, 8.54] |    8.47 [5.18, 8.66] |
| 600 seconds, four-second zooms |      50% |    3.41 [3.22, 4.97] |    3.97 [3.19, 5.05] |
| 600 seconds, four-second zooms |      98% |    4.27 [4.09, 5.14] |    4.28 [3.82, 4.45] |

An exact two-sided rank-sum check on the five run medians gives p=0.0079 for both the middle and late continuous ten-minute case at either resolution. The other comparisons have p≥0.095. The 320×180 four-second control's middle-position median increases, but its overlapping ranges and p=0.42 do not establish a regression. These small samples do not prove that all short inputs have identical cost.

Median process CPU time over the 90 edits in the continuous ten-minute 1080p case is 0.749 seconds before and 0.228 seconds after. The average CPU saving is smaller than the original average CPU cost per edit. The latency result therefore does not require saving more CPU work than the baseline performs.

## Profiler and correctness evidence

A separate, unreported `sample` run uses the 320×180 baseline with symbols retained. The dominant `targets_at` offsets, +788 and +792, resolve to the reverse cluster loop: load a timestamp, move backward 48 bytes, compare with the requested time, and branch back. `targets_at` accounts for 2,096 of the 2,172 samples below `advance_one_step`. This identifies the precompute CPU cost, not its fraction of whole-edit wall time. Sleeping decoder, GPU, and runtime threads are also present in the profile.

The ten-minute continuous fixture produces 1,126 clusters and up to 75,002 cached spring samples. The indexed lookup changes a linear reverse search into a binary search for ordered clusters. Unordered lists retain the original scan. The ignored rebuild benchmark compares every sample bit with the linear path outside its timer, including the long and four-second controls. The full ten-minute continuous case has sample hash `8f8ba71ca9a5b122`.

Validation passes all 307 rendering unit tests, including 30,811 lookup comparisons and 24 complete-timeline comparisons across crop styles, fullscreen holds, reordered moves, clip jumps, and transitions. The export equivalence test also passes for eager, incremental, and seek paths. Rust formatting, all-target compilation, and Python Ruff checks pass.

Strict Rust 1.97 Clippy reports existing modulo expressions in `crates/project/src/animated_gradient.rs:259,266`, loop suggestions in `crates/rendering/src/lib.rs:738,1325`, and a cloned-reference suggestion in `crates/rendering/src/layers/text.rs:992`. These files match the baseline. Running Clippy again with the original zoom source reproduces the same rendering findings. No lint suppressions are added. Root CI uses Rust 1.88.

## Commands

Fixture creation uses the new generator. It refuses an existing destination.

```sh
python3 scripts/benchmark-zoom-clusters.py /tmp/zoom-long.cap --duration 600 --width 1920 --height 1080
python3 scripts/benchmark-zoom-clusters.py /tmp/zoom-short.cap --duration 600 --width 1920 --height 1080 --short-zooms
```

The existing benchmark command runs from `apps/desktop-gpui` on each revision, with the same generated fixture and native dependency environment. The measurements above use five interleaved runs per revision.

```sh
cargo +stable run --release --example live-edit-benchmark -- /tmp/zoom-long.cap 30
cargo +stable run --release --example live-edit-benchmark -- /tmp/zoom-short.cap 30
```

The rendering crate owns the ignored diagnostic benchmark and correctness tests. Its release profile uses size optimization by default. The opt-level override below matches the GPUI app's optimization level.

```sh
cargo +stable test -p cap-rendering --lib --release --config profile.release.opt-level=3 zoom_cluster_timeline_rebuild -- --ignored --nocapture
cargo +stable test -p cap-rendering --lib
cargo +stable test -p cap-rendering --test export_zoom_equivalence
```
