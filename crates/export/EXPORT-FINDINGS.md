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

**Last Updated**: 2026-08-17

### Performance Summary (Real recording, 71s, debug build)

| Metric | Target | 720p | 1080p | 4K | Status |
|--------|--------|------|-------|----|--------|
| MP4 Render FPS (30fps) | >= 30 fps (1080p), >= 15 fps (4K) | 276-306 fps | 249-286 fps | 106-175 fps | PASS |
| MP4 Render FPS (60fps) | >= 30 fps | - | 284 fps | - | PASS |
| Export Completion | No errors | 3/3 | 4/4 | 2/2 | PASS |

### Desktop Shell Comparison (29.95s recording, 1080p60 Social, release)

| Exporter | Median Time | Median CPU | Median RSS | Status |
|----------|-------------|------------|------------|--------|
| Current Cap source | 6.950s | 27.4% | 271.6 MB | PASS |
| Optimized Electron source | 6.958s | 28.4% | 278.8 MB | PASS |

The current and Electron exporters produce byte-identical 21,878,792-byte outputs. The desktop shell is not in the export process: both measurements invoke the release `cap` CLI directly against the same project. The earlier 6.93s / 40.5% result labelled GPUI used an older Tauri `cap-cli` binary and was not a GPUI export measurement.

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

### Session 2026-03-25 (Export Pipeline Optimizations)

**Goal**: Run export benchmarks, identify and implement safe performance improvements on macOS

**What was done**:
1. Ran full export benchmarks (11 presets) to establish baseline
2. Deep analysis of export pipeline: mp4.rs, gif.rs, h264.rs, enc-gif, rendering
3. Identified 4 optimization opportunities, implemented 3 (1 reverted after testing)
4. Verified all optimizations with multiple benchmark runs
5. Confirmed no regressions via A/B testing of channel size change

**Changes Made**:
- `crates/enc-gif/src/lib.rs`: Replaced per-pixel `push(RGBA8::new(...))` double loop with bulk `slice::from_raw_parts` + `extend_from_slice`. When stride matches width*4, entire frame is cast in one operation. When stride differs, copies row-by-row via slice (O(height) instead of O(width*height)).
- `crates/enc-ffmpeg/src/video/h264.rs`: Trimmed macOS encoder priority from `[h264_videotoolbox, h264_qsv, h264_nvenc, h264_amf, h264_mf, libx264]` to `[h264_videotoolbox, libx264]`. The 4 removed encoders never exist on macOS and just add failed init attempts.
- `crates/export/src/mp4.rs`: Increased NV12 render channel capacity from 2 to 8, allowing better pipeline overlap between GPU rendering and H.264 encoding. Memory cost: ~25MB at 1080p, ~100MB at 4K (acceptable for export).
- REVERTED: VideoToolbox `g` (keyframe interval) — tested and found it caused FPS regression on synthetic content. VT manages GOP internally; forcing it adds overhead.

**Benchmark Results**:
- Overall: 9/9 MP4 passed, 2/2 GIF passed (all above targets)
- MP4 720p: 347-370 fps (target: >=30)
- MP4 1080p/30: 272-289 fps (target: >=30)
- MP4 1080p/60: 304 fps (target: >=30)
- MP4 4K: 108-109 fps (target: >=15)
- GIF 720p: 1.7-1.8 fps (debug build, expected)
- A/B test confirmed channel 2→8 is neutral on synthetic content (identical FPS within noise)

**Estimation Accuracy**:
- MP4 avg error on synthetic: high (expected - synthetic content compresses much better than real recordings)
- Real-recording calibration from 2026-02-16 session still valid (avg 3.0% error)

**Key findings from pipeline analysis**:
1. The NV12 export pipeline (GPU render → readback → pool → copy to FFmpeg AVFrame) has inherent CPU copy overhead but is well-optimized for the current FFmpeg-based architecture
2. Software NV12 fallback (`render_nv12_software_path`) is slow but only triggers when hardware GPU adapter unavailable
3. The AVFoundation encoder (`crates/enc-avfoundation/src/mp4.rs`) is only used for live recording, not export — a future IOSurface/CVPixelBuffer bridge from wgpu to VideoToolbox could eliminate the CPU NV12 copy in export, but that's a major architectural change
4. GIF encoding is gifski-bound (CPU quantization), not renderer-bound; the `add_frame` optimization reduces overhead of frame delivery to gifski

**Stopping point**: Three safe optimizations implemented and verified. Further improvements would require architectural changes (IOSurface bridge, alternative encoder API for zero-copy) or release-mode GIF benchmarks.

### Session 2026-08-17 (GPUI Export Parity Audit)

**Goal**: Verify the reported GPUI export time and CPU regression against the optimized Electron build.

**What was done**:
1. Traced the GPUI benchmark harness and found that it invoked the Tauri benchmark bundle's `cap-cli`; the GPUI Export button is currently disabled.
2. Ran four measured interleaved release trials per exporter after one warm-up, using the same 29.95s project, 1920x1080 resolution, 60 fps and Social quality.
3. Compared the exporter and encoder source trees and confirmed that the reported CPU gap came from a pre-optimization rendering/decoder build.
4. Built the current Cap CLI, which includes the retained-IOSurface decoder path, and repeated the interleaved comparison against Electron.

**Changes Made**:
- None to the exporter. The necessary decoder optimization was already present in the current source.
- Corrected the benchmark graphic to use the verified current results.

**Benchmark Results**:
- Current Cap: 6.950s median, 27.4% median CPU, 271.6 MB median average RSS.
- Electron: 6.958s median, 28.4% median CPU, 278.8 MB median average RSS.
- Current Cap is 0.1% faster, uses 3.3% less CPU and 2.6% less memory in this workload.
- All eight measured exports completed with 1,797 frames and byte-identical outputs.

**Estimation Accuracy**:
- Not recalibrated; this audit used the established real recording and did not change estimation logic.

**Stopping point**: No current export regression remains. A real GPUI export flow still needs to be wired into the disabled editor Export control before it can be benchmarked as an application feature.

### Session 2026-08-18 (Zero-Copy VideoToolbox Export Input)

**Goal**: Remove the export video path's per-frame CPU work: GPU->CPU NV12 readback (3.11 MB at 1080p, 12.4 MB at 4K), the memcpy into the reusable AVFrame, and VideoToolbox's own software-frame ingest copy.

**What was done**:
1. `RgbaToNv12Converter` gained a surface-output mode: the existing compute shader writes the same NV12 bytes (256-aligned stride, values unchanged) and the GPU copies them into an IOSurface-backed 420v CVPixelBuffer from a fixed 8-slot ring — no readback, no map. Fallback to readback mode is automatic if the surface machinery fails.
2. `Nv12RenderedFrame` optionally carries an `Nv12Surface`; the export render channel is otherwise unchanged. Only `render_video_to_channel_nv12` enables surface output (macOS, hardware adapter), so the editor's NV12 consumers are untouched.
3. The export encoder thread decides its input mode from the first frame it receives: surface frames open `h264_videotoolbox` with `AV_PIX_FMT_VIDEOTOOLBOX` + `AVHWFramesContext` (the primitive added for recording) and queue wrapped CVPixelBuffers zero-copy; CPU frames (non-macOS, software adapter, escape hatch) keep the existing path. CRF/libx264 exports receive surface frames into the software encoder via a single lock-and-copy (one copy where there used to be readback + two).
4. `CAP_EXPORT_DISABLE_ZERO_COPY=1` forces the previous readback + software-frame path end to end.

**Verification**:
- `frame_pipeline::surface_output_tests::the_surface_output_matches_the_readback_output`: surface NV12 bytes match readback NV12 bytes exactly (max delta 0) at 1920x1080 and 1284x722 (stride-padding case).
- Full-export A/B on `/tmp/cap-performance-fixtures/reference-recording.cap` (release `cap` CLI, 1080p60 Social and 4K60 Social): decoded video is bit-identical (ffmpeg PSNR = inf) between the old and new paths — the same equivalence two runs of the OLD path have with each other (VT export bitstreams are run-to-run nondeterministic; decoded pixels are not). Audio streams byte-identical; file sizes byte-equal; dimensions/duration/frame counts identical.
- CRF (`--optimize-filesize`) export completes on the software encoder via surface materialization and decodes clean.
- First-frame screenshot (`screenshots/display.jpg`) still written, now materialized from the surface.
- cap-export (6), cap-rendering (172, incl. the new exactness test), cap-editor (31) tests pass; `cap-desktop` and the desktop-gpui workspace compile.

**Results** (release `cap` CLI, 30.8s reference recording, M4 Max, /usr/bin/time -l):

| Export | Path | Wall | User CPU | Peak RSS |
|--------|------|------|----------|----------|
| 1080p60 Social | old (readback) | 8.70s | 3.43s | 216.5 MB |
| 1080p60 Social | new (zero-copy) | 8.55s | 3.26s | 171.0 MB (-21%) |
| 4K60 Social | old (readback) | 20.04s | 5.30s | 402.1 MB |
| 4K60 Social | new (zero-copy) | 20.09s | 4.31s (-19%) | 213.3 MB (-47%) |

Wall time is neutral on this machine because the 4K export is GPU-render-bound, not encoder-bound; the win is the removed CPU work and memory traffic (readback + 2 memcpys + VT ingest per frame), which matters most on lower-powered hardware where the encoder thread contends with rendering.

**Stopping point**: The macOS export video path is IOSurface end to end: composite (GPU) -> NV12 convert (GPU) -> CVPixelBuffer (GPU copy) -> VideoToolbox (reads the IOSurface). Remaining CPU touches per frame are zero on the happy path.

### Session 2026-10-15 (Encoder-Bound Exports; Per-Frame Command Buffers and Render Passes)

**Goal**: Find what bounds macOS MP4 export and cut the renderer's fixed per-frame GPU work.

**What was done**:
1. Exported two real Studio recordings with the release `cap` CLI on an M4 Max: a 236 s, 2542x1226 recording with background blur, shadow, zoom and motion blur (5,616 output frames), and a 167 s, 1260x860 recording with captions and keyboard segments (2,712 frames).
2. At 4K, turning off background blur, motion blur, shadow and rounding, together or one at a time, moved wall time by under 0.3% (56.21-56.44 s). Encoding the same frames standalone with `h264_videotoolbox` and the export options took 18.2 s at 1080p and 55.6 s at 4K, matching the exports (18.8 s, 56.3 s). 1080p and 4K exports are VideoToolbox-bound here, not GPU-bound as the 2026-08-18 note concluded; a Metal System Trace puts the GPU at about 12% busy. Two concurrent VideoToolbox sessions encode less in total than one, so splitting an export does not help.
3. A Time Profiler trace of a 1080p export attributed 47% of process CPU to the Metal driver, 27% to kernel `IOGPUCommandQueueSubmitCommandBuffers`. A Metal System Trace counted 19.1 MTLCommandBuffers per frame: 7.7 empty "(wgpu internal) Pre Pass", 1.0 empty "Transit", 6.0 "Render Pass". wgpu-core gives each pass its own HAL command buffer plus one for barriers, which are no-ops on Metal (gfx-rs/wgpu#5738), and `RendererLayers::render` opened a pass per layer.
4. `vendor/wgpu-hal` Metal: an MTLCommandBuffer is created when the first encoder starts, empty ones are never committed, and the fence signal goes on the last non-empty one.
5. `RendererLayers::render`: consecutive layer draws into the same texture share one render pass. A pass still ends at a target switch, a clear, a mask, a blur-cache copy or a texture swap.
6. The blurred static background cache, previously enabled only by the render farm, now runs everywhere: the blurred backdrop is copied instead of re-blurred while its background, blur amount and sizes are unchanged.

**Verification**:
- 1080p exports from a build of main and from this change decode to identical frames (`ffmpeg -f framemd5`): 5,616/5,616 for the blur recording, 2,712/2,712 for the captions recording, and 5,616/5,616 each for blurred image, wallpaper, gradient and colour backgrounds and for style segments that swap the background and change the blur mid-export.
- New native test `cached_background_blur_matches_a_fresh_blur_and_follows_edits`; it fails if the cache ignores its key. cap-rendering, cap-editor, cap-export and cap-camera-effects tests pass.

**Benchmark Results** (M4 Max, release, means of 3 interleaved runs; command buffers from Metal System Trace):

| Metric | Before | After |
|--------|--------|-------|
| MTLCommandBuffers / frame, blur project 4K | 18.6 | 5.5 (-70%) |
| MTLCommandBuffers / frame, no-blur project 1080p | 13.7 | 4.5 (-67%) |
| Render passes / frame (blur / no blur) | 6 / 4 | 1 / 1 |
| Export CPU, blur project 720p / 1080p / 4K | 6.77 / 9.26 / 18.93 s | 5.74 / 8.26 / 17.20 s (-15% / -11% / -9%) |
| Export CPU, no-blur project 720p / 1080p / 4K | 3.03 / 4.37 / 7.97 s | 2.66 / 4.06 / 7.16 s (-12% / -7% / -10%) |

Wall time is unchanged on this machine: 1080p and 4K are encoder-bound, and 720p waits on the NV12 surface poll's millisecond sleeps (#2464).

The GPU-time rows first published here (4K 4,065 µs -> 1,656 µs; no-blur 1080p 330 µs -> 278 µs) came from single traces and did not reproduce on 2026-10-16, so they were removed; see that session.

**Stopping point**: About five command buffers per frame remain: one per remaining pass, PendingWrites and copy segments. Folding them into one needs pass coalescing in wgpu-core (gfx-rs/wgpu#10506).

### Session 2026-10-16 (Per-Change Attribution, CPU Profile, GPU Figures Rechecked)

**Goal**: Attribute the 2026-10-15 savings to each change, find where the remaining export CPU goes, and recheck the GPU figures.

**What was done**:
1. Release `cap` builds of main (83237e994), the wgpu-hal change alone, wgpu-hal plus pass merging, and all three changes. Exported the blur recording at 1080p and 4K under Metal System Trace, 10 s windows, counting only the `cap` process.
2. Five interleaved rounds of 1080p exports of both recordings, main against all three changes.
3. Time Profiler on 10 s of the 1080p blur export, main against all three changes.

**Results** (blur recording, 1080p; GPU busy is the union of the process's GPU intervals over seconds 2-9 of each trace):

| Build | MTLCommandBuffers / frame | GPU encoders / frame | GPU busy / frame |
|-------|---------------------------|----------------------|------------------|
| main | 19.4 | 16.6 | 744-858 µs |
| wgpu-hal change | 10.6 | 16.6 | 739 µs |
| + pass merging | 7.6 | 10.7 | 736 µs |
| + blur cache | 5.8 | 7.0 | 527-731 µs |

- At 4K, wgpu-hal alone against wgpu-hal plus pass merging: 10.2 -> 7.2 command buffers and 16.9 -> 11.0 encoders per frame; GPU busy 2,379 and 2,443 µs against 2,348 and 2,410 µs, inside the 1,900-3,700 µs second-to-second swing of each trace.
- Pass merging removes submission work, not GPU time. The attachment store and reload it avoids is not measurable on this GPU at 1080p or 4K. The GPU-time drop comes from the blur cache.
- At about 20% GPU load, GPU busy per frame varies by a quarter between identical runs, so it is a range here. The 2026-10-15 GPU rows summed per-channel intervals from single traces. Their 4K baseline does not reproduce: the wgpu-hal change alone measures about 2,650 µs summed at 4K, and that change removes no GPU work.
- Export CPU (user + sys), all three changes against main in each round: blur recording -16.1, -6.8, -10.9, -10.5, -23.1% (median -10.9%); no-blur recording -7.3, -11.1, -10.4, -18.0, -16.9% (median -11.1%). Absolute CPU drifts between rounds (6.2-9.4 s for main on the blur recording), so the per-round difference is the statistic. Wall time is unchanged and the decoded frames are identical.
- Time Profiler, 10 s of the 1080p blur export, each sample assigned to the first matching group in this order:

| Group | main | all three changes |
|-------|------|-------------------|
| Command-buffer submission (`IOGPUCommandQueueSubmitCommandBuffers`) | 905 ms (25.2%) | 630 ms (21.5%) |
| Other Metal, AGX and IOGPU driver work | 658 ms | 468 ms |
| wgpu-core and wgpu-hal | 231 ms | 198 ms |
| VideoToolbox and CoreMedia | 712 ms | 705 ms (24.0%) |
| FFmpeg | 247 ms | 228 ms |
| Cap code | 348 ms | 305 ms |
| Other | 488 ms | 403 ms |
| Total | 3,589 ms | 2,937 ms (-18%) |

- GIF at the 640x360 setting, 30 fps, blur recording, 15 interleaved rounds against main: CPU time (user + sys) was lower in all 15, median -1.9%. Wall time was shorter in 8 of 15 rounds, median -3.1%, per round -22.8% to +29.4%, too spread to show a change. GIF export is bound by gifski (about 10 fps at 720p in release, against about 290 fps for MP4 rendering; see Time Estimation), so the renderer's saving is a small share of it.
- GIF goes through the RGBA readback wait (`finish_encoder_timed` and `PendingReadback::wait`), which MP4 does not, so it was measured again after that wait became a blocking wait on the frame's submission (PLAYBACK-FINDINGS 2026-10-16). Five interleaved rounds against main: CPU lower in all 5, median -1.5% (per round -1.4, -0.5, -1.7, -2.9, -1.5%), instructions -0.5%, and all ten outputs byte-identical (10,357,857 bytes). Wall time was shorter in all 5 (main 6.51-7.13 s, branch 6.14-6.36 s, median -6.4%); given the 15 inconclusive rounds above, no wall-time change is claimed.
- The blurred-background cache now releases its texture on the first frame without blur. That exposed an older bug: `RendererLayers` refreshed the blur strength only while blur was above zero, so after blur was set to 0 the previous strength stayed in effect and the frame still had a cache key. The strength is now refreshed every frame. Its visible effect, the background staying blurred after blur is set to 0, is inferred from the code; the cache test's gradient background looks the same blurred and unblurred, so it checks the state instead.
- ProRes MOV was not benchmarked. One export took 96.7 s wall on 97.5 s of user CPU, about one core on average even though `prores_ks` is given `available_parallelism()` threads (`crates/enc-ffmpeg/src/video/prores.rs`). The encoder paces that export, so renderer savings cannot shorten it.

**Stopping point**: VideoToolbox is now the largest CPU cost of a 1080p export, followed by command-buffer submission, which is almost entirely `mach_msg2_trap`. Command buffers fell 70% while submission time fell 30%, so the remaining submission cost appears to follow the number of queue submissions per frame rather than the buffers in each; that is inferred from the profile and not measured. Xcode's `xctrace` leaves a kernel trace of 1-5 GB per recording in the system temporary directory and ignores `TMPDIR`; delete `$TMPDIR/instruments*.ktrace` after tracing.

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
