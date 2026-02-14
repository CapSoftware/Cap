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

#### Playback Startup Latency Report (log analysis)

```bash
# Capture startup traces from desktop editor playback sessions
CAP_PLAYBACK_STARTUP_TRACE_FILE=/tmp/playback-startup.csv pnpm dev:desktop

# Parse startup timing logs captured from desktop editor sessions
cargo run -p cap-editor --example playback-startup-report -- --log /path/to/editor.log

# Aggregate multiple session logs
cargo run -p cap-editor --example playback-startup-report -- --log /path/to/macos.log --log /path/to/windows.log
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
