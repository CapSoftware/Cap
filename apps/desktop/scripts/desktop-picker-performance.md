# Desktop picker latency

The display and window pickers should reuse healthy selected devices. Restoring saved inputs must not open error dialogs for disconnected devices. Recording still waits for input setup, and missing selections remain saved for reconnection.

## Benchmarks

The ignored native benchmark runs real device discovery, microphone configuration lookups, camera setup, and camera frame delivery. It compares repeated camera setup with reuse and compares microphone lookup strategies in the same process. It opens the specified camera without creating recordings.

```sh
cd apps/desktop-gpui
CAP_PICKER_BENCH_CAMERA_ID=<device-id> cargo test -p cap-desktop-gpui --bin cap-gpui picker_benchmark::native_picker_latency -- --ignored --nocapture
```

Both debug apps also support `CAP_PICKER_BENCHMARK_OUTPUT=<absolute-json-path>` and `CAP_PICKER_BENCHMARK_DELAY_MS=0`. They open and dismiss six alternating display/window pickers, write timings, and exit. The default delay is 2000 ms. Run them sequentially after compilation has finished.

- Tauri measures from the target-mode request through native window creation, frontend initialization, input restoration, and two animation frames with the recording button enabled.
- GPUI includes pending device discovery and selected-input readiness, then waits for two rendered overlay frames.
- Sample zero measures the first picker in a fresh process. Later samples measure reopening. These are picker timings, not total process launch times. They are not directly interchangeable across UI implementations.

Use isolated settings for these app runs. GPUI accepts `CAP_GPUI_APP_DATA_DIR`. Build Tauri with a separate `TAURI_CONFIG` identifier and seed only that identifier's application-data `store`. Set the recording mode to `studio` and select the test inputs in that store. Never point a benchmark at customer recordings or an active recording session.

For a Tauri build with bundled frontend assets and no development server:

```sh
pnpm --filter @cap/desktop build
TAURI_CONFIG='{"identifier":"so.cap.desktop.picker-benchmark","productName":"Cap Picker Benchmark","build":{"devUrl":null}}' cargo build -p cap-desktop --features tauri/custom-protocol
```

## What changed

- Startup restoration bypasses the global mutation handler that displays native error dialogs. Explicit device selections retain their normal error handling.
- Matching simultaneous Tauri requests share pending setup. A different device, configuration, or camera-window request supersedes it.
- Repeated Tauri selections reuse a feed only when its identity and settings match and frames or audio samples arrived within 250 ms. Stalled feeds continue through setup and recovery.
- Camera-only mode retains its normal camera setup path, which also handles its different preview routing.
- GPUI startup lists microphone names without opening every device's audio configuration. Detailed configuration remains available when opening the microphone menu.
- Tauri microphone details configure only the requested device, avoiding a complete configuration scan for each row.
- The picker keeps its action label while readiness checks run.

## Local comparison, 2026-09-09

On macOS with five cameras, five microphones, one display, and twelve listed windows; the built-in camera and microphone were selected. The baseline used the original Rust selection/discovery paths from `0c403be8a57f7ba4de67140273708a392c8b4050`. Both variants used the same frontend, timing hooks, settings, and build profile. Runs were sequential with no compilation in progress.

| UI measurement | Before | After |
| --- | ---: | ---: |
| Tauri first display picker | 1,921 ms | 955 ms |
| Tauri reopening, median of five alternating display/window openings | 815 ms | 65 ms |
| GPUI first display picker | 1,046 ms | 679 ms |
| GPUI reopening, median of five alternating display/window openings | 28 ms | 24 ms |

All 24 openings reached readiness. GPUI reopening was already fast; its improvement is in discovery during startup. Across the optimized Tauri run, native logs showed one microphone setup and one camera setup for all six openings.

The final native comparison measured median microphone metadata lookup time of 1,579 ms for repeated full scans versus 187 ms for named lookups. Repeated camera setup took 433 ms; checking an already-streaming matching camera took 0.02 ms, with subsequent frames received in every sample. That last number is the feed acknowledgment time, not UI latency or first-frame startup.

An additional Tauri run restored the unavailable `Shure MV7+` and `046d:08e5` selections. All six pickers reached readiness without blocking dialogs, and both selections remained persisted. Cold samples are individual observations, not percentile estimates.

## Validation boundaries

The local measurements exercise macOS hardware and debug Rust builds with bundled production frontend assets. They do not establish Windows hardware latency or release-package behavior. Keep cold samples separate from reopening samples, and preserve device counts and first-frame checks when comparing runs.
