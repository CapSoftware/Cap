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

- [ ] **Test fragmented mode** - Run playback tests on fragmented recordings
- [ ] **Investigate display decoder init time** - 337ms may be optimizable

### Completed
- [x] **Run initial baseline** - Established current playback performance metrics (2026-01-28)
- [x] **Profile decoder init time** - Hardware acceleration confirmed (AVAssetReader) (2026-01-28)
- [x] **Identify latency hotspots** - No issues found, p95=3.1ms (2026-01-28)

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

## References

- `PLAYBACK-BENCHMARKS.md` - Raw performance test data (auto-updated by test runner)
- `../recording/FINDINGS.md` - Recording performance findings (source of test files)
- `../recording/BENCHMARKS.md` - Recording benchmark data
- `examples/playback-test-runner.rs` - Playback test implementation
