# Cap Playback Benchmark Results

This document tracks performance benchmarks for Cap's playback and decoding system over time. Each benchmark run is timestamped, enabling comparison across different versions, configurations, and hardware.

## Quick Reference

### Performance Targets

| Metric | Target | Tolerance |
|--------|--------|-----------|
| Decoder Init | <200ms | - |
| Decode Latency (p95) | <50ms | - |
| Startup to First Frame | <250ms | configurable |
| Effective FPS | ≥30 fps | ±2 fps |
| Decode Jitter | <10ms | - |
| Scrub Seek Latency (p95) | <40ms | - |
| A/V Sync (mic↔video) | <100ms | - |
| A/V Sync (system↔video) | <100ms | - |
| Camera-Display Drift | <100ms | - |

### Test Categories

- **Decoder Tests**: Init time, hardware acceleration detection, fallback handling
- **Playback Tests**: Sequential decode, frame retrieval, latency percentiles
- **Scrub Tests**: Random access seek decode latency and seek failure rate
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
cargo run -p cap-recording --example playback-test-runner -- full --startup-threshold-ms 250

# Run specific test categories
cargo run -p cap-recording --example playback-test-runner -- decoder
cargo run -p cap-recording --example playback-test-runner -- playback
cargo run -p cap-recording --example playback-test-runner -- scrub
cargo run -p cap-recording --example playback-test-runner -- audio-sync
cargo run -p cap-recording --example playback-test-runner -- camera-sync

# Test a specific recording
cargo run -p cap-recording --example playback-test-runner -- --recording-path /path/to/recording full

# List available recordings
cargo run -p cap-recording --example playback-test-runner -- list

# Emit machine-readable JSON report
cargo run -p cap-recording --example playback-test-runner -- full --json-output /tmp/playback-benchmark.json
```

Aggregate JSON outputs from multiple machines:

```bash
node scripts/aggregate-playback-benchmarks.js --input /path/to/json-results --output /tmp/playback-benchmark-aggregate.md
node scripts/build-playback-matrix-report.js --input /path/to/json-results --output /tmp/playback-matrix-status.md
```

Validate matrix coverage and required formats:

```bash
node scripts/validate-playback-matrix.js --input /path/to/json-results --require-formats mp4,fragmented
node scripts/validate-playback-matrix.js --input /path/to/json-results --require-formats mp4,fragmented --output-json /tmp/playback-matrix-validation.json

# Finalize aggregate + status + validation artifacts
node scripts/finalize-playback-matrix.js --input /path/to/json-results --output-dir /tmp/playback-matrix-final --require-formats mp4,fragmented
node scripts/finalize-playback-matrix.js --input /path/to/json-results --output-dir /tmp/playback-matrix-final --require-formats mp4,fragmented --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250
node scripts/finalize-playback-matrix.js --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --allow-fps-drop 2 --allow-startup-increase-ms 25 --allow-scrub-p95-increase-ms 5
node scripts/finalize-playback-matrix.js --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --allow-missing-candidate
node scripts/finalize-playback-matrix.js --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --fail-on-candidate-only
node scripts/finalize-playback-matrix.js --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --min-samples-per-row 3
node scripts/finalize-playback-matrix.js --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --fail-on-parse-errors
node scripts/finalize-playback-matrix.js --input /path/to/candidate-results --output-dir /tmp/playback-matrix-final --compare-baseline /path/to/baseline-results --fail-on-zero-compared
node scripts/finalize-playback-matrix.js --input /path/to/json-results --output-dir /tmp/playback-matrix-final --output-json /tmp/playback-matrix-final/playback-finalize-summary.json
node scripts/finalize-playback-matrix.js --input /path/to/json-results --output-dir /tmp/playback-matrix-final --require-formats mp4,fragmented --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250 --publish-target /workspace/crates/editor/PLAYBACK-BENCHMARKS.md

Finalize summary JSON includes generated timestamp, artifact paths, settings, pass/fail flags, and git branch/commit metadata when available.
Finalize summary JSON also carries comparison failure reasons and gate outcomes when comparison is enabled.
Finalize summary JSON includes comparison file stats (including parse error counts) when comparison is enabled.
Finalize summary JSON includes comparison summary counts (compared rows, regressions, missing/candidate-only/insufficient-sample counts) when comparison is enabled.

# Publish matrix artifacts into this benchmark history
node scripts/publish-playback-matrix-summary.js --aggregate-md /tmp/playback-matrix-final/playback-benchmark-aggregate.md --status-md /tmp/playback-matrix-final/playback-matrix-status.md --validation-json /tmp/playback-matrix-final/playback-matrix-validation.json --bottlenecks-md /tmp/playback-matrix-final/playback-bottlenecks.md
node scripts/publish-playback-matrix-summary.js --aggregate-md /tmp/playback-matrix-final/playback-benchmark-aggregate.md --status-md /tmp/playback-matrix-final/playback-matrix-status.md --validation-json /tmp/playback-matrix-final/playback-matrix-validation.json --comparison-md /tmp/playback-matrix-final/playback-comparison.md --comparison-json /tmp/playback-matrix-final/playback-comparison.json
node scripts/publish-playback-matrix-summary.js --aggregate-md /tmp/playback-matrix-final/playback-benchmark-aggregate.md --status-md /tmp/playback-matrix-final/playback-matrix-status.md --validation-json /tmp/playback-matrix-final/playback-matrix-validation.json --finalize-summary-json /tmp/playback-matrix-final/playback-finalize-summary.json

# Analyze bottlenecks from matrix results
node scripts/analyze-playback-matrix-bottlenecks.js --input /path/to/json-results --output /tmp/playback-bottlenecks.md --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250
node scripts/analyze-playback-matrix-bottlenecks.js --input /path/to/json-results --output /tmp/playback-bottlenecks.md --output-json /tmp/playback-bottlenecks.json --target-fps 60 --max-scrub-p95-ms 40 --max-startup-ms 250

# Compare candidate against baseline and flag regressions
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results --candidate /path/to/candidate-results --output /tmp/playback-comparison.md --allow-fps-drop 2 --allow-startup-increase-ms 25 --allow-scrub-p95-increase-ms 5
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results-a --baseline /path/to/baseline-results-b --candidate /path/to/candidate-results-a --candidate /path/to/candidate-results-b --output /tmp/playback-comparison.md
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results --candidate /path/to/candidate-results --allow-missing-candidate
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results --candidate /path/to/candidate-results --fail-on-candidate-only
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results --candidate /path/to/candidate-results --min-samples-per-row 3
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results --candidate /path/to/candidate-results --fail-on-parse-errors
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results --candidate /path/to/candidate-results --fail-on-zero-compared
node scripts/compare-playback-benchmark-runs.js --baseline /path/to/baseline-results --candidate /path/to/candidate-results --output /tmp/playback-comparison.md --output-json /tmp/playback-comparison.json

Comparison output reports both baseline rows missing in candidate and candidate-only rows not present in baseline.
Comparison table also reports baseline/candidate run counts per row when multiple JSON inputs contribute to the same key.
Comparison JSON summary includes `failureReasons` and `gateOutcomes` fields for automation-friendly gate diagnostics.
Minimum sample gating is applied against metrics that are actually comparable for the row (for example, scrub samples are not required for rows with no scrub metric comparison).
Comparison JSON also includes baseline/candidate file parsing stats and optional parse-error gating support.
```

#### Decode Performance Benchmark

```bash
# Benchmark decode performance on a video file
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/video.mp4

# With custom FPS and iterations
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/video.mp4 --fps 60 --iterations 50

# Emit machine-readable JSON with startup/scrub metrics
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/video.mp4 --fps 60 --sequential-frames 180 --random-samples 120 --output-json /tmp/decode-benchmark.json

# Fragmented segment input is supported by passing the display directory
cargo run -p cap-editor --example decode-benchmark -- --video /path/to/segment/display --fps 60 --output-json /tmp/decode-benchmark-fragmented.json
```

#### Combined Workflow (Recording → Playback)

```bash
# Step 1: Create test recordings with outputs kept
cargo run -p cap-recording --example real-device-test-runner -- full --keep-outputs

# Step 2: Validate playback of those recordings
cargo run -p cap-recording --example playback-test-runner -- full
```

### Cross-Platform Validation Matrix

Run these scenarios on each required hardware class and append outputs via `--benchmark-output`.

```bash
cargo run -p cap-recording --example playback-test-runner -- full --fps 60 --benchmark-output --notes "platform=<platform> gpu=<gpu> scenario=full"
cargo run -p cap-recording --example playback-test-runner -- scrub --fps 60 --benchmark-output --notes "platform=<platform> gpu=<gpu> scenario=scrub"
```

Automated helper for machine runs:

```bash
node scripts/run-playback-benchmark-matrix.js --platform macos-13 --gpu apple-silicon --output-dir /tmp/playback-matrix --fps 60 --startup-threshold-ms 250 --input-dir /tmp/cap-real-device-tests
node scripts/run-playback-benchmark-matrix.js --platform windows-11 --gpu nvidia-discrete --output-dir /tmp/playback-matrix-windows-nvidia --fps 60 --startup-threshold-ms 250 --require-formats mp4,fragmented --input-dir /tmp/cap-real-device-tests
node scripts/run-playback-benchmark-matrix.js --platform windows-11 --gpu integrated --output-dir /tmp/playback-matrix-windows-integrated --fps 60 --startup-threshold-ms 250 --scenarios scrub --input-dir /tmp/cap-real-device-tests
```

| Platform | GPU Class | MP4 Full | Fragmented Full | MP4 Scrub | Fragmented Scrub | Notes |
|----------|-----------|----------|-----------------|-----------|------------------|-------|
| macOS 13+ | Apple Silicon | ☐ | ☐ | ☐ | ☐ | |
| Windows 11 | NVIDIA discrete | ☐ | ☐ | ☐ | ☐ | |
| Windows 11 | AMD discrete | ☐ | ☐ | ☐ | ☐ | |
| Windows 11 | Integrated baseline | ☐ | ☐ | ☐ | ☐ | |

---

## Benchmark History

<!-- PLAYBACK_BENCHMARK_RESULTS_START -->

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
| **First Decode** | Decode latency for first successful frame | elapsed from first frame request |
| **Startup to First** | Time from playback test start to first decoded frame | elapsed since playback test start |

### Scrub Metrics

| Metric | Description | How Measured |
|--------|-------------|--------------|
| **Seek Operations** | Total random seek attempts | Fixed operation count per segment |
| **Successful Seeks** | Seeks returning a decoded frame | Count of non-None seek decodes |
| **Failed Seeks** | Seeks returning no frame | Count of None seek decodes |
| **Avg Seek Time** | Mean random seek decode latency | Avg of seek decode times |
| **P50/P95/P99 Seek** | Seek latency percentiles | Sorted seek time distribution |
| **Max Seek Time** | Worst seek decode latency | Max of seek decode times |

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
- [Playback Matrix Runbook](./PLAYBACK-MATRIX-RUNBOOK.md) - Cross-platform evidence collection workflow
- [cap-rendering/decoder](../rendering/src/decoder.rs) - Decoder implementation
- [cap-video-decode](../video-decode/) - Platform-specific decoders
