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
- [ ] **Capture scrub benchmark CSV sweeps on macOS/Windows** - Use `--output-csv` plus supersession env values for side-by-side threshold comparisons
- [ ] **Run full desktop editor validation on macOS + Windows** - Confirm in-app FPS and A/V behavior on target platforms

### Completed
- [x] **Run initial baseline** - Established current playback performance metrics (2026-01-28)
- [x] **Profile decoder init time** - Hardware acceleration confirmed (AVAssetReader) (2026-01-28)
- [x] **Identify latency hotspots** - No issues found, p95=3.1ms (2026-01-28)
- [x] **Add Linux-compatible benchmark fallback path** - Added `cap-editor` playback benchmark example and supporting linux compile fallbacks (2026-02-14)
- [x] **Harden seek benchmark methodology** - Added repeated seek sampling with avg/p95/max and de-cached iteration strategy (2026-02-14)

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
| `crates/editor/examples/playback-csv-report.rs` | Playback CSV summary and label-delta analysis |
| `crates/editor/examples/scrub-benchmark.rs` | Scrub burst latency benchmark |
| `crates/editor/examples/scrub-csv-report.rs` | Scrub CSV summary and label-delta analysis |

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

### Session 2026-02-14 (Seek benchmark methodology hardening)

**Goal**: Improve benchmark evidence quality for seek optimizations by reducing cache-driven false positives

**What was done**:
1. Updated `decode-benchmark` to support `--seek-iterations` and report per-distance avg/p95/max.
2. Updated seek sampling logic to vary the start position per iteration, keeping constant seek distance while avoiding repeated cache hits.
3. Updated `playback-benchmark` with the same `--seek-iterations` support, distance-tail reporting, and varied start-point strategy.
4. Re-ran 1080p and 4k decode/playback benchmarks with repeated seek sampling.

**Changes Made**:
- `crates/editor/examples/decode-benchmark.rs`
  - added `--seek-iterations`
  - added repeated seek stats tables (avg/p95/max/samples/failures)
  - varied per-iteration seek start times to avoid de-cached artifacts
- `crates/editor/examples/playback-benchmark.rs`
  - added `--seek-iterations`
  - added repeated seek stats table output
  - varied per-iteration seek start times with from->to measurement
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - updated benchmark command docs and added methodology-hardening benchmark run data

**Results**:
- ✅ Throughput remains at ~60fps in playback benchmark:
  - 1080p: **60.24 fps**, missed deadlines **0**
  - 4k: **60.13 fps**, missed deadlines **0**
- ✅ Repeated seek sampling now reveals tail behavior directly:
  - 4k decode seeks show high p95 tails up to ~1.47s at 5s distance
  - 1080p seeks are substantially lower but still non-trivial at medium/long jumps
- ✅ Benchmark tooling now better discriminates real improvements vs cache effects.

**Stopping point**: next optimization passes should be evaluated with `--seek-iterations` to prevent regression masking and to target 4k long-seek tail reduction.

---

### Session 2026-02-14 (Rejected FFmpeg seek/thread tuning under hardened benchmarks)

**Goal**: Test low-risk FFmpeg decode tuning ideas against hardened seek benchmark tails

**What was done**:
1. Tested backward-only forward-seek window ordering in `cap-video-decode`.
2. Benchmarked 1080p/4k decode with `--seek-iterations 10`.
3. Reverted due regressions, then tested software thread-count cap for 4k decode.
4. Benchmarked again and reverted second experiment due seek-tail regressions.

**Results**:
- ❌ Backward-only seek preference regressed seek tails and random access:
  - 4k seek avg/p95 reached roughly:
    - 0.5s: **320 / 407ms**
    - 1.0s: **577 / 714ms**
    - 2.0s: **1076 / 1670ms**
    - 5.0s: **1051 / 1725ms**
  - 4k random access avg rose to **~925ms**
- ❌ 4k thread-count cap experiment also worsened seek tails:
  - 4k seek avg/p95 reached roughly:
    - 0.5s: **224 / 395ms**
    - 1.0s: **367 / 734ms**
    - 2.0s: **638 / 1479ms**
    - 5.0s: **975 / 1523ms**

**Stopping point**: both candidates reverted. Next viable direction should focus on architecture-level seek improvements (decoder pool/keyframe-aware jump scheduling) rather than small FFmpeg seek-window tweaks.

---

### Session 2026-02-14 (FFmpeg duplicate-request coalescing)

**Goal**: Reduce wasted decode work during scrub/request bursts that target the same frame

**What was done**:
1. Added same-frame coalescing in FFmpeg decoder request batches (software + hardware paths).
2. When multiple pending requests resolve to one frame index, decoder now executes one response production and fans the frame out to all waiting reply channels.
3. Re-ran hardened decode/playback benchmarks (`--seek-iterations 10`) to verify throughput and tail stability.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - pending request now stores additional replies for same-frame coalescing
  - request intake merges duplicate frame requests in-batch
  - frame send path fans out decoded/cached frame to all coalesced replies

**Results**:
- ✅ Playback throughput remains stable at 60fps-class:
  - 1080p playback benchmark: **60.24 fps**, missed deadlines **0**
  - 4k playback benchmark: **60.20 fps**, missed deadlines **0**
- ✅ Decode benchmarks stayed within expected variance envelope for current seek-tail profile.
- ✅ No regressions observed in compile/test benchmark runs after coalescing change.

**Stopping point**: same-frame coalescing landed as a low-risk scrub efficiency improvement; next major improvement still requires reducing long-distance 4k seek tails via deeper decoder strategy.

---

### Session 2026-02-14 (Duplicate burst benchmark signal hardening)

**Goal**: Stabilize duplicate-request benchmark signal for evaluating coalescing behavior

**What was done**:
1. Extended `decode-benchmark` with an explicit duplicate-request burst section (burst sizes 4/8/16).
2. Added warmup frame fetch before burst sampling to remove cold-start outlier distortion.
3. Re-ran 1080p and 4k decode benchmarks with hardened seek sampling and burst metrics.

**Changes Made**:
- `crates/editor/examples/decode-benchmark.rs`
  - added duplicate burst metric table output
  - added burst warmup call prior to timing iterations
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - recorded stabilized duplicate burst metrics and updated decode-benchmark command notes

**Results**:
- ✅ Duplicate burst metrics now stable and interpretable:
  - 1080p burst batch p95: **~3.7–3.8ms**
  - 4k burst batch p95: **~21.7–22.0ms**
- ✅ No failures in duplicate burst requests across tested burst sizes.
- ✅ Existing throughput and seek-tail profile remained consistent with recent runs.

**Stopping point**: duplicate burst metric is now productionized for ongoing coalescing validation; remaining performance gap is still long-distance 4k seek tails.

---

### Session 2026-02-14 (Scrub burst benchmark baseline)

**Goal**: Add direct scrub-queue stress evidence for latest-request latency

**What was done**:
1. Added `scrub-benchmark` example that issues bursty decoder requests over a configurable sweep window.
2. Captured two key metrics:
   - all-request latency distribution
   - last-request-in-burst latency distribution
3. Ran 1080p and 4k baseline passes with 20 bursts × 12 requests.

**Changes Made**:
- `crates/editor/examples/scrub-benchmark.rs`
  - new benchmark for scrub queue stress behavior
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added command usage and baseline results for scrub burst runs

**Results**:
- 1080p scrub burst:
  - all-request avg **217.97ms**, p95 **434.83ms**
  - last-request avg **312.50ms**, p95 **455.72ms**
- 4k scrub burst:
  - all-request avg **1071.64ms**, p95 **2098.98ms**
  - last-request avg **1524.00ms**, p95 **2116.35ms**
- ✅ Benchmark now exposes scrub-specific latency that decode/playback sequential tests do not capture.

**Stopping point**: next optimization pass should target reducing last-request-in-burst latency (especially 4k) and use scrub-benchmark plus seek-iteration benchmarks as acceptance gates.

---

### Session 2026-02-14 (Decoder scrub supersession heuristic)

**Goal**: Reduce latest-request latency during wide-span scrub bursts without breaking throughput

**What was done**:
1. Added a burst supersession heuristic in FFmpeg decoder request batching:
   - when request queue is large and frame span is wide, collapse batch to the newest request target while fanning responses to waiting receivers.
2. Applied heuristic to both software and hardware FFmpeg decoder paths.
3. Re-ran scrub, decode, and playback benchmarks for validation.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - request metadata now tracks enqueue order
  - added `maybe_supersede_scrub_burst` to collapse large-span batches to newest target
  - retained same-frame coalescing and response fan-out

**Results**:
- ✅ Scrub burst latency improved materially for 4k:
  - last-request avg: **1524ms -> 870ms**
  - all-request avg: **1072ms -> 834ms**
  - last-request p95: **2116ms -> 1941ms**
- ✅ 1080p scrub average improved:
  - last-request avg: **313ms -> 221ms**
- ⚠️ 1080p scrub tail widened in this pass (p95/p99), so heuristic still needs refinement for consistency.
- ✅ Throughput remains ~60fps in playback benchmark:
  - 1080p: **60.23 fps**
  - 4k: **60.16 fps**

**Stopping point**: first pass improved 4k scrub responsiveness but had mixed 1080p tail behavior; moved to resolution-gated supersession in follow-up pass.

---

### Session 2026-02-14 (Decoder scrub supersession heuristic pass 2)

**Goal**: Retain 4k scrub gains while reducing 1080p side effects

**What was done**:
1. Gated supersession heuristic to high-resolution streams only (`>= 2560x1440`).
2. Re-ran scrub burst benchmarks for 1080p and 4k.
3. Re-ran decode and playback regression benchmarks for both clips.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - `maybe_supersede_scrub_burst` now accepts an enable flag
  - supersession enablement computed from stream resolution in both FFmpeg loops

**Results**:
- ✅ 4k scrub responsiveness remained improved vs baseline:
  - last-request avg: **1524ms -> 864ms**
  - last-request p95: **2116ms -> 1689ms**
  - all-request avg: **1072ms -> 820ms**
- ✅ 1080p tails improved vs pass 1 while keeping better average:
  - last-request avg: **313ms -> 298ms**
  - last-request p95: **456ms -> 427ms**
- ✅ Playback throughput remained stable:
  - 1080p: **60.23 fps**
  - 4k: **60.19 fps**
- ✅ Decode seek/random-access metrics stayed within expected variance envelope.

**Stopping point**: resolution-gated supersession is currently the best scrub-latency configuration; next work should focus on reducing 4k long-seek tails further without regressing these burst-latency gains.

---

### Session 2026-02-14 (Supersession runtime configurability)

**Goal**: Enable faster cross-platform tuning of scrub supersession without code edits

**What was done**:
1. Added environment-driven controls for FFmpeg scrub supersession behavior:
   - `CAP_FFMPEG_SCRUB_SUPERSEDE_DISABLED`
   - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_PIXELS`
   - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_REQUESTS`
   - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES`
2. Kept default behavior equivalent to current tuned path.
3. Re-ran scrub, decode, and playback benchmarks with defaults to verify no functional regressions.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - added `ScrubSupersessionConfig` with `OnceLock` initialization
  - replaced hard-coded supersession thresholds with config values
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added command examples for runtime supersession tuning
  - added validation benchmark run for the configurable defaults

**Results**:
- ✅ Scrub supersession behavior preserved with defaults:
  - 4k last-request avg **~821ms**, p95 **~1768ms**
  - 1080p last-request avg **~304ms**, p95 **~435ms**
- ✅ Playback throughput remains at 60fps-class:
  - 1080p: **60.22 fps**
  - 4k: **60.17 fps**
- ✅ Decode benchmark metrics remain in expected variance envelope after config refactor.

**Stopping point**: supersession tuning is now runtime-configurable, enabling platform-specific calibration runs (especially macOS/Windows) without recompiling.

---

### Session 2026-02-14 (Supersession default span tuning)

**Goal**: Promote a better default supersession span without requiring env overrides

**What was done**:
1. Benchmarked supersession configs with multi-run scrub reports (`--runs 3`) to reduce noise.
2. Compared default behavior against candidate span thresholds.
3. Set default `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES` fallback to `25`.
4. Re-ran scrub/decode/playback benchmarks with the new default.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - changed default supersession span fallback from `FRAME_CACHE_SIZE / 2` to `25`
  - kept runtime override support intact
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added benchmark run section for the new default tuning pass

**Results**:
- ✅ Scrub median improvements vs previous default:
  - 1080p last-request avg: **~319.76ms -> ~294.07ms**
  - 4k last-request avg: **~967.21ms -> ~808.71ms**
  - 4k last-request p95: **~1881ms -> ~1694ms**
- ✅ Playback remained 60fps-class in regression runs:
  - 1080p: **60.22 fps**
  - 4k: **60.18 fps** (best run in pass)
- ✅ Decode metrics remained in expected variance envelope after default change.

**Stopping point**: supersession now ships with a stronger default profile while remaining fully runtime-tunable for platform-specific calibration.

---

### Session 2026-02-14 (Supersession min-request threshold sweep)

**Goal**: Validate whether lowering supersession queue threshold improves scrub latency further

**What was done**:
1. Ran 3-run scrub benchmarks for candidate `min_requests=6`, `min_span_frames=25`.
2. Compared medians against current default (`min_requests=8`, `min_span_frames=25`).

**Results**:
- 1080p improved with threshold 6:
  - median last-request avg: **~294ms -> ~286ms**
  - median last-request p95: **~456ms -> ~428ms**
- 4k regressed vs threshold 8:
  - median last-request avg: **~809ms -> ~842ms**
  - median last-request p95: **~1694ms -> ~1744ms**

**Decision**: keep default `min_requests=8` because it gives better 4k scrub responsiveness while still materially improving 1080p over the original baseline.

**Stopping point**: defaults remain `min_requests=8`, `min_span_frames=25`, with runtime overrides available for platform-specific tuning.

---

### Session 2026-02-14 (Supersession span threshold retune to 20)

**Goal**: Re-evaluate supersession span threshold with CSV-backed multi-run sweeps and improve 4k scrub medians

**What was done**:
1. Ran a 4-way sweep over `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES={15,20,25,30}` with `scrub-benchmark --runs 3`.
2. Compared median last-request latency and p95 tails from CSV outputs.
3. Updated FFmpeg supersession default span fallback from `25` to `20`.
4. Re-ran scrub, playback, and decode regression benchmarks after the default change.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - changed default `min_span_frames` fallback from `25` to `20`
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - updated command examples to show span `20`
  - added benchmark entry for the threshold sweep and post-change regression runs

**Results**:
- 4k sweep medians (last-request avg / p95):
  - span 15: **836.94ms / 1740.74ms**
  - span 20: **814.93ms / 1743.49ms**
  - span 25: **819.11ms / 1762.74ms**
  - span 30: **923.18ms / 1947.86ms**
- Post-change default (span 20) validation:
  - 4k scrub median last-request avg **836.61ms**, p95 **1732.40ms**
  - playback throughput remains 60fps-class:
    - 1080p: **60.24 fps**
    - 4k: **60.18 fps**
  - decode metrics remain in expected variance envelope:
    - 1080p random avg **111.79ms**
    - 4k random avg **509.26ms**

**Decision**: keep defaults at `min_requests=8`, `min_span_frames=20`.

**Stopping point**: supersession defaults now favor a slightly more aggressive span threshold while preserving 60fps throughput and stable decode behavior.

---

### Session 2026-02-14 (Supersession min-pixels threshold retune to 2,000,000)

**Goal**: Validate whether enabling supersession for 1080p-class streams improves scrub latency without harming 4k behavior

**What was done**:
1. Ran baseline scrub benchmarks with current defaults (`min_pixels=3_686_400`, `min_span_frames=20`).
2. Ran candidate scrub benchmarks with `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_PIXELS=2_000_000`.
3. Compared 1080p and 4k median run aggregates from `--runs 3`.
4. Updated FFmpeg supersession default min-pixels fallback to `2_000_000`.
5. Re-ran scrub + playback + decode regression benchmarks after default promotion.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - changed default supersession `min_pixels` fallback from `3_686_400` to `2_000_000`
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - updated runtime tuning command examples
  - added benchmark history section for min-pixels sweep and post-retune regression checks

**Results**:
- Sweep medians (last-request avg / p95):
  - baseline min_pixels=3_686_400:
    - 1080p: **332.72ms / 480.45ms**
    - 4k: **855.08ms / 1769.64ms**
  - candidate min_pixels=2_000_000:
    - 1080p: **213.36ms / 449.62ms**
    - 4k: **814.28ms / 1716.14ms**
- Post-change default validation:
  - 1080p scrub median last-request avg **200.14ms**, p95 **429.83ms**
  - 4k scrub median last-request avg **834.23ms**, p95 **1718.54ms**
  - playback remains 60fps-class:
    - 1080p: **60.23 fps**
    - 4k: **60.19 fps**

**Decision**: keep defaults at `min_requests=8`, `min_span_frames=20`, `min_pixels=2_000_000`.

**Stopping point**: supersession now benefits both 1080p and 4k scrub paths under the same default policy while preserving playback throughput targets.

---

### Session 2026-02-14 (Supersession min-requests threshold retune to 7)

**Goal**: Re-check request-burst threshold using updated defaults (`min_span_frames=20`, `min_pixels=2_000_000`)

**What was done**:
1. Ran a sequential threshold sweep for `min_requests={6,7,8}` on 1080p and 4k scrub benchmarks (`--runs 3`).
2. Compared median last-request latency and p95 tails across both resolutions.
3. Updated FFmpeg supersession default `min_requests` fallback from `8` to `7`.
4. Re-ran scrub + playback + decode regression benchmarks after promoting the new default.

**Changes Made**:
- `crates/rendering/src/decoder/ffmpeg.rs`
  - changed default supersession `min_requests` fallback from `8` to `7`
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - updated runtime tuning command examples to use `min_requests=7`
  - added benchmark history section for threshold sweep and regression checks

**Results**:
- Sequential sweep medians (last-request avg / p95):
  - 1080p:
    - req 6: **209.99ms / 444.08ms**
    - req 7: **211.36ms / 447.60ms**
    - req 8: **209.11ms / 441.08ms**
  - 4k:
    - req 6: **827.29ms / 1707.63ms**
    - req 7: **823.15ms / 1699.04ms**
    - req 8: **884.74ms / 1837.32ms**
- Post-change default (`min_requests=7`) validation:
  - 1080p scrub median last-request avg **205.46ms**, p95 **432.90ms**
  - 4k scrub median last-request avg **825.01ms**, p95 **1712.30ms**
  - playback remains 60fps-class:
    - 1080p: **60.24 fps**
    - 4k: **60.20 fps**

**Decision**: keep defaults at `min_requests=7`, `min_span_frames=20`, `min_pixels=2_000_000`.

**Stopping point**: supersession defaults now balance 1080p and 4k scrub responsiveness better than the previous `min_requests=8` profile while preserving throughput targets.

---

### Session 2026-02-14 (Rejected span threshold changes after default retunes)

**Goal**: Verify whether span threshold should move again after adopting `min_requests=7` and `min_pixels=2_000_000`

**What was done**:
1. Re-ran span sweep with `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES={15,20,25}`.
2. Executed 1080p and 4k scrub benchmarks (`--runs 3`) for each span candidate.
3. Compared median last-request averages and p95 tails.

**Results**:
- 1080p (avg / p95):
  - span 15: **216.43ms / 457.45ms**
  - span 20: **209.63ms / 442.04ms**
  - span 25: **213.84ms / 447.71ms**
- 4k (avg / p95):
  - span 15: **862.02ms / 1789.73ms**
  - span 20: **860.43ms / 1761.25ms**
  - span 25: **866.03ms / 1781.42ms**

**Decision**: keep `min_span_frames=20`; candidates 15 and 25 were rejected.

**Stopping point**: supersession defaults remain `min_requests=7`, `min_span_frames=20`, `min_pixels=2_000_000`.

---

### Session 2026-02-14 (Rejected fine span retune to 22)

**Goal**: Validate whether a finer span adjustment (`22`) outperforms the current default (`20`)

**What was done**:
1. Ran fine span sweep (`18`, `20`, `22`) on 1080p and 4k with `--runs 3`.
2. Ran paired span20/span22 sweeps with explicit run labels and compared via `scrub-csv-report`.
3. Temporarily switched default span to `22` and executed scrub/playback/decode regression checks.

**Results**:
- Fine sweep signal:
  - 1080p favored `20` on tails (span 22 raised p95 vs span 20 in sampled runs).
  - 4k often favored `22` in paired delta comparisons.
- Paired labeled deltas (`span22 - span20`):
  - 1080p: p95 worsened by about **+24ms**
  - 4k: avg and p95 improved materially in that paired sample
- Temporary default-22 regressions:
  - 4k scrub sample still showed heavy tails (**~1797ms p95**)
  - playback regression sample had higher missed deadlines (**4**)
  - decode remained in variance envelope but with no clear stability gain

**Decision**: rejected promoting `min_span_frames=22` due inconsistent tail behavior across reruns.

**Stopping point**: keep defaults at `min_requests=7`, `min_span_frames=20`, `min_pixels=2_000_000`.

---

### Session 2026-02-14 (Scrub CSV report utility)

**Goal**: Provide a lightweight analysis tool for cross-machine scrub CSV comparisons

**What was done**:
1. Added a new CSV report example for scrub benchmarks.
2. Implemented aggregate-row parsing with run-label and video grouping.
3. Added baseline/candidate label delta reporting per overlapping video.
4. Added derived config-label fallback for rows without explicit run labels.
5. Added `--output-csv` to persist summary and delta rows.
6. Added unit tests for CSV parsing, config-label fallback, median summarization, grouping, and CSV writing.

**Changes Made**:
- `crates/editor/examples/scrub-csv-report.rs`
  - new CLI args:
    - `--csv <path>` (repeatable)
    - `--label <run-label>`
    - `--baseline-label <run-label>`
    - `--candidate-label <run-label>`
    - `--output-csv <path>`
  - reports median summaries per run label from aggregate rows
  - auto-labels unlabeled rows with config-derived keys
  - computes candidate-minus-baseline deltas for all/last request avg and p95 per video
  - writes summary/delta rows for downstream reporting when output path is provided
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added command usage and validation run output for the new utility

**Verification**:
- `cargo +1.88.0 check -p cap-editor --example scrub-csv-report`
- `cargo +1.88.0 test -p cap-editor --example scrub-csv-report` (5 tests)
- `cargo +1.88.0 run -p cap-editor --example scrub-csv-report -- --csv /tmp/cap-scrub-labeled.csv --label linux-pass-a`
- `cargo +1.88.0 run -p cap-editor --example scrub-csv-report -- --csv /tmp/cap-scrub-span-20-22.csv --baseline-label span20 --candidate-label span22 --output-csv /tmp/cap-scrub-summary.csv`

**Results**:
- ✅ Cross-machine scrub CSVs can now be summarized and compared without manual spreadsheet work.
- ✅ Unlabeled sweeps now group correctly by supersession config defaults/overrides.
- ✅ Summary/delta exports can now be archived as machine-readable artifacts.
- ✅ Utility test suite passing (5/5).

**Stopping point**: startup and scrub evidence collection on macOS/Windows now has matching run-label analysis tools on Linux for post-capture evaluation.

---

### Session 2026-02-14 (Playback benchmark CSV export)

**Goal**: Persist playback throughput benchmark outputs in machine-readable format for cross-platform comparisons

**What was done**:
1. Added optional CSV export to `playback-benchmark`.
2. Added optional run labeling for exported playback benchmark rows.
3. Emitted sequential and per-seek rows in a single CSV schema.

**Changes Made**:
- `crates/editor/examples/playback-benchmark.rs`
  - new CLI args:
    - `--output-csv <path>`
    - `--run-label <label>`
  - new env fallback:
    - `CAP_PLAYBACK_BENCHMARK_RUN_LABEL`
  - CSV rows:
    - `mode=sequential` for throughput/decode summary
    - `mode=seek` for each seek distance sample summary
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added command usage and validation benchmark sample for CSV mode

**Verification**:
- `cargo +1.88.0 check -p cap-editor --example playback-benchmark`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --max-frames 240 --seek-iterations 10 --output-csv /tmp/cap-playback-benchmark.csv --run-label linux-pass-a`
- inspected `/tmp/cap-playback-benchmark.csv` and confirmed sequential + seek rows with populated metrics.

**Results**:
- ✅ Playback benchmark outputs can now be aggregated across machines/runs without manual copy-paste.
- ✅ CSV schema captures both real-time throughput and seek behavior under one run label.

**Stopping point**: startup + scrub + playback benchmark tooling now all support labeled CSV exports, enabling cleaner macOS/Windows evidence ingestion once traces are collected.

---

### Session 2026-02-14 (Playback CSV report utility)

**Goal**: Add analysis tooling for playback benchmark CSVs to support cross-machine run-label comparisons

**What was done**:
1. Added new `playback-csv-report` example to parse playback benchmark CSV outputs.
2. Implemented grouping by `(run_label, video)` with median summaries for:
   - sequential effective FPS / decode p95 / missed deadlines
   - seek avg/p95/max per distance plus aggregate sample/failure counts
3. Added baseline/candidate run-label delta output for overlapping videos and seek distances.
4. Added optional `--output-csv` to export summary and delta rows for downstream reporting.
5. Added unit tests for CSV parsing, grouping, median summarization, and CSV writer paths.

**Changes Made**:
- `crates/editor/examples/playback-csv-report.rs`
  - new CLI args:
    - `--csv <path>` (repeatable)
    - `--label <run-label>`
    - `--baseline-label <run-label>`
    - `--candidate-label <run-label>`
    - `--output-csv <path>`
  - emits per-label summaries and baseline/candidate deltas
  - writes `summary_sequential`, `summary_seek`, `delta_sequential`, and `delta_seek` CSV rows
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added usage commands and validation run notes for playback CSV report workflows

**Verification**:
- `cargo +1.88.0 check -p cap-editor --example playback-csv-report`
- `cargo +1.88.0 test -p cap-editor --example playback-csv-report` (5 tests)
- `cargo +1.88.0 run -p cap-editor --example playback-csv-report -- --csv /tmp/cap-playback-benchmark.csv --label linux-pass-a`
- `cargo +1.88.0 run -p cap-editor --example playback-csv-report -- --csv /tmp/cap-playback-benchmark.csv --baseline-label linux-pass-a --candidate-label linux-pass-b --output-csv /tmp/cap-playback-summary.csv`

**Results**:
- ✅ Playback CSVs can now be summarized and compared without manual spreadsheet work.
- ✅ Summary and delta exports provide machine-readable artifacts aligned with existing startup/scrub report flows.
- ✅ Utility test suite passing (5/5).

**Stopping point**: playback, scrub, and startup CSV workflows now all have matching summary/delta tooling for incoming macOS/Windows captures.

---

### Session 2026-02-14 (Desktop socket RGBA-only transport path simplification)

**Goal**: Reduce preview-frame hot-path overhead by removing legacy NV12 handling from desktop websocket frame consumption

**What was done**:
1. Simplified desktop websocket frame handling in `socket.ts` to operate on RGBA payloads only.
2. Simplified worker decode/render path in `frame-worker.ts` to parse and process only RGBA transport metadata.
3. Removed unused NV12 shader/pipeline allocation path from `webgpu-renderer.ts` so renderer initialization only builds the active RGBA pipeline.
4. Removed NV12 detection, conversion, deferred NV12 frame buffering, and NV12 render branches from main-thread and worker hot paths.
5. Kept stride-correction and worker fallback paths for RGBA frames intact.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - removed NV12 conversion helpers and associated state
  - removed NV12 render paths for main-thread WebGPU and 2D fallback
  - simplified frame metadata parsing to RGBA 24-byte trailer handling
  - simplified stored-frame capture path to direct RGBA image data
- `apps/desktop/src/utils/frame-worker.ts`
  - removed NV12 parsing and conversion branches
  - removed NV12 WebGPU render dispatch paths
  - simplified queued-frame and metadata types to RGBA-only transport
- `apps/desktop/src/utils/webgpu-renderer.ts`
  - removed NV12 fragment shader, pipeline, bind-group layout, and texture/bind group cache state
  - removed unused `renderNv12FrameWebGPU` export
  - simplified renderer initialization and disposal to RGBA-only resources

**Verification**:
- `pnpm install --filter @cap/desktop...`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm exec biome format --write apps/desktop/src/utils/socket.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ Desktop TypeScript build checks pass with the simplified RGBA-only transport handling.
- ✅ Legacy NV12-only branches no longer execute on websocket frame hot path.

**Stopping point**: next validation step for this change is in-app desktop playback profiling (macOS/Windows) using existing overlay stats and startup/scrub capture workflow.

---

### Session 2026-02-14 (Rejected superseded-burst cache-window reduction)

**Goal**: Reduce superseded scrub decode work by shrinking decode cache window for superseded requests

**What was done**:
1. Implemented a reduced cache window path for requests marked as superseded bursts.
2. Ran scrub, decode, and playback regression benchmarks on 1080p and 4k.
3. Compared multi-run scrub medians and tail behavior to current default.

**Results**:
- 4k scrub median last-request average improved (roughly **809ms -> 782ms**), but p95 tail worsened materially in sampled runs (up to **~1952ms**).
- 1080p scrub average regressed vs current default (roughly **294ms -> 313ms**).
- Decode/playback regressions remained generally stable, but scrub-tail tradeoff was unfavorable.

**Decision**: reverted the cache-window reduction experiment; keep current supersession behavior unchanged.

**Stopping point**: continue tuning through runtime thresholds and benchmark methodology rather than superseded-request decode-window specialization.

---

### Session 2026-02-14 (Startup trace run labeling)

**Goal**: Improve startup trace collection hygiene across repeated platform sessions

**What was done**:
1. Added optional startup trace run label sourced from `CAP_PLAYBACK_STARTUP_TRACE_RUN_ID`.
2. Startup CSV rows now include a fifth `run_id` column.
3. Updated benchmark docs with labeled trace capture example.

**Changes Made**:
- `crates/editor/src/playback.rs`
  - added run-id capture for startup trace rows
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - documented labeled startup trace collection command

**Stopping point**: startup traces from macOS/Windows can now carry explicit run labels for easier before/after grouping.

---

### Session 2026-02-14 (Scrub benchmark multi-run aggregation)

**Goal**: Improve scrub benchmark repeatability by reducing single-run noise in comparisons

**What was done**:
1. Extended `scrub-benchmark` with `--runs <n>` support.
2. Added per-run summaries and median-across-runs aggregate reporting.
3. Validated on 1080p and 4k with 3-run aggregated passes.

**Changes Made**:
- `crates/editor/examples/scrub-benchmark.rs`
  - added `--runs` option (default 1)
  - added `ScrubSummary` and median aggregation across runs
  - output now includes per-run last-request averages when runs > 1
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added command usage and benchmark data for multi-run aggregation mode

**Results**:
- ✅ Benchmark output now exposes run-to-run variance directly and provides median summary.
- ✅ 1080p (3 runs) median last-request avg: **303.69ms**.
- ✅ 4k (3 runs) median last-request avg: **963.69ms**.
- ✅ No failures in aggregated scrub runs.

**Stopping point**: scrub tuning can now use multi-run medians as acceptance criteria, reducing false positives from one-off noisy runs.

---

### Session 2026-02-14 (Startup report baseline/candidate deltas)

**Goal**: Improve startup-latency evidence workflow for before/after validation

**What was done**:
1. Extended startup report tool with paired baseline/candidate log support.
2. Added delta output for avg and p95 startup latency per event.
3. Added tests for metric summarization path.

**Changes Made**:
- `crates/editor/examples/playback-startup-report.rs`
  - new args:
    - `--baseline-log <path>`
    - `--candidate-log <path>`
  - prints candidate-minus-baseline deltas for:
    - first decoded frame
    - first rendered frame
    - audio streaming callback
    - audio pre-rendered callback
  - kept existing `--log` aggregate mode
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - documented baseline/candidate comparison command

**Verification**:
- `cargo +1.88.0 test -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 check -p cap-editor --example playback-startup-report`

**Stopping point**: startup instrumentation evidence can now be reported as explicit before/after deltas once macOS and Windows traces are collected.

---

### Session 2026-02-14 (Scrub benchmark CSV export)

**Goal**: Make scrub benchmark outputs portable for cross-platform tuning analysis

**What was done**:
1. Extended `scrub-benchmark` with `--output-csv <path>`.
2. Added CSV row emission for each run and one aggregate row.
3. Embedded supersession runtime env values in each CSV row for threshold traceability.
4. Added optional run labeling (`--run-label` / `CAP_SCRUB_BENCHMARK_RUN_LABEL`) in CSV output.
5. Validated export flow with labeled and unlabeled benchmark passes.

**Changes Made**:
- `crates/editor/examples/scrub-benchmark.rs`
  - added `output_csv` config field and CLI parsing
  - added `run_label` config field and CLI/env wiring
  - writes append-only CSV rows with run and aggregate metrics
  - includes current supersession env vars:
    - `CAP_FFMPEG_SCRUB_SUPERSEDE_DISABLED`
    - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_PIXELS`
    - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_REQUESTS`
    - `CAP_FFMPEG_SCRUB_SUPERSEDE_MIN_SPAN_FRAMES`
    - `CAP_SCRUB_BENCHMARK_RUN_LABEL`
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - documented CSV export usage and recorded validation benchmark sample

**Verification**:
- `cargo +1.88.0 check -p cap-editor --example scrub-benchmark`
- `cargo +1.88.0 run -p cap-editor --example scrub-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --bursts 8 --burst-size 12 --sweep-seconds 2.0 --runs 2 --output-csv /tmp/cap-scrub-benchmark.csv`
- `cargo +1.88.0 run -p cap-editor --example scrub-benchmark -- --video /tmp/cap-bench-4k60.mp4 --fps 60 --bursts 8 --burst-size 12 --sweep-seconds 2.0 --runs 2 --output-csv /tmp/cap-scrub-benchmark.csv`
- `cargo +1.88.0 run -p cap-editor --example scrub-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --bursts 6 --burst-size 12 --sweep-seconds 2.0 --runs 2 --output-csv /tmp/cap-scrub-labeled.csv --run-label linux-pass-a`

**Results**:
- ✅ CSV output captured run-level and aggregate metrics for both test clips.
- ✅ Export includes supersession env values, enabling apples-to-apples threshold sweeps across machines.
- ✅ Labeled CSV rows now support explicit machine/pass grouping without separate files.
- ✅ No request failures in validation passes.

**Stopping point**: macOS and Windows scrub passes can now produce directly comparable CSV artifacts without manual copy/paste from terminal output.

---

### Session 2026-02-14 (Startup report run-id filtering)

**Goal**: Allow startup latency comparisons from shared CSV logs without manual file splitting

**What was done**:
1. Extended startup report parser to read optional CSV run-id column.
2. Added run-id filters for aggregate mode and baseline/candidate comparison mode.
3. Added `--list-runs` mode to enumerate run-id sample counts from startup CSV traces.
4. Added strict failures when a requested run-id filter matches zero startup samples.
5. Added `--output-csv` export for aggregate summaries and baseline/candidate deltas.
6. Added `--list-run-metrics` mode to print per-run startup metric summaries.
7. Added CSV export support for `--list-runs` and `--list-run-metrics` modes.
8. Added parser tests that validate run-id filtering behavior on mixed-run CSV traces.

**Changes Made**:
- `crates/editor/examples/playback-startup-report.rs`
  - CSV parser now returns optional run-id field
  - new CLI args:
    - `--run-id`
    - `--baseline-run-id`
    - `--candidate-run-id`
    - `--list-runs`
    - `--list-run-metrics`
    - `--output-csv`
  - run-id filter now excludes non-matching CSV rows before metric aggregation
  - run-id filtered queries now return explicit non-zero exit on zero matches
  - aggregate and delta modes can append CSV rows for downstream analysis
  - run-metrics mode now reports per-run decoded/rendered/audio startup summaries
  - list-runs and list-run-metrics modes can export rows via shared CSV output path
  - added unit test coverage for run-id-filtered parsing
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added command examples for run-id filtering, run listing, CSV export, and same-file baseline/candidate comparisons

**Verification**:
- `cargo +1.88.0 test -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --list-runs`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --list-run-metrics`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --list-runs --output-csv /tmp/playback-startup-run-export.csv`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --list-run-metrics --output-csv /tmp/playback-startup-run-export.csv`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --run-id missing-run` (expected non-zero exit)
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --output-csv /tmp/playback-startup-summary.csv`

**Results**:
- ✅ Startup parser supports grouped analysis across repeated sessions in one CSV file.
- ✅ Baseline/candidate deltas can now target specific labeled runs in shared trace files.
- ✅ Run-id inventory can be listed before comparisons to avoid manual CSV inspection.
- ✅ Run-metrics listing surfaces avg/p95 startup behavior per run id without manual slicing.
- ✅ CSV summaries/deltas can now be exported to files for external aggregation.
- ✅ List-run and run-metrics modes can now emit CSV artifacts for CI/report pipelines.
- ✅ All startup report example tests passing (10/10).

**Stopping point**: macOS/Windows startup captures can remain in a single trace file while still enabling precise per-run before/after reporting.

---

## References

- `PLAYBACK-BENCHMARKS.md` - Raw performance test data (auto-updated by test runner)
- `../recording/FINDINGS.md` - Recording performance findings (source of test files)
- `../recording/BENCHMARKS.md` - Recording benchmark data
- `examples/playback-test-runner.rs` - Playback test implementation
