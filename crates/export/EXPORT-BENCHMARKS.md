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

### Benchmark Run: 2026-02-16 11:02:26 UTC

*Local time: 2026-02-16 11:02:26*

**Overall Result:** ALL PASS (9/9)

**Test Video:** 72s at 1920x1080 30fps

**Notes:** Final calibration: encoder_efficiency=0.5 applied, FPS tapering, real-world data

**Command:** `cargo run -p cap-export --example export-benchmark-runner -- mp4-only --duration 72 --recording-path /Users/richie/Library/Application Support/so.cap.desktop.dev/recordings/Odyssey G93SC (Display) 2026-02-16 10.06 AM.cap --benchmark-output`

<details>
<summary>System Information</summary>

- **OS:** macos
- **Arch:** aarch64

</details>

#### Export Results

| Preset | Time(s) | FPS | Size(MB) | Estimated(MB) | Size Err(%) | Time Est(s) | Time Err(%) | Status |
|--------|---------|-----|----------|---------------|-------------|-------------|-------------|--------|
| MP4 720p/30fps/Maximum | 7.58 | 283.4 | 35.79 | 36.22 | +1.2 | 7.41 | -2.3 | PASS |
| MP4 720p/30fps/Social | 7.78 | 276.2 | 18.93 | 18.52 | -2.2 | 7.41 | -4.8 | PASS |
| MP4 720p/30fps/Web | 7.03 | 305.6 | 12.13 | 10.26 | -15.4 | 7.41 | +5.4 | PASS |
| MP4 1080p/30fps/Maximum | 7.66 | 280.3 | 80.27 | 80.46 | +0.2 | 7.41 | -3.4 | PASS |
| MP4 1080p/30fps/Social | 8.62 | 249.2 | 41.19 | 40.64 | -1.3 | 7.41 | -14.1 | PASS |
| MP4 1080p/30fps/Web | 7.50 | 286.3 | 23.37 | 22.06 | -5.6 | 7.41 | -1.3 | PASS |
| MP4 1080p/60fps/Maximum | 15.15 | 283.5 | 127.65 | 128.25 | +0.5 | 14.81 | -2.2 | PASS |
| MP4 4K/30fps/Maximum | 20.22 | 106.3 | 319.82 | 319.39 | -0.1 | 12.27 | -39.3 | PASS |
| MP4 4K/30fps/Social | 12.26 | 175.2 | 161.26 | 160.11 | -0.7 | 12.27 | +0.1 | PASS |

#### Estimation Accuracy

- **MP4 Size**: avg error -2.6%, avg |error| 3.0%
- **MP4 Time**: avg error -6.9%, avg |error| 8.1%

#### Calibration Data

Use these actual-vs-estimated ratios to tune the estimation algorithm:

| Preset | Actual(MB) | Estimated(MB) | Ratio (actual/est) | Suggested BPP Multiplier |
|--------|------------|---------------|--------------------|--------------------------|
| MP4 720p/30fps/Maximum | 35.79 | 36.22 | 0.9882 | 0.2965 (current: 0.30) |
| MP4 720p/30fps/Social | 18.93 | 18.52 | 1.0224 | 0.1534 (current: 0.15) |
| MP4 720p/30fps/Web | 12.13 | 10.26 | 1.1827 | 0.0946 (current: 0.08) |
| MP4 1080p/30fps/Maximum | 80.27 | 80.46 | 0.9976 | 0.2993 (current: 0.30) |
| MP4 1080p/30fps/Social | 41.19 | 40.64 | 1.0134 | 0.1520 (current: 0.15) |
| MP4 1080p/30fps/Web | 23.37 | 22.06 | 1.0593 | 0.0847 (current: 0.08) |
| MP4 1080p/60fps/Maximum | 127.65 | 128.25 | 0.9953 | 0.2986 (current: 0.30) |
| MP4 4K/30fps/Maximum | 319.82 | 319.39 | 1.0013 | 0.3004 (current: 0.30) |
| MP4 4K/30fps/Social | 161.26 | 160.11 | 1.0072 | 0.1511 (current: 0.15) |

---

<!-- EXPORT_BENCHMARK_RESULTS_END -->

---

## Notes

- Test videos are generated synthetically using FFmpeg `testsrc` for deterministic results
- Source video is 1920x1080 at 30fps; exports at different resolutions test upscaling/downscaling
- Size estimation uses the same algorithm as `apps/desktop/src-tauri/src/export.rs`
- Calibration data in each run shows actual-vs-estimated ratios for tuning the estimation algorithm
