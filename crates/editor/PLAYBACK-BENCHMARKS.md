# Cap Playback Benchmark Results

This document tracks performance benchmarks for Cap's playback and decoding system over time. Each benchmark run is timestamped, enabling comparison across different versions, configurations, and hardware.

## Quick Reference

### Performance Targets

| Metric | Target | Tolerance |
|--------|--------|-----------|
| Decoder Init | <200ms | - |
| Decode Latency (p95) | <50ms | - |
| Effective FPS | ≥60 fps | ±2 fps |
| Decode Jitter | <10ms | - |
| A/V Sync (mic↔video) | <100ms | - |
| A/V Sync (system↔video) | <100ms | - |
| Camera-Display Drift | <100ms | - |

### Test Categories

- **Decoder Tests**: Init time, hardware acceleration detection, fallback handling
- **Playback Tests**: Sequential decode, frame retrieval, latency percentiles
- **Audio Sync Tests**: Mic-video sync, system audio-video sync
- **Camera Sync Tests**: Camera-display drift, frame count alignment
- **Decode Benchmark**: Creation, sequential, seek, and random access performance

### Supported Formats

| Format | Extension | Hardware Accel | Notes |
|--------|-----------|----------------|-------|
| MP4 (H.264) | .mp4 | ✅ VideoToolbox (macOS), MediaFoundation (Win) | Primary format |
| Fragmented MP4 | init.mp4 + .m4s | ✅ | Segmented recording |
| MP4 (HEVC/H.265) | .mp4 | ✅ | Higher compression |
| WebM (VP9) | .webm | ⚠️ Software fallback | Web compatibility |

### Running Benchmarks

#### Playback Validation (uses recording test outputs)

```bash
# Run full playback validation on recordings from real-device-test-runner
cargo run -p cap-recording --example playback-test-runner -- full

# Run specific test categories
cargo run -p cap-recording --example playback-test-runner -- decoder
cargo run -p cap-recording --example playback-test-runner -- playback
cargo run -p cap-recording --example playback-test-runner -- audio-sync
cargo run -p cap-recording --example playback-test-runner -- camera-sync

# Test a specific recording
cargo run -p cap-recording --example playback-test-runner -- --recording-path /path/to/recording full

# List available recordings
cargo run -p cap-recording --example playback-test-runner -- list
```

#### Decode Performance Benchmark

```bash
# Benchmark decode performance on a video file
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/video.mp4

# With custom FPS and iterations
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/video.mp4 --fps 60 --iterations 50

# Increase seek sampling per distance for more stable tails
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/video.mp4 --fps 60 --seek-iterations 20

# Includes duplicate-request burst stats (burst sizes 4/8/16) by default
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/video.mp4 --fps 60
```

#### Playback Throughput Benchmark (Linux-compatible)

```bash
# Simulate real-time playback deadlines from a single video
cargo run -p cap-editor --example playback-benchmark -- --video /path/to/video.mp4 --fps 60 --max-frames 600

# Optional audio duration comparison
cargo run -p cap-editor --example playback-benchmark -- --video /path/to/video.mp4 --audio /path/to/audio.ogg --fps 60

# Increase seek sample count for stable p95/max seek stats
cargo run -p cap-editor --example playback-benchmark -- --video /path/to/video.mp4 --fps 60 --max-frames 600 --seek-iterations 20
```

#### Scrub Burst Benchmark (queue stress)

```bash
# Simulate rapid scrub bursts and track latest-request latency
cargo run -p cap-editor --example scrub-benchmark -- --video /path/to/video.mp4 --fps 60 --bursts 20 --burst-size 12 --sweep-seconds 2.0

# Aggregate multiple runs (median across runs) for lower-variance comparisons
cargo run -p cap-editor --example scrub-benchmark -- --video /path/to/video.mp4 --fps 60 --bursts 10 --burst-size 12 --sweep-seconds 2.0 --runs 3

# Runtime tuning for FFmpeg scrub supersession heuristic
CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_PIXELS=2000000 \
CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_REQUESTS=7 \
CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES=20 \
cargo run -p cap-editor --example scrub-benchmark -- --video /path/to/video.mp4

# Export per-run and aggregate scrub metrics to CSV
cargo run -p cap-editor --example scrub-benchmark -- --video /path/to/video.mp4 --runs 3 --output-csv /tmp/cap-scrub-benchmark.csv

# Add explicit run label for cross-machine comparisons
cargo run -p cap-editor --example scrub-benchmark -- --video /path/to/video.mp4 --runs 3 --output-csv /tmp/cap-scrub-benchmark.csv --run-label windows-pass-1

# Summarize scrub CSV runs grouped by run label
cargo run -p cap-editor --example scrub-csv-report -- --csv /tmp/cap-scrub-benchmark.csv

# Compare two run labels directly
cargo run -p cap-editor --example scrub-csv-report -- --csv /tmp/cap-scrub-benchmark.csv --baseline-label macos-pass-1 --candidate-label windows-pass-1
```

#### Playback Startup Latency Report (log analysis)

```bash
# Capture startup traces from desktop editor playback sessions
CAP_PLAYBACK_STARTUP_TRACE_FILE=/tmp/playback-startup.csv pnpm dev:desktop

# Optional run label embedded in each CSV line
CAP_PLAYBACK_STARTUP_TRACE_FILE=/tmp/playback-startup.csv CAP_PLAYBACK_STARTUP_TRACE_RUN_ID=macos-pass-1 pnpm dev:desktop

# Parse startup timing logs captured from desktop editor sessions
cargo run -p cap-editor --example playback-startup-report -- --log /path/to/editor.log

# Export startup metric summaries to CSV
cargo run -p cap-editor --example playback-startup-report -- --log /path/to/editor.log --output-csv /tmp/playback-startup-summary.csv

# Filter startup CSV events to a specific labeled run id
cargo run -p cap-editor --example playback-startup-report -- --log /tmp/playback-startup.csv --run-id macos-pass-1

# List run-id sample counts discovered in startup CSV logs
cargo run -p cap-editor --example playback-startup-report -- --log /tmp/playback-startup.csv --list-runs

# List per-run startup metric summaries (avg/p95 by event)
cargo run -p cap-editor --example playback-startup-report -- --log /tmp/playback-startup.csv --list-run-metrics

# Aggregate multiple session logs
cargo run -p cap-editor --example playback-startup-report -- --log /path/to/macos.log --log /path/to/windows.log

# Compare candidate logs against baseline logs
cargo run -p cap-editor --example playback-startup-report -- --baseline-log /path/to/baseline.log --candidate-log /path/to/candidate.log

# Compare specific labeled runs inside shared startup CSV traces
cargo run -p cap-editor --example playback-startup-report -- --baseline-log /tmp/playback-startup.csv --candidate-log /tmp/playback-startup.csv --baseline-run-id macos-pass-1 --candidate-run-id macos-pass-2

# Export baseline/candidate deltas to CSV
cargo run -p cap-editor --example playback-startup-report -- --baseline-log /tmp/playback-startup.csv --candidate-log /tmp/playback-startup.csv --baseline-run-id macos-pass-1 --candidate-run-id macos-pass-2 --output-csv /tmp/playback-startup-delta.csv
```

#### Combined Workflow (Recording → Playback)

```bash
# Step 1: Create test recordings with outputs kept
cargo run -p cap-recording --example real-device-test-runner -- full --keep-outputs

# Step 2: Validate playback of those recordings
cargo run -p cap-recording --example playback-test-runner -- full
```

---

## Benchmark History

<!-- PLAYBACK_BENCHMARK_RESULTS_START -->

### Benchmark Run: 2026-02-14 00:00:00 UTC (scrub CSV export)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark --runs 2 --output-csv /tmp/cap-scrub-benchmark.csv`

#### Scrub Burst Benchmark + CSV — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Successful requests: **192**, failures: **0**
- Median across 2 runs (all-request): avg **191.35ms**, p95 **430.23ms**, p99 **430.23ms**, max **450.58ms**
- Median across 2 runs (last-request): avg **290.53ms**, p95 **450.58ms**, p99 **450.58ms**, max **450.58ms**

#### Scrub Burst Benchmark + CSV — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Successful requests: **192**, failures: **0**
- Median across 2 runs (all-request): avg **740.11ms**, p95 **1712.02ms**, p99 **1712.02ms**, max **1712.03ms**
- Median across 2 runs (last-request): avg **740.10ms**, p95 **1712.02ms**, p99 **1712.02ms**, max **1712.02ms**

#### CSV Output
- Output file: `/tmp/cap-scrub-benchmark.csv`
- Rows emitted per invocation:
  - one row per run (`scope=run`)
  - one aggregate row (`scope=aggregate`)
- Captures runtime supersession env values alongside scrub latency metrics for easier cross-machine sweeps.

### Benchmark Run: 2026-02-14 00:00:00 UTC (startup report run-id filters)

**Environment:** Linux runner, startup report parser validation  
**Commands:** `playback-startup-report --run-id`, `cargo test -p cap-editor --example playback-startup-report`

#### Startup Report Parser Validation
- Unit tests: **6 passed**, including:
  - CSV parse with and without run-id column
  - run-id filtering of startup metrics from mixed-run CSV lines
- CLI smoke run:
  - `cargo run -p cap-editor --example playback-startup-report -- --log crates/editor/PLAYBACK-BENCHMARKS.md --run-id sample-run`
  - Completed successfully with filtered metric output path active.

### Benchmark Run: 2026-02-14 00:00:00 UTC (startup report run-id listing + strict filtering)

**Environment:** Linux runner, startup report parser validation  
**Commands:** `playback-startup-report --list-runs`, `playback-startup-report --run-id ...`

#### Startup Report CLI Validation
- `--list-runs` mode prints grouped run-id sample counts from CSV traces.
- Requesting a `--run-id` with zero matched startup samples now exits with an explicit failure.
- Validation commands:
  - `cargo run -p cap-editor --example playback-startup-report -- --log crates/editor/PLAYBACK-BENCHMARKS.md --list-runs`
  - `cargo run -p cap-editor --example playback-startup-report -- --log crates/editor/PLAYBACK-BENCHMARKS.md --run-id missing-run` (expected non-zero exit)
- Unit tests remain green: `cargo test -p cap-editor --example playback-startup-report` (**6 passed**).

### Benchmark Run: 2026-02-14 00:00:00 UTC (startup report CSV export)

**Environment:** Linux runner, startup report parser validation  
**Commands:** `playback-startup-report --output-csv`, `cargo test -p cap-editor --example playback-startup-report`

#### Startup Report CSV Validation
- Added CSV export for:
  - aggregate startup metrics (`mode=aggregate`)
  - baseline/candidate deltas (`mode=delta`)
- Unit tests now cover CSV row emission and delta summarization (**8 passed**).
- CLI smoke run:
  - `cargo run -p cap-editor --example playback-startup-report -- --log crates/editor/PLAYBACK-BENCHMARKS.md --output-csv /tmp/playback-startup-summary.csv`
  - output CSV schema verified with header row.

### Benchmark Run: 2026-02-14 00:00:00 UTC (startup run-metrics listing)

**Environment:** Linux runner, startup report parser validation  
**Commands:** `playback-startup-report --list-run-metrics`, `cargo test -p cap-editor --example playback-startup-report`

#### Validation
- Added `--list-run-metrics` mode to print per-run startup metric summaries (avg/p95/samples per event).
- Unit tests now include run-metrics aggregation path (**9 passed** total in example target).
- CLI smoke run:
  - `cargo run -p cap-editor --example playback-startup-report -- --log crates/editor/PLAYBACK-BENCHMARKS.md --list-run-metrics`
  - confirms mode execution path and empty-run handling output.

### Benchmark Run: 2026-02-14 00:00:00 UTC (supersession span retune to 20)

**Environment:** Linux runner with synthetic 4k60 and 1080p60 MP4 assets  
**Commands:** `scrub-benchmark --runs 3`, `playback-benchmark --seek-iterations 10`, `decode-benchmark --seek-iterations 10`  
**Change under test:** default `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES` fallback changed from `25` to `20`

#### 4k scrub span sweep before promoting new default
- Command family:
  - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES={15,20,25,30} scrub-benchmark --runs 3`
- Median last-request latency by span:
  - **15**: avg **836.94ms**, p95 **1740.74ms**
  - **20**: avg **814.93ms**, p95 **1743.49ms**
  - **25**: avg **819.11ms**, p95 **1762.74ms**
  - **30**: avg **923.18ms**, p95 **1947.86ms**
- Decision: promote span **20** as new default based on best median average and lower tail than span 25/30.

#### Scrub Benchmark — default after retune (span=20)
- 4k60 (`/tmp/cap-bench-4k60.mp4`, runs=3):
  - Median all-request: avg **832.56ms**, p95 **1732.40ms**, p99 **1732.40ms**, max **1732.41ms**
  - Median last-request: avg **836.61ms**, p95 **1732.40ms**, p99 **1732.40ms**, max **1732.40ms**
- 1080p60 (`/tmp/cap-bench-1080p60.mp4`, runs=3):
  - Median all-request: avg **222.58ms**, p95 **446.05ms**, p99 **472.21ms**, max **472.21ms**
  - Median last-request: avg **326.36ms**, p95 **472.21ms**, p99 **472.21ms**, max **472.21ms**

#### Regression checks after default retune
- Playback throughput:
  - 1080p60: **60.24 fps**, missed deadlines **0**, decode p95 **2.24ms**
  - 4k60: **60.18 fps**, missed deadlines **2**, decode p95 **9.67ms**
- Decode benchmark:
  - 1080p random access avg **111.79ms**, p95 **337.65ms**
  - 4k random access avg **509.26ms**, p95 **1451.87ms**
- Duplicate burst handling remained stable (0 failures for burst sizes 4/8/16).

### Benchmark Run: 2026-02-14 00:00:00 UTC (supersession min-pixels retune to 2,000,000)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark --runs 3`, `playback-benchmark --seek-iterations 10`, `decode-benchmark --seek-iterations 10`  
**Change under test:** default `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_PIXELS` fallback changed from `3_686_400` to `2_000_000`

#### Min-pixels threshold sweep (with span=20, min_requests=8)
- Baseline (`min_pixels=3_686_400`):
  - 1080p median last-request avg **332.72ms**, p95 **480.45ms**
  - 4k median last-request avg **855.08ms**, p95 **1769.64ms**
- Candidate (`min_pixels=2_000_000`):
  - 1080p median last-request avg **213.36ms**, p95 **449.62ms**
  - 4k median last-request avg **814.28ms**, p95 **1716.14ms**
- Decision: promote `min_pixels=2_000_000` as new default; it materially improves 1080p scrub responsiveness while also tightening 4k tails.

#### Scrub Benchmark — default after retune
- 1080p60 (`/tmp/cap-bench-1080p60.mp4`, runs=3):
  - Median all-request: avg **199.10ms**, p95 **429.83ms**, p99 **429.83ms**, max **429.83ms**
  - Median last-request: avg **200.14ms**, p95 **429.83ms**, p99 **429.83ms**, max **429.83ms**
- 4k60 (`/tmp/cap-bench-4k60.mp4`, runs=3):
  - Median all-request: avg **829.97ms**, p95 **1718.54ms**, p99 **1718.55ms**, max **1718.55ms**
  - Median last-request: avg **834.23ms**, p95 **1718.54ms**, p99 **1718.54ms**, max **1718.54ms**

#### Regression checks after default retune
- Playback throughput:
  - 1080p60: **60.23 fps**, missed deadlines **0**, decode p95 **2.29ms**
  - 4k60: **60.19 fps**, missed deadlines **1**, decode p95 **7.72ms**
- Decode benchmark:
  - 1080p random access avg **116.73ms**, p95 **369.84ms**
  - 4k random access avg **522.27ms**, p95 **1514.02ms**
  - follow-up 4k run: random access avg **537.60ms** and **522.27ms** (variance envelope maintained)

### Benchmark Run: 2026-02-14 00:00:00 UTC (scrub CSV run-label tagging)

**Environment:** Linux runner, synthetic 1080p60 MP4  
**Command:** `scrub-benchmark --runs 2 --output-csv /tmp/cap-scrub-labeled.csv --run-label linux-pass-a`

#### Result
- Successful requests: **144**, failures: **0**
- Median all-request latency: avg **199.01ms**, p95 **410.34ms**
- Median last-request latency: avg **213.93ms**, p95 **410.34ms**
- CSV output now includes `run_label` column across run and aggregate rows, enabling direct cross-machine merge and grouping.

### Benchmark Run: 2026-02-14 00:00:00 UTC (supersession min-requests retune to 7)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark --runs 3`, `playback-benchmark --seek-iterations 10`, `decode-benchmark --seek-iterations 10`  
**Change under test:** default `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_REQUESTS` fallback changed from `8` to `7`

#### Min-requests threshold sweep (with span=20, min_pixels=2_000_000)
- Sequential sweep command family:
  - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_REQUESTS={6,7,8} scrub-benchmark --runs 3`
- 1080p median last-request latency:
  - **6**: avg **209.99ms**, p95 **444.08ms**
  - **7**: avg **211.36ms**, p95 **447.60ms**
  - **8**: avg **209.11ms**, p95 **441.08ms**
- 4k median last-request latency:
  - **6**: avg **827.29ms**, p95 **1707.63ms**
  - **7**: avg **823.15ms**, p95 **1699.04ms**
  - **8**: avg **884.74ms**, p95 **1837.32ms**
- Decision: promote `min_requests=7` as the best cross-resolution compromise, preserving 1080p performance while significantly improving 4k tails over `8`.

#### Scrub Benchmark — default after retune (`min_requests=7`)
- 1080p60 (`/tmp/cap-bench-1080p60.mp4`, runs=3):
  - Median all-request: avg **204.34ms**, p95 **432.90ms**, p99 **432.91ms**, max **432.91ms**
  - Median last-request: avg **205.46ms**, p95 **432.90ms**, p99 **432.90ms**, max **432.90ms**
- 4k60 (`/tmp/cap-bench-4k60.mp4`, runs=3):
  - Median all-request: avg **820.91ms**, p95 **1712.30ms**, p99 **1712.30ms**, max **1712.31ms**
  - Median last-request: avg **825.01ms**, p95 **1712.30ms**, p99 **1712.30ms**, max **1712.30ms**

#### Regression checks after default retune
- Playback throughput:
  - 1080p60: **60.24 fps**, missed deadlines **0**, decode p95 **2.14ms**
  - 4k60: **60.20 fps**, missed deadlines **0**, decode p95 **8.82ms**
- Decode benchmark:
  - 1080p random access avg **115.49ms**, p95 **350.30ms**
  - 4k random access avg **511.55ms**, p95 **1394.69ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (span threshold recheck after default retunes)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES={15,20,25} scrub-benchmark --runs 3`  
**Context:** defaults already retuned to `min_requests=7`, `min_pixels=2_000_000`

#### Span sweep medians (last-request latency)
- 1080p:
  - **15**: avg **216.43ms**, p95 **457.45ms**
  - **20**: avg **209.63ms**, p95 **442.04ms**
  - **25**: avg **213.84ms**, p95 **447.71ms**
- 4k:
  - **15**: avg **862.02ms**, p95 **1789.73ms**
  - **20**: avg **860.43ms**, p95 **1761.25ms**
  - **25**: avg **866.03ms**, p95 **1781.42ms**

#### Decision
- Keep `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES` default at **20**.
- Candidate spans 15 and 25 were rejected; neither improved both 1080p and 4k tails versus 20 under the new defaults.

### Benchmark Run: 2026-02-14 00:00:00 UTC (fine span sweep 18/20/22, rejected span 22)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark --runs 3`, `scrub-csv-report --baseline-label span20 --candidate-label span22`

#### Fine sweep medians (single-pass)
- 1080p:
  - **18**: avg **303.40ms**, p95 **665.16ms**
  - **20**: avg **214.65ms**, p95 **434.74ms**
  - **22**: avg **210.83ms**, p95 **442.55ms**
- 4k:
  - **18**: avg **897.87ms**, p95 **1891.21ms**
  - **20**: avg **967.04ms**, p95 **1897.05ms**
  - **22**: avg **829.73ms**, p95 **1714.74ms**

#### Paired span20 vs span22 labeled sweep
- Using `/tmp/cap-scrub-span-20-22.csv` with run labels:
  - 1080p delta (22-20): all_avg **-0.34ms**, all_p95 **+24.13ms**, last_avg **-0.15ms**, last_p95 **+24.13ms**
  - 4k delta (22-20): all_avg **-64.97ms**, all_p95 **-227.95ms**, last_avg **-78.37ms**, last_p95 **-296.82ms**

#### Validation pass on temporary default-22 branch state
- Scrub medians:
  - 1080p last-request avg **203.87ms**, p95 **435.18ms**
  - 4k last-request avg **847.32ms**, p95 **1797.10ms**
- Playback regression sample:
  - 4k effective fps **60.14** with missed deadlines **4**
- Decode regression sample:
  - 4k random access avg **511.57ms**, p95 **1456.64ms**

#### Decision
- Rejected promoting span **22** as default due inconsistent 4k tail behavior across repeated runs and a noisier playback regression sample.
- Keep default `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES` at **20** for stability.

### Benchmark Run: 2026-02-14 00:00:00 UTC (scrub CSV report tooling)

**Environment:** Linux runner, CSV analysis utility validation  
**Commands:** `scrub-csv-report`, `cargo test -p cap-editor --example scrub-csv-report`

#### Validation
- New utility parses scrub benchmark CSV aggregate rows and reports median summaries by run label + video.
- Empty run labels now automatically fall back to a derived config label (`min_pixels`, `min_requests`, `min_span`, `disabled`) so unlabeled sweeps remain distinguishable.
- Smoke run against labeled CSV:
  - `cargo run -p cap-editor --example scrub-csv-report -- --csv /tmp/cap-scrub-labeled.csv --label linux-pass-a`
  - output summary:
    - all_avg **199.01ms**
    - last_avg **213.93ms**
    - successful **144**, failed **0**
- Unit tests: **4 passed** (`parses_aggregate_csv_line`, `falls_back_to_config_label_when_run_label_missing`, `summarizes_medians`, `groups_rows_by_label_and_video`).

### Benchmark Run: 2026-02-14 00:00:00 UTC

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `decode-benchmark` and `playback-benchmark`

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **6.09ms**
- Sequential decode: **401.9 fps**, avg **2.49ms**, p95 **~2.34ms**
- Seek latency: 0.5s **1.88ms**, 1.0s **1.83ms**, 2.0s **260.87ms**, 5.0s **102.36ms**
- Random access: avg **223.27ms**, p95 **398.42ms**, p99 **443.68ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **28.65ms**
- Sequential decode: **99.4 fps**, avg **10.06ms**, p95 **~8.35ms**
- Seek latency: 0.5s **6.61ms**, 1.0s **6.73ms**, 2.0s **905.03ms**, 5.0s **442.71ms**
- Random access: avg **918.05ms**, p95 **1620.94ms**, p99 **2084.36ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.11**
- Decode: avg **1.23ms**, p95 **2.34ms**, p99 **2.44ms**, max **4.76ms**
- Seek samples: 0.5s **104.51ms**, 1.0s **90.83ms**, 2.0s **144.89ms**, 5.0s **98.70ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **2**
- Effective FPS: **60.11**
- Decode: avg **5.54ms**, p95 **8.35ms**, p99 **12.69ms**, max **17.10ms**
- Seek samples: 0.5s **266.92ms**, 1.0s **306.19ms**, 2.0s **570.41ms**, 5.0s **442.48ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (FFmpeg seek reset tuning)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `decode-benchmark` and `playback-benchmark`  
**Change under test:** FFmpeg decoder reset now uses forward seek window before fallback seek

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **6.58ms**
- Sequential decode: **367.9 fps**, avg **2.72ms**
- Seek latency: 0.5s **1.88ms**, 1.0s **1.73ms**, 2.0s **5.26ms**, 5.0s **115.42ms**
- Random access: avg **120.87ms**, p95 **366.01ms**, p99 **391.53ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **32.65ms**
- Sequential decode: **88.0 fps**, avg **11.36ms**
- Seek latency: 0.5s **7.52ms**, 1.0s **7.76ms**, 2.0s **12.65ms**, 5.0s **679.52ms**
- Random access: avg **533.65ms**, p95 **1520.65ms**, p99 **1636.44ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.11**
- Decode: avg **1.33ms**, p95 **2.45ms**, p99 **2.51ms**, max **3.99ms**
- Seek samples: 0.5s **11.89ms**, 1.0s **2.71ms**, 2.0s **2.81ms**, 5.0s **138.26ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **1**
- Effective FPS: **60.11**
- Decode: avg **5.41ms**, p95 **7.93ms**, p99 **11.18ms**, max **18.70ms**
- Seek samples: 0.5s **30.06ms**, 1.0s **9.43ms**, 2.0s **9.15ms**, 5.0s **432.97ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (FFmpeg long-seek tuning pass 2)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `decode-benchmark` and `playback-benchmark`  
**Change under test:** narrower backtrack window for forward seeks with near-target keyframe preference

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **6.18ms**
- Sequential decode: **403.6 fps**, avg **2.48ms**
- Seek latency: 0.5s **1.78ms**, 1.0s **1.79ms**, 2.0s **7.05ms**, 5.0s **142.01ms**
- Random access: avg **114.64ms**, p95 **351.09ms**, p99 **378.21ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **29.37ms**
- Sequential decode: **105.9 fps**, avg **9.44ms**
- Seek latency: 0.5s **6.50ms**, 1.0s **6.53ms**, 2.0s **11.20ms**, 5.0s **559.44ms**
- Random access: avg **525.90ms**, p95 **1489.77ms**, p99 **1628.36ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.11**
- Decode: avg **1.21ms**, p95 **2.26ms**, p99 **2.35ms**, max **4.11ms**
- Seek samples: 0.5s **11.39ms**, 1.0s **2.75ms**, 2.0s **2.55ms**, 5.0s **138.90ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **1**
- Effective FPS: **60.11**
- Decode: avg **4.76ms**, p95 **7.41ms**, p99 **9.82ms**, max **15.94ms**
- Seek samples: 0.5s **29.80ms**, 1.0s **9.01ms**, 2.0s **8.80ms**, 5.0s **410.35ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (FFmpeg long-seek tuning pass 3)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `decode-benchmark` and `playback-benchmark`  
**Change under test:** seek fallback order adjusted (preferred -> legacy backward -> wide window)

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **5.91ms**
- Sequential decode: **393.7 fps**, avg **2.54ms**
- Seek latency: 0.5s **2.04ms**, 1.0s **1.71ms**, 2.0s **4.61ms**, 5.0s **110.27ms**
- Random access: avg **119.53ms**, p95 **364.02ms**, p99 **404.91ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **29.08ms**
- Sequential decode: **104.1 fps**, avg **9.60ms**
- Seek latency: 0.5s **6.72ms**, 1.0s **6.76ms**, 2.0s **11.48ms**, 5.0s **569.83ms**
- Random access: avg **516.48ms**, p95 **1505.44ms**, p99 **1566.39ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.11**
- Decode: avg **1.27ms**, p95 **2.33ms**, p99 **2.42ms**, max **3.74ms**
- Seek samples: 0.5s **12.01ms**, 1.0s **2.68ms**, 2.0s **2.80ms**, 5.0s **144.54ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.12**
- Decode: avg **4.95ms**, p95 **7.57ms**, p99 **10.04ms**, max **14.18ms**
- Seek samples: 0.5s **30.56ms**, 1.0s **9.45ms**, 2.0s **8.94ms**, 5.0s **430.25ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Startup instrumentation pass)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `playback-benchmark`  
**Change under test:** startup timeline instrumentation for first decoded frame, first rendered frame, and audio callback origin aligned to playback start

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.11**
- Decode: avg **1.28ms**, p95 **2.51ms**, p99 **2.63ms**, max **4.70ms**
- Seek samples: 0.5s **14.63ms**, 1.0s **2.68ms**, 2.0s **2.87ms**, 5.0s **145.33ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **480/480**, failures **0**
- Missed deadlines: **1**
- Effective FPS: **60.11**
- Decode: avg **5.54ms**, p95 **8.09ms**, p99 **11.25ms**, max **15.17ms**
- Seek samples: 0.5s **41.73ms**, 1.0s **9.75ms**, 2.0s **8.98ms**, 5.0s **451.74ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Seek benchmark methodology hardening)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `decode-benchmark` and `playback-benchmark` with `--seek-iterations 10`  
**Change under test:** benchmark seek sampling now uses varied start positions per iteration and reports avg/p95/max tails

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **6.93ms**
- Sequential decode: **393.9 fps**, avg **2.54ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **47.25 / 92.23 / 92.23ms**
  - 1.0s: **69.24 / 144.81 / 144.81ms**
  - 2.0s: **151.47 / 375.69 / 375.69ms**
  - 5.0s: **237.30 / 379.66 / 379.66ms**
- Random access: avg **115.46ms**, p95 **351.75ms**, p99 **386.64ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **30.88ms**
- Sequential decode: **100.4 fps**, avg **9.96ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **195.41 / 369.35 / 369.35ms**
  - 1.0s: **333.83 / 671.86 / 671.86ms**
  - 2.0s: **584.19 / 1421.40 / 1421.40ms**
  - 5.0s: **925.07 / 1474.59 / 1474.59ms**
- Random access: avg **539.69ms**, p95 **1467.07ms**, p99 **1667.76ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.24**
- Decode: avg **1.17ms**, p95 **2.22ms**, p99 **2.61ms**, max **3.71ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **47.74 / 104.77 / 104.77ms**
  - 1.0s: **68.99 / 142.64 / 142.64ms**
  - 2.0s: **155.51 / 367.99 / 367.99ms**
  - 5.0s: **231.63 / 372.21 / 372.21ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.13**
- Decode: avg **5.13ms**, p95 **7.60ms**, p99 **11.15ms**, max **12.78ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **202.75 / 361.23 / 361.23ms**
  - 1.0s: **320.26 / 617.03 / 617.03ms**
  - 2.0s: **589.11 / 1424.54 / 1424.54ms**
  - 5.0s: **926.16 / 1460.47 / 1460.47ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Decoder duplicate-request coalescing)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `decode-benchmark` and `playback-benchmark` with `--seek-iterations 10`  
**Change under test:** FFmpeg decoder request batches now coalesce same-frame requests into a single decode result fan-out

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **6.80ms**
- Sequential decode: **385.6 fps**, avg **2.59ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **46.92 / 89.95 / 89.95ms**
  - 1.0s: **70.08 / 147.40 / 147.40ms**
  - 2.0s: **153.93 / 373.48 / 373.48ms**
  - 5.0s: **251.75 / 419.44 / 419.44ms**
- Random access: avg **125.70ms**, p95 **376.36ms**, p99 **426.63ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **30.79ms**
- Sequential decode: **103.4 fps**, avg **9.67ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **197.39 / 395.30 / 395.30ms**
  - 1.0s: **351.40 / 730.65 / 730.65ms**
  - 2.0s: **613.21 / 1398.75 / 1398.75ms**
  - 5.0s: **900.60 / 1467.33 / 1467.33ms**
- Random access: avg **517.34ms**, p95 **1493.69ms**, p99 **1622.08ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.24**
- Decode: avg **1.21ms**, p95 **2.14ms**, p99 **2.23ms**, max **3.63ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **46.02 / 92.97 / 92.97ms**
  - 1.0s: **68.15 / 142.22 / 142.22ms**
  - 2.0s: **146.18 / 356.46 / 356.46ms**
  - 5.0s: **232.73 / 379.79 / 379.79ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.20**
- Decode: avg **4.81ms**, p95 **7.59ms**, p99 **12.31ms**, max **13.54ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **201.18 / 362.15 / 362.15ms**
  - 1.0s: **332.09 / 662.63 / 662.63ms**
  - 2.0s: **584.79 / 1411.56 / 1411.56ms**
  - 5.0s: **1012.17 / 1722.61 / 1722.61ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Duplicate burst metric stabilization)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `decode-benchmark --seek-iterations 10`  
**Change under test:** duplicate-request burst benchmark now includes warmup seek to remove first-request cold-start distortion

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **7.31ms**
- Sequential decode: **392.4 fps**, avg **2.55ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **45.99 / 87.99 / 87.99ms**
  - 1.0s: **69.52 / 146.76 / 146.76ms**
  - 2.0s: **148.12 / 359.00 / 359.00ms**
  - 5.0s: **231.81 / 375.66 / 375.66ms**
- Random access: avg **115.46ms**, p95 **352.45ms**, p99 **378.86ms**
- Duplicate burst batch avg / p95:
  - burst 4: **3.68 / 3.84ms**
  - burst 8: **3.68 / 3.74ms**
  - burst 16: **2.33 / 3.69ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **30.03ms**
- Sequential decode: **94.3 fps**, avg **10.61ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **188.28 / 356.06 / 356.06ms**
  - 1.0s: **337.66 / 681.87 / 681.87ms**
  - 2.0s: **635.27 / 1455.41 / 1455.41ms**
  - 5.0s: **922.75 / 1510.31 / 1510.31ms**
- Random access: avg **527.08ms**, p95 **1481.91ms**, p99 **1649.11ms**
- Duplicate burst batch avg / p95:
  - burst 4: **21.25 / 21.98ms**
  - burst 8: **21.76 / 21.95ms**
  - burst 16: **16.89 / 21.72ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Scrub burst queue stress baseline)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Command:** `scrub-benchmark --bursts 20 --burst-size 12 --sweep-seconds 2.0`  
**Goal:** measure latest-request latency under rapid scrub-like request bursts

#### Scrub Burst Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **217.97ms**, p95 **434.83ms**, p99 **455.72ms**, max **461.85ms**
- Last-request-in-burst latency: avg **312.50ms**, p95 **455.72ms**, p99 **461.85ms**, max **461.85ms**

#### Scrub Burst Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **1071.64ms**, p95 **2098.98ms**, p99 **2204.29ms**, max **2204.29ms**
- Last-request-in-burst latency: avg **1524.00ms**, p95 **2116.35ms**, p99 **2204.29ms**, max **2204.29ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Scrub supersession heuristic pass)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark`, `decode-benchmark`, `playback-benchmark`  
**Change under test:** decoder batch supersession for large-span burst queues (keeps newest request as primary target)

#### Scrub Burst Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **204.53ms**, p95 **452.60ms**, p99 **622.10ms**, max **622.10ms**
- Last-request-in-burst latency: avg **221.18ms**, p95 **528.20ms**, p99 **622.09ms**, max **622.09ms**

#### Scrub Burst Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **833.64ms**, p95 **1888.52ms**, p99 **1941.42ms**, max **1954.14ms**
- Last-request-in-burst latency: avg **869.99ms**, p95 **1941.42ms**, p99 **1954.14ms**, max **1954.14ms**

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **7.45ms**
- Sequential decode: **389.5 fps**, avg **2.57ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **47.39 / 87.98 / 87.98ms**
  - 1.0s: **70.93 / 147.39 / 147.39ms**
  - 2.0s: **149.20 / 359.46 / 359.46ms**
  - 5.0s: **238.28 / 400.59 / 400.59ms**
- Random access: avg **115.15ms**, p95 **355.59ms**, p99 **371.61ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **30.67ms**
- Sequential decode: **98.4 fps**, avg **10.16ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **191.23 / 344.32 / 344.32ms**
  - 1.0s: **320.28 / 634.08 / 634.08ms**
  - 2.0s: **577.92 / 1399.73 / 1399.73ms**
  - 5.0s: **992.08 / 1635.12 / 1635.12ms**
- Random access: avg **500.44ms**, p95 **1480.01ms**, p99 **1531.96ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.23**
- Decode: avg **1.41ms**, p95 **2.51ms**, p99 **2.57ms**, max **4.27ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **1**
- Effective FPS: **60.16**
- Decode: avg **6.40ms**, p95 **8.65ms**, p99 **13.10ms**, max **18.91ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Scrub supersession pass 2: resolution-gated)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark`, `decode-benchmark`, `playback-benchmark`  
**Change under test:** supersession heuristic enabled only for higher-resolution streams (`>= 2560x1440`)

#### Scrub Burst Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **206.84ms**, p95 **409.20ms**, p99 **424.00ms**, max **436.97ms**
- Last-request-in-burst latency: avg **297.67ms**, p95 **427.05ms**, p99 **436.97ms**, max **436.97ms**

#### Scrub Burst Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **820.24ms**, p95 **1689.13ms**, p99 **1828.91ms**, max **1828.91ms**
- Last-request-in-burst latency: avg **863.94ms**, p95 **1689.13ms**, p99 **1828.91ms**, max **1828.91ms**

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **6.69ms**
- Sequential decode: **414.7 fps**, avg **2.41ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **45.48 / 89.37 / 89.37ms**
  - 1.0s: **69.15 / 144.09 / 144.09ms**
  - 2.0s: **148.41 / 358.91 / 358.91ms**
  - 5.0s: **231.79 / 377.04 / 377.04ms**
- Random access: avg **116.19ms**, p95 **350.22ms**, p99 **379.83ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **29.79ms**
- Sequential decode: **105.4 fps**, avg **9.49ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **189.31 / 354.05 / 354.05ms**
  - 1.0s: **336.64 / 710.24 / 710.24ms**
  - 2.0s: **589.34 / 1393.35 / 1393.35ms**
  - 5.0s: **898.27 / 1479.23 / 1479.23ms**
- Random access: avg **511.68ms**, p95 **1497.14ms**, p99 **1611.62ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.23**
- Decode: avg **1.20ms**, p95 **2.13ms**, p99 **3.09ms**, max **4.08ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.19**
- Decode: avg **4.99ms**, p95 **7.17ms**, p99 **9.64ms**, max **13.37ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Scrub supersession runtime controls)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark`, `decode-benchmark`, `playback-benchmark`  
**Change under test:** FFmpeg scrub supersession thresholds moved to env-configurable runtime controls

#### Scrub Burst Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **211.38ms**, p95 **417.65ms**, p99 **435.23ms**, max **454.51ms**
- Last-request-in-burst latency: avg **303.76ms**, p95 **435.23ms**, p99 **454.51ms**, max **454.51ms**

#### Scrub Burst Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Requests: **240 success / 0 failures**
- All-request latency: avg **812.11ms**, p95 **1767.50ms**, p99 **1822.52ms**, max **1822.52ms**
- Last-request-in-burst latency: avg **820.99ms**, p95 **1767.50ms**, p99 **1822.52ms**, max **1822.52ms**

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **6.64ms**
- Sequential decode: **335.5 fps**, avg **2.98ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **48.41 / 96.68 / 96.68ms**
  - 1.0s: **71.81 / 151.73 / 151.73ms**
  - 2.0s: **152.21 / 372.41 / 372.41ms**
  - 5.0s: **233.93 / 388.51 / 388.51ms**
- Random access: avg **115.07ms**, p95 **354.67ms**, p99 **399.31ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **32.18ms**
- Sequential decode: **98.7 fps**, avg **10.13ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **201.24 / 387.51 / 387.51ms**
  - 1.0s: **347.03 / 774.83 / 774.83ms**
  - 2.0s: **623.25 / 1499.39 / 1499.39ms**
  - 5.0s: **961.84 / 1629.35 / 1629.35ms**
- Random access: avg **524.19ms**, p95 **1485.61ms**, p99 **1619.96ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.22**
- Decode: avg **1.33ms**, p95 **2.49ms**, p99 **2.80ms**, max **3.90ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **2**
- Effective FPS: **60.17**
- Decode: avg **6.43ms**, p95 **8.82ms**, p99 **14.14ms**, max **17.52ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Scrub multi-run aggregation support)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Command:** `scrub-benchmark --bursts 10 --burst-size 12 --sweep-seconds 2.0 --runs 3`  
**Change under test:** scrub benchmark now supports repeated runs with median aggregation

#### Scrub Burst Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Runs: **3**, requests: **360 success / 0 failures**
- Per-run last-request averages: **303.69ms**, **284.95ms**, **310.89ms**
- Median all-request latency: avg **210.56ms**, p95 **429.62ms**, p99 **442.55ms**, max **457.71ms**
- Median last-request latency: avg **303.69ms**, p95 **457.71ms**, p99 **457.71ms**, max **457.71ms**

#### Scrub Burst Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Runs: **3**, requests: **360 success / 0 failures**
- Per-run last-request averages: **963.69ms**, **887.58ms**, **1001.96ms**
- Median all-request latency: avg **957.47ms**, p95 **2087.13ms**, p99 **2087.15ms**, max **2087.15ms**
- Median last-request latency: avg **963.69ms**, p95 **2087.13ms**, p99 **2087.13ms**, max **2087.13ms**

### Benchmark Run: 2026-02-14 00:00:00 UTC (Supersession default span set to 25)

**Environment:** Linux runner with synthetic 1080p60 and 4k60 MP4 assets  
**Commands:** `scrub-benchmark --runs 3`, `decode-benchmark --seek-iterations 10`, `playback-benchmark --seek-iterations 10`  
**Change under test:** default supersession span threshold reduced from 45 to 25 frames

#### Scrub Burst Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Runs: **3**, requests: **360 success / 0 failures**
- Per-run last-request averages: **304.93ms**, **294.07ms**, **293.85ms**
- Median all-request latency: avg **202.60ms**, p95 **425.68ms**, p99 **450.24ms**, max **455.69ms**
- Median last-request latency: avg **294.07ms**, p95 **455.69ms**, p99 **455.69ms**, max **455.69ms**

#### Scrub Burst Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Runs: **3**, requests: **360 success / 0 failures**
- Per-run last-request averages: **1008.68ms**, **808.71ms**, **805.92ms**
- Median all-request latency: avg **804.50ms**, p95 **1694.01ms**, p99 **1694.02ms**, max **1694.02ms**
- Median last-request latency: avg **808.71ms**, p95 **1694.01ms**, p99 **1694.01ms**, max **1694.01ms**

#### Decode Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Decoder init: **7.32ms**
- Sequential decode: **375.7 fps**, avg **2.66ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **47.99 / 96.34 / 96.34ms**
  - 1.0s: **69.90 / 147.03 / 147.03ms**
  - 2.0s: **152.95 / 364.03 / 364.03ms**
  - 5.0s: **236.14 / 385.37 / 385.37ms**
- Random access: avg **117.85ms**, p95 **367.79ms**, p99 **376.78ms**

#### Decode Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Decoder init: **35.38ms**
- Sequential decode: **95.5 fps**, avg **10.47ms**
- Seek latency (avg / p95 / max):
  - 0.5s: **201.57 / 395.76 / 395.76ms**
  - 1.0s: **323.73 / 627.27 / 627.27ms**
  - 2.0s: **607.72 / 1500.76 / 1500.76ms**
  - 5.0s: **932.14 / 1463.20 / 1463.20ms**
- Random access: avg **539.60ms**, p95 **1516.95ms**, p99 **1707.36ms**

#### Playback Throughput Benchmark — 1080p60 (`/tmp/cap-bench-1080p60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Missed deadlines: **0**
- Effective FPS: **60.22**
- Decode: avg **1.40ms**, p95 **2.51ms**, p99 **2.89ms**, max **4.27ms**

#### Playback Throughput Benchmark — 4k60 (`/tmp/cap-bench-4k60.mp4`)
- Target: **60 fps**, budget **16.67ms**
- Decoded: **240/240**, failures **0**
- Effective FPS: **60.18**
- Decode: avg **5.02ms**, p95 **7.18ms**, p99 **11.55ms**, max **15.85ms**

<!-- PLAYBACK_BENCHMARK_RESULTS_END -->

---

## Detailed Metric Definitions

### Decoder Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| **Init Time** | Time to create and initialize decoder | `spawn_decoder()` latency |
| **Decoder Type** | Backend used (AVAssetReader, FFmpeg, MediaFoundation) | Reported by decoder |
| **Hardware Accel** | Whether GPU decoding is active | Decoder capability check |
| **Fallback Reason** | Why software decoding was used (if applicable) | Decoder error chain |

### Playback Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| **Frames Decoded** | Successfully retrieved frames | Count of non-None results |
| **Failed Frames** | Frames that failed to decode | Count of None results |
| **Avg Decode Time** | Mean frame retrieval latency | Avg of all frame times |
| **Min/Max Decode Time** | Latency range | Min/max of frame times |
| **P50/P95/P99** | Latency percentiles | Sorted distribution |
| **Effective FPS** | Actual decode throughput | frames / elapsed_time |
| **Jitter** | Decode time variance (std dev) | sqrt(variance) |

### Audio Sync Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| **Mic Duration** | Total mic audio length | sample_count / sample_rate |
| **System Audio Duration** | Total system audio length | sample_count / sample_rate |
| **Video Duration** | Total video length | FFmpeg duration query |
| **Mic-Video Diff** | Audio/video duration mismatch | |mic_duration - video_duration| |
| **System-Video Diff** | System audio/video mismatch | |sys_duration - video_duration| |
| **Detected Sync Offset** | Cross-correlation sync analysis | SyncAnalyzer result |
| **Sync Confidence** | Reliability of sync detection | 0.0 - 1.0 score |

### Camera Sync Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| **Camera Start Time** | Recorded start timestamp | Metadata |
| **Display Start Time** | Display recording start | Metadata |
| **Drift** | Camera vs display timing offset | |camera_start - display_start| |
| **Camera Frame Count** | Frames decoded from camera | Test loop count |
| **Display Frame Count** | Frames decoded from display | Test loop count |

---

## Analysis Guidelines

When analyzing benchmark results, focus on:

1. **Hardware Acceleration**: Verify decoder is using GPU when available
2. **Latency Spikes**: Check P95/P99 for outlier decode times
3. **Format Comparison**: Compare MP4 vs fragmented performance
4. **A/V Sync Drift**: Identify recordings with sync issues
5. **Regression Detection**: Compare against historical baselines

### Common Issues & Solutions

| Issue | Possible Causes | Investigation Steps |
|-------|-----------------|---------------------|
| High Init Time | Codec probe delay, HW init | Check decoder type, try software fallback |
| Low Effective FPS | Slow decode, I/O bound | Profile decode times, check disk speed |
| High Jitter | Thread contention, GC | Check system load, memory pressure |
| A/V Sync Drift | Timestamp mismatch, sample rate | Verify audio metadata, check recording |
| Camera Drift | Start time alignment | Check segment start_time values |
| Decoder Fallback | Missing codec, HW unavailable | Check codec support, permissions |

### Resolution-Specific Expectations

| Resolution | Target Decode (p95) | Notes |
|------------|---------------------|-------|
| 1080p (1920x1080) | <30ms | Standard target |
| 1440p (2560x1440) | <40ms | High DPI displays |
| 4K (3840x2160) | <60ms | May need HW accel |
| 5K (5120x2880) | <80ms | Apple displays |

---

## Decoder Implementation Details

### macOS (AVAssetReader)

- Primary decoder using VideoToolbox hardware acceleration
- Automatic fallback to FFmpeg for unsupported formats
- Best performance for H.264/HEVC on Apple Silicon

### Windows (MediaFoundation)

- Primary decoder using DXVA2/D3D11 hardware acceleration
- Automatic fallback to FFmpeg for unsupported formats
- Best performance for H.264/HEVC with compatible GPU

### FFmpeg (Software Fallback)

- Cross-platform software decoding
- Supports widest format range
- Used when hardware acceleration unavailable or fails

---

## Related Documentation

- [Recording Benchmarks](../recording/BENCHMARKS.md) - Recording performance tracking
- [cap-rendering/decoder](../rendering/src/decoder.rs) - Decoder implementation
- [cap-video-decode](../video-decode/) - Platform-specific decoders
