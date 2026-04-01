# Cap Export Benchmark Results

This document tracks performance benchmarks for Cap's export system over time. Each benchmark run is timestamped, enabling comparison across different versions, configurations, and hardware.

## Quick Reference

### Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Export Render FPS (1080p) | >= 30 fps | For 1080p and below |
| Export Render FPS (4K) | >= 15 fps | For 4K resolution |
| Export Completion | No errors | All presets must complete |
| Size Estimation Accuracy | < 50% error | Initial target, tighten with data |

### Export Presets Tested

**MP4:**
- 720p / 30fps / Maximum, Social, Web
- 1080p / 30fps / Maximum, Social, Web
- 1080p / 60fps / Maximum
- 4K / 30fps / Maximum, Social

**GIF:**
- 720p / 15fps
- 720p / 30fps

### Running Benchmarks

```bash
# Quick benchmark (3 core presets)
cargo run -p cap-export --example export-benchmark-runner -- quick

# Full benchmark (all presets, writes to this file)
cargo run -p cap-export --example export-benchmark-runner -- full --benchmark-output

# MP4 only
cargo run -p cap-export --example export-benchmark-runner -- mp4-only --benchmark-output

# GIF only
cargo run -p cap-export --example export-benchmark-runner -- gif-only --benchmark-output

# Custom duration (default: 30s)
cargo run -p cap-export --example export-benchmark-runner -- full --duration 60 --benchmark-output
```

---

## Benchmark History

<!-- EXPORT_BENCHMARK_RESULTS_START -->

### Benchmark Run: 2026-03-25 13:12:31 UTC

*Local time: 2026-03-25 13:12:31*

**Overall Result:** ALL PASS (9/9)

**Test Video:** 30s at 1920x1080 30fps

**Notes:** Post-optimization: trimmed macOS encoder priority, increased NV12 render channel 2->8, optimized GIF add_frame

**Command:** `cargo run -p cap-export --example export-benchmark-runner -- mp4-only --duration 30 --benchmark-output`

<details>
<summary>System Information</summary>

- **OS:** macos
- **Arch:** aarch64

</details>

#### Export Results

| Preset | Time(s) | FPS | Size(MB) | Estimated(MB) | Size Err(%) | Time Est(s) | Time Err(%) | Status |
|--------|---------|-----|----------|---------------|-------------|-------------|-------------|--------|
| MP4 720p/30fps/Maximum | 2.48 | 362.3 | 6.01 | 15.17 | +152.6 | 3.10 | +24.9 | PASS |
| MP4 720p/30fps/Social | 2.59 | 347.2 | 5.98 | 7.76 | +29.7 | 3.10 | +19.7 | PASS |
| MP4 720p/30fps/Web | 2.57 | 350.3 | 5.71 | 4.30 | -24.7 | 3.10 | +20.8 | PASS |
| MP4 1080p/30fps/Maximum | 3.12 | 288.8 | 3.99 | 33.71 | +745.9 | 3.10 | -0.4 | PASS |
| MP4 1080p/30fps/Social | 3.31 | 272.3 | 3.95 | 17.03 | +330.8 | 3.10 | -6.1 | PASS |
| MP4 1080p/30fps/Web | 3.31 | 271.9 | 3.93 | 9.24 | +135.0 | 3.10 | -6.3 | PASS |
| MP4 1080p/60fps/Maximum | 5.93 | 303.8 | 5.50 | 53.74 | +876.3 | 6.21 | +4.8 | PASS |
| MP4 4K/30fps/Maximum | 8.28 | 108.7 | 6.63 | 133.83 | +1920.0 | 5.14 | -37.9 | PASS |
| MP4 4K/30fps/Social | 8.27 | 108.8 | 6.54 | 67.09 | +926.1 | 5.14 | -37.8 | PASS |

#### Estimation Accuracy

- **MP4 Size**: avg error +565.7%, avg |error| 571.2%
- **MP4 Time**: avg error -2.0%, avg |error| 17.6%

#### Calibration Data

Use these actual-vs-estimated ratios to tune the estimation algorithm:

| Preset | Actual(MB) | Estimated(MB) | Ratio (actual/est) | Suggested BPP Multiplier |
|--------|------------|---------------|--------------------|--------------------------|
| MP4 720p/30fps/Maximum | 6.01 | 15.17 | 0.3958 | 0.1187 (current: 0.30) |
| MP4 720p/30fps/Social | 5.98 | 7.76 | 0.7709 | 0.1156 (current: 0.15) |
| MP4 720p/30fps/Web | 5.71 | 4.30 | 1.3286 | 0.1063 (current: 0.08) |
| MP4 1080p/30fps/Maximum | 3.99 | 33.71 | 0.1182 | 0.0355 (current: 0.30) |
| MP4 1080p/30fps/Social | 3.95 | 17.03 | 0.2321 | 0.0348 (current: 0.15) |
| MP4 1080p/30fps/Web | 3.93 | 9.24 | 0.4255 | 0.0340 (current: 0.08) |
| MP4 1080p/60fps/Maximum | 5.50 | 53.74 | 0.1024 | 0.0307 (current: 0.30) |
| MP4 4K/30fps/Maximum | 6.63 | 133.83 | 0.0495 | 0.0149 (current: 0.30) |
| MP4 4K/30fps/Social | 6.54 | 67.09 | 0.0975 | 0.0146 (current: 0.15) |

---

<!-- EXPORT_BENCHMARK_RESULTS_END -->

---

## Notes

- Test videos are generated synthetically using FFmpeg `testsrc` for deterministic results
- Source video is 1920x1080 at 30fps; exports at different resolutions test upscaling/downscaling
- Size estimation uses the same algorithm as `apps/desktop/src-tauri/src/export.rs`
- Calibration data in each run shows actual-vs-estimated ratios for tuning the estimation algorithm
