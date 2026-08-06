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

**Last Updated**: 2026-07-03

### Performance Summary

| Metric | Target | QHD (2560x1440) | 4K (3840x2160) | Status |
|--------|--------|-----------------|----------------|--------|
| Decoder Init (display) | <200ms | 123ms | 29ms | ✅ Pass |
| Decoder Init (camera) | <200ms | 7ms | 6ms | ✅ Pass |
| Decode Latency (p95) | <50ms | 1.4ms | 4.3ms | ✅ Pass |
| Effective FPS | ≥30 fps | 1318 fps | 479 fps | ✅ Pass |
| Decode Jitter | <10ms | ~1ms | ~2ms | ✅ Pass |
| A/V Sync (mic↔video) | <100ms | 0ms | 0ms | ✅ Pass |
| Camera-Display Drift | <100ms | 0ms | 0ms | ✅ Pass |

*Display decoder init time includes multi-position pool initialization (5 decoder instances)

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

- [ ] **Test fragmented mode** - Run playback tests on fragmented recordings
- [ ] **Investigate display decoder init time** - 337ms may be optimizable

### Completed
- [x] **Run initial baseline** - Established current playback performance metrics (2026-01-28)
- [x] **Profile decoder init time** - Hardware acceleration confirmed (AVAssetReader) (2026-01-28)
- [x] **Identify latency hotspots** - No issues found, p95=3.1ms (2026-01-28)
- [x] **Optimize random-access scrubbing** - Reduced AVAssetReader scrub decode p95 on cap-performance-fixtures from 231.5ms to 47.6ms (2026-05-07)
- [x] **Add live editor playback harness** - Added `cap-editor --example editor-playback-benchmark` telemetry for warmup, frame source, skips, renderer queue wait, render time, callback packing, and output format (2026-05-20)
- [x] **Optimize live editor playback render output** - Switched live editor renderer output from NV12 to RGBA after telemetry showed NV12 renderer p95 over frame budget at 1080p (2026-05-20)
- [x] **Reduce live editor first-render drops** - Moved renderer setup earlier and prerendered the first playback frame before starting the playback clock, reducing 1080p renderer drops from 8 to 0 on the reference live run (2026-05-20)
- [x] **Measure desktop RGBA display bandwidth** - Time-normalized desktop frame transport stats and measured RGBA payload at 406.6 MB/s full preview, 172.8 MB/s default half preview, with callback/display packing below budget (2026-05-20)
- [x] **Instrument desktop transport/display leg** - Added Rust WebSocket pack/send stats plus browser receive-to-display and WebGPU upload timing in `__capFpsStats()` (2026-05-20)
- [x] **Run sustained live editor playback** - 900-frame full and default-half preview runs stayed near 60fps with no playback skips; both exposed a deterministic renderer spike around frame 696/keyframe area causing 3 renderer drops (2026-05-20)
- [x] **Preload editor cursor assets off the playback path** - Moved SVG/PNG cursor texture loading into renderer-layer initialization after stage telemetry proved the frame 696 sustained-run drop was first-use cursor asset loading (2026-05-20)
- [x] **Capture live desktop transport/display stats** - Added a no-dev-server desktop display benchmark that drives the real Rust renderer/WebSocket path into Chrome and captured WebGPU upload/display stats for 300-frame and 900-frame full/default-half runs (2026-05-20)

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

### Session 2026-02-15 (Performance Check + AVAssetReader Fix)

**Goal**: Run playback benchmarks, fix panics in decoder fallback path

**What was done**:
1. Ran full playback validation on MP4 and fragmented recordings
2. Identified AVAssetReader panicking with `unwrap()` on directory paths (fragmented recordings)
3. Fixed by replacing `unwrap()` with proper error propagation

**Changes Made**:
- `crates/video-decode/src/avassetreader.rs`: Replaced `ffmpeg::format::input(&path).unwrap()` and `.ok_or(...).unwrap()` with `map_err()?` and `ok_or_else()?` for clean error propagation instead of panics

**Results** (MP4 Mode):
- ✅ Decoder: AVAssetReader (hardware), display init=114-123ms, camera init=25-33ms
- ✅ Playback: 637-640 fps effective, avg=1.6ms, p95=5.0ms, p99=6.3ms
- ✅ Camera sync: 0ms drift (perfect)
- ✅ Mic sync: 88-100ms (borderline on this run, normally 77-88ms)
- 🟡 System audio: 193-205ms (known issue, inherited from recording)

**Results** (Fragmented Mode):
- ✅ Decoder: FFmpeg (hardware) with VideoToolbox, display init=100-110ms, camera init=7ms
- ✅ Playback: 153-173 fps effective, avg=5.8-6.5ms, p95=9.0-12.4ms
- ✅ Camera sync: 0ms drift (perfect)
- ✅ Mic sync: 10-23ms (excellent)
- ✅ AVAssetReader now cleanly falls back to FFmpeg without panicking
- 🟡 System audio: 85-116ms (borderline, known issue)

**Stopping point**: All playback metrics healthy. AVAssetReader panic fixed. No further action needed.

---

### Session 2026-02-15 (Playback Validation + System Audio Sync)

**Goal**: Comprehensive playback benchmark validation, system audio start_time sync fix

**What was done**:
1. Ran playback validation on fragmented and MP4 recordings
2. Verified AVAssetReader graceful fallback on directory paths (no panics)
3. Audited all decoder `unwrap()` calls for safety
4. Added system audio to recording start_time sync chain (studio_recording.rs)

**Changes Made**:
- `crates/recording/src/studio_recording.rs`: System audio start_time now syncs to mic (or display) when drift >30ms, matching the existing camera/display sync pattern. Improves playback alignment.

**Results (MP4 Mode)**:
- ✅ Decoder: AVAssetReader (hardware), display init=162-174ms, camera init=21-32ms
- ✅ Playback: 283-641 fps effective (target ≥60fps)
- ✅ Latency: avg=1.6-3.5ms, p95=2.8-5.0ms (target p95 <50ms)
- ✅ Camera sync: 0ms drift (target <100ms)
- ✅ Mic sync: 93ms (target <100ms)
- 🟡 System audio: 178-195ms (inherent macOS capture latency, sync fix improves alignment)

**Results (Fragmented Mode)**:
- ✅ Decoder: FFmpeg (hardware) with VideoToolbox, display init=100ms, camera init=7ms
- ✅ Playback: 156 fps effective (target ≥60fps)
- ✅ Latency: avg=6.4ms, p95=9.5ms (target p95 <50ms)
- ✅ Camera sync: 0ms drift (target <100ms)
- ✅ Mic sync: 8.5ms (target <100ms)
- ✅ System audio: 98ms (target <100ms)
- ✅ AVAssetReader cleanly falls back to FFmpeg with descriptive error message

**Decoder audit**: All `unwrap()` in `avassetreader.rs` eliminated. Remaining `unwrap()` calls in ffmpeg.rs and avassetreader decoder loop are on guaranteed-non-empty BTreeMap caches (safe by construction).

**Stopping point**: All playback metrics healthy. System audio sync metadata fix applied.

---

### Session 2026-03-25 (Decoder Init + Frame Processing Optimizations)

**Goal**: Run playback benchmarks, identify performance improvement areas, implement safe optimizations

**What was done**:
1. Ran full playback benchmarks on synthetic QHD (2560x1440) and 4K (3840x2160) recordings
2. Deep-dived into entire playback pipeline: decoder, frame converter, WebSocket transport, WebGPU renderer
3. Identified 5 concrete optimization opportunities via parallel code analysis agents
4. Implemented 5 targeted optimizations
5. Re-ran benchmarks to verify improvements with no regressions

**Changes Made**:
- `crates/video-decode/src/avassetreader.rs`: Single file open in KeyframeIndex::build (was opening the file twice - once for metadata, once for packet scan). Also caches pixel_format/width/height from the initial probe so pool decoders skip redundant FFmpeg opens.
- `crates/rendering/src/decoder/frame_converter.rs`: BGRA→RGBA conversion now processes 8 pixels (32 bytes) per loop iteration with direct indexed writes instead of per-pixel push(). Added fast path for RGBA when stride==width*4 (single memcpy instead of per-row copies).
- `apps/desktop/src-tauri/src/frame_ws.rs`: Consolidated WebSocket frame packing into single pack_ws_frame() function, removed redundant pack_*_ref helper functions.

**Results**:
- 4K decoder init: 66.8ms → 28.6ms (**-57%**)
- QHD decoder init: 146.1ms → 123.1ms (**-16%**)
- Camera decoder init: 9.6ms → 6.5ms (**-32%**)
- KeyframeIndex build: 17ms → 10ms (**-41%**) at 4K
- All playback metrics remain healthy, no regressions
- BGRA→RGBA and RGBA copy improvements don't show in decoder benchmarks (these formats aren't used by the test videos) but benefit real recordings where macOS outputs BGRA

**Stopping point**: All optimizations implemented and verified. Future directions:
- Consider lazy pool decoder creation (defer creating secondary decoders until needed for scrubbing)
- Shared memory / IPC instead of WebSocket for local frame transport (architectural change)
- NEON SIMD intrinsics for BGRA→RGBA on Apple Silicon (currently uses unrolled scalar)

---

### Session 2026-05-07 (Reference Fixture Scrub Optimization)

**Goal**: Benchmark current editor playback performance on a repeatable real `.cap` fixture and improve playback responsiveness without compromising FPS, visual quality, or audio sync.

**What was done**:
1. Cloned `https://github.com/CapSoftware/cap-performance-fixtures` to `/tmp/cap-performance-fixtures`
2. Used `/tmp/cap-performance-fixtures/reference-recording.cap`, a two-segment Studio recording with 3024x1964 display video, 1920x1080 camera video, mic audio, system audio, cursor data, and zoom configuration
3. Ran playback validation at 60fps
4. Ran `cap-editor` decode/render/scrub pipeline benchmarks at 60fps for 300 frames
5. Tuned the macOS AVAssetReader multi-position decoder pool so scrub requests use a stricter decoder reuse window than linear playback

**Changes Made**:
- `crates/rendering/src/decoder/multi_position.rs`: Added a custom reuse-threshold entry point for decoder selection while preserving the default playback threshold.
- `crates/rendering/src/decoder/avassetreader.rs`: During detected scrubbing, reuse an existing decoder only when it is within 0.5s behind the requested frame; otherwise reset the nearest decoder to the target keyframe.

**Baseline Results**:
- Playback validation: PASS, AVAssetReader hardware decode, camera-display drift 0ms, mic diff 35.3ms/13.8ms, system audio diff 92.7ms/92.8ms.
- Decode-only: 730.0 fps effective, avg 1.37ms, p95 2.94ms, p99 9.34ms.
- Full pipeline 1920x1080: 140.8 fps effective, total avg 7.10ms, p95 8.73ms, p99 9.64ms.
- Scrubbing half resolution: 6.8 fps effective, decode avg 138.98ms, p95 231.49ms, p99 263.25ms, total p95 242.61ms.

**Final Results**:
- Playback validation: PASS, AVAssetReader hardware decode, camera-display drift 0ms, mic diff 35.3ms/13.8ms, system audio diff 92.7ms/92.8ms.
- Decode-only: 722.2 fps effective, avg 1.38ms, p95 3.03ms, p99 8.31ms.
- Full pipeline 1920x1080: 147.6 fps effective, total avg 6.78ms, p95 8.37ms, p99 9.31ms.
- Scrubbing half resolution: 19.9 fps effective, decode avg 41.86ms, p95 47.57ms, p99 47.95ms, total p95 55.48ms.

**Impact**:
- Scrub decode average improved 138.98ms → 41.86ms (-69.9%).
- Scrub decode p95 improved 231.49ms → 47.57ms (-79.4%).
- Scrub throughput improved 6.8fps → 19.9fps (2.9x).
- Linear playback, camera sync, mic sync, and system-audio sync remained healthy.

**Validation**:
- `cargo fmt --all`
- `cargo run -p cap-recording --example playback-test-runner -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 full`
- `cargo run -p cap-editor --example playback-pipeline-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300`
- `cargo clippy -p cap-rendering --all-targets -- -D warnings`

**Stopping point**: Scrubbing is substantially faster and playback validation still passes. Remaining architectural opportunities are renderer readback/transport overhead and longer-duration testing on lower-powered MacBook Air hardware.

---

### Session 2026-05-20 (Live Editor Playback Harness + RGBA Output)

**Goal**: Build an editor playback performance harness, identify the top measured bottleneck in the actual live playback path, and fix it without changing playback timing, decode behavior, or audio sync.

**What was done**:
1. Added `crates/editor/examples/editor-playback-benchmark.rs`, which drives the real `Playback` loop and `Renderer` with telemetry instead of only benchmarking direct decode/render calls.
2. Added playback telemetry for warmup, frame source, skips, schedule overshoot, frame acquisition, uniform construction, renderer queue wait, render time, callback packing, dropped frames, and output format.
3. Ran baseline live playback on `/tmp/cap-performance-fixtures/reference-recording.cap` at 60fps for 300 frames.
4. Identified `render_immediate_nv12` as the top measured bottleneck.
5. Switched live editor playback renderer output to RGBA, using the existing desktop RGBA frame transport path.

**Changes Made**:
- `crates/editor/src/telemetry.rs`: New telemetry event channel and stage enums.
- `crates/editor/src/playback.rs`: Emits live playback telemetry without changing playback scheduling.
- `crates/editor/src/editor.rs`: Emits renderer telemetry and uses RGBA output for live editor frames.
- `crates/editor/examples/editor-playback-benchmark.rs`: New live playback benchmark harness.
- `crates/editor/Cargo.toml`: Registers the new benchmark example.

**Baseline Results**:
- Live 1080p playback: submitted 300, rendered 253, renderer dropped 47, skipped 28.
- Renderer output: NV12.
- Renderer render p95: 19.00ms, over the 16.67ms frame budget.
- Callback packing p95: 0.02ms.

**Final Results**:
- Live 1080p playback: submitted 300, rendered 290, renderer dropped 10, skipped 0.
- Renderer output: RGBA.
- Renderer render p95: 9.21ms.
- Default half preview: renderer render p95 7.37ms, skipped 0.
- Existing playback validation still passes: decode p95 5.0ms/3.0ms, mic diff 35.3ms/13.8ms, system audio diff 92.7ms/92.8ms, camera drift 0.0ms.

**Impact**:
- Live 1080p renderer p95 improved 19.00ms → 9.21ms (-51.5%).
- Playback skips improved 28 → 0 on the measured 300-frame run.
- The fix avoids NV12 color conversion for editor preview frames and uses the already-supported RGBA display path.

**Validation**:
- `cargo fmt --all`
- `cargo check -p cap-editor --examples`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution full`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution half`
- `cargo run -p cap-recording --example playback-test-runner -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 full`

**Stopping point**: The top measured live playback bottleneck is fixed. Remaining opportunity is first-render setup latency, visible as a max render spike and a small number of initial renderer drops even though steady-state p95 is under budget.

---

### Session 2026-05-20 (First-Render Setup + RGBA Transport)

**Goal**: Continue after the RGBA output change by reducing first-render/setup latency and remaining live renderer drops, then check whether the larger RGBA desktop payload is becoming the next limiter.

**What was done**:
1. Measured the post-RGBA live playback path on `/tmp/cap-performance-fixtures/reference-recording.cap` at 60fps for 300 frames.
2. Confirmed the remaining drops were concentrated around renderer setup and the first rendered frame, not steady-state rendering.
3. Moved renderer layer creation earlier so it overlaps segment/decoder creation.
4. Added renderer output-size preparation before playback frames are queued.
5. Prerendered the exact starting playhead frame before starting the playback clock/audio stream, then began the timed loop at the next frame.
6. Tightened desktop display stats so `__capFpsStats()` reports true MB/s, render FPS, render duration, and active transport mode for the RGBA display path.

**Before This Session**:
- Full 1080p RGBA live playback: submitted 300, rendered 292, renderer dropped 8, skipped 0.
- Warmup: 28.2ms.
- Renderer render p95: 8.20ms, max 62.90ms.
- Callback payload: 398.6 MB/s.

**Final Results**:
- Full 1080p RGBA live playback: submitted 300, rendered 300, renderer dropped 0, skipped 0.
- Full 1080p setup/warmup including initial prerender: 65.4ms.
- Full 1080p renderer render p95: 7.10ms; first-frame prerender max: 63.16ms before playback clock start.
- Full 1080p callback payload: 406.6 MB/s.
- Default half preview: submitted 300, rendered 300, renderer dropped 0, skipped 0.
- Default half preview renderer render p95: 7.05ms.
- Default half preview callback payload: 172.8 MB/s.
- Existing playback validation still passes: decode p95 4.8ms/2.9ms, mic diff 35.3ms/13.8ms, system audio diff 92.7ms/92.8ms, camera drift 0.0ms.

**Impact**:
- Remaining 1080p renderer drops improved 8 → 0.
- First-frame GPU spike still exists, but it is paid before the playback clock and audio stream start, so it no longer causes renderer queue drops or visual startup skips.
- RGBA bandwidth is not the measured limiter on the reference runs: callback packing p95 stayed at 0.01ms and renderer queue wait p95 stayed at 0.05ms while carrying the larger RGBA payload.

**Validation**:
- `cargo fmt --all`
- `cargo check -p cap-rendering`
- `cargo check -p cap-editor --examples`
- `pnpm exec biome check --write apps/desktop/src/utils/socket.ts`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution full`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution half`
- `cargo run -p cap-recording --example playback-test-runner -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 full`

**Stopping point**: The measured live editor path now renders every submitted frame on the reference fixture with no renderer drops or playback skips. The remaining first-frame cost is GPU startup work, but it is isolated to setup before timed playback begins.

---

### Session 2026-05-20 (Desktop Path Instrumentation + Cursor Asset Preload)

**Goal**: Measure and safely reduce the next bottleneck across the desktop editor playback path after first-render/drop fixes, including Rust WebSocket pack/send, browser receive/display, WebGPU upload timing, full/default-half preview comparison, sustained playback, and first-frame setup latency.

**What was done**:
1. Added Rust WebSocket timing fields to the existing `WS frame stats` log: pack avg/max, send avg/max, and renderer-output-created-to-sent avg/max.
2. Extended desktop `__capFpsStats()` with WebGPU upload avg/max, receive-to-display avg/max, and SharedArrayBuffer write/fallback counts.
3. Updated the live editor benchmark to report effective FPS without teardown sleep, separate steady renderer timing from the prewarmed first frame, and split renderer preparation into display, cursor, camera, layer render, finish, and readback stages.
4. Measured the 900-frame sustained drop: both full and default-half preview hit a deterministic frame 696 outlier, with cursor preparation at about 64-66ms while display, camera, callback packing, queue wait, and readback stayed below budget.
5. Moved cursor SVG/PNG texture loading into the existing renderer-layer initialization path, keeping the same SVG-first and PNG-fallback asset selection and the lazy fallback for non-editor paths.
6. Added a no-dev-server desktop display transport benchmark that runs the real `cap-desktop` Rust WebSocket sender, bundles the real desktop `socket.ts` display path with Vite, opens Chrome through CDP, and captures WebGPU display notifications and stats.
7. Ran final 300-frame and 900-frame full/default-half preview benchmarks on `/tmp/cap-performance-fixtures/reference-recording.cap` at 60fps.
8. Re-ran playback sync validation on the same fixture.

**Changes Made**:
- `apps/desktop/src-tauri/src/frame_ws.rs`: Added pack/send/created-to-sent counters to desktop WebSocket frame stats.
- `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/examples/desktop-display-transport-benchmark.rs`: Exposed the existing frame WebSocket module to examples and added a benchmark that pushes real editor renderer output through the desktop WebSocket sender.
- `apps/desktop/scripts/desktop-display-transport-benchmark.js`, `apps/desktop/package.json`: Added the browser-side benchmark harness that captures display notifications, sampled WebGPU upload timing, receive-to-display timing, transport mode, and fallback counters without starting a dev server.
- `apps/desktop/src/utils/webgpu-renderer.ts`: Returns render timing with resize, texture setup, upload, draw, and total durations.
- `apps/desktop/src/utils/socket.ts`: Records receive-to-display, WebGPU upload, render, SharedArrayBuffer write, fallback stats, and stable stats-window counters for benchmark aggregation.
- `crates/editor/examples/editor-playback-benchmark.rs`: Reports steady render timing separately from first-frame prewarm and prints renderer stage breakdowns.
- `crates/editor/src/editor.rs`, `crates/editor/src/telemetry.rs`, `crates/rendering/src/frame_pipeline.rs`, `crates/rendering/src/lib.rs`: Added live renderer-stage telemetry for prepare, display/cursor/camera preparation, render command encoding, finish/readback submit, and immediate flush.
- `crates/rendering/src/layers/cursor.rs`: Preloads recording cursor assets through the same SVG-first/PNG-fallback path before playback frames need a newly-seen cursor texture.

**Results**:
- Before cursor preload, 900-frame full/default-half preview rendered 897/900 frames with 3 renderer drops and no playback skips; the repeated outlier was frame 696, with cursor preparation at 64.44ms full and 66.29ms default-half.
- Final 300-frame full preview: submitted/rendered/callback 300/300/300, skipped 0, renderer dropped 0, effective rendered FPS 59.9, steady render p95 8.47ms, first render 18.72ms, cursor prepare max 0.20ms, payload 430.8 MB/s.
- Final 300-frame default-half preview: submitted/rendered/callback 300/300/300, skipped 0, renderer dropped 0, effective rendered FPS 59.9, steady render p95 7.71ms, first render 16.73ms, cursor prepare max 0.16ms, payload 183.1 MB/s.
- Final 900-frame full preview: submitted/rendered/callback 900/900/900, skipped 0, renderer dropped 0, effective rendered FPS 59.9, steady render p95 7.67ms, max 9.50ms, first render 16.98ms, cursor prepare max 0.24ms, payload 430.9 MB/s.
- Final 900-frame default-half preview: submitted/rendered/callback 900/900/900, skipped 0, renderer dropped 0, effective rendered FPS 60.0, steady render p95 7.47ms, max 8.37ms, first render 17.94ms, cursor prepare max 0.23ms, payload 183.2 MB/s.
- The first-frame cursor asset cost was removed from the measured prewarmed frame by running cursor preload in the existing renderer-layer initialization thread; final warmup was 28.4ms full and 20.1ms default-half on the sustained runs.
- Playback validation still passes: AVAssetReader hardware decode, playback p95 5.0ms/3.2ms, mic diff 35.3ms/13.8ms, system audio diff 92.7ms/92.8ms, camera drift 0.0ms.
- Desktop transport/display 300-frame full preview: Rust submitted/rendered/callback 300/300/300, browser displayed 300/300, WebGPU transport, browser aggregate render FPS 60.59, upload avg/max 2.05/2.40ms, receive-to-display avg/max 3.24/11.40ms, Rust WebSocket steady pack avg/max 0.111/0.219ms, send avg/max 1.195/1.916ms, created-to-sent avg/max 1.340/2.053ms, payload 430.6 MB/s.
- Desktop transport/display 300-frame default-half preview: Rust submitted/rendered/callback 300/300/300, browser displayed 300/300, WebGPU transport, browser aggregate render FPS 59.60, upload avg/max 0.057/0.300ms, receive-to-display avg/max 1.47/8.70ms, Rust WebSocket steady pack avg/max 0.050/0.128ms, send avg/max 0.479/0.964ms, created-to-sent avg/max 0.560/1.105ms, payload 183.1 MB/s.
- Desktop transport/display 900-frame full preview: Rust submitted/rendered/callback 900/900/900, browser displayed 900/900, WebGPU transport, browser aggregate render FPS 60.00, upload avg/max 2.08/2.50ms, receive-to-display avg/max 4.22/11.10ms, Rust WebSocket steady pack avg/max 0.109/0.635ms, send avg/max 1.260/9.272ms, created-to-sent avg/max 1.401/9.427ms, payload 431.0 MB/s.
- Desktop transport/display 900-frame default-half preview: Rust submitted/rendered/callback 900/900/900, browser displayed 900/900, WebGPU transport, browser aggregate render FPS 59.95, upload avg/max 0.062/0.300ms, receive-to-display avg/max 1.65/8.70ms, Rust WebSocket steady pack avg/max 0.048/0.177ms, send avg/max 0.462/3.040ms, created-to-sent avg/max 0.542/3.182ms, payload 183.2 MB/s.
- Shared-buffer write/fallback counters were zero on these editor-preview runs because the direct-canvas WebGPU path handled the displayed frames; no fallback transport was observed.

**Validation**:
- `cargo fmt --all`
- `cargo check -p cap-editor --examples`
- `cargo check -p cap-desktop --examples`
- `pnpm exec biome check --write apps/desktop/scripts/desktop-display-transport-benchmark.js apps/desktop/package.json apps/desktop/src/utils/socket.ts apps/desktop/src/utils/webgpu-renderer.ts crates/editor/PLAYBACK-FINDINGS.md`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution full`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution half`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 900 --resolution full`
- `cargo run -p cap-editor --example editor-playback-benchmark -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 900 --resolution half`
- `pnpm --dir apps/desktop test:display-transport -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution full --startup-delay-ms 5000`
- `pnpm --dir apps/desktop test:display-transport -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 300 --resolution half --startup-delay-ms 5000`
- `pnpm --dir apps/desktop test:display-transport -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 900 --resolution full --startup-delay-ms 5000`
- `pnpm --dir apps/desktop test:display-transport -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 --frames 900 --resolution half --startup-delay-ms 5000`
- `cargo run -p cap-recording --example playback-test-runner -- --recording-path /tmp/cap-performance-fixtures/reference-recording.cap --fps 60 full`

**Stopping point**: The measured sustained-run bottleneck was first-use cursor asset loading during playback. Moving that work to renderer-layer initialization removes the repeated frame 696 drop without changing playback timing, frame choice, preview resolution semantics, visual asset selection, audio/video sync, decoder selection, GPU adapter selection, or fallback behavior. The full desktop path now sustains 60fps on the reference fixture with no renderer drops, skips, WebSocket send failures, or browser display notification loss in the 900-frame full/default-half runs. The next visible full-preview cost is WebGPU texture upload/display work around 2.1ms average plus Rust WebSocket send around 1.3ms average, both still under frame budget.

---

### Session 2026-07-03 (Play-Start Latency: Progressive Audio Pre-Render)

**Goal**: Pressing play (including after scrubbing) sometimes took multiple seconds before video started. Benchmark press-play → clock-start latency, find the cause, fix it without any A/V sync or steady-state regressions.

**What was done**:
1. Added permanent play-start telemetry to `Playback`: `AudioSegmentsResolved` (background audio-decode wait inside `Playback::start`), `AudioPipelineReady` (audio setup block duration), `ClockStarted` (total press-to-clock latency). Zero overhead in production (`telemetry: None`).
2. Extended `editor-playback-benchmark` with `--press-starts "0,45,0"` — sequential play presses (play → scrub ahead → play → scrub back → play) against one shared renderer/decoders, mirroring the real app, printing a per-press latency breakdown.
3. Benchmarked a real 226s 7-segment recording (mic + system audio + 60fps import) on M4 Max, release AND debug profiles (dev app runs debug with no opt-level override → Rust audio loops are ~15x slower).
4. Root cause: `PrerenderedAudioBuffer::new` rendered + resampled the ENTIRE timeline mix synchronously on EVERY play press before the clock could start — O(duration) CPU + 82MB alloc for 226s. Debug: ~930ms per press; scales with duration everywhere (1hr recording ≈ 1s+ even on fast hardware in release).
5. Rewrote it as a progressive pre-render: a `cap-audio-prerender` producer thread renders the same chunk-for-chunk pipeline (AudioRenderer → AudioResampler) into a shared zero-initialised `Box<[AtomicU32]>` (f32 bits), publishing progress via Release/Acquire watermarks. Pass 1 renders playhead−1s→end (stream ready after a 250ms window, typically <5ms), pass 2 wraps 0→playhead for backwards seeks. The cpal callback reads only below the watermarks and outputs silence for not-yet-rendered regions (never garbage); it converts f32→device format per sample. Producer renders 240x+ realtime even in debug, and aborts via a stop flag when the stream drops.

**Changes Made**:
- `crates/editor/src/audio.rs`: `PrerenderedAudioBuffer` is now progressive (`ProgressiveTimeline` shared state, `spawn_progressive_render`, watermark-gated `fill`). Same public API + `start_playhead_secs` param + `wait_until_ready`.
- `crates/editor/src/playback.rs`: `create_stream_prerendered` computes the latency hint first, passes the start playhead to the buffer, and waits (bounded 2s) for the initial window before returning the stream. Play-start telemetry emission.
- `crates/editor/src/telemetry.rs`: new `AudioSegmentsResolved` / `AudioPipelineReady` / `ClockStarted` events.
- `crates/editor/examples/editor-playback-benchmark.rs`: `--press-starts` multi-press mode + play-start latency report.

**Results** (226s recording, 30fps, half preview, M4 Max):
- Release press-to-clock: press1 183→129ms, press2 (scrub) 147→82ms, press3 146→62ms. Audio pipeline block 113-135ms → 40-80ms.
- Debug (dev app): press2 (scrub) 997→50ms, press3 →55ms (≈20x). Press1 975ms remains video warmup (fresh-process decoder/GPU warmup; the real app prewarms this at editor open).
- Full playback validation still passes: all 6 segments decode OK, mic sync 28-86ms, system audio 19-27ms, camera drift 0.0ms.
- Sustained 300-frame run: 300/300 rendered, 0 skips, 0 renderer drops, 29.8/30fps.
- All 17 cap-editor tests pass (debug + release), including `prerendered_playback_and_export_apply_negative_timing_offset_consistently` which asserts playback `fill()` output (through the new atomic read path) matches export rendering sample-for-sample.

**Intentional behavior notes**:
- Seeking into a not-yet-rendered region (only possible within ~100ms of press in release, ~1s in debug) plays brief silence instead of blocking; video is unaffected and audio realigns via the existing playhead sync.
- The full mix still completes in the background (~60ms release / ~950ms debug for 226s), so seeks after that are identical to the old fully-prerendered behavior.
- On non-f32 output devices the sample conversion moved from swr to cpal (`f32 → T` per sample); values are equivalent (neither dithers), and macOS/Windows default outputs are f32 anyway.

**Stopping point**: Press-to-clock is now duration-independent. Remaining (not blocking): first-callback wait (~40ms, device period) could overlap video warmup for another ~40ms win; Bluetooth outputs still gate clock start on the device's first callback (pre-existing); benchmark press-1 warmup in a fresh process reflects setup the real app prewarms at editor open.

---

### Session 2026-07-03 (No-Silence Guarantee: Persistent Audio Output Stream)

**Goal**: Continue the play-start work with a hard requirement: video must never play while audio that should be audible is silent, and repeated play/scrub cycles must be instant even on Bluetooth outputs.

**What was done**:
1. Fixed a ready-gate anchoring bug in the progressive pre-render: the "initial window rendered" signal was anchored at the pre-roll start (playhead−1s), not the playhead itself, so the guarantee "samples at the playhead exist before the stream starts" had a hole. The signal is now anchored at the actual start playhead + 250ms window.
2. Replaced the per-press audio stream with a persistent per-editor-session output stream (`crates/editor/src/audio_output.rs`): one `cap-audio-output` thread owns a cpal stream that plays silence while paused. A play press builds the progressive buffer, waits for the playhead window (ms), and installs the source into the live callback via a command channel; the callback acknowledges on first consumption, and only then does the playback clock start. Pressing play costs one callback period (~5-15ms) instead of a device open + first-callback wait (~40ms internal, seconds on Bluetooth).
3. The stream is prewarmed at `EditorInstance::new` (when the recording declares audio or the project has music), so even the FIRST press skips the device wake. It is rebuilt only when the default output device changes or the stream errors (checked per play), and shuts down on editor dispose/drop.
4. Sources carry a generation token: a stale playback shutting down cannot detach its successor's audio (start_playback installs the new source before stopping the old one).
5. Deleted the now-dead legacy audio paths: `AudioPlayback`, per-press `create_stream`/`create_stream_prerendered` (playback.rs) and `AudioPlaybackBuffer` + resampler `reset` (audio.rs).

**Why silence is now structurally prevented**:
- Clock start is gated on BOTH the playhead window being rendered AND the live callback consuming the source.
- User seeks always create a new playback (there is no live-seek path into a running `Playback`), which re-anchors pass 1 at the new position and re-gates.
- Mid-playback the video clock advances at 1x while the producer renders 240x+ realtime even in debug — consumption can never catch the watermark. Drift corrections are bounded ≪ the 1s pre-roll.
- If the audio device is genuinely dead (ack timeout 5s), playback degrades to video-only exactly as before, and the stream is rebuilt on the next press.

**Results** (226s 7-segment recording, 30fps, half preview, M4 Max):
- Release press-to-clock: 57 / 40 / 41ms (press 1 / scrub+play / play again) — audio pipeline 5-12ms per press (was 113-135ms at baseline, 40-80ms after the progressive fix alone).
- Debug (dev app): 923 / 59 / 48ms — press-1 remainder is fresh-process video warmup that the real app prewarms at editor open.
- Sustained 300-frame run: 300/300 rendered, 0 renderer drops, 29.9/30fps, render p95 9.4ms.
- Sync validation unchanged: mic 28-86ms, system 19-27ms, camera drift 0.0ms.
- All 17 cap-editor tests pass (debug + release); clippy clean; cap-desktop/cap-export/cap CLI compile.

**Behavior notes**:
- While the editor is open (and the recording has audio), the app holds an open output stream playing silence — this is how DAWs/editors keep latency down; it keeps Bluetooth links awake between presses.
- Pause responsiveness: audio now stops when the playback loop exits (≤1 frame + 1 callback period ≈ ~45ms) instead of the audio thread being woken directly; imperceptible in practice.
- Output device switching mid-playback keeps playing to the old device until the next press (same as the old per-press binding), then rebuilds.

**Multi-recording regression matrix (10 latest real recordings, release, M4 Max)**:
- Coverage: 7-segment mixed mic+system+camera project, 4-segment system-audio project, 3840×1920 window recordings, single-segment mic+camera recordings, mic+system single-segment — 30 play presses total (play at 0 → scrub to mid → play again).
- Press-to-clock: 16-125ms across all 30 presses (fresh-process press 1 on 4K-window content up to ~490ms — decoder warmup the real app pays at editor open, not at press). Audio pipeline attach: 1-28ms every press. Frames: 60/60 rendered on every press, 0 renderer drops, 0 skips, 0 send failures.
- Sync validation: 9/10 pass (mic 8-86ms, system 19-32ms, camera drift 0.0ms everywhere). The one FAIL ("Built-in Retina 01.03 PM", mic diff 265ms) is baked into that recording's files — the validator's code paths (crates/recording, crates/audio) are untouched by this change and measure the same on any build; it's the known recording-side start_time class, not a playback regression.
- One matrix-script artifact: pressing play past the end of an edited timeline (script used raw-footage midpoint, 82s > 64.8s timeline) hits the pre-existing 5s no-frames warmup timeout and aborts cleanly; next press recovers. Unreachable in the app (playhead is clamped) and unchanged behavior.

**Stopping point**: No-silence + instant-press guarantees in place, validated across 10 real recordings. Follow-up candidates: overlap the (now ~10ms) audio attach with video warmup; a few-ms fade-in on source install to eliminate any theoretical click at play start.

---

### Session 2026-07-16 (Scrub and Transition Decoder Scheduling)

**Goal**: Reduce decoder work during rapid preview requests and keep 60fps playback stable through scrubbing, jumps, timeline restarts, and transitions without changing export behavior.

**What was done**:
1. Traced preview, playback prefetch, renderer, and AVAssetReader pool activity during repeated scrubs, transition restarts, forward jumps, and a return to frame zero.
2. Replaced 15 concurrent preview-prefetch tasks with one sequential, cancellable task that begins only after the requested preview frame renders.
3. Removed playback prefetch work behind the playhead after runtime traces showed it caused unnecessary decode traffic and false scrub behavior.
4. Split discontinuous AVAssetReader request batches into contiguous clusters and kept deferred clusters for the next decoder selection.
5. Changed reset selection to use an untouched decoder first, then the least-recently-used decoder once every pool member has been used.

**Changes Made**:
- `crates/editor/src/editor_instance.rs`: Preview prefetch is sequential, cancellable, and starts after confirmed rendering.
- `crates/editor/src/playback.rs`: Removed behind-playhead prefetch.
- `crates/rendering/src/decoder/avassetreader.rs`: Discontinuous request batches are processed as separate contiguous clusters.
- `crates/rendering/src/decoder/multi_position.rs`: Repositioning preserves active decoder work when an unused pool member is available.

**Results**:
- Transition playback sustained 60.38fps with 119 rendered frames and zero skipped frames.
- Two additional sustained samples measured 60.47fps and 60.19fps with zero skipped frames.
- Decoder traces showed transition source ranges separated into clusters and assigned to stable decoder positions instead of repeatedly resetting one active decoder.
- Repeated scrubbing, forward jumps, timeline restarts, and returning to frame zero were visually smooth.
- Debug instrumentation was removed after the successful verification run.

**Validation**:
- `cargo fmt --all`
- `cargo test -p cap-rendering decoder::multi_position::tests::test_reposition_preserves_accessed_decoder_when_unused_decoder_is_available`
- `cargo test -p cap-rendering` (118 passed, 1 ignored)
- `cargo check -p cap-rendering -p cap-editor`
- `cargo check -p cap-export`

**Stopping point**: The reproduced transition and seek workload is smooth at 60fps with zero measured playback skips. The final implementation retains only the measured scheduling changes and their decoder-pool regression test.

---

## References

- `PLAYBACK-BENCHMARKS.md` - Raw performance test data (auto-updated by test runner)
- `../recording/FINDINGS.md` - Recording performance findings (source of test files)
- `../recording/BENCHMARKS.md` - Recording benchmark data
- `examples/playback-test-runner.rs` - Playback test implementation
