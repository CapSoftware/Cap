# Cap Export Performance Findings

> **SELF-HEALING DOCUMENT**: This file is designed to maintain complete context for export performance work. After any work session, UPDATE this file with your findings before ending.

---

## Quick Start (Read This First)

**When your context resets, do this:**

1. Read this file completely
2. Read `EXPORT-BENCHMARKS.md` for latest raw benchmark data
3. Run a quick export benchmark to verify current state:
   ```bash
   cargo run -p cap-export --example export-benchmark-runner -- quick
   ```
4. Continue work from "Next Steps" section below

**After completing work, UPDATE these sections:**
- [ ] Current Status table (if metrics changed)
- [ ] Estimation Accuracy table (if estimation data changed)
- [ ] Next Steps (mark completed, add new)
- [ ] Session Notes (add your session)

---

## Current Status

**Last Updated**: 2026-02-16

### Performance Summary (Real recording, 71s, debug build)

| Metric | Target | 720p | 1080p | 4K | Status |
|--------|--------|------|-------|----|--------|
| MP4 Render FPS (30fps) | >= 30 fps (1080p), >= 15 fps (4K) | 276-306 fps | 249-286 fps | 106-175 fps | PASS |
| MP4 Render FPS (60fps) | >= 30 fps | - | 284 fps | - | PASS |
| Export Completion | No errors | 3/3 | 4/4 | 2/2 | PASS |

### Estimation Accuracy (Real recording, calibrated algorithm)

| Preset | Estimated Size | Actual Size | Error (%) | Notes |
|--------|----------------|-------------|-----------|-------|
| MP4 720p/30fps/Maximum | 36.22 MB | 35.79 MB | +1.2% | |
| MP4 720p/30fps/Social | 18.52 MB | 18.93 MB | -2.2% | |
| MP4 720p/30fps/Web | 10.26 MB | 12.13 MB | -15.4% | Slight underestimate at low BPP |
| MP4 1080p/30fps/Maximum | 80.46 MB | 80.27 MB | +0.2% | |
| MP4 1080p/30fps/Social | 40.64 MB | 41.19 MB | -1.3% | |
| MP4 1080p/30fps/Web | 22.06 MB | 23.37 MB | -5.6% | |
| MP4 1080p/60fps/Maximum | 128.25 MB | 127.65 MB | +0.5% | |
| MP4 4K/30fps/Maximum | 319.39 MB | 319.82 MB | -0.1% | |
| MP4 4K/30fps/Social | 160.11 MB | 161.26 MB | -0.7% | |

**Average size estimation error: 3.0%** (calibrated from real-world recording data)

### Current Estimation Algorithm (Calibrated 2026-02-16)

The size estimation uses BPP with encoder-matched FPS tapering and measured efficiency:

**MP4 formula:**
```
effective_fps = min(fps, 30) + max(fps - 30, 0) * 0.6
video_bitrate = width * height * bpp * effective_fps
audio_bitrate = 192,000 bps
encoder_efficiency = 0.5
total_size = (video_bitrate + audio_bitrate) * encoder_efficiency * duration / 8
```

BPP values (unchanged, used by both encoder and estimation):
- Maximum: 0.3
- Social: 0.15
- Web: 0.08
- Potato: 0.04

The `effective_fps` tapering matches the H.264 encoder's `get_bitrate()` function in `crates/enc-ffmpeg/src/video/h264.rs`. The `encoder_efficiency = 0.5` accounts for H.264 achieving better compression than the theoretical BPP * pixels calculation.

**GIF formula:**
```
bytes_per_frame = width * height * 0.5 * 0.07
total_size = bytes_per_frame * total_frames
```

**Time estimation** uses observed render FPS from benchmarks:
- MP4 <= 2560px wide: ~290 effective render FPS
- MP4 4K: ~175 effective render FPS
- GIF 720p: ~10 fps (release build), ~1.5 fps (debug)

### What's Working
- Export pipeline (render -> encode -> mux)
- NV12 GPU-accelerated pipeline for MP4
- GIF encoding via gifski
- Multiple resolution/fps/compression presets
- Benchmark infrastructure in place

### Known Issues
- Web (0.08 BPP) preset slightly underestimates at 720p (-15.4%) - encoder may use minimum bitrate floor
- GIF estimation not yet calibrated against real recordings (only synthetic data)
- GIF encoding is very slow in debug builds (1.5-1.8 fps vs expected 10+ fps in release)
- 4K time estimation can vary by ~40% depending on system load (GPU-bound)

---

## Root Cause Analysis

### Estimation Accuracy
- **Status**: RESOLVED - calibrated against real recording, avg error 3.0%
- **Root cause**: Raw BPP * pixels * fps overestimates by ~2x because H.264 encoder is more efficient
- **Fix**: Applied `encoder_efficiency = 0.5` factor + FPS tapering matching the encoder's `get_bitrate()` logic
- **Result**: 8 of 9 presets within 6% error, worst case -15.4% (720p/Web)

### Time Estimation
- **Status**: RESOLVED - calibrated using observed render FPS from benchmarks
- **Root cause**: Old algorithm used arbitrary resolution * compression * fps factors
- **Fix**: Replaced with `total_frames / effective_render_fps` using measured FPS (290 for <=1080p, 175 for 4K)
- **Result**: Most presets within 5% error, 4K can vary more due to GPU load

---

## Fix Progress

1. [x] Run initial benchmarks to establish baseline data
2. [x] Analyze estimation accuracy across all presets (synthetic data)
3. [x] Run benchmarks against real user recordings for meaningful calibration
4. [x] Calibrate BPP constants based on actual export data
5. [x] Remove UI multiplier hacks (0.5x MP4, 0.7x GIF) - backend now gives accurate estimates
6. [x] Re-benchmark to verify calibration (avg error: 3.0%)

---

## Next Steps

1. **GIF calibration** - Run GIF exports against real recordings (in release mode) to calibrate GIF estimation
2. **Release-mode benchmarks** - Run `--release` builds for more representative GIF and overall numbers
3. **More recording types** - Test with different content types (presentations, code, video playback)
4. **Add CI integration** - Consider adding export benchmarks to CI pipeline

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `crates/export/src/lib.rs` | ExporterBase, builder pattern, export orchestration |
| `crates/export/src/mp4.rs` | MP4 export pipeline (NV12 render -> H.264 encode -> MP4 mux) |
| `crates/export/src/gif.rs` | GIF export pipeline (RGBA render -> gifski encode) |
| `crates/rendering/src/lib.rs` | `render_video_to_channel_nv12()` and `render_video_to_channel()` |
| `crates/enc-ffmpeg/src/video/h264.rs` | H.264 encoder with BPP-based bitrate |
| `crates/enc-ffmpeg/src/mux/mp4.rs` | MP4 muxer |
| `crates/enc-gif/src/lib.rs` | GIF encoder wrapper |
| `apps/desktop/src-tauri/src/export.rs` | Size/time estimation, Tauri export command |
| `apps/desktop/src/routes/editor/ExportPage.tsx` | Export UI, preset options, size display |
| `crates/export/examples/export-benchmark-runner.rs` | Export benchmark runner |

---

## Session Notes

### Session 2026-02-16 (Real-World Calibration)

**Goal**: Run benchmarks against real Cap recording and calibrate estimation algorithm

**What was done**:
1. Ran full MP4 benchmark against real 71s recording (2 segments, camera, mic, system audio, zoom segments)
2. Analyzed estimation errors - raw BPP formula overestimates by exactly ~2x
3. Applied FPS tapering to match encoder's `get_bitrate()` function
4. Applied `encoder_efficiency = 0.5` factor based on measured actual/estimated ratios
5. Removed UI 0.5x/0.7x multiplier hacks - backend now gives accurate estimates directly
6. Updated time estimation to use observed render FPS from benchmarks
7. Re-ran benchmark to verify - avg size error dropped from ~100% to 3.0%

**Changes Made**:
- `apps/desktop/src-tauri/src/export.rs`: Rewrote size estimation (FPS tapering + encoder efficiency), rewrote time estimation (observed render FPS)
- `apps/desktop/src/routes/editor/ExportPage.tsx`: Removed 0.5x/0.7x UI size multiplier hacks
- `crates/export/examples/export-benchmark-runner.rs`: Updated estimation functions to match backend

**Benchmark Results**:
- Overall: 9/9 passed
- Render FPS: 106-312 fps across all presets
- All exports completed successfully

**Estimation Accuracy**:
- MP4 avg size error: 3.0% (down from ~100%)
- Best: 4K/Maximum at -0.1%, 1080p/Maximum at +0.2%
- Worst: 720p/Web at -15.4%
- Time estimation: mostly within 5%

**Stopping point**: MP4 estimation is calibrated and accurate. GIF estimation still needs real-world data.

### Session 2026-02-16 (Initial Benchmark Infrastructure)

**Goal**: Create export benchmark infrastructure matching recording/playback pattern

**What was done**:
1. Created `export-benchmark-runner.rs` with synthetic video generation, multi-preset test matrix, file size tracking, estimation comparison
2. Created EXPORT-BENCHMARKS.md and EXPORT-FINDINGS.md documents
3. Created performance-export skill
4. Ran initial full benchmark (11 presets, 10s synthetic video)
5. Attempted real-recording calibration (failed - real recordings without timelines don't export correctly)

**Changes Made**:
- `crates/export/examples/export-benchmark-runner.rs`: New benchmark runner
- `crates/export/Cargo.toml`: Added chrono, tracing-subscriber dev-dependencies
- `crates/export/EXPORT-BENCHMARKS.md`: New benchmark history file
- `crates/export/EXPORT-FINDINGS.md`: New findings document
- `.claude/skills/performance-export/SKILL.md`: New performance skill

**Benchmark Results**:
- Overall: 9/11 passed (all MP4 passed, GIF failed FPS target in debug build - expected)
- MP4 render FPS: 60-370 fps (well above targets)
- GIF render FPS: 1.5-1.8 fps (debug build, would be much faster in release)

**Estimation Accuracy**:
- MP4 avg size error: +1294% (synthetic content compresses much better than real content)
- GIF avg size error: +1206% (same reason)
- Note: These errors are expected for synthetic testsrc content; real screen recordings are more complex

**Stopping point**: Infrastructure is complete. Next steps are:
1. Run benchmarks against real user recordings for meaningful calibration data
2. Consider running in release mode for more realistic GIF performance numbers
3. Calibrate estimation constants once real-world data is available

### Template for new sessions:

```markdown
### Session YYYY-MM-DD (Brief Description)

**Goal**: What you set out to do

**What was done**:
1. Step 1
2. Step 2

**Changes Made**:
- File: description of change (or "None - performance healthy")

**Benchmark Results**:
- Overall: X/Y passed
- Key metrics summary

**Estimation Accuracy**:
- MP4 avg error: X%
- GIF avg error: X%

**Stopping point**: Current state and any follow-up needed
```
