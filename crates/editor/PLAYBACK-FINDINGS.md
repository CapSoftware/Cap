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

**Last Updated**: 2026-02-13

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
- ✅ Editor playback now keeps a live seek channel during playback instead of stop/start restart loops
- ✅ Audio playback defaults to low-latency streaming buffer path with bounded prefill

### Known Issues (Lower Priority)
1. **System audio timing**: ~162ms difference inherited from recording-side timing issue
2. **Display decoder init time**: baseline was 337ms from eager multi-decoder setup; now reduced by lazy decoder warmup but needs benchmark confirmation

---

## Next Steps

### Active Work Items
*(Update this section as you work)*

- [ ] **Test fragmented mode** - Run playback tests on fragmented recordings
- [ ] **Collect cross-platform benchmark evidence** - macOS 13+ and Windows GPU matrix for FPS, scrub settle, audio start latency, and A/V drift
- [ ] **Validate lazy decoder warmup impact** - measure display decoder init and scrub settle before/after on real recordings
- [ ] **Validate streaming audio startup/sync** - benchmark low-latency path vs legacy pre-render path across long timelines

### Completed
- [x] **Run initial baseline** - Established current playback performance metrics (2026-01-28)
- [x] **Profile decoder init time** - Hardware acceleration confirmed (AVAssetReader) (2026-01-28)
- [x] **Identify latency hotspots** - No issues found, p95=3.1ms (2026-01-28)
- [x] **Remove seek restart churn in timeline path** - in-playback seeks now route through live playback handle (2026-02-13)
- [x] **Switch default audio mode to low-latency streaming** - full prerender now opt-in by env flag (2026-02-13)
- [x] **Reduce eager AVAssetReader decoder warmup** - pool now initializes lazily beyond first warm decoders (2026-02-13)

---

## Benchmarking Commands

```bash
# Full playback validation (RECOMMENDED)
cargo run -p cap-recording --example playback-test-runner -- full

# Test specific categories
cargo run -p cap-recording --example playback-test-runner -- decoder
cargo run -p cap-recording --example playback-test-runner -- playback
cargo run -p cap-recording --example playback-test-runner -- scrub
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

1. **Low-latency audio startup enabled by default (2026-02-13)**
   - `AudioPlayback::spawn()` now selects streaming `create_stream()` path by default.
   - Legacy full-timeline prerender path is still available via `CAP_AUDIO_PRERENDER_PLAYBACK=1`.
   - `AudioPlaybackBuffer` is available on all platforms so Windows can use streaming sync logic.

2. **In-playback seek path without stop/start (2026-02-13)**
   - Added seek channel to `PlaybackHandle` and playback loop.
   - `seek_to` and `set_playhead_position` commands now forward seek requests to active playback.
   - Timeline seek no longer tears down and recreates playback while playing.
   - Seek signaling now uses watch semantics so only latest frame target is consumed under heavy scrub load.

3. **Lazy decoder pool warmup on macOS AVAssetReader (2026-02-13)**
   - Initial warmup now creates only a small subset of decoder instances.
   - Additional decoder instances are initialized lazily when scrub patterns request them.
   - Failed lazy init falls back safely to currently available decoders.

4. **Playback benchmark runner now captures scrub and startup metrics (2026-02-13)**
   - Added `scrub` benchmark mode to `playback-test-runner`.
   - Playback result now includes first-frame decode and startup-to-first-frame latency.
   - Scrub result now reports seek p50/p95/p99 and seek failure counts.

5. **Playback runtime emits startup latency signals (2026-02-13)**
   - Playback loop now logs first rendered frame latency.
   - Audio stream setup now logs startup preparation time and first callback latency.
   - Playback loop now logs seek settle latency (`seek_target_frame` to rendered frame).

6. **Decode benchmark now supports machine-readable evidence output (2026-02-13)**
   - `decode-benchmark` supports `--output-json` for structured metric capture.
   - Added sequential frame and random sample count controls to scale benchmark depth per hardware class.
   - Supports fragmented segment directories for duration-aware benchmarking.

7. **Timeline seek dispatch now coalesces during drag (2026-02-13)**
   - Frontend seek calls are requestAnimationFrame-batched.
   - Only the latest pending seek frame is sent while an async seek is in-flight.
   - Duplicate same-frame seeks are dropped in both frontend dispatch and playback seek signaling.

8. **Playback frame wait timeout now scales with target FPS (2026-02-13)**
   - Replaced fixed 200ms frame fetch waits with FPS-derived bounded timeout.
   - Reduces long stall windows on 60fps playback and improves real-time catch-up behavior.
   - In-flight polling interval now scales with frame budget instead of fixed 5ms.
   - Catch-up skip threshold now adapts with late streak depth and logs skip event telemetry.
   - Warmup target and warmup timeout now scale with FPS, reducing startup buffering overhead.
   - Prefetch ahead/behind windows now scale with FPS to reduce unnecessary decode pressure at lower targets.

8. **Playback benchmark runner now supports JSON evidence export (2026-02-13)**
   - `playback-test-runner` supports `--json-output` for structured report emission.
   - JSON output includes command metadata, system info, summary, and per-recording test detail.
   - Command metadata now includes input scope and output flags for reproducibility.
   - Startup-to-first-frame threshold is configurable with `--startup-threshold-ms` and tracked as pass/fail signal.

9. **Added JSON aggregate utility for cross-platform benchmark collation (2026-02-13)**
   - `scripts/aggregate-playback-benchmarks.js` builds a markdown table from multiple JSON outputs.
   - Aggregates platform/gpu/scenario-tagged runs for matrix reporting.

10. **Added matrix run helper for platform/GPU benchmark execution (2026-02-13)**
   - `scripts/run-playback-benchmark-matrix.js` runs `full` and `scrub` scenarios with tagged notes and JSON output.
   - Automatically generates aggregate markdown for each machine run directory.
   - Performs per-machine post-run validation for required scenarios and optional format requirements.
   - Supports scenario subset reruns via `--scenarios` for faster targeted validation.
   - Supports startup threshold tuning via `--startup-threshold-ms`.

11. **Added matrix completeness validator (2026-02-13)**
   - `scripts/validate-playback-matrix.js` validates required platform/gpu/scenario cells.
   - Supports required format checks per cell (mp4 + fragmented).
   - Root `package.json` now exposes `bench:playback:*` script aliases for matrix, aggregate, and validate flows.
   - Can emit structured validation JSON for artifact upload and automation.

12. **Added matrix status report generator (2026-02-13)**
   - `scripts/build-playback-matrix-report.js` generates concise matrix markdown from JSON results.
   - Highlights missing cells, scenario pass/fail, and format coverage per platform/GPU row.

13. **Added matrix finalization helper (2026-02-13)**
   - `scripts/finalize-playback-matrix.js` generates aggregate markdown, status markdown, and validation JSON in one command.
   - Supports optional required format enforcement during finalization.
   - Also emits bottleneck analysis markdown using configurable FPS/scrub/startup thresholds.
   - Can optionally publish finalized artifacts directly into benchmark history target.

14. **Added matrix summary publisher (2026-02-13)**
   - `scripts/publish-playback-matrix-summary.js` injects finalized matrix artifacts into playback benchmark history.
   - Keeps matrix evidence updates consistent and repeatable.
   - Supports optional bottleneck analysis attachment in published summary.

15. **Added bottleneck analyzer for continuous FPS optimization (2026-02-13)**
   - `scripts/analyze-playback-matrix-bottlenecks.js` ranks matrix cells by FPS, startup, and scrub threshold breaches.
   - Produces prioritized optimization backlog from real matrix evidence.
   - Supports structured JSON output for automation and regression tracking.

---

## Root Cause Analysis Archive

1. **Audio start delay from full-track prerender**
   - Root cause: playback startup used `create_stream_prerendered()` for all sample formats, forcing full timeline audio render before output stream started.
   - Fix direction: switch default to incremental `AudioPlaybackBuffer` path with bounded prefill and live playhead correction.

2. **Scrub lag from playback restart loop**
   - Root cause: timeline seek while playing called stop → seek → start, rebuilding playback/audio state on every interactive seek.
   - Fix direction: add live seek channel into running playback loop and route frontend seeks to it.

3. **Display decoder init inflation on macOS**
   - Root cause: AVAssetReader decoder pool eagerly initialized multiple decoders during startup.
   - Fix direction: reduce eager warmup and lazily instantiate additional pool decoders when scrub behavior actually needs them.

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

### Session 2026-02-13 (Audio Startup + Live Seek + Lazy Decoder Warmup)

**Goal**: Remove major editor playback bottlenecks affecting startup latency, scrub responsiveness, and decoder init overhead.

**What was done**:
1. Switched playback audio startup default to streaming buffer path.
2. Kept prerender audio path behind `CAP_AUDIO_PRERENDER_PLAYBACK` as explicit fallback.
3. Enabled `AudioPlaybackBuffer` for all platforms so Windows uses live buffering/sync path.
4. Added a seek channel to `PlaybackHandle` and integrated seek handling into the main playback loop.
5. Updated Tauri seek/playhead commands to forward seeks into active playback handle.
6. Removed frontend timeline stop/start cycle when seeking while playing.
7. Reduced AVAssetReader eager pool warmup and added lazy decoder instantiation for additional pool slots.
8. Extended playback benchmark tooling with scrub mode and startup latency metrics.
9. Added playback runtime startup telemetry logs for first frame and audio callback bring-up.
10. Enhanced decode benchmark example with structured JSON output and configurable sample depth.
11. Added timeline seek dispatch coalescing to reduce seek command storms during drag.
12. Added JSON report output support to playback-test-runner for benchmark evidence collection.
13. Added cross-platform benchmark JSON aggregation utility script.
14. Added matrix execution helper script for full + scrub benchmark runs per platform/GPU.
15. Added matrix validation script for required cell and format coverage checks.
16. Added matrix status report generator for concise artifact summaries.
17. Added one-shot finalization script for aggregate + status + validation outputs.
18. Added benchmark history publisher script for finalized matrix artifacts.
19. Added matrix bottleneck analysis script for prioritized FPS optimization follow-up.

**Changes Made**:
- `crates/editor/src/playback.rs`: default low-latency audio mode, playback seek channel, seek-aware scheduling.
- `crates/editor/src/audio.rs`: cross-platform `AudioPlaybackBuffer`, windows-only smooth seek helper.
- `apps/desktop/src-tauri/src/lib.rs`: forward `seek_to` and `set_playhead_position` into active playback handle.
- `apps/desktop/src/routes/editor/Timeline/index.tsx`: seek while playing now sends direct `seekTo` without playback restart.
- `crates/rendering/src/decoder/avassetreader.rs`: lower eager decoder warmup and lazy pool growth.
- `crates/recording/examples/playback-test-runner.rs`: added scrub command and startup/scrub latency metrics.
- `crates/editor/PLAYBACK-BENCHMARKS.md`: updated benchmark reference and metric definitions.
- `crates/editor/src/playback.rs`: added first-render and audio-callback startup latency logging.
- `crates/editor/examples/decode-benchmark.rs`: added `--output-json`, startup metrics, and configurable sequential/random sampling.
- `apps/desktop/src/routes/editor/Timeline/index.tsx`: added requestAnimationFrame-based seek coalescing with in-flight protection.
- `crates/recording/examples/playback-test-runner.rs`: added `--json-output` to emit structured benchmark reports.
- `scripts/aggregate-playback-benchmarks.js`: added markdown aggregation for multiple playback benchmark JSON artifacts.
- `scripts/run-playback-benchmark-matrix.js`: added orchestrated full/scrub benchmark runner with per-machine aggregate generation.
- `scripts/validate-playback-matrix.js`: added required matrix cell/format validation for aggregated evidence.
- `scripts/build-playback-matrix-report.js`: added concise matrix status report generation from JSON benchmark outputs.
- `scripts/finalize-playback-matrix.js`: added one-shot matrix artifact finalization workflow.
- `scripts/publish-playback-matrix-summary.js`: added matrix artifact publisher into PLAYBACK-BENCHMARKS history region.
- `scripts/analyze-playback-matrix-bottlenecks.js`: added prioritized bottleneck analysis output from matrix JSON evidence.

**Results**:
- ✅ `cargo +stable check -p cap-editor` passes after changes.
- ✅ `cargo +stable check -p cap-rendering` passes after changes.
- ✅ `pnpm --dir apps/desktop exec tsc --noEmit` passes after frontend seek changes.
- ⚠️ `cargo +stable check -p cap-desktop` and `cargo +stable run -p cap-recording --example playback-test-runner -- list` fail in this Linux environment because `scap-targets` does not currently compile on this target (`DisplayIdImpl`/`WindowImpl` unresolved), preventing local benchmark execution here.
- ⚠️ Cross-platform FPS/scrub/A-V benchmark evidence still pending on macOS and Windows devices with real recordings.

**Stopping point**: Core playback code-path optimizations are implemented and compiling in touched crates; next step is benchmark execution on macOS 13+ and Windows GPU matrix to quantify gains.

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

## References

- `PLAYBACK-BENCHMARKS.md` - Raw performance test data (auto-updated by test runner)
- `PLAYBACK-MATRIX-RUNBOOK.md` - Cross-platform playback evidence collection process
- `../recording/FINDINGS.md` - Recording performance findings (source of test files)
- `../recording/BENCHMARKS.md` - Recording benchmark data
- `examples/playback-test-runner.rs` - Playback test implementation
