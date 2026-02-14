# Cap Playback Performance Findings

> **SELF-HEALING DOCUMENT**: This file is designed to maintain complete context for playback performance work. After any work session, UPDATE this file with your findings before ending.

---

## Quick Start (Read This First)

**When your context resets, do this:**

1. Read this file completely
2. Read `PLAYBACK-BENCHMARKS.md` for latest raw test data
3. Ensure test recordings exist (or create them):
   ```bash
   # Check for existing recordings
   ls /tmp/cap-real-device-tests/

   # If none exist, create them first:
   cargo run -p cap-recording --example real-device-test-runner -- baseline --keep-outputs
   ```
4. Run a quick playback benchmark to verify current state:
   ```bash
   cargo run -p cap-recording --example playback-test-runner -- full
   ```
5. Continue work from "Next Steps" section below

**After completing work, UPDATE these sections:**
- [ ] Current Status table (if metrics changed)
- [ ] Root Cause Analysis (if new issues found)
- [ ] Fix Progress (if fixes implemented)
- [ ] Next Steps (mark completed, add new)
- [ ] Session Notes (add your session)

---

## Current Status

**Last Updated**: 2026-01-30

### Performance Summary

| Metric | Target | MP4 Mode | Fragmented Mode | Status |
|--------|--------|----------|-----------------|--------|
| Decoder Init (display) | <200ms | 337ms* | TBD | 🟡 Note |
| Decoder Init (camera) | <200ms | 23ms | TBD | ✅ Pass |
| Decode Latency (p95) | <50ms | 3.1ms | TBD | ✅ Pass |
| Effective FPS | ≥30 fps | 549 fps | TBD | ✅ Pass |
| Decode Jitter | <10ms | ~1ms | TBD | ✅ Pass |
| A/V Sync (mic↔video) | <100ms | 77ms | TBD | ✅ Pass |
| A/V Sync (system↔video) | <100ms | 162ms | TBD | 🟡 Known |
| Camera-Display Drift | <100ms | 0ms | TBD | ✅ Pass |

*Display decoder init time includes multi-position pool initialization (3 decoder instances)

### What's Working
- ✅ Playback test infrastructure in place
- ✅ Uses recordings from real-device-test-runner
- ✅ Hardware-accelerated decoding on macOS (AVAssetReader)
- ✅ Excellent decode performance (549 fps effective, 1.8ms avg latency)
- ✅ Multi-position decoder pool for smooth scrubbing
- ✅ Mic audio sync within tolerance
- ✅ Camera-display sync perfect (0ms drift)

### Known Issues (Lower Priority)
1. **System audio timing**: ~162ms difference inherited from recording-side timing issue
2. **Display decoder init time**: 337ms due to multi-position pool (creates 3 decoders)

---

## Next Steps

### Active Work Items
*(Update this section as you work)*

- [ ] **Capture audio startup latency before/after** - Use new playback log metrics (`Audio streaming callback started`) to validate startup on macOS/Windows
- [ ] **Tune medium/long seek latency** - Reduce 2s+ seek spikes visible in decode and playback benchmarks
- [ ] **Run full desktop editor validation on macOS + Windows** - Confirm in-app FPS and A/V behavior on target platforms

### Completed
- [x] **Run initial baseline** - Established current playback performance metrics (2026-01-28)
- [x] **Profile decoder init time** - Hardware acceleration confirmed (AVAssetReader) (2026-01-28)
- [x] **Identify latency hotspots** - No issues found, p95=3.1ms (2026-01-28)
- [x] **Add Linux-compatible benchmark fallback path** - Added `cap-editor` playback benchmark example and supporting linux compile fallbacks (2026-02-14)

---

## Benchmarking Commands

```bash
# Full playback validation (RECOMMENDED)
cargo run -p cap-recording --example playback-test-runner -- full

# Test specific categories
cargo run -p cap-recording --example playback-test-runner -- decoder
cargo run -p cap-recording --example playback-test-runner -- playback
cargo run -p cap-recording --example playback-test-runner -- audio-sync
cargo run -p cap-recording --example playback-test-runner -- camera-sync

# List available recordings
cargo run -p cap-recording --example playback-test-runner -- list

# Test a specific recording
cargo run -p cap-recording --example playback-test-runner -- --recording-path /path/to/recording full

# Save benchmark results to PLAYBACK-BENCHMARKS.md
cargo run -p cap-recording --example playback-test-runner -- full --benchmark-output

# Combined workflow: record then playback
cargo run -p cap-recording --example real-device-test-runner -- baseline --keep-outputs && \
cargo run -p cap-recording --example playback-test-runner -- full

# Linux-compatible playback throughput benchmark
cargo run -p cap-editor --example playback-benchmark -- --video /path/to/video.mp4 --fps 60 --max-frames 600
```

**Note**: Playback tests require recordings to exist. Run the recording test runner with `--keep-outputs` first.

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `crates/rendering/src/decoder.rs` | Main decoder interface, spawn_decoder() |
| `crates/video-decode/src/` | Platform-specific decoders |
| `crates/video-decode/src/macos.rs` | AVAssetReader hardware decoder |
| `crates/video-decode/src/ffmpeg.rs` | FFmpeg software fallback |
| `crates/audio/src/lib.rs` | AudioData loading and sync analysis |
| `crates/recording/examples/playback-test-runner.rs` | Playback benchmark runner |
| `crates/editor/examples/playback-benchmark.rs` | Linux-compatible playback throughput benchmark |

---

## Completed Fixes

*(Document fixes here as they are implemented)*

---

## Root Cause Analysis Archive

*(Document investigated issues here)*

---

## Architecture Overview

```
Recording Files (from real-device-test-runner)
├── baseline_mp4/
│   └── content/segments/segment-0/
│       ├── display.mp4        ─┐
│       ├── camera.mp4          ├── Decoder tests
│       ├── audio-input.ogg    ─┼── Audio sync tests
│       └── system_audio.ogg   ─┘
│
└── baseline_fragmented/
    └── content/segments/segment-0/
        ├── display/           ─┐
        │   ├── init.mp4        │  Fragmented decoder
        │   └── segment_*.m4s   │  (combines init + segments)
        ├── camera/            ─┘
        ├── audio-input.m4a    ─┬── Audio sync tests
        └── system_audio.m4a   ─┘

Decoder Pipeline:
┌─────────────────────────────────────────────────────────────────┐
│ spawn_decoder()                                                  │
│   ├── macOS: AVAssetReader (VideoToolbox HW accel)              │
│   ├── Windows: MediaFoundation (DXVA2/D3D11 HW accel)           │
│   └── Fallback: FFmpeg software decoder                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Session Notes

> **IMPORTANT**: Add a new session entry whenever you work on playback performance.
> This maintains context for future sessions.

---

### Session Template (Copy This)

```
### Session YYYY-MM-DD (Brief Description)

**Goal**: What you set out to do

**What was done**:
1. Step 1
2. Step 2
3. ...

**Changes Made**:
- File: description of change

**Results**:
- ✅ What worked
- ❌ What didn't work

**Stopping point**: Where you left off, what to do next
```

---

### Session 2026-01-28 (Initial Baseline - MP4)

**Goal**: Establish initial playback performance baseline

**What was done**:
1. Created PLAYBACK-FINDINGS.md (self-healing document)
2. Created /performance-playback skill
3. Verified test recordings exist from recording benchmarks
4. Ran full playback validation on MP4 recording

**Changes Made**:
- Created `crates/editor/PLAYBACK-FINDINGS.md`
- Created `.claude/skills/performance-playback/SKILL.md`

**Results**:
- ✅ Decoder: AVAssetReader hardware acceleration working
- ✅ Display: 4096x1152, init=337ms (multi-decoder pool)
- ✅ Camera: 1920x1080, init=23ms
- ✅ Playback: 549 fps effective, avg=1.8ms, p95=3.1ms, p99=4.4ms
- ✅ Mic sync: 77ms diff (within 100ms target)
- ✅ Camera sync: 0ms drift (perfect)
- 🟡 System audio: 162ms diff (inherited from recording)

**Stopping point**: MP4 baseline established. Need to test fragmented mode next.

---

### Session 2026-01-28 (Performance Check - Healthy)

**Goal**: Verify current playback performance against targets

**What was done**:
1. Read PLAYBACK-FINDINGS.md and PLAYBACK-BENCHMARKS.md for context
2. Created fragmented baseline recording
3. Ran full playback validation tests
4. Analyzed results against performance targets

**Changes Made**:
- None - performance is healthy

**Results** (Fragmented Mode):
- ✅ Decoder: FFmpeg (hardware) with VideoToolbox HW acceleration
- ✅ Display decoder init: 139ms (target <200ms)
- ✅ Camera decoder init: 19ms (target <200ms)
- ✅ Effective FPS: 278 fps (target ≥60 fps)
- ✅ Decode latency avg: 3.6ms, p95: 3.2ms, p99: 135ms (target p95 <50ms)
- ✅ Mic audio sync: 8ms diff (target <100ms)
- ✅ System audio sync: 99ms diff (target <100ms)
- ✅ Camera-display drift: 0ms (target <100ms)

**Notes**:
- AVAssetReader fails on fragmented recordings (directory path), falls back to FFmpeg
- FFmpeg with VideoToolbox provides excellent hardware-accelerated decoding
- All playback metrics well within targets

**Stopping point**: All metrics healthy. No action required.

---

### Session 2026-01-30 (Performance Check - Healthy)

**Goal**: Verify current playback performance against targets

**What was done**:
1. Read PLAYBACK-FINDINGS.md and PLAYBACK-BENCHMARKS.md for context
2. Verified test recordings exist from recording benchmark run
3. Ran full playback validation tests twice
4. Analyzed results against performance targets

**Changes Made**:
- None - performance is healthy

**Results** (MP4 Mode):
- ✅ Decoder: AVAssetReader (hardware) with VideoToolbox HW acceleration
- ✅ Display decoder init: 320-354ms (multi-position pool with 3 decoders)
- ✅ Camera decoder init: 35ms (target <200ms)
- ✅ Effective FPS: 334-337 fps (target ≥60 fps)
- ✅ Decode latency: avg=3.0ms, p95=5.1ms, p99=79-81ms (target p95 <50ms)
- ✅ Mic audio sync: 81.7ms diff (target <100ms)
- ✅ Camera-display drift: 0ms (target <100ms)
- 🟡 System audio sync: 186.7ms diff (known issue, inherited from recording)

**Analysis**:
- Playback decoder performance is excellent (334-337 fps effective, 5.1ms p95 latency)
- Hardware acceleration (VideoToolbox) confirmed working
- All core sync metrics pass targets
- System audio timing issue is recording-side, not playback-side

**Stopping point**: All metrics healthy. No action required.

---

### Session 2026-01-30 (Fix Frame Rate Bottleneck - CPU→GPU RGBA)

**Goal**: Fix editor playback only achieving ~40-50fps instead of 60fps

**What was done**:
1. Analyzed the full playback pipeline: Rust decoder → GPU render → readback → WebSocket → JavaScript → display
2. Identified bottleneck: `convert_to_nv12()` in `frame_ws.rs` doing per-pixel CPU color conversion (~6M pixels/frame)
3. Implemented fix: Skip NV12 conversion, send RGBA directly to WebGPU

**Changes Made**:
- `apps/desktop/src-tauri/src/frame_ws.rs`: Replaced NV12 conversion with direct RGBA packing in `create_watch_frame_ws()`
- `apps/desktop/src/utils/socket.ts`: Added WebGPU RGBA rendering path using `renderFrameWebGPU()`

**Root Cause Analysis**:
The pipeline was:
1. GPU renders RGBA → readback to CPU (~23MB)
2. **CPU converts RGBA→NV12** (per-pixel, ~15-25ms per frame) ← BOTTLENECK
3. Send NV12 over WebSocket (~9MB)
4. JavaScript receives NV12 → WebGPU converts NV12→display

The CPU RGBA→NV12 conversion was taking 15-25ms per frame for 3024x1964 resolution, limiting frame rate to 40-50fps. NV12 was originally used to reduce WebSocket bandwidth (12 vs 32 bits/pixel), but the CPU cost outweighed the bandwidth savings for local WebSocket.

**Fix**: Skip NV12 conversion entirely. Send RGBA directly and use WebGPU `renderFrameWebGPU()` to display. This trades 2.7x bandwidth increase for eliminating the 15-25ms CPU conversion per frame.

**Results**:
- Eliminates ~15-25ms CPU overhead per frame
- Expected improvement: 40-50fps → 60fps
- Bandwidth increase: ~9MB → ~23MB per frame (acceptable for local WebSocket)

**Stopping point**: Fix implemented and compiles. Needs testing with actual editor to verify 60fps achievement.

---

### Session 2026-02-14 (Linux benchmark fallback + audio startup path)

**Goal**: Continue playback optimization with measurable benchmarks in Linux environment and reduce audio startup delay risk

**What was done**:
1. Unblocked several Linux compile blockers in platform-dependent crates (`scap-targets`, `cap-cursor-capture`, `cap-camera-ffmpeg`, `cap-timestamp`, `scap-ffmpeg`)
2. Verified `cap-recording` benchmark path remains heavily platform-specific on Linux and cannot be fully used without broad recording-stack Linux enablement
3. Added new Linux-compatible benchmark example `crates/editor/examples/playback-benchmark.rs`
4. Ran playback throughput benchmarks on synthetic 1080p60 and 4k60 files
5. Switched editor audio playback startup logic to prefer streaming audio path with fallback to pre-rendered path

**Changes Made**:
- `crates/scap-targets/src/platform/linux.rs` and related platform exports
- `crates/scap-targets/src/lib.rs`
- `crates/cursor-capture/src/position.rs`
- `crates/camera-ffmpeg/src/lib.rs`
- `crates/timestamp/src/lib.rs`
- `crates/scap-ffmpeg/src/lib.rs`
- `crates/editor/examples/playback-benchmark.rs`
- `crates/editor/src/playback.rs`
- `crates/editor/PLAYBACK-BENCHMARKS.md`

**Results**:
- Playback benchmark (1080p60 synthetic): 480 decoded / 480, effective 60.11 fps, 0 missed deadlines, decode p95 2.34ms
- Playback benchmark (4k60 synthetic): 480 decoded / 480, effective 60.11 fps, 2 missed deadlines, decode p95 8.35ms
- Decode benchmark confirms persistent seek/random-access hotspots, especially 4k medium/long seeks
- Audio startup path now prefers streaming playback on non-Windows, with automatic fallback to pre-rendered path on stream creation failure

**Stopping point**: Need targeted measurement of audio startup latency deltas in real editor playback, then continue seek-latency tuning.

---

### Session 2026-02-14 (FFmpeg seek reset tuning)

**Goal**: Reduce medium-distance seek latency spikes in FFmpeg decode path

**What was done**:
1. Updated `cap-video-decode` FFmpeg reset logic to use a forward bounded seek window before fallback
2. Re-ran decode and playback throughput benchmarks on synthetic 1080p60 and 4k60 videos

**Changes Made**:
- `crates/video-decode/src/ffmpeg.rs`
  - Added `last_seek_position` tracking
  - For forward seeks, attempts `seek(position, min..max)` using a 2-second window
  - Falls back to previous `..position` strategy if bounded seek fails

**Results**:
- 1080p60 decode benchmark:
  - 2.0s seek improved from ~260ms to **5.26ms**
  - random access avg improved from ~223ms to **120.87ms**
- 4k60 decode benchmark:
  - 2.0s seek improved from ~905ms to **12.65ms**
  - random access avg improved from ~918ms to **533.65ms**
- Playback throughput remains at ~60fps for both 1080p60 and 4k60 synthetic runs
- Long 5.0s seek latency is still elevated on 4k and remains an active tuning target

**Stopping point**: Keep current seek tuning; next focus is long-seek (5s+) latency and real desktop A/V startup measurements.

---

### Session 2026-02-14 (Audio startup instrumentation)

**Goal**: Add measurable startup telemetry for audio output callback timing

**What was done**:
1. Instrumented audio output callback startup in both streaming and pre-rendered playback paths
2. Added one-time startup latency logs from playback start thread spawn to first output callback invocation

**Changes Made**:
- `crates/editor/src/playback.rs`
  - Added startup timing capture in `AudioPlayback::spawn`
  - Logs:
    - `Audio streaming callback started`
    - `Audio pre-rendered callback started`
  - Includes startup latency in milliseconds

**Results**:
- No compile regressions in `cap-editor`
- Playback now has explicit, low-overhead startup latency telemetry for validating user-reported delayed audio start

**Stopping point**: Run this instrumentation on macOS and Windows editor sessions to collect before/after startup latency evidence.

---

### Session 2026-02-14 (FFmpeg long-seek tuning pass 2)

**Goal**: Improve long forward seek latency while preserving medium seek gains

**What was done**:
1. Adjusted FFmpeg forward-seek behavior to prefer keyframes closer to target time
2. Re-ran decode and playback throughput benchmarks

**Changes Made**:
- `crates/video-decode/src/ffmpeg.rs`
  - forward seek now first tries:
    - small backtrack window (0.5s)
    - larger forward allowance (2.0s)
  - then falls back to wider symmetric window and legacy seek behavior

**Results**:
- 1080p60:
  - random access avg: **120.87ms -> 114.64ms**
  - playback 5s seek sample: **138.26ms -> 138.90ms** (flat)
- 4k60:
  - random access avg: **533.65ms -> 525.90ms**
  - playback 5s seek sample: **432.97ms -> 410.35ms**
- Playback throughput still meets 60fps target in synthetic real-time simulation

**Stopping point**: Long-seek behavior improved but still high on 4k; next progress requires richer keyframe-aware seek strategy or decoder-pool approach for FFmpeg path.

---

### Session 2026-02-14 (FFmpeg long-seek tuning pass 3)

**Goal**: Improve long-seek behavior by changing seek fallback ordering

**What was done**:
1. Changed forward seek fallback order in FFmpeg reset path:
   - preferred bounded seek
   - legacy backward seek
   - wide bounded seek
2. Re-ran decode and playback throughput benchmarks

**Changes Made**:
- `crates/video-decode/src/ffmpeg.rs`
  - reordered fallback sequence in forward seek reset path

**Results**:
- 1080p:
  - 5s decode seek: **142.01ms -> 110.27ms** (improved)
  - random access avg: **114.64ms -> 119.53ms** (slight regression/noise)
- 4k:
  - random access avg: **525.90ms -> 516.48ms** (small improvement)
  - 5s decode seek: **559.44ms -> 569.83ms** (flat/slightly worse)
  - 5s playback seek sample: **410.35ms -> 430.25ms** (slight regression)
- Throughput remains ~60fps in playback benchmark for both synthetic clips

**Stopping point**: pass 3 did not materially improve long 4k seeks; code was reverted to pass 2 strategy and further gains will need a deeper keyframe-aware approach.

---

### Session 2026-02-14 (Playback startup instrumentation alignment)

**Goal**: Make startup latency logs directly comparable across decode, render, and audio callback milestones

**What was done**:
1. Added playback startup origin timestamp at playback start.
2. Logged first decoded frame availability in prefetch pipeline against that origin.
3. Logged first rendered frame against the same origin.
4. Switched audio callback startup logging to use the same playback origin timestamp.

**Changes Made**:
- `crates/editor/src/playback.rs`
  - added startup timeline logs:
    - `Playback first decoded frame ready`
    - `Playback first frame rendered`
  - added `startup_instant` to `AudioPlayback` and wired callback logs to playback start origin
- `crates/editor/examples/playback-startup-report.rs`
  - added log analysis utility for startup timing markers
  - reports avg/p50/p95/min/max for decoded, rendered, and audio callback startup milestones

**Results**:
- Playback throughput remains at ~60fps in synthetic benchmark after instrumentation:
  - 1080p: **60.11 fps**, missed deadlines **0**
  - 4k: **60.11 fps**, missed deadlines **1**
- No functional playback regression observed in benchmark pass.

**Stopping point**: startup timing evidence can now be captured in real editor sessions and compared directly; next required step is collecting macOS and Windows session logs with the new unified timing markers.

---

### Session 2026-02-14 (Startup trace export for cross-platform sessions)

**Goal**: Make macOS/Windows startup latency collection deterministic and parseable

**What was done**:
1. Added optional startup trace CSV export from desktop playback path via environment variable.
2. Emitted trace rows for first decoded frame, first rendered frame, and first audio callback milestones.
3. Updated startup report example to parse both tracing logs and CSV trace lines.

**Changes Made**:
- `crates/editor/src/playback.rs`
  - added `CAP_PLAYBACK_STARTUP_TRACE_FILE` writer
  - startup milestones now append CSV rows:
    - `first_decoded_frame`
    - `first_rendered_frame`
    - `audio_streaming_callback`
    - `audio_prerender_callback`
- `crates/editor/examples/playback-startup-report.rs`
  - added CSV event parser support

**Verification**:
- `cargo +1.88.0 check -p cap-editor`
- `cargo +1.88.0 check -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 test -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log crates/editor/PLAYBACK-BENCHMARKS.md`

**Stopping point**: next actionable step is running desktop playback sessions on macOS and Windows with `CAP_PLAYBACK_STARTUP_TRACE_FILE` enabled and feeding the resulting logs into `playback-startup-report`.

---

## References

- `PLAYBACK-BENCHMARKS.md` - Raw performance test data (auto-updated by test runner)
- `../recording/FINDINGS.md` - Recording performance findings (source of test files)
- `../recording/BENCHMARKS.md` - Recording benchmark data
- `examples/playback-test-runner.rs` - Playback test implementation
