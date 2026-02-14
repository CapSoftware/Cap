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
| `crates/editor/examples/decode-benchmark.rs` | Decode benchmark + CSV export |
| `crates/editor/examples/decode-csv-report.rs` | Decode CSV summary + label-delta analysis |
| `crates/editor/examples/playback-benchmark.rs` | Linux-compatible playback throughput benchmark |
| `crates/editor/examples/playback-csv-report.rs` | Playback CSV summary and label-delta analysis |
| `crates/editor/examples/scrub-benchmark.rs` | Scrub burst latency benchmark |
| `crates/editor/examples/scrub-csv-report.rs` | Scrub CSV summary and label-delta analysis |
| `apps/desktop/src/utils/frame-order.ts` | Wrap-safe frame-order comparisons |
| `apps/desktop/src/utils/frame-transport-order.ts` | Shared transport stale-order decision helper |
| `apps/desktop/src/utils/frame-transport-stride.ts` | Shared stride dispatch/coalescing decision helper |

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

### Session 2026-02-14 (Desktop socket frame-copy reduction)

**Goal**: Remove per-frame buffer copies from desktop websocket hot path to reduce CPU/memory overhead during preview playback

**What was done**:
1. Updated `storeRenderedFrame` in `socket.ts` to store the current frame view directly instead of copying every frame into a mirrored buffer.
2. Kept frame-capture behavior intact by cloning only at capture time.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - replaced per-frame `Uint8ClampedArray.set` copy path with direct frame-reference assignment
  - preserved width/height/stride metadata tracking for capture

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop run preparescript`
- `pnpm --dir apps/desktop build` (fails in this environment due pre-existing missing `src/app.tsx` entry expectation)

**Results**:
- ✅ Desktop TypeScript checks pass after copy-removal change.
- ✅ Hot path no longer performs a full-frame duplicate memory copy for every rendered frame.

**Stopping point**: next validation should be in-app playback profiling on macOS/Windows to quantify frame-time and CPU impact from reduced per-frame copying.

---

### Session 2026-02-14 (Adaptive SharedArrayBuffer sizing for large RGBA frames)

**Goal**: Prevent oversized RGBA frames from repeatedly bypassing SAB transport and falling back to postMessage copies

**What was done**:
1. Added adaptive SAB buffer reconfiguration in `socket.ts` based on observed frame byte size.
2. Added slot-size headroom + alignment strategy for dynamic SAB growth.
3. Added one-time resize failure guard to prevent repeated allocation attempts.
4. Restored worker transport stats accounting for:
   - frames sent via worker fallback
   - dropped queued frames when newer frames supersede pending ones
5. Added SAB telemetry counters to frame stats logs:
   - SAB resize count
   - SAB fallback count
   - oversize-triggered SAB fallback count
6. Added SAB backpressure retry path:
   - when SAB write fails due slot contention (non-oversize), frame is re-queued for next animation frame instead of immediately transferring via worker message copy
7. Added retry-limit fallback guard:
   - after bounded SAB retry attempts, transport falls back to worker transfer to avoid indefinite retry loops
8. Expanded SAB telemetry to separate:
   - oversize-triggered fallbacks
   - retry-limit-triggered fallbacks
9. Added SAB retry scheduling guard:
   - retry requeue now uses a single pending animation-frame callback to avoid stacking duplicate retry callbacks under burst pressure
10. Expanded exported FPS stats payload to include SAB transport diagnostics:
    - resize/fallback counters
    - in-flight retry count
    - current SAB slot size

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `initializeSharedBuffer`, `nextSharedBufferConfig`, and `ensureSharedBufferCapacity`
  - dynamic slot-size growth up to 64MB with adaptive slot counts
  - worker fallback now increments `framesSentToWorker`
  - queue supersession now increments `framesDropped` when replacing an already pending frame

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/socket.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ Desktop TypeScript checks pass after adaptive SAB logic.
- ✅ Large RGBA frame paths can now grow SAB capacity instead of permanently falling back to transfer-based worker messaging.
- ✅ FPS debug telemetry now reflects worker-fallback sends and dropped superseded frames.

**Stopping point**: next step is in-app validation on macOS/Windows to confirm reduced worker-transfer fallback frequency for high-resolution playback.

---

### Session 2026-02-14 (Rejected adaptive FFmpeg seek-window scaling)

**Goal**: Improve long forward seek behavior by scaling preferred FFmpeg seek windows based on seek distance

**What was done**:
1. Implemented adaptive forward/backtrack window scaling in `cap-video-decode` FFmpeg reset path.
2. Ran full decode/playback regression benchmarks on synthetic 1080p60 and 4k60 assets.
3. Reverted the code change after evaluating seek-tail regressions.

**Verification**:
- `cargo +1.88.0 check -p cap-editor`
- `cargo +1.88.0 run -p cap-editor --example decode-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --seek-iterations 10`
- `cargo +1.88.0 run -p cap-editor --example decode-benchmark -- --video /tmp/cap-bench-4k60.mp4 --fps 60 --seek-iterations 10`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --max-frames 240 --seek-iterations 10`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-4k60.mp4 --fps 60 --max-frames 240 --seek-iterations 10`

**Results**:
- ❌ Long-distance 4k seek metrics regressed:
  - decode 5.0s seek avg/p95: **1068.25 / 1734.44ms**
  - playback 5.0s seek avg/p95: **1007.51 / 1663.69ms**
- ✅ Playback throughput remained near 60fps, but seek-tail regression failed acceptance criteria.

**Decision**: keep current FFmpeg seek-window defaults and reject adaptive scaling variant.

**Stopping point**: continue seek-latency improvements through other decoder strategies; this adaptive window variant is closed.

---

### Session 2026-02-14 (Shared frame buffer slot probing under contention)

**Goal**: Reduce websocket frame transport fallback frequency when the current SAB write slot is busy

**What was done**:
1. Updated SAB producer write path to probe multiple ring slots instead of only attempting the current write index.
2. Claimed the first empty slot via CAS and wrote frame payload there.
3. Kept write-index advancement semantics, now advancing from the selected slot after a successful write.

**Changes Made**:
- `apps/desktop/src/utils/shared-frame-buffer.ts`
  - `createProducer().write` now scans up to `slotCount` candidate slots for an empty write target
  - preserves slot-state transitions (`EMPTY -> WRITING -> READY`) and metadata writes
  - returns false only when no writable slot is available

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/shared-frame-buffer.ts`
- `pnpm --dir apps/desktop exec vitest run src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ Desktop TypeScript checks pass.
- ✅ SAB producer can now write into available slots under transient contention, reducing avoidable fallback pressure.

**Stopping point**: combine with existing socket SAB telemetry on target machines to confirm lower fallback counts during high-FPS playback.

---

### Session 2026-02-14 (Shared frame buffer consumer probing for sparse-ready slots)

**Goal**: Keep consumer latency low when producer writes into non-sequential available slots under contention

**What was done**:
1. Added consumer-side ready-slot probing across the ring buffer starting from the current read index.
2. Updated `read`, `readInto`, and `borrow` to claim the first READY slot found via CAS.
3. Preserved existing timeout behavior when no READY slot is currently available.

**Changes Made**:
- `apps/desktop/src/utils/shared-frame-buffer.ts`
  - added `claimReadySlot` helper
  - consumer read APIs now probe all slots for READY state before waiting on the current read slot

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/shared-frame-buffer.ts`
- `pnpm --dir apps/desktop exec vitest run src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ Desktop unit tests pass (3/3) for writer-slot probing and sparse-ready `read`/`readInto` paths.
- ✅ Desktop TypeScript checks pass.
- ✅ Consumer path now remains compatible with producer-side sparse slot selection and avoids avoidable waits on empty read-index slots.

**Stopping point**: pair this with existing SAB transport telemetry in target-machine runs to validate reduced fallback and lower queueing jitter.

---

### Session 2026-02-14 (Shared frame buffer overwrite-on-full policy)

**Goal**: Preserve latest-frame delivery under sustained pressure without unnecessary SAB write failures

**What was done**:
1. Added producer fallback policy to reclaim READY slots when no EMPTY slots are available.
2. Prioritized reclaiming the oldest READY slot under full-buffer pressure.
3. Kept WRITING/READING slots protected; only READY slots are eligible for replacement.
4. Added unit coverage for overwrite-on-full behavior.
5. Made oldest-slot selection wrap-safe by comparing frame age in unsigned 32-bit space.
6. Added explicit `frameAge` helper and unit coverage for u32 wrap semantics.
7. Updated consumer wait strategy to wait on write-index updates, preventing missed wakeups when READY frames appear in non-read-index slots.

**Changes Made**:
- `apps/desktop/src/utils/shared-frame-buffer.ts`
  - producer write now:
    - probes EMPTY slots first
    - if none available, probes READY slots and replaces the oldest claimable READY slot
- `apps/desktop/src/utils/shared-frame-buffer.test.ts`
  - added tests verifying:
    - full-ring overwrite keeps latest frame set (`[2, 3]`) after writing `1,2,3` into 2 slots
    - READING slots are not overwritten when ring is saturated
    - oldest READY slot is replaced under mixed full-pressure conditions (`[4,5,6,7]` retained)

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/shared-frame-buffer.ts apps/desktop/src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec vitest run src/utils/shared-frame-buffer.test.ts` (6 passed)
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ Desktop unit tests pass (6/6) for sparse-slot, oldest-ready overwrite, and READING-slot protection behaviors.
- ✅ Producer now avoids avoidable write failures when buffer is saturated with READY slots and can keep newer frames flowing.

**Stopping point**: validate on macOS/Windows with SAB telemetry to confirm reduced worker fallback rate under sustained high-resolution playback.

---

### Session 2026-02-14 (Frame transport config extraction and memory-budgeted SAB sizing)

**Goal**: Make SAB sizing policy testable and enforce a bounded total shared-memory footprint

**What was done**:
1. Extracted SAB sizing policy into a dedicated utility module.
2. Replaced socket-local sizing heuristics with shared `computeSharedBufferConfig` logic.
3. Added explicit total shared-memory budget handling (`FRAME_BUFFER_MAX_TOTAL_BYTES`) to derive slot counts from slot size.
4. Added dedicated unit tests for default sizing, growth behavior, and max-size budget caps.

**Changes Made**:
- `apps/desktop/src/utils/frame-transport-config.ts`
  - new constants and helpers for SAB sizing policy
  - exported `computeSharedBufferConfig`
- `apps/desktop/src/utils/socket.ts`
  - now imports and uses extracted SAB sizing utility
  - removed inline sizing heuristics
- `apps/desktop/src/utils/frame-transport-config.test.ts`
  - added 3 tests covering:
    - default behavior for small frames
    - aligned growth for larger frames
    - slot-size cap and total-memory budget enforcement

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/socket.ts apps/desktop/src/utils/frame-transport-config.ts apps/desktop/src/utils/frame-transport-config.test.ts`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/shared-frame-buffer.test.ts` (8 passed)
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ SAB sizing policy is now reusable and test-covered.
- ✅ Shared memory usage now remains bounded while still scaling slot size for large frames.
- ✅ Desktop tests and TypeScript checks pass.

**Stopping point**: next target-machine runs should use SAB diagnostics to confirm lower fallback counts with memory budget still within acceptable limits.

---

### Session 2026-02-14 (SAB retry decision extraction + test coverage)

**Goal**: Make SAB retry/fallback policy deterministic and test-covered

**What was done**:
1. Extracted SAB write-failure decision logic into a dedicated helper.
2. Replaced inline socket retry branch logic with helper-driven decisions.
3. Added targeted unit tests for oversize fallback, retry progression, and retry-limit fallback.

**Changes Made**:
- `apps/desktop/src/utils/frame-transport-retry.ts`
  - added `decideSabWriteFailure`
  - explicit decision outcomes:
    - `retry`
    - `fallback_oversize`
    - `fallback_retry_limit`
- `apps/desktop/src/utils/socket.ts`
  - now consumes `decideSabWriteFailure` for SAB write-failure handling
- `apps/desktop/src/utils/frame-transport-retry.test.ts`
  - added 3 tests covering all decision outcomes

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/socket.ts apps/desktop/src/utils/frame-transport-retry.ts apps/desktop/src/utils/frame-transport-retry.test.ts`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-retry.test.ts src/utils/frame-transport-config.test.ts src/utils/shared-frame-buffer.test.ts` (11 passed)
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ SAB retry policy behavior is now isolated, testable, and easier to tune.
- ✅ Desktop tests and TypeScript checks pass.

**Stopping point**: keep using SAB telemetry counters on target machines to tune retry limit and slot sizing defaults from real playback traces.

---

### Session 2026-02-14 (Frame-age helper extraction for wrap-safe ordering)

**Goal**: Make wrap-safe frame ordering explicit and testable in shared-buffer reclaim logic

**What was done**:
1. Extracted unsigned wrap-safe frame-age computation into `frameAge`.
2. Replaced inline reclaim age arithmetic with helper usage.
3. Added unit tests for wrap semantics around `0xffffffff -> 0`.

**Changes Made**:
- `apps/desktop/src/utils/shared-frame-buffer.ts`
  - added exported `frameAge(current, candidate)`
  - producer reclaim path now calls `frameAge` when selecting oldest READY frame
- `apps/desktop/src/utils/shared-frame-buffer.test.ts`
  - added `computes frame age across u32 wrap`

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/shared-frame-buffer.ts apps/desktop/src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec vitest run src/utils/shared-frame-buffer.test.ts src/utils/frame-transport-retry.test.ts src/utils/frame-transport-config.test.ts` (13 passed)
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ Shared-buffer ordering logic now has a dedicated wrap-safe primitive with direct test coverage.
- ✅ Desktop transport utility tests and typecheck remain green.

**Stopping point**: continue using this helper for any future reclaim policy tuning that depends on frame ordering.

---

### Session 2026-02-14 (Performance overlay transport diagnostics)

**Goal**: Surface SAB transport telemetry directly in overlay UI for faster cross-platform validation

**What was done**:
1. Wired overlay to read live socket transport stats via `getFpsStats`.
2. Added transport diagnostics to overlay panel:
   - render FPS
   - transport MB/s
   - SAB slot size, slot count, total SAB memory, and resize count
   - SAB fallback counters (oversize vs retry-limit)
   - in-flight SAB retry count
3. Extended clipboard export payload with the same transport diagnostics.

**Changes Made**:
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - added transport stats polling and reset behavior
  - added transport diagnostics rows to overlay UI
  - added transport fields to copied stats text

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
- `pnpm --dir apps/desktop exec tsc --noEmit`

**Results**:
- ✅ Desktop TypeScript checks pass.
- ✅ Overlay now exposes SAB transport metrics needed for target-machine playback tuning sessions.

**Stopping point**: use this diagnostics panel in upcoming macOS/Windows runs to collect evidence for fallback-rate and transport-throughput behavior.

---

### Session 2026-02-14 (Cumulative SAB fallback counters for diagnostics stability)

**Goal**: Keep overlay diagnostics stable across sampling windows by preserving cumulative fallback counters

**What was done**:
1. Split SAB fallback counters into:
   - cumulative totals (for exported FPS stats / overlay)
   - window counters (for per-log-frame console snapshots)
2. Updated websocket frame log output to include both window and total fallback counters.
3. Stopped resetting cumulative fallback counters in the periodic logging reset path.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added window counter variables for SAB fallback classes
  - log output now prints `*_window` and `*_total` values
  - `getFpsStats()` now remains backed by cumulative fallback counters

**Verification**:
- `pnpm exec biome format --write apps/desktop/src/utils/socket.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-retry.test.ts src/utils/frame-transport-config.test.ts src/utils/shared-frame-buffer.test.ts` (13 passed)

**Results**:
- ✅ Overlay/clipboard transport diagnostics now remain monotonic across log windows.
- ✅ Console output still includes short-window fallback visibility for burst debugging.

**Stopping point**: ready for target-machine playback sessions where cumulative fallback totals are needed across longer runs.

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

### Session 2026-02-14 (SAB lifetime transport counters in overlay)

**Goal**: Improve real-machine playback diagnostics with cumulative SAB transport counters for longer editor runs

**What was done**:
1. Extended `FpsStats` in the desktop socket transport with cumulative counters for received frames, worker fallback frames, and superseded frame drops.
2. Wired cumulative counter increments through websocket receive and fallback/drop paths while keeping existing 60-frame window counters unchanged.
3. Added the new cumulative counters to the performance overlay state and clipboard export payload.
4. Added an always-on overlay row showing lifetime SAB transport totals once traffic is present.
5. Re-ran desktop typecheck and targeted frame-transport vitest coverage.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - Added `sabTotalFramesReceived`, `sabTotalFramesSentToWorker`, `sabTotalSupersededDrops` to `FpsStats`
  - Added lifetime counter bookkeeping and metric emission in `getLocalFpsStats`
  - Incremented lifetime counters in receive, fallback-to-worker, and superseded-drop branches
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - Extended transport state/reset and socket polling to include new lifetime counters
  - Included lifetime counters in clipboard dump
  - Rendered a new `SAB totals` row in overlay diagnostics

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Overlay now reports lifetime transport behavior during extended playback sessions.
- ✅ Clipboard exports now include cumulative SAB receive/fallback/superseded counters for cross-machine comparisons.
- ✅ Desktop TS typecheck and all targeted transport tests pass.

**Stopping point**: Ready for macOS/Windows runs to capture longer-session SAB behavior and correlate fallback totals with observed FPS/audio startup traces.

---

### Session 2026-02-14 (SAB write fast-path dispatch and totals)

**Goal**: Reduce frame handoff stalls when SharedArrayBuffer writes succeed and improve transport-path attribution in overlay telemetry

**What was done**:
1. Updated socket frame dispatch so successful SAB writes no longer wait for worker queue callbacks before accepting the next frame.
2. Added cumulative SAB write-success counter to transport stats.
3. Extended overlay diagnostics and clipboard export with explicit recv/sab/worker/superseded totals.
4. Re-ran desktop typecheck and transport utility test suite.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `sabTotalFramesWrittenToSharedBuffer` to `FpsStats`
  - added cumulative counter tracking for successful SAB writes
  - changed successful SAB write path in `processNextFrame` to clear `isProcessing` immediately and continue dispatching pending frames without waiting for worker ack events
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - extended transport state/reset/polling with `sabTotalFramesWrittenToSharedBuffer`
  - added clipboard export line for SAB-written totals
  - updated `SAB totals` row to show `recv / sab / worker / superseded`

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ SAB success path no longer serializes on worker `frame-queued` acknowledgements, reducing dispatch-side stalls.
- ✅ Overlay and clipboard output now expose explicit SAB-written totals alongside worker fallback totals for easier cross-machine diagnosis.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for next macOS/Windows validation pass to compare worker fallback share against total SAB write share during long playback sessions.

---

### Session 2026-02-14 (SAB retry total diagnostics and drop accounting fix)

**Goal**: Improve long-session transport diagnostics by exposing cumulative retry counts and correcting superseded-drop totals in retry pressure paths

**What was done**:
1. Added cumulative retry-attempt counter to socket transport stats.
2. Fixed superseded-drop total accounting when retry scheduling replaces an already queued `nextFrame`.
3. Extended overlay and clipboard diagnostics with retry totals.
4. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `sabTotalRetryAttempts` to `FpsStats`
  - increments cumulative retry counter on each `decision.action === "retry"` branch
  - increments cumulative superseded-drop counter when retry path evicts an existing queued frame
  - emits retry totals through `getLocalFpsStats`
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - extended transport state/reset/polling with `sabTotalRetryAttempts`
  - added retry total to clipboard export
  - expanded `SAB totals` row to include cumulative retry count

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Overlay/clipboard now expose cumulative retry pressure during long runs.
- ✅ Superseded-drop totals now include retry-path queue replacement events.
- ✅ Desktop typecheck and transport utility tests pass.

**Stopping point**: Ready for cross-machine sessions to compare retry pressure against fallback and frame-drop totals when evaluating SAB contention behavior.

---

### Session 2026-02-14 (direct-render metadata parse gating)

**Goal**: Reduce main-thread websocket overhead by avoiding duplicate metadata parsing when frames are routed directly to worker/SAB transport

**What was done**:
1. Added a shared `enqueueFrameBuffer` path for worker/SAB dispatch.
2. Added a direct-render capability gate in websocket message handling.
3. Bypassed metadata decode/validation on the main thread when direct canvas rendering is inactive.
4. Kept metadata parsing on direct-render path only (main-thread WebGPU/canvas fallback).
5. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - introduced `enqueueFrameBuffer(buffer)` helper for consistent pending/next-frame supersession handling
  - `ws.onmessage` now computes `shouldRenderDirect`
  - when direct rendering is unavailable, frame buffers are enqueued immediately without local metadata parse
  - retained existing metadata parse/validation for direct-render branches only

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`

**Results**:
- ✅ Worker/SAB path now avoids duplicate per-frame metadata parsing on main thread.
- ✅ Direct-render behavior remains unchanged and still validates frame metadata before rendering.
- ✅ Desktop typecheck and transport tests pass.

**Stopping point**: Ready for macOS/Windows editor sessions to validate whether reduced main-thread frame parsing lowers transport-side frame jitter under sustained playback.

---

### Session 2026-02-14 (worker fallback transfer volume telemetry)

**Goal**: Quantify cumulative worker fallback transfer cost during long playback sessions for cross-machine transport analysis

**What was done**:
1. Added cumulative fallback transfer bytes counter in socket transport stats.
2. Wired byte accumulation on all worker-posted frame paths (SAB fallback and no-SAB mode).
3. Extended performance overlay diagnostics and clipboard export with fallback transfer megabytes.
4. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `sabTotalWorkerFallbackBytes` to `FpsStats`
  - accumulates `buffer.byteLength` whenever frame payload is sent through worker `postMessage`
  - emits cumulative fallback bytes through `getLocalFpsStats`
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - extended transport state/reset/polling with `sabTotalWorkerFallbackBytes`
  - clipboard export now includes cumulative fallback transfer MB
  - `SAB totals` row now appends fallback transfer megabytes

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Overlay now shows cumulative fallback transfer volume in MB for sustained sessions.
- ✅ Clipboard exports now include worker fallback byte totals for external comparison.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for macOS/Windows captures to correlate fallback transfer volume with observed frame pacing and SAB contention counters.

---

### Session 2026-02-14 (transport split percentage diagnostics)

**Goal**: Make long-session transport attribution easier by surfacing SAB-vs-worker share percentages directly in overlay and clipboard output

**What was done**:
1. Added derived transport split metrics for SAB and worker frame share.
2. Added derived superseded-drop percentage relative to total received frames.
3. Extended clipboard export and overlay rows with these percentages.
4. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - added derived helpers:
    - total transported frame count
    - SAB frame share percent
    - worker frame share percent
    - superseded-drop percent
  - clipboard export now includes all three percentages
  - new overlay row displays transport split percentages during active sessions

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Overlay now provides immediate percentage-level attribution for SAB vs worker transport usage.
- ✅ Clipboard exports include normalized split metrics for easier cross-machine comparison.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for macOS/Windows diagnostics runs where percentage splits can be compared alongside fallback byte totals and startup timing traces.

---

### Session 2026-02-14 (worker SAB polling borrow-path optimization)

**Goal**: Reduce worker-side frame copy overhead when consuming shared-buffer frames in non-WebGPU render mode

**What was done**:
1. Reworked shared-buffer polling in frame worker canvas path to use borrowed SAB frames.
2. Removed extra `readInto` copy buffer path for non-WebGPU polling.
3. Kept release-callback semantics through existing `queueFrameFromBytes` flow.
4. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - `tryPollSharedBuffer` now uses `consumer.borrow(0)` and forwards borrowed data to `queueFrameFromBytes`
  - removed `sharedReadBuffer` / `sharedReadBufferSize` scratch buffer state
  - removed obsolete shared buffer reset assignments in cleanup/init paths

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Worker canvas fallback path no longer copies SAB frames through an intermediate `readInto` buffer.
- ✅ Existing release lifecycle remains managed by `queueFrameFromBytes`.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for macOS/Windows validation to confirm reduced copy pressure in non-WebGPU fallback sessions.

---

### Session 2026-02-14 (shared-buffer queue-message suppression)

**Goal**: Cut worker-to-main-thread message volume during shared-buffer playback by suppressing queue notifications that are not needed for SAB dispatch flow

**What was done**:
1. Added optional queue-notification emission control in shared frame queue helper.
2. Disabled `frame-queued` postMessage emission for shared-buffer polling path.
3. Kept queue notifications enabled for direct worker-posted fallback frames.
4. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - `queueFrameFromBytes` now accepts `emitQueuedMessage` flag (default `true`)
  - `tryPollSharedBuffer` now calls `queueFrameFromBytes(..., false)` for borrowed SAB frames
  - preserves existing queue notifications for non-SAB worker frame messages

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ SAB polling path no longer emits per-frame `frame-queued` worker messages.
- ✅ Fallback worker-posted frame path behavior remains unchanged.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for macOS/Windows diagnostics to validate reduced main-thread message churn under sustained shared-buffer playback.

---

### Session 2026-02-14 (socket frame-queued callback reduction)

**Goal**: Reduce redundant main-thread update work by removing duplicate frame-dimension callback traffic from worker `frame-queued` events

**What was done**:
1. Removed `onmessage({ width, height })` dispatch on `frame-queued` worker events.
2. Preserved `isProcessing` reset and `processNextFrame` scheduling behavior for worker fallback flow.
3. Kept frame-dimension updates on `frame-rendered`, which already reflects the displayed frame.
4. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - `worker.onmessage` `frame-queued` branch now only:
    - clears `isProcessing`
    - calls `processNextFrame()`
  - removed redundant early `onmessage` callback for queued-but-not-yet-rendered frames

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`

**Results**:
- ✅ Worker fallback path still advances queue dispatch correctly.
- ✅ Main-thread frame callback traffic reduced by dropping queued-frame duplicate notifications.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for macOS/Windows validation to compare UI-thread callback load and transport-side stability under fallback-heavy sessions.

---

### Session 2026-02-14 (canvas shared-buffer latest-frame draining)

**Goal**: Reduce wasted parse/copy work in canvas fallback mode by draining SAB bursts to the latest frame before queueing

**What was done**:
1. Added canvas-mode SAB drain helper in worker.
2. Changed render loop SAB polling branch to drain up to four borrowed frames and keep only latest for canvas mode.
3. Kept existing WebGPU drain behavior unchanged.
4. Preserved pending-mode polling behavior.
5. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - added `drainAndQueueLatestSharedCanvas(maxDrain)` helper
  - render loop now:
    - uses `drainAndRenderLatestSharedWebGPU(8)` for webgpu mode
    - uses `drainAndQueueLatestSharedCanvas(4)` for canvas2d mode
    - retains existing `tryPollSharedBuffer` loop for pending mode

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Canvas SAB path now avoids processing multiple stale frames when bursts arrive between render ticks.
- ✅ WebGPU and pending paths remain behaviorally unchanged.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for macOS/Windows fallback validation to confirm reduced canvas-path copy pressure during sustained playback bursts.

---

### Session 2026-02-14 (pending-mode SAB drain coalescing)

**Goal**: Reduce stale-frame churn and queue-message volume in renderer-pending startup windows under shared-buffer burst traffic

**What was done**:
1. Removed per-frame shared-buffer polling loop for pending mode.
2. Unified non-WebGPU SAB draining into latest-frame coalescing helper.
3. Kept one queue notification for pending mode while preserving zero queue notifications for canvas-mode SAB drains.
4. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - removed `tryPollSharedBuffer` per-frame borrow loop
  - renamed/generalized canvas drain helper to:
    - `drainAndQueueLatestSharedFrame(maxDrain, emitQueuedMessage)`
  - render loop now uses:
    - `drainAndQueueLatestSharedFrame(4, false)` for `canvas2d`
    - `drainAndQueueLatestSharedFrame(4, true)` for `pending`
  - WebGPU drain path remains unchanged (`drainAndRenderLatestSharedWebGPU`)

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Pending mode now coalesces SAB bursts to latest frame before queueing, reducing stale queued-frame churn.
- ✅ Canvas mode retains queue-message suppression behavior introduced previously.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for startup-heavy playback validation to verify smoother pending-to-renderer transition under bursty shared-buffer traffic.

---

### Session 2026-02-14 (worker fallback ack bypass)

**Goal**: Reduce fallback-path postMessage round-trips by removing queue-ack pacing between socket and worker

**What was done**:
1. Switched worker fallback dispatch in socket to non-blocking progression (mirroring SAB success path behavior).
2. Removed worker `frame-queued` message emission for `frame` payload handling.
3. Kept worker `frame-rendered` and error messaging unchanged.
4. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - after worker fallback `postMessage({ type: "frame" })`, now clears `isProcessing` immediately
  - continues dispatching pending `nextFrame` / `pendingFrame` without waiting for worker queue acknowledgements
- `apps/desktop/src/utils/frame-worker.ts`
  - `self.onmessage` `type === "frame"` path now suppresses `frame-queued` outbound message
  - still forwards `error` messages from `processFrameBytesSync`

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/utils/frame-worker.ts`

**Results**:
- ✅ Fallback path no longer depends on per-frame queue acknowledgement messages for dispatch progress.
- ✅ Worker->main-thread message volume reduced by dropping fallback `frame-queued` events.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback-heavy playback validation to compare frame pacing and worker message traffic after ack bypass.

---

### Session 2026-02-14 (frame-worker queue path deduplication)

**Goal**: Reduce fallback-frame processing overhead by removing duplicate frame parsing/queueing code paths in worker message handling

**What was done**:
1. Refactored worker `frame` message handling to use `queueFrameFromBytes` directly.
2. Removed `processFrameBytesSync` duplicate decode/queue implementation.
3. Updated `queueFrameFromBytes` to:
   - return boolean success/failure
   - start render loop internally
4. Preserved worker error reporting when metadata parsing fails.
5. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - `queueFrameFromBytes` now returns `boolean` and calls `startRenderLoop()`
  - `self.onmessage` `type === "frame"` path now:
    - calls `queueFrameFromBytes(new Uint8Array(buffer), undefined, false)`
    - emits `error` message on failed parse
  - removed obsolete `DecodeResult` type and `processFrameBytesSync` function

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Worker fallback frame handling now follows a single queueing/parsing path.
- ✅ Duplicate parse/stride/copy branches removed from worker message handler.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback-heavy desktop runs to validate reduced worker-side overhead under sustained postMessage transport.

---

### Session 2026-02-14 (single-slot worker queue compaction)

**Goal**: Minimize worker queue churn and stale-frame processing by compacting queued frames to a single latest sample across render modes

**What was done**:
1. Added shared queue-clearing helper that releases pending borrowed WebGPU frames safely.
2. Updated frame enqueue path to clear existing queued entries before pushing the new frame in both WebGPU/pending and canvas modes.
3. Removed unused fixed queue-size constant and migrated reset/cleanup paths to shared queue-clearing helper.
4. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - added `clearQueuedFrames()` helper
  - `queueFrameFromBytes` now compacts to a single latest frame by clearing existing queue before push
  - removed `FRAME_QUEUE_SIZE` constant and old shift-based queue trimming
  - reset/cleanup paths now call `clearQueuedFrames()`

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Worker queue now keeps only latest frame payload, reducing stale-frame backlog and queue maintenance overhead.
- ✅ WebGPU borrowed-frame releases remain correctly handled through centralized queue clear logic.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for sustained playback validation to confirm queue compaction reduces worker overhead under bursty transport conditions.

---

### Session 2026-02-14 (render loop single-frame fast path)

**Goal**: Reduce worker render-loop overhead by removing unnecessary queue scans after queue compaction to single-latest semantics

**What was done**:
1. Simplified render-loop frame selection to direct head lookup (`frameQueue[0]`).
2. Removed full-queue max-frame scan and duplicate frame cleanup loop.
3. Preserved pending-mode behavior by keeping frame queued until renderer becomes available.
4. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - render loop no longer computes `frameToRender`/`frameIndex` via queue iteration
  - now uses direct frame head check with targeted `shift()` when rendering/converting
  - pending-mode `webgpu` frame retention remains intact until renderer init completes

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Render-loop queue-selection overhead reduced to O(1) after single-slot queue compaction.
- ✅ Pending-mode frame retention semantics preserved.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for desktop playback validation to confirm lower worker-loop overhead under sustained shared-buffer traffic.

---

### Session 2026-02-14 (frame-queued message removal and queue drain cleanup)

**Goal**: Remove now-redundant `frame-queued` message traffic and simplify shared-buffer drain control flow after socket-side ack bypass changes

**What was done**:
1. Removed `frame-queued` worker message type and all socket-side handling branches.
2. Simplified shared-frame drain helper usage in worker by removing queue-message emission toggles.
3. Updated fallback `frame` message handling to call queue path directly without queue-ack emission.
4. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - removed `FrameQueuedMessage` interface/export
  - removed `emitQueuedMessage` parameter from queue/drain helpers
  - shared-buffer canvas/pending drain now uses unified `drainAndQueueLatestSharedFrame(4)`
  - fallback `frame` onmessage path now calls `queueFrameFromBytes(new Uint8Array(buffer))`
- `apps/desktop/src/utils/socket.ts`
  - removed `FrameQueuedMessage` interface from worker message union
  - removed `worker.onmessage` `frame-queued` branch

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts src/utils/socket.ts`

**Results**:
- ✅ Worker/main-thread queue-ack message path fully removed.
- ✅ Shared-buffer drain code simplified with equivalent latest-frame behavior.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback-heavy validation to confirm reduced worker/main-thread message overhead and stable dispatch behavior after queue-ack removal.

---

### Session 2026-02-14 (worker raw-frame cache copy removal)

**Goal**: Reduce canvas-path per-frame memory copy overhead by removing redundant raw-frame cache maintenance

**What was done**:
1. Removed dedicated `lastRawFrame*` cache state from frame worker.
2. Stopped copying every canvas-path frame into the removed raw cache.
3. Updated WebGPU init replay path to use `lastImageData` directly.
4. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - removed:
    - `lastRawFrameData`
    - `lastRawFrameWidth`
    - `lastRawFrameHeight`
  - removed per-frame `lastRawFrameData.set(processedFrameData)` copy in `queueFrameFromBytes`
  - `initCanvas` WebGPU replay now renders from `lastImageData.data` and dimensions
  - cleanup path no longer resets removed raw-cache fields

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Canvas-path enqueue no longer performs redundant full-frame copy into raw cache.
- ✅ WebGPU initialization replay continues using latest rendered image data.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for desktop validation to confirm reduced worker memory bandwidth during canvas fallback sessions.

---

### Session 2026-02-14 (readback overlap in frame pipeline)

**Goal**: Increase render/readback overlap by submitting current-frame readback before waiting on prior pending map completion

**What was done**:
1. Updated frame pipeline finalization order to capture previous pending readback handle first.
2. Submitted current frame readback immediately.
3. Deferred waiting on previous pending readback until after current submission.
4. Retained current-frame return semantics by still awaiting current pending readback before returning.
5. Re-ran rendering crate check and playback benchmark passes for 1080p and 4k.

**Changes Made**:
- `crates/rendering/src/frame_pipeline.rs`
  - `finish_encoder` now:
    - stores previous pending readback with `take_pending()`
    - submits current frame readback
    - waits previous pending (if any)
    - waits and returns current pending frame

**Verification**:
- `cargo +1.88.0 check -p cap-rendering`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --max-frames 240 --seek-iterations 8`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-4k60.mp4 --fps 60 --max-frames 240 --seek-iterations 8`
- `cargo +1.88.0 fmt --all`

**Results**:
- ✅ 1080p playback benchmark remained stable:
  - effective FPS 60.24, missed deadlines 0
  - decode p95 2.14ms
- ✅ 4k playback benchmark remained stable:
  - effective FPS 60.18, missed deadlines 0
  - decode p95 7.13ms
- ✅ No regressions detected in sequential throughput; seek profile remained within expected variance envelope.

**Stopping point**: Ready for target-machine desktop validation to confirm overlap change improves real preview frame pacing under sustained render load.

---

### Session 2026-02-14 (decoded transport branch cleanup)

**Goal**: Remove stale worker/socket transport branch handling that was no longer emitted after queue-ack path removal

**What was done**:
1. Removed unused `DecodedFrame` message type from worker utilities.
2. Removed `decoded` branch handling from socket worker message dispatcher.
3. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - removed `DecodedFrame` interface/export
- `apps/desktop/src/utils/socket.ts`
  - removed `DecodedFrame` interface and worker message union entry
  - removed dead `if (e.data.type === "decoded")` handling block

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts src/utils/socket.ts`

**Results**:
- ✅ Worker/socket message surface now matches currently emitted runtime events.
- ✅ Removed dead branch logic from socket worker dispatcher.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for continued transport tuning with reduced message-schema complexity.

---

### Session 2026-02-14 (single-slot queue variable refactor)

**Goal**: Reduce worker render-loop bookkeeping overhead by replacing array-backed single-item queue usage with explicit nullable frame slot

**What was done**:
1. Replaced `frameQueue: PendingFrame[]` with `queuedFrame: PendingFrame | null`.
2. Updated queue clear helper to release and clear single slot.
3. Updated enqueue and render-loop logic to use direct nullable slot checks and assignments.
4. Preserved pending-mode behavior and shared-buffer polling flow.
5. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - replaced queue storage with `queuedFrame`
  - `clearQueuedFrames` now releases one pending webgpu borrowed frame if present
  - `queueFrameFromBytes` writes directly to `queuedFrame`
  - render loop now reads `queuedFrame` directly and clears via `queuedFrame = null` on consume
  - `shouldContinue` checks now use `queuedFrame !== null`

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts`

**Results**:
- ✅ Worker queue bookkeeping now fully O(1) with no array operations on hot path.
- ✅ Queue semantics remain single-latest as intended.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for runtime validation of reduced worker-loop overhead under sustained playback.

---

### Session 2026-02-14 (socket microtask dispatch scheduling)

**Goal**: Reduce synchronous recursion pressure in socket dispatch path by deferring chained `processNextFrame` calls through a guarded microtask scheduler

**What was done**:
1. Added guarded microtask scheduler for `processNextFrame`.
2. Replaced immediate recursive/inline `processNextFrame` calls in worker error path and post-dispatch continuation branches.
3. Updated enqueue path to schedule processing instead of direct invocation.
4. Reset scheduling guard during cleanup.
5. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `processNextScheduled` guard and `scheduleProcessNextFrame()` helper
  - uses `queueMicrotask` to coalesce follow-up processing into one pending microtask
  - replaced direct continuation calls in:
    - worker `error` handling
    - worker fallback postMessage continuation
    - SAB success continuation
    - non-SAB postMessage continuation
    - enqueue initial dispatch
  - cleanup now resets `processNextScheduled`

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`

**Results**:
- ✅ Socket dispatch path now avoids deep synchronous chaining when multiple pending frames are waiting.
- ✅ Processing remains coalesced via single scheduled microtask guard.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for sustained playback validation to confirm flatter main-thread call stacks under fallback-heavy transport conditions.

---

### Session 2026-02-14 (worker in-flight gating for fallback dispatch)

**Goal**: Prevent unbounded fallback postMessage backlog after queue-ack removal by adding explicit worker in-flight frame cap in socket dispatch

**What was done**:
1. Added worker in-flight frame tracking in socket transport.
2. Enforced in-flight limit before posting fallback frames to worker.
3. Updated worker message handlers to decrement in-flight count on render/error completion.
4. Added in-flight diagnostics to transport stats and overlay display.
5. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added:
    - `WORKER_IN_FLIGHT_LIMIT = 2`
    - `workerFramesInFlight` runtime counter
  - fallback postMessage paths now:
    - gate on `workerFramesInFlight >= WORKER_IN_FLIGHT_LIMIT`
    - requeue latest frame instead of pushing unbounded worker backlog
  - increments in-flight counter on fallback postMessage dispatch
  - decrements in-flight counter on worker `frame-rendered` and `error`
  - exports `workerFramesInFlight` via `FpsStats`
  - cleanup now resets in-flight counter
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/polling now includes `workerFramesInFlight`
  - clipboard export includes worker in-flight count
  - overlay now shows `Worker frames in flight` when non-zero

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Fallback dispatch now has explicit bounded in-flight pressure control.
- ✅ Main-thread retains latest-frame supersession behavior instead of feeding unbounded worker queue.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback-heavy target-machine runs to evaluate whether capped in-flight fallback improves pacing and drop behavior under sustained contention.

---

### Session 2026-02-14 (in-flight cap backoff spin avoidance)

**Goal**: Prevent microtask reschedule spin when worker fallback in-flight cap is reached

**What was done**:
1. Removed immediate `scheduleProcessNextFrame()` calls from both fallback branches when `workerFramesInFlight` is already at cap.
2. Kept latest-frame supersession behavior (`nextFrame` replacement) unchanged.
3. Relied on existing worker completion callbacks (`frame-rendered` / `error`) to resume queued dispatch.
4. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - in `processNextFrame` fallback paths:
    - when `workerFramesInFlight >= WORKER_IN_FLIGHT_LIMIT`, now stores latest frame and returns without scheduling another immediate microtask
  - avoids tight no-progress scheduling loops while worker backlog is saturated

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`

**Results**:
- ✅ In-flight cap path no longer schedules repeated microtasks without worker capacity.
- ✅ Dispatch resumes via worker completion events as intended.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback contention validation to confirm reduced main-thread scheduling churn when worker in-flight cap is active.

---

### Session 2026-02-14 (worker in-flight cap hit telemetry)

**Goal**: Improve fallback-pressure diagnostics by exposing how often worker in-flight capping blocks immediate postMessage dispatch

**What was done**:
1. Added cumulative counter for worker in-flight cap hits in socket transport.
2. Incremented counter in both fallback branches when dispatch is blocked by in-flight cap.
3. Exposed new metric through `FpsStats`.
4. Added overlay and clipboard output for cap-hit totals.
5. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `workerInFlightBackpressureHits` to `FpsStats`
  - added `totalWorkerInFlightBackpressureHits` runtime counter
  - increments counter when `workerFramesInFlight >= WORKER_IN_FLIGHT_LIMIT`
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - extended transport stats state/reset/polling with `workerInFlightBackpressureHits`
  - clipboard export includes `Worker In-Flight Cap Hits`
  - overlay now shows `Worker in-flight cap hits` row when non-zero

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Diagnostics now surface how frequently fallback dispatch is blocked by in-flight limits.
- ✅ Overlay and clipboard provide direct visibility into cap-pressure behavior during long sessions.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback contention runs to correlate cap-hit frequency with superseded drops, retry counts, and FPS stability.

---

### Session 2026-02-14 (worker cap-hit window diagnostics)

**Goal**: Improve short-window fallback-pressure visibility by surfacing windowed worker in-flight cap-hit counters alongside cumulative totals

**What was done**:
1. Added window-scoped worker cap-hit counter in socket runtime metrics.
2. Incremented window counter on each in-flight cap block event.
3. Included both window and cumulative cap-hit metrics in periodic frame logs.
4. Exposed window metric through `FpsStats` and Performance Overlay.
5. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `workerInFlightBackpressureWindowHits` to `FpsStats`
  - tracks `workerInFlightBackpressureWindowHits` per 60-frame logging window
  - logs:
    - `worker_inflight`
    - `worker_cap_hits_window`
    - `worker_cap_hits_total`
  - resets window counter after each frame-log window flush
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - extended transport state/reset/polling with `workerInFlightBackpressureWindowHits`
  - clipboard export includes window cap-hit value
  - overlay shows `Worker cap hits (window)` when non-zero

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Diagnostics now distinguish burst-window cap pressure from cumulative long-session totals.
- ✅ Frame logs provide immediate cap-pressure context without requiring overlay inspection.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for cross-machine fallback stress sessions to compare cap-hit bursts across short windows and entire runs.

---

### Session 2026-02-14 (worker in-flight peak diagnostics)

**Goal**: Add peak worker in-flight visibility to complement cap-hit counters and better characterize fallback backlog pressure

**What was done**:
1. Added worker in-flight peak counters (window and cumulative) to socket transport metrics.
2. Updated fallback dispatch paths to update peak counters whenever in-flight count increments.
3. Extended periodic frame logs with peak in-flight window/total values.
4. Reset window peak at each stats window flush while preserving cumulative peak.
5. Added peak metrics to overlay and clipboard diagnostics.
6. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `workerFramesInFlightPeakWindow` and `workerFramesInFlightPeakTotal` to `FpsStats`
  - tracks peak counters during fallback postMessage dispatch
  - periodic `[Frame]` log now includes:
    - `worker_inflight_peak_window`
    - `worker_inflight_peak_total`
  - resets window peak on each log-window flush
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling now includes both peak metrics
  - clipboard export includes worker in-flight peak values
  - overlay shows `Worker in-flight peak: <window> window / <total> total`

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Diagnostics now expose instantaneous, windowed, and cumulative backlog pressure for fallback worker dispatch.
- ✅ Frame logs include peak pressure context for terminal-only benchmark sessions.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback stress validation to correlate peak in-flight backlog with cap-hit frequencies and superseded-drop behavior.

---

### Session 2026-02-14 (worker in-flight superseded-drop diagnostics)

**Goal**: Distinguish drops caused specifically by worker in-flight cap pressure from other superseded-frame drop causes

**What was done**:
1. Added cumulative and window counters for superseded drops that occur while worker in-flight cap is active.
2. Incremented these counters only when cap-hit branches overwrite an existing `nextFrame`.
3. Added counters to socket frame logs and transport stats payload.
4. Exposed the metrics in overlay and clipboard diagnostics.
5. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added to `FpsStats`:
    - `workerInFlightSupersededDrops`
    - `workerInFlightSupersededDropsWindow`
  - tracks both counters in fallback cap-hit overwrite branches
  - periodic `[Frame]` log now includes:
    - `worker_superseded_window`
    - `worker_superseded_total`
  - resets window counter on log-window flush
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling now includes in-flight superseded-drop metrics
  - clipboard export includes both total and window values
  - overlay row shows `Worker in-flight superseded drops` with window suffix when present

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Diagnostics now isolate cap-pressure-induced superseded drops from broader drop totals.
- ✅ Frame logs and overlay provide both burst-window and cumulative visibility for this drop mode.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback-pressure validation to quantify how much dropping is attributable specifically to worker in-flight capping.

---

### Session 2026-02-14 (render-source-aware in-flight accounting)

**Goal**: Correct fallback in-flight accounting by distinguishing worker-posted renders from shared-buffer renders and extend backlog pressure telemetry

**What was done**:
1. Added render source tagging to worker `frame-rendered` messages (`shared` vs `worker`).
2. Updated socket in-flight decrement logic to only decrement on `source === "worker"`.
3. Added in-flight superseded-drop counters (window and cumulative) for cap-hit overwrite cases.
4. Added worker in-flight peak counters (window and cumulative) plus periodic log output.
5. Exposed all new counters through overlay and clipboard diagnostics.
6. Re-ran desktop typecheck and targeted transport tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-worker.ts`
  - `FrameRenderedMessage` now includes `source`
  - queued frames now carry source metadata
  - shared-buffer immediate WebGPU renders emit `source: "shared"`
  - fallback-posted renders emit `source: "worker"`
- `apps/desktop/src/utils/socket.ts`
  - decrements `workerFramesInFlight` only when render source is `worker`
  - added `workerInFlightSupersededDrops` and `workerInFlightSupersededDropsWindow`
  - added `workerFramesInFlightPeakWindow` and `workerFramesInFlightPeakTotal`
  - periodic frame logs now include worker peak and superseded counters
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling now includes new worker source-aware counters
  - clipboard export includes all added counters
  - overlay rows now show worker in-flight peak and cap-induced superseded drops

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ In-flight fallback accounting no longer decrements on shared-buffer renders.
- ✅ Diagnostics now capture cap-hit pressure, superseded consequences, and in-flight peaks with window and cumulative visibility.
- ✅ Desktop typecheck and targeted transport tests pass.

**Stopping point**: Ready for fallback-heavy validation to measure true worker-posted backlog pressure and cap-induced dropping behavior on target machines.

---

### Session 2026-02-14 (in-flight helper consolidation and source-aware dispatch counters)

**Goal**: Consolidate fallback in-flight dispatch branching into shared helper logic and ensure in-flight completion counts only worker-sourced renders

**What was done**:
1. Integrated `frame-transport-inflight` helper into socket fallback dispatch.
2. Added `dispatchToWorker` wrapper to centralize decision handling, peak tracking, and counters.
3. Tagged worker `frame-rendered` messages with `source: "shared" | "worker"`.
4. Updated socket to decrement `workerFramesInFlight` only for `source === "worker"`.
5. Added/expanded worker pressure diagnostics:
   - in-flight peaks (window/total)
   - cap-hit counters (window/total)
   - cap-induced superseded drops (window/total)
6. Added unit tests for in-flight decision/peak helpers and re-ran desktop checks/tests.

**Changes Made**:
- `apps/desktop/src/utils/frame-transport-inflight.ts`
  - added:
    - `decideWorkerInflightDispatch`
    - `updateWorkerInflightPeaks`
- `apps/desktop/src/utils/frame-transport-inflight.test.ts`
  - added 4 tests for dispatch/backpressure decisions and peak updates
- `apps/desktop/src/utils/socket.ts`
  - uses helper-driven `dispatchToWorker(buffer)`
  - source-aware in-flight decrement on worker messages
  - expanded worker pressure counters and frame-log diagnostics
- `apps/desktop/src/utils/frame-worker.ts`
  - `FrameRenderedMessage` now includes `source`
  - queued frames retain source for rendered-event emission
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - includes all new worker pressure counters in state, overlay, and clipboard export

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-transport-inflight.ts src/utils/frame-transport-inflight.test.ts src/utils/socket.ts src/utils/frame-worker.ts src/routes/editor/PerformanceOverlay.tsx`

**Results**:
- ✅ Fallback in-flight gating logic is centralized and unit-tested.
- ✅ In-flight completion no longer decrements on shared-buffer render events.
- ✅ Overlay/log diagnostics now expose richer fallback backlog pressure behavior.
- ✅ Desktop typecheck and expanded transport suite pass (17/17).

**Stopping point**: Ready for fallback-heavy validation runs to compare source-aware in-flight pressure signatures across target machines.

---

### Session 2026-02-14 (render-source window/total diagnostics)

**Goal**: Improve mixed-path visibility by tracking shared-rendered vs worker-rendered frame counts in both rolling windows and cumulative totals

**What was done**:
1. Added render-source counters (shared/worker) to socket transport stats.
2. Incremented counters from `frame-rendered` events based on `source`.
3. Extended periodic frame logs with render-source window/total counts.
4. Exposed counters in overlay and clipboard diagnostics.
5. Re-ran desktop typecheck and expanded transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added `FpsStats` fields:
    - `renderedFromSharedTotal`
    - `renderedFromSharedWindow`
    - `renderedFromWorkerTotal`
    - `renderedFromWorkerWindow`
  - updates counters in `worker.onmessage` `frame-rendered` branch using `source`
  - periodic frame log now includes render-source counters
  - window counters reset on each stats window flush
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling includes render-source counters
  - clipboard export includes render-source window/total fields
  - new overlay row shows:
    - `<shared window> shared / <worker window> worker`
    - plus cumulative totals

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx src/utils/frame-worker.ts src/utils/frame-transport-inflight.ts src/utils/frame-transport-inflight.test.ts`

**Results**:
- ✅ Diagnostics now show how much rendering work is coming from shared-buffer vs fallback worker frames over both short windows and full sessions.
- ✅ Frame logs carry the same split for terminal-driven perf sampling.
- ✅ Desktop typecheck and expanded transport tests pass (17/17).

**Stopping point**: Ready for target-machine runs to compare render-source mix against fallback pressure counters and FPS outcomes.

---

### Session 2026-02-14 (out-of-order frame stale gating in worker queue)

**Goal**: Prevent slightly stale out-of-order frames from displacing newer queued/rendered frames while preserving large backward jumps for seek transitions

**What was done**:
1. Added frame-order utility helpers for unsigned frame-number comparisons.
2. Added stale-frame drop gating in worker queue ingestion against queued or last-rendered frame numbers.
3. Added stale-frame drop gating in shared WebGPU immediate render path before render submission.
4. Reused a shared seek threshold for both stale suppression and seek detection.
5. Added dedicated unit tests for frame-order behavior, including wraparound semantics.

**Changes Made**:
- `apps/desktop/src/utils/frame-order.ts`
  - added:
    - `frameNumberForwardDelta`
    - `isFrameNumberNewer`
    - `shouldDropOutOfOrderFrame`
  - defines `FRAME_ORDER_STALE_WINDOW` default threshold
- `apps/desktop/src/utils/frame-order.test.ts`
  - added tests for:
    - forward progression
    - wraparound progression
    - duplicate drop
    - stale-window drop
    - seek-distance acceptance
- `apps/desktop/src/utils/frame-worker.ts`
  - imports new frame-order helpers
  - adds `FRAME_ORDER_SEEK_THRESHOLD`
  - `renderBorrowedWebGPU` now drops stale out-of-order frames before rendering
  - queue ingestion now drops stale out-of-order frames relative to queued/latest rendered frame
  - seek detection now uses unsigned forward delta helper

**Verification**:
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`
- `pnpm --dir apps/desktop exec biome format --write src/utils/frame-worker.ts src/utils/frame-order.ts src/utils/frame-order.test.ts`

**Results**:
- ✅ Worker queue now resists small out-of-order regressions that previously could replace newer frames.
- ✅ Large backward frame jumps remain eligible for seek behavior.
- ✅ Frame-order logic is covered by focused unit tests (23/23 utility tests passing).

**Stopping point**: Ready for target-machine playback traces to verify reduced jitter during fallback/shared mixed transport bursts.

---

### Session 2026-02-14 (decode benchmark CSV export + run labels)

**Goal**: Improve decode benchmark evidence portability for cross-machine baseline/candidate comparisons

**What was done**:
1. Extended decode benchmark CLI with CSV output path support.
2. Added optional run-label support via CLI/env for grouped analysis.
3. Added structured CSV rows for decoder creation, sequential decode, seek distances, random access, and duplicate burst metrics.
4. Validated CSV generation with a full benchmark run on 1080p60.

**Changes Made**:
- `crates/editor/examples/decode-benchmark.rs`
  - added config fields:
    - `output_csv: Option<PathBuf>`
    - `run_label: Option<String>`
  - added CSV writer with append-header behavior
  - added run-label resolver from:
    - `--run-label`
    - `CAP_DECODE_BENCHMARK_RUN_LABEL`
  - exports row modes:
    - `decoder_creation`
    - `sequential`
    - `seek`
    - `random_access`
    - `duplicate_batch`
    - `duplicate_request`
  - wired CLI args:
    - `--output-csv <path>`
    - `--run-label <label>`
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added decode CSV export command examples
  - added validation benchmark run summary for CSV mode

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 check -p cap-editor --example decode-benchmark`
- `cargo +1.88.0 run -p cap-editor --example decode-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --iterations 3 --seek-iterations 2 --output-csv /tmp/cap-decode-benchmark-v2.csv --run-label linux-frame-order-pass-v2`

**Results**:
- ✅ Decode benchmark now emits structured CSV suitable for aggregated multi-machine analysis.
- ✅ Run labels allow baseline/candidate grouping in a shared CSV artifact.
- ✅ Validation run completed and appended expected row modes to `/tmp/cap-decode-benchmark-v2.csv`.

**Stopping point**: Ready to collect decode CSV artifacts from macOS and Windows with consistent labels alongside existing scrub/playback CSV workflows.

---

### Session 2026-02-14 (decode CSV report utility)

**Goal**: Add grouped decode CSV summaries and baseline/candidate deltas to match existing scrub/playback CSV workflows

**What was done**:
1. Added a new decode CSV report example with summary and delta modes.
2. Added parsing for decode benchmark row modes including seek and duplicate burst rows.
3. Added optional CSV export for summary and delta outputs.
4. Validated with two labeled decode benchmark runs and a baseline/candidate comparison.
5. Added unit tests for parsing, summarization, and CSV append behavior.

**Changes Made**:
- `crates/editor/examples/decode-csv-report.rs` (new)
  - CLI args:
    - `--csv <path>` (repeatable)
    - `--label <run-label>`
    - `--baseline-label <run-label>`
    - `--candidate-label <run-label>`
    - `--output-csv <path>`
  - grouped summary by `(run_label, video)` with medians for:
    - decoder creation
    - sequential fps + decode p95
    - random-access avg/p95
    - seek avg/p95/p99/max by distance
    - duplicate burst avg/p95/p99/max by mode and burst size
  - baseline/candidate delta output for core, seek, and duplicate metrics
  - CSV output modes:
    - `summary_core`
    - `summary_seek`
    - `summary_duplicate`
    - `delta_core`
    - `delta_seek`
    - `delta_duplicate`
  - unit tests:
    - parse sequential row
    - summarize mixed mode rows
    - write summary + delta CSV rows
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added decode-csv-report command examples
  - added validation run entry including baseline/candidate delta output

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 check -p cap-editor --example decode-csv-report`
- `cargo +1.88.0 test -p cap-editor --example decode-csv-report`
- `cargo +1.88.0 run -p cap-editor --example decode-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --iterations 4 --seek-iterations 2 --output-csv /tmp/cap-decode-benchmark-v2.csv --run-label linux-frame-order-pass-v2b`
- `cargo +1.88.0 run -p cap-editor --example decode-csv-report -- --csv /tmp/cap-decode-benchmark-v2.csv --baseline-label linux-frame-order-pass-v2 --candidate-label linux-frame-order-pass-v2b --output-csv /tmp/cap-decode-summary-v2.csv`

**Results**:
- ✅ Decode CSV workflows now support same-label summaries and baseline/candidate deltas, matching playback/scrub reporting ergonomics.
- ✅ Delta output surfaces decode creation/fps/random-access/seek/duplicate changes in one command.
- ✅ New example tests pass (3/3).

**Stopping point**: Ready to ingest decode CSV runs from macOS + Windows and compute cross-platform baseline/candidate deltas without manual spreadsheet work.

---

### Session 2026-02-14 (direct-render out-of-order stale frame gating)

**Goal**: Reduce direct-render jitter from stale out-of-order frame arrivals by dropping short-backward regressions before main-thread rendering

**What was done**:
1. Reused frame-order stale detection in socket direct-render path.
2. Added direct-path out-of-order drop counters (window + cumulative).
3. Extended periodic frame logs with direct-path drop counters.
4. Exposed new counters in overlay and clipboard diagnostics.
5. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - imports `shouldDropOutOfOrderFrame` and adds direct stale window constant
  - direct render metadata path now reads `frameNumber`
  - drops frame when it is stale out-of-order relative to latest direct rendered frame
  - adds `FpsStats` fields:
    - `directOutOfOrderDropsTotal`
    - `directOutOfOrderDropsWindow`
  - periodic `[Frame]` log now includes:
    - `direct_ooo_window`
    - `direct_ooo_total`
  - resets direct drop window counter on each log flush
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling now includes direct out-of-order drop counters
  - clipboard export includes direct out-of-order drop metrics
  - overlay row shows direct out-of-order drops with window suffix

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Direct render path now drops stale short-regression frames before render.
- ✅ New diagnostics expose direct-path stale-drop behavior in overlay, clipboard, and frame logs.
- ✅ Desktop typecheck and transport utility tests pass (23/23).

**Stopping point**: Ready for target-machine playback sessions to correlate direct-path stale drops with render jitter and fallback pressure counters.

---

### Session 2026-02-14 (queued transport out-of-order stale gating)

**Goal**: Reduce worker-path churn by dropping stale out-of-order frames before queueing when transport is not in direct-render mode

**What was done**:
1. Added frame-number extraction for incoming websocket frame buffers.
2. Added queued-path stale gating against latest accepted queued frame number.
3. Added queued out-of-order drop counters (window + cumulative).
4. Extended frame logs, overlay, and clipboard diagnostics with queued drop counters.
5. Re-ran desktop typecheck and transport utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - queue ingress now reads frame number from frame metadata trailer
  - drops stale out-of-order queued frames via `shouldDropOutOfOrderFrame`
  - adds `FpsStats` fields:
    - `queuedOutOfOrderDropsTotal`
    - `queuedOutOfOrderDropsWindow`
  - periodic `[Frame]` log now includes:
    - `queued_ooo_window`
    - `queued_ooo_total`
  - resets queued out-of-order window counter on each log flush
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling now includes queued out-of-order counters
  - clipboard export includes queued out-of-order metrics
  - overlay row shows queued out-of-order drops with window suffix

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Non-direct transport path now suppresses stale out-of-order queued frames before worker dispatch.
- ✅ Diagnostics now separate queued-path stale drops from direct-path stale drops.
- ✅ Desktop typecheck and transport utility tests pass (23/23).

**Stopping point**: Ready for target-machine runs to attribute stale-drop behavior between queued and direct render paths.

---

### Session 2026-02-14 (frame-order decision helper extraction for socket transport)

**Goal**: Consolidate queued/direct stale-frame ordering decisions into a shared helper and add targeted unit coverage

**What was done**:
1. Added shared transport frame-order decision helper.
2. Added focused unit tests for missing/latest/forward/backward/seek decision cases.
3. Refactored socket queued ingress and direct-render gating to use shared helper.
4. Re-ran desktop typecheck and expanded transport utility test suite.

**Changes Made**:
- `apps/desktop/src/utils/frame-transport-order.ts` (new)
  - added `decideFrameOrder(candidateFrameNumber, latestFrameNumber, staleWindow)`
  - returns:
    - `action` (`accept` / `drop`)
    - `nextLatestFrameNumber`
    - `dropsIncrement`
- `apps/desktop/src/utils/frame-transport-order.test.ts` (new)
  - covers:
    - missing candidate acceptance
    - first-frame seeding
    - short backward stale drop
    - large backward seek acceptance
    - forward progression acceptance
- `apps/desktop/src/utils/socket.ts`
  - replaced direct calls to `shouldDropOutOfOrderFrame` with `decideFrameOrder`
  - queued and direct transport stale-drop counters now update from helper decisions
  - latest frame-number state updates now flow through helper return values

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/utils/frame-transport-order.ts src/utils/frame-transport-order.test.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Socket transport ordering behavior now uses a single tested decision primitive.
- ✅ Queued and direct stale-drop logic remains consistent and easier to evolve.
- ✅ Desktop typecheck and utility suite pass (28/28).

**Stopping point**: Ready for target-machine playback sessions with unified stale-ordering decision behavior in both queued and direct transport paths.

---

### Session 2026-02-14 (stride-correction response frame-order guard)

**Goal**: Prevent asynchronous stride-correction worker responses from rendering stale direct-path frames out of order

**What was done**:
1. Added frame-number payload to stride correction request/response messages.
2. Split direct-path ordering state into accepted-frame and rendered-frame trackers.
3. Added response-time stale-order checks before applying corrected stride frames.
4. Reset direct ordering trackers when direct rendering is unavailable or frame state resets.
5. Re-ran desktop typecheck and transport utility test suite.

**Changes Made**:
- `apps/desktop/src/utils/stride-correction-worker.ts`
  - request/response contracts now include `frameNumber`
  - corrected responses echo originating frame number
- `apps/desktop/src/utils/socket.ts`
  - added `latestDirectAcceptedFrameNumber` tracker for ingress ordering decisions
  - retained `lastDirectRenderedFrameNumber` for render completion ordering decisions
  - direct ingress stale gating now compares against accepted tracker
  - stride-correction response handler now compares response `frameNumber` against rendered tracker and drops stale responses
  - updates rendered tracker only after actual direct render completion
  - resets direct ordering trackers when direct path is unavailable or reset

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/utils/stride-correction-worker.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Stride-correction responses now honor frame-order stale gating before main-thread render.
- ✅ Direct-path ordering state now distinguishes accepted ingress ordering from completed render ordering.
- ✅ Desktop typecheck and transport utility tests pass (28/28).
- ✅ Transport order helper coverage now includes duplicate-frame and wraparound-forward decision cases (30/30 utility tests).

**Stopping point**: Ready for target-machine sessions to validate reduced direct-path visual regressions under stride-correction-heavy clips.

---

### Session 2026-02-14 (direct stale-drop source split diagnostics)

**Goal**: Separate direct-path stale drops caused at ingress from stale drops caused by asynchronous stride-correction response ordering

**What was done**:
1. Added split counters for direct stale-drop sources (ingress vs response).
2. Wired split counters into socket stats payload and periodic frame logs.
3. Exposed split counters in overlay and clipboard diagnostics.
4. Re-ran desktop typecheck and utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - `FpsStats` now includes:
    - `directIngressOutOfOrderDropsTotal`
    - `directIngressOutOfOrderDropsWindow`
    - `directResponseOutOfOrderDropsTotal`
    - `directResponseOutOfOrderDropsWindow`
  - increments ingress counters on direct metadata-path stale drop
  - increments response counters on stride-correction response stale drop
  - periodic `[Frame]` log now includes:
    - `direct_ingress_ooo_window`
    - `direct_ingress_ooo_total`
    - `direct_response_ooo_window`
    - `direct_response_ooo_total`
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling now includes split direct stale-drop counters
  - clipboard export includes split direct stale-drop metrics
  - direct out-of-order overlay row now shows ingress/response totals

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Direct stale-drop telemetry now attributes whether drops happen at direct ingress or stride-response completion.
- ✅ Overlay, clipboard, and logs provide source-split counters for targeted debugging on real machines.
- ✅ Desktop typecheck and utility tests pass (30/30).

**Stopping point**: Ready for target-machine traces to correlate ingress-vs-response stale drops with render jitter and fallback pressure.

---

### Session 2026-02-14 (audio streaming-first startup path across platforms)

**Goal**: Reduce startup audio delay by trying streaming playback path on all platforms before falling back to pre-rendered audio

**What was done**:
1. Removed platform gating that prevented streaming audio path from compiling on Windows.
2. Unified spawn-time stream selection to attempt streaming first, then fallback to pre-rendered on failure.
3. Added runtime override `CAP_AUDIO_PRERENDER_ONLY` for forced fallback behavior when needed.
4. Ran playback throughput benchmark smoke passes on 1080p60 and 4k60.

**Changes Made**:
- `crates/editor/src/playback.rs`
  - `create_stream` is now available cross-platform
  - audio thread startup now uses one stream-selection flow for all platforms:
    - try `create_stream`
    - on error fallback to `create_stream_prerendered`
  - added `env_flag_enabled` utility and runtime override:
    - `CAP_AUDIO_PRERENDER_ONLY`
  - removed platform-conditional imports now required by shared stream path
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added benchmark entry for post-change playback throughput smoke validation

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 check -p cap-editor`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --max-frames 240 --seek-iterations 8`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-4k60.mp4 --fps 60 --max-frames 240 --seek-iterations 8`

**Results**:
- ✅ Playback benchmark smoke run remains stable at ~60fps on both clips after startup-path change.
- ✅ Audio pipeline now has a single streaming-first path with fallback and runtime override.
- ✅ Editor crate compiles cleanly after cross-platform stream-path unification.

**Stopping point**: Ready for macOS + Windows editor startup trace captures to quantify callback-start deltas from streaming-first startup path.

---

### Session 2026-02-14 (startup report audio-path classification)

**Goal**: Improve startup trace readability by explicitly classifying audio startup mode per run (streaming/prerendered/mixed/none)

**What was done**:
1. Added audio-path classification helpers to startup report parser.
2. Extended `--list-run-metrics` output with audio path labels and sample counts.
3. Extended aggregate and delta modes with explicit audio path summary lines.
4. Added unit tests covering all audio-path classification modes.

**Changes Made**:
- `crates/editor/examples/playback-startup-report.rs`
  - added:
    - `AudioStartupPath` enum
    - `detect_audio_startup_path`
    - `audio_startup_path_label`
  - `--list-run-metrics` now prints audio path classification per run id
  - aggregate mode prints:
    - `audio startup path: <mode> (stream_samples=<n> prerender_samples=<n>)`
  - delta mode prints:
    - baseline and candidate audio path classification + counts
  - tests now include `detects_audio_startup_path_modes`
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - startup report command docs now mention audio-path classification in run-metrics output

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 test -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --list-run-metrics`

**Results**:
- ✅ Startup report now surfaces whether runs used streaming, pre-rendered, mixed, or no audio callback samples.
- ✅ Unit tests pass with new audio-path mode coverage (11/11).
- ✅ CLI run succeeds with updated run-metrics output path.

**Stopping point**: Ready for macOS/Windows startup traces where audio path classification can quickly verify whether streaming-first startup engaged.

---

### Session 2026-02-14 (direct stride-worker lifecycle tightening)

**Goal**: Reduce direct-path worker overhead by avoiding unnecessary stride-correction workers and preventing worker leaks across direct canvas re-inits

**What was done**:
1. Added explicit stride-worker setup/teardown helpers in socket transport.
2. Removed unconditional stride-worker creation from `initDirectCanvas`.
3. Created stride worker only when canvas2d direct path is active.
4. Added teardown when WebGPU direct path initializes successfully and during canvas swaps.
5. Re-ran desktop typecheck and utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added:
    - `setupStrideWorker()`
    - `teardownStrideWorker()`
  - `cleanup()` now uses shared teardown helper
  - `initDirectCanvas()` now:
    - tears down stale worker on canvas switch
    - initializes stride worker only when `directCtx` exists
    - tears down stride worker when WebGPU direct init succeeds
  - removed unconditional worker construction path

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Direct path no longer allocates stride-correction worker when WebGPU direct rendering is active.
- ✅ Re-init paths now explicitly tear down old stride workers before replacement.
- ✅ Desktop typecheck and utility suite pass (30/30).

**Stopping point**: Ready for long editor sessions to confirm reduced worker churn and stable direct-path behavior during canvas mode transitions.

---

### Session 2026-02-14 (startup report CSV audio-path rows)

**Goal**: Persist audio startup mode classification into startup report CSV outputs for downstream baseline/candidate analysis

**What was done**:
1. Extended aggregate CSV export with `aggregate_audio_path` rows.
2. Extended delta CSV export with `delta_audio_path` rows.
3. Extended run-metrics CSV export with `run_metric_audio_path` rows.
4. Added structured audio-path columns in CSV schema for machine-readable parsing.
5. Added tests validating new audio-path CSV rows.
6. Updated benchmark docs to note audio-path run-metric CSV mode.
7. Validated with synthetic baseline/candidate startup trace export.

**Changes Made**:
- `crates/editor/examples/playback-startup-report.rs`
  - CSV header now includes:
    - `audio_path`
    - `audio_stream_samples`
    - `audio_prerender_samples`
    - `candidate_audio_path`
    - `candidate_audio_stream_samples`
    - `candidate_audio_prerender_samples`
  - `append_aggregate_csv` now appends `aggregate_audio_path` row with:
    - audio path label
    - stream callback sample count
    - prerender callback sample count
  - `append_delta_csv` now appends `delta_audio_path` row with baseline/candidate audio path summary
  - `append_run_metrics_csv` now appends `run_metric_audio_path` row per run id
  - aggregate/delta call sites now pass audio-path summaries
  - tests updated to assert new row modes
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - startup report CSV command note updated to mention `run_metric_audio_path` row mode

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 test -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --list-run-metrics --output-csv /tmp/playback-startup-run-export.csv`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/tmp-startup-sample.csv --list-run-metrics --output-csv /tmp/playback-startup-run-export-v2.csv`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --baseline-log /workspace/tmp-startup-sample.csv --candidate-log /workspace/tmp-startup-sample.csv --baseline-run-id baseline --candidate-run-id candidate --output-csv /tmp/playback-startup-run-export-v2.csv`

**Results**:
- ✅ Startup report CSV outputs now carry explicit audio startup mode rows for aggregate, delta, and run-metrics exports.
- ✅ Audio path rows now populate structured columns for direct CSV querying.
- ✅ Updated startup report tests pass with new row modes (11/11).

**Stopping point**: Ready to ingest macOS/Windows startup trace CSVs and query audio startup mode directly from exported rows.

---

### Session 2026-02-14 (startup path selection trace event plumbing)

**Goal**: Ensure startup audio mode classification still works when callback startup events are absent but explicit path-selection events are present

**What was done**:
1. Added explicit startup trace events for selected audio startup path in playback runtime.
2. Extended startup report parser to ingest selected-path events.
3. Updated audio-path detection to fall back to selected-path counts when callback counts are missing.
4. Fixed run-metrics aggregation to merge selected-path vectors across logs.
5. Added test coverage for selected-path event parsing in run-id metrics.
6. Validated parser behavior on a path-selection-only sample trace.

**Changes Made**:
- `crates/editor/src/playback.rs`
  - records startup trace events at stream selection:
    - `audio_startup_path_streaming`
    - `audio_startup_path_prerendered`
  - logs selected audio startup mode with startup timing
- `crates/editor/examples/playback-startup-report.rs`
  - `EventStats` now stores:
    - `audio_stream_path_selected_ms`
    - `audio_prerender_path_selected_ms`
  - parser now maps new startup path events from CSV and structured log lines
  - run-metrics aggregation now merges selected-path vectors
  - `detect_audio_startup_path` now uses callback counts with selected-path fallback
  - tests extended in `collects_run_id_metrics` for selected-path events
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - added validation run entry for path-selection-only startup logs

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 test -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 check -p cap-editor`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --max-frames 120 --seek-iterations 4`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/tmp-startup-path-only.csv --list-run-metrics --output-csv /tmp/playback-startup-path-only.csv`

**Results**:
- ✅ Startup classification now reports prerender/streaming mode from explicit path-selection events even without callback samples.
- ✅ Path-selection event aggregation across logs is now correct in run-metrics mode.
- ✅ Startup report tests pass (11/11) and editor crate check remains green.

**Stopping point**: Ready for macOS/Windows traces to verify selected startup mode immediately from trace events before waiting for callback evidence.

---

### Session 2026-02-14 (startup report path-selection metric summaries)

**Goal**: Surface explicit startup path-selection timing metrics alongside callback metrics in startup report outputs

**What was done**:
1. Added path-selection metric rows to run-metrics CSV export.
2. Added path-selection metric printing in list-run-metrics output.
3. Added path-selection metric printing in aggregate and delta modes.
4. Added path-selection metric participation in aggregate/delta CSV metric arrays.

**Changes Made**:
- `crates/editor/examples/playback-startup-report.rs`
  - run metrics now include:
    - `audio startup path streaming`
    - `audio startup path prerendered`
  - list-run-metrics console output now prints metric briefs for selected-path events
  - aggregate mode now prints selected-path metric summaries
  - delta mode now prints selected-path metric deltas
  - aggregate/delta CSV exports now receive selected-path metric slices
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - startup report command description updated to include path-selection event summaries

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 test -p cap-editor --example playback-startup-report`
- `cargo +1.88.0 run -p cap-editor --example playback-startup-report -- --log /workspace/crates/editor/PLAYBACK-BENCHMARKS.md --list-run-metrics`

**Results**:
- ✅ Startup report now emits path-selection metric summaries in both console and CSV flows.
- ✅ Added structured-log parsing coverage for path-selection-only lines.
- ✅ Existing startup report tests remain green (12/12).

**Stopping point**: Ready for real startup traces where path-selection event timing should be compared directly against callback startup timing.

---

### Session 2026-02-14 (audio startup mode env override expansion)

**Goal**: Improve startup A/B experimentation by adding an explicit streaming-only override in addition to the existing pre-render-only override

**What was done**:
1. Added `CAP_AUDIO_STREAMING_ONLY` override handling in playback audio startup selection.
2. Preserved `CAP_AUDIO_PRERENDER_ONLY` precedence when both overrides are set.
3. Updated startup capture docs with streaming-only command variant.

**Changes Made**:
- `crates/editor/src/playback.rs`
  - reads `CAP_AUDIO_STREAMING_ONLY` via `env_flag_enabled`
  - stream selection logic now supports:
    - pre-render-only override
    - streaming-only override
    - default streaming with pre-render fallback
  - logs warning when both pre-render-only and streaming-only flags are set
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - startup trace capture commands now include `CAP_AUDIO_STREAMING_ONLY=1` variant

**Verification**:
- `cargo +1.88.0 fmt --all`
- `cargo +1.88.0 check -p cap-editor`
- `cargo +1.88.0 run -p cap-editor --example playback-benchmark -- --video /tmp/cap-bench-1080p60.mp4 --fps 60 --max-frames 120 --seek-iterations 4`

**Results**:
- ✅ Startup mode overrides now support explicit streaming-only and pre-render-only A/B captures.
- ✅ Override conflict behavior is deterministic (`CAP_AUDIO_PRERENDER_ONLY` wins).
- ✅ Editor crate compiles and playback benchmark smoke run remains healthy.

**Stopping point**: Ready for macOS/Windows startup trace capture sweeps using labeled streaming-only vs pre-render-only runs.

---

### Session 2026-02-14 (startup capture docs for pre-render override)

**Goal**: Make A/B startup capture workflow explicit for streaming-first vs forced pre-render audio startup comparisons

**What was done**:
1. Added startup capture command showing `CAP_AUDIO_PRERENDER_ONLY=1` usage.
2. Included run-id labeling in the same command for direct baseline/candidate grouping.

**Changes Made**:
- `crates/editor/PLAYBACK-BENCHMARKS.md`
  - startup latency section now includes:
    - `CAP_AUDIO_PRERENDER_ONLY=1`
    - `CAP_PLAYBACK_STARTUP_TRACE_FILE`
    - `CAP_PLAYBACK_STARTUP_TRACE_RUN_ID`
  - command demonstrates forced pre-render run labeling for startup deltas

**Results**:
- ✅ Startup trace capture docs now include explicit forced pre-render comparison path for audio startup A/B runs.

**Stopping point**: Ready for macOS/Windows startup capture passes with matched streaming/pre-render run labels.

---

### Session 2026-02-14 (direct stale-drop accounting + stride render counter fix)

**Goal**: Align transport drop-rate and render FPS diagnostics with direct-path behavior, including stride-corrected direct renders

**What was done**:
1. Counted direct ingress/response stale drops in overall dropped-frame window counter.
2. Counted stride-corrected direct renders in actual render FPS counters.
3. Re-ran desktop typecheck and utility test suite.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - direct ingress stale drops now increment `framesDropped`
  - direct response stale drops now increment `framesDropped`
  - stride-correction direct render path now increments:
    - `actualRendersCount`
    - `renderFrameCount`

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Drop-rate calculations now include direct-path stale drops.
- ✅ Render FPS counters now include stride-corrected direct frames.
- ✅ Desktop typecheck and utility tests pass (30/30).

**Stopping point**: Ready for target-machine sessions where drop-rate and render-FPS telemetry should better match direct-path visual behavior.

---

### Session 2026-02-14 (socket dead render counter cleanup)

**Goal**: Remove unused render counter state from socket transport hot paths to reduce bookkeeping overhead

**What was done**:
1. Removed unused `renderFrameCount` state from socket transport.
2. Removed associated increments from direct render branches.
3. Re-ran desktop typecheck and utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - removed `renderFrameCount` declaration
  - removed direct-path increment sites that did not feed any stats output

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Socket hot path no longer updates unused render counter state.
- ✅ Desktop typecheck and utility tests pass (30/30).

**Stopping point**: Ready for continued direct-path tuning with leaner per-frame bookkeeping.

---

### Session 2026-02-14 (stride-correction queue backpressure coalescing)

**Goal**: Prevent stride-correction worker backlog growth by capping in-flight corrections and coalescing to the latest pending request

**What was done**:
1. Added in-flight tracking for stride-correction worker requests.
2. Added single-slot pending request buffer for stride correction.
3. Dispatch now allows one in-flight request plus one latest pending request.
4. Pending replacement now drops stale pending corrections instead of unbounded queue growth.
5. Worker response/error paths now flush pending work when possible.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - added:
    - `strideWorkerInFlight`
    - `pendingStrideCorrection`
    - `dispatchStrideCorrection`
    - `queueStrideCorrection`
  - stride correction path now calls `queueStrideCorrection(...)` instead of direct `postMessage`
  - worker message handler now:
    - handles `error` messages
    - clears in-flight flag before dispatching pending request
    - coalesces pending requests to latest frame
  - teardown now resets in-flight and pending stride state

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Stride-correction flow now bounds worker backlog pressure to one in-flight + one pending correction.
- ✅ Older pending stride corrections are superseded by newer frames under burst load.
- ✅ Desktop typecheck and utility suite pass (30/30).

**Stopping point**: Ready for stride-heavy direct-path runs to validate reduced correction backlog and stale response pressure.

---

### Session 2026-02-14 (stride correction backlog telemetry)

**Goal**: Expose stride-correction backlog behavior in transport diagnostics for direct-path burst tuning

**What was done**:
1. Added stride-correction queue state metrics (in-flight/pending).
2. Added stride-correction dispatch counters (window/total).
3. Added stride-correction superseded pending-drop counters (window/total).
4. Wired metrics into socket frame logs, stats payload, overlay, and clipboard export.
5. Re-ran desktop typecheck and utility tests.

**Changes Made**:
- `apps/desktop/src/utils/socket.ts`
  - `FpsStats` now includes:
    - `strideCorrectionInFlight`
    - `strideCorrectionPending`
    - `strideCorrectionDispatchesTotal`
    - `strideCorrectionDispatchesWindow`
    - `strideCorrectionSupersededDropsTotal`
    - `strideCorrectionSupersededDropsWindow`
  - `dispatchStrideCorrection` now increments dispatch counters
  - pending replacement in `queueStrideCorrection` now increments superseded counters
  - periodic frame log includes stride correction counters
  - stride window counters reset per frame-log window
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling includes new stride counters
  - clipboard export includes stride correction counters
  - overlay row now shows stride in-flight/pending + dispatch/superseded totals

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Transport diagnostics now expose stride-correction backlog pressure and superseded pending work.
- ✅ Overlay/log/clipboard flows provide consistent stride backlog metrics.
- ✅ Desktop typecheck and utility tests pass (30/30).

**Stopping point**: Ready for stride-heavy direct-path sessions to correlate backlog telemetry with direct stale-drop counters and FPS stability.

---

### Session 2026-02-14 (stride dispatch decision helper extraction)

**Goal**: Centralize stride-correction dispatch/coalescing decisions into a reusable tested helper

**What was done**:
1. Added a stride dispatch decision helper module.
2. Added helper tests for dispatch/queue/supersede branches.
3. Refactored socket stride queue logic to use helper decision output.
4. Re-ran desktop typecheck and expanded utility test suite.

**Changes Made**:
- `apps/desktop/src/utils/frame-transport-stride.ts` (new)
  - added `decideStrideCorrectionDispatch(inFlight, hasPending)`
  - returns dispatch/queue action and increment deltas
- `apps/desktop/src/utils/frame-transport-stride.test.ts` (new)
  - covers:
    - immediate dispatch when idle
    - queue when in-flight with no pending
    - queue + supersede when in-flight with pending
- `apps/desktop/src/utils/socket.ts`
  - `queueStrideCorrection` now uses `decideStrideCorrectionDispatch`
  - superseded drop counters now flow from helper increments

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/utils/frame-transport-stride.ts src/utils/frame-transport-stride.test.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-stride.test.ts src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Stride dispatch/coalescing logic now uses a single tested decision primitive.
- ✅ Utility test suite expanded and passing (33/33).

**Stopping point**: Ready for additional stride-path tuning with helper-backed decision logic and telemetry.

---

### Session 2026-02-14 (stride worker error handling + telemetry)

**Goal**: Improve robustness and observability for stride-correction failures and worker error scenarios

**What was done**:
1. Added explicit validation/error responses in stride-correction worker.
2. Added stride worker error counters (window + total) in socket stats.
3. Extended frame logs/overlay/clipboard with stride error counters.
4. Updated stride row visibility to include error-driven display condition.
5. Re-ran desktop typecheck and utility tests.

**Changes Made**:
- `apps/desktop/src/utils/stride-correction-worker.ts`
  - validates dimensions/stride and source buffer length
  - emits typed `error` responses for invalid input or exceptions
- `apps/desktop/src/utils/socket.ts`
  - handles stride worker `error` responses and increments:
    - `strideCorrectionErrorsTotal`
    - `strideCorrectionErrorsWindow`
  - `FpsStats` extended with stride error counters
  - periodic frame log now includes stride error counters
  - window error counter resets each frame-log window
- `apps/desktop/src/routes/editor/PerformanceOverlay.tsx`
  - transport state/reset/polling includes stride error counters
  - clipboard export includes stride error counters
  - stride overlay row now shows errors (window/total)

**Verification**:
- `pnpm --dir apps/desktop exec biome format --write src/utils/socket.ts src/routes/editor/PerformanceOverlay.tsx src/utils/stride-correction-worker.ts`
- `pnpm --dir apps/desktop exec tsc --noEmit`
- `pnpm --dir apps/desktop exec vitest run src/utils/frame-transport-stride.test.ts src/utils/frame-transport-order.test.ts src/utils/frame-order.test.ts src/utils/frame-transport-inflight.test.ts src/utils/frame-transport-config.test.ts src/utils/frame-transport-retry.test.ts src/utils/shared-frame-buffer.test.ts`

**Results**:
- ✅ Stride correction path now surfaces invalid-input/exception failures explicitly.
- ✅ Transport diagnostics now include stride error counters for field debugging.
- ✅ Desktop typecheck and utility suite pass (33/33).

**Stopping point**: Ready for direct-path stress runs where stride error counters can confirm transport stability under malformed or extreme stride inputs.

---

## References

- `PLAYBACK-BENCHMARKS.md` - Raw performance test data (auto-updated by test runner)
- `../recording/FINDINGS.md` - Recording performance findings (source of test files)
- `../recording/BENCHMARKS.md` - Recording benchmark data
- `examples/playback-test-runner.rs` - Playback test implementation
