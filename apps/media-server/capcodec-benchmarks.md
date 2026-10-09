# capcodec vs x264 veryfast

Measurements from the capcodec bench harness for the binary `CAP_MEDIA_VIDEO_ENCODER=capcodec` runs. This repository's CI does not regenerate them. A speed ratio above 1 means capcodec is faster. A BD-rate below 0 means capcodec uses fewer bits at the same quality.

The 12-clip speed table is main `00fecf7` (read-ahead, CABAC, intra minIndex), retimed with other processes stopped. The 4-thread column ran capcodec with `--threads 4` and x264 with `-threads 0` (automatic). The 1-thread column set both to 1 thread. `--bframes 0` matches that encoder. Concurrent B-frames are the default after that measurement. Screen clips stay almost entirely P frames, so those speed rows still describe the default. full_motion was retimed with concurrent B-frames: 4-thread wall is 1.35-1.40x medium and 1.44-1.50x live (the same sessions measured the previous encoder at 1.09-1.10x and 1.19-1.21x). The other 11 clips were not retimed. full_motion quality below is the pre-concurrent-B bitstream.

`rd-next` (`d0cce5e`) and SSIM round 3 (`b72e995`) are not in the binary this flag runs. The media server's `ultrafast` preset maps to capcodec `fast`. Job CRF and preset apply unless `CAPCODEC_CRF` or `CAPCODEC_PRESET` is set.

| Metric | Result |
|---|---|
| Keyframe-only CPU | 1.06-1.76x at 1 and 4 threads; busy_ui uses 12% more bits in all-intra |
| Peak RSS, 4 threads | 34-308 MiB vs 141-1304 MiB on the speed rerun |
| Output delay | live 2 frames (5 with B-frames), medium 10 (steady 13), zerolatency 0; x264 17-19 frames at 4 threads |
| Startup | 0.9-1.2 ms vs 1.3-1.5 ms on a 64x64 frame |
| Decode CPU of the output | 0.58-1.54 s vs 1.59-2.40 s on the measured clips |
| Binary | 561,312 bytes at `00fecf7`; 609,152 bytes with concurrent B-frames. Minimal x264 build is 1.29 MB |
| Build CPU | about 12 s vs 36 s (minimal x264) |
| Bitrate error at Cap targets | two-pass 4.9% vs 5.5%; one-pass 7.7% vs 5.5% (one-pass rate control is not in this binary) |

Quality measured 2026-10-09 on main `fff504d`. Speed remeasured the same day on main `00fecf7` (read-ahead, pin7 intra minIndex, CABAC table). Those commits match the `fff504d` bitstreams, so the quality tables still describe this encoder. Pending quality branch `rd-next` `d0cce5e`. All 12 corpus clips.

How to reproduce (from the `capcodec/` directory in this repository):

- Quality: `CAPCODEC_BIN_UNCHECKED=<binary> python3 bench/bench.py standard --quality-only --encoders capcodec-medium,capcodec-live,capcodec-live-zerolatency,x264-veryfast,x264-veryfast-zerolatency --out <dir>` (1080p, 10 s per clip; code_4k is scaled to 1080p here). capcodec's CRF ladder runs 20-44 so its VMAF range covers x264's CRF 18-33; the overlap column shows how much of the two curves BD-rate compares (it was 15-24% on screen clips with the old 20-36 ladder).
- Speed: `bench/lane.sh start`, then `bench/lane.sh run "python3 bench/speedcmp.py --binary <binary> --clips all --modes medium,live,zerolatency --retime bench/out/speedcmp-fff504d-v2 --out <dir>"`. The rerun reuses the CRF that matched x264 CRF 23 (bitstreams are unchanged, so the match stands). 5 shuffled, interleaved rounds at 1 and 4 threads; every other process is stopped for each timed run (about 690 processes stopped, frozen median). code_4k runs at native 4K for 5 s. Output: `bench/out/speedcmp-00fecf7`.
- Tables: `python3 bench/scoreboard.py --quality LABEL=<dir> --speed LABEL=<dir> --out SCOREBOARD.md`.

### main fff504d: capcodec-medium vs x264-veryfast (BD-rate, negative = capcodec needs fewer bits)

| clip | VMAF | PSNR-YUV | SSIM | VMAF range overlap |
|---|---|---|---|---|
| busy_ui | +5.4% lose | +5.1% lose | +14.8% lose | 52% |
| busy_ui_60fps | +2.6% lose | +2.0% lose | +16.8% lose | 74% |
| code_4k | -3.3% win | +1.0% lose | +9.2% lose | 72% |
| code_editor | -0.5% win | +4.9% lose | +7.3% lose | 76% |
| dark_mode | -17.2% win | -16.9% win | -11.9% win | 75% |
| dashboard | +7.9% lose | +12.3% lose | +25.9% lose | 59% |
| full_motion | -12.2% win | -10.0% win | +4.8% lose | 44% |
| idle | -8.8% win | -6.3% win | -3.4% win | 73% |
| slides | -18.0% win | +0.5% lose | -3.6% win | 66% |
| slow_typing | -0.8% win | +4.5% lose | +8.6% lose | 80% |
| text_scroll | -15.5% win | -14.8% win | -14.9% win | 88% |
| webcam_overlay | -20.0% win | -4.3% win | -4.0% win | 69% |

19 wins, 17 losses across 12 clips x 3 metrics.

### main fff504d: capcodec-live vs x264-veryfast (BD-rate, negative = capcodec needs fewer bits)

| clip | VMAF | PSNR-YUV | SSIM | VMAF range overlap |
|---|---|---|---|---|
| busy_ui | +5.7% lose | +5.7% lose | +15.6% lose | 51% |
| busy_ui_60fps | +3.5% lose | +2.9% lose | +18.1% lose | 73% |
| code_4k | +0.2% lose | +5.3% lose | +13.4% lose | 72% |
| code_editor | +2.8% lose | +8.6% lose | +11.2% lose | 76% |
| dark_mode | -16.6% win | -16.2% win | -10.9% win | 75% |
| dashboard | +10.8% lose | +15.7% lose | +29.3% lose | 61% |
| full_motion | -7.8% win | -1.9% win | +12.0% lose | 43% |
| idle | -8.4% win | -6.2% win | -3.0% win | 72% |
| slides | -20.0% win | -1.5% win | -6.4% win | 65% |
| slow_typing | +1.1% lose | +4.8% lose | +9.1% lose | 78% |
| text_scroll | -15.1% win | -14.7% win | -14.8% win | 88% |
| webcam_overlay | -18.7% win | -3.8% win | -1.7% win | 67% |

17 wins, 19 losses across 12 clips x 3 metrics.

### main fff504d: capcodec-live-zerolatency vs x264-veryfast-zerolatency (BD-rate, negative = capcodec needs fewer bits)

| clip | VMAF | PSNR-YUV | SSIM | VMAF range overlap |
|---|---|---|---|---|
| busy_ui | +1.6% lose | +2.3% lose | +6.7% lose | 23% |
| busy_ui_60fps | +2.0% lose | +1.9% lose | +9.2% lose | 30% |
| code_4k | -1.2% win | +2.4% lose | +7.9% lose | 36% |
| code_editor | -0.5% win | +8.0% lose | +5.8% lose | 36% |
| dark_mode | -22.3% win | -21.6% win | -21.3% win | 35% |
| dashboard | +0.2% lose | +2.3% lose | +7.4% lose | 27% |
| full_motion | -3.1% win | -1.0% win | +15.1% lose | 98% |
| idle | -17.2% win | -17.8% win | -15.6% win | 28% |
| slides | -30.8% win | -22.7% win | -20.8% win | 40% |
| slow_typing | -0.8% win | +3.8% lose | +4.8% lose | 37% |
| text_scroll | -16.3% win | -17.6% win | -20.7% win | 33% |
| webcam_overlay | -74.8% win | -64.5% win | -54.8% win | 42% |

20 wins, 16 losses across 12 clips x 3 metrics.

### rd-next d0cce5e: capcodec-medium vs x264-veryfast (BD-rate, negative = capcodec needs fewer bits)

| clip | VMAF | PSNR-YUV | SSIM | VMAF range overlap |
|---|---|---|---|---|
| busy_ui | -17.0% win | -2.4% win | +6.5% lose | 65% |
| busy_ui_60fps | -18.8% win | -3.8% win | +6.4% lose | 42% |
| code_4k | -23.0% win | -1.4% win | +5.0% lose | 57% |
| code_editor | -22.7% win | -3.7% win | +2.5% lose | 57% |
| dark_mode | -35.0% win | -19.9% win | -13.5% win | 58% |
| dashboard | -12.3% win | +3.2% lose | +12.8% lose | 77% |
| full_motion | -21.6% win | -8.9% win | +1.5% lose | 52% |
| idle | -24.0% win | -11.8% win | -2.9% win | 66% |
| slides | -33.6% win | -13.3% win | -10.2% win | 81% |
| slow_typing | -22.4% win | -4.1% win | +2.2% lose | 43% |
| text_scroll | -31.1% win | -19.6% win | -14.3% win | 54% |
| webcam_overlay | -34.1% win | -14.0% win | +3.4% lose | 87% |

27 wins, 9 losses across 12 clips x 3 metrics.

### rd-next d0cce5e: capcodec-live vs x264-veryfast (BD-rate, negative = capcodec needs fewer bits)

| clip | VMAF | PSNR-YUV | SSIM | VMAF range overlap |
|---|---|---|---|---|
| busy_ui | -17.3% win | -2.3% win | +6.5% lose | 64% |
| busy_ui_60fps | -18.9% win | -3.7% win | +6.5% lose | 42% |
| code_4k | -22.7% win | -1.3% win | +5.2% lose | 58% |
| code_editor | -22.1% win | -3.7% win | +2.7% lose | 57% |
| dark_mode | -34.4% win | -19.6% win | -13.0% win | 59% |
| dashboard | -12.4% win | +3.8% lose | +14.0% lose | 73% |
| full_motion | -18.0% win | -2.6% win | +6.8% lose | 51% |
| idle | -23.8% win | -11.7% win | -2.7% win | 67% |
| slides | -35.3% win | -15.6% win | -12.6% win | 83% |
| slow_typing | -21.3% win | -4.1% win | +2.2% lose | 43% |
| text_scroll | -31.0% win | -19.6% win | -14.3% win | 54% |
| webcam_overlay | -34.1% win | -14.9% win | +1.2% lose | 88% |

27 wins, 9 losses across 12 clips x 3 metrics.

### rd-next d0cce5e: capcodec-live-zerolatency vs x264-veryfast-zerolatency (BD-rate, negative = capcodec needs fewer bits)

| clip | VMAF | PSNR-YUV | SSIM | VMAF range overlap |
|---|---|---|---|---|
| busy_ui | -21.3% win | -6.6% win | +1.0% lose | 48% |
| busy_ui_60fps | -18.9% win | -6.2% win | +3.0% lose | 64% |
| code_4k | -20.7% win | -0.8% win | +5.4% lose | 62% |
| code_editor | -22.6% win | -3.7% win | +2.8% lose | 62% |
| dark_mode | -37.4% win | -26.1% win | -22.1% win | 58% |
| dashboard | -21.6% win | -7.8% win | -0.1% win | 45% |
| full_motion | -15.6% win | -0.3% win | +7.4% lose | 62% |
| idle | -33.5% win | -25.2% win | -13.5% win | 46% |
| slides | -46.6% win | -35.0% win | -23.4% win | 58% |
| slow_typing | -21.3% win | -6.2% win | +0.5% lose | 70% |
| text_scroll | -32.6% win | -24.5% win | -20.8% win | 53% |
| webcam_overlay | -80.6% win | -64.2% win | -43.9% win | 58% |

30 wins, 6 losses across 12 clips x 3 metrics.

### main 00fecf7: speed at matched VMAF (x264 / capcodec, interleaved medians, other work paused)

| clip | mode | VMAF | CPU 1t | wall 1t | CPU 4t | wall 4t | peak RSS 4t capcodec / x264 MiB |
|---|---|---|---|---|---|---|---|
| busy_ui | live | 94.5 | 7.42x win | 6.55x win | 8.25x win | 4.40x win | 46 / 377 |
| busy_ui_60fps | live | 93.2 | 8.20x win | 7.23x win | 9.21x win | 4.17x win | 46 / 374 |
| code_4k | live | 95.2 | 8.92x win | 7.96x win | 9.73x win | 4.58x win | 176 / 1304 |
| code_editor | live | 94.4 | 7.36x win | 6.52x win | 7.97x win | 4.49x win | 49 / 382 |
| dark_mode | live | 93.4 | 7.33x win | 6.54x win | 6.80x win | 4.59x win | 48 / 393 |
| dashboard | live | 94.4 | 3.86x win | 3.51x win | 4.25x win | 2.10x win | 51 / 384 |
| full_motion | live | 88.2 | 1.61x win | 1.54x win | 1.37x win | 1.21x win | 80 / 379 |
| idle | live | 95.3 | 9.18x win | 8.11x win | 10.19x win | 4.55x win | 44 / 379 |
| slides | live | 95.0 | 5.15x win | 4.64x win | 4.61x win | 3.24x win | 74 / 391 |
| slow_typing | live | 95.2 | 7.87x win | 6.88x win | 8.82x win | 4.15x win | 45 / 387 |
| text_scroll | live | 95.0 | 4.88x win | 4.40x win | 3.84x win | 3.10x win | 53 / 384 |
| webcam_overlay | live | 95.4 | 4.64x win | 4.21x win | 4.55x win | 3.46x win | 74 / 391 |
| busy_ui | medium | 94.5 | 7.30x win | 6.31x win | 7.77x win | 4.11x win | 77 / 371 |
| busy_ui_60fps | medium | 93.2 | 8.08x win | 7.13x win | 8.77x win | 4.09x win | 77 / 372 |
| code_4k | medium | 95.2 | 7.96x win | 7.13x win | 8.78x win | 3.89x win | 308 / 1279 |
| code_editor | medium | 94.4 | 7.01x win | 6.17x win | 7.88x win | 4.13x win | 83 / 379 |
| dark_mode | medium | 93.4 | 7.25x win | 6.48x win | 6.37x win | 4.24x win | 79 / 386 |
| dashboard | medium | 94.4 | 3.59x win | 3.21x win | 3.82x win | 1.75x win | 85 / 382 |
| full_motion | medium | 88.2 | 1.39x win | 1.33x win | 1.22x win | 1.06x win | 103 / 375 |
| idle | medium | 95.3 | 9.37x win | 8.30x win | 10.28x win | 4.54x win | 73 / 385 |
| slides | medium | 95.0 | 4.86x win | 4.40x win | 4.34x win | 2.90x win | 98 / 384 |
| slow_typing | medium | 95.2 | 7.94x win | 6.94x win | 8.26x win | 3.97x win | 76 / 384 |
| text_scroll | medium | 95.0 | 4.39x win | 3.88x win | 3.64x win | 2.89x win | 88 / 385 |
| webcam_overlay | medium | 95.4 | 4.32x win | 3.92x win | 4.20x win | 3.01x win | 99 / 386 |
| busy_ui | zerolatency | 96.0 | 6.79x win | 5.96x win | 6.92x win | 3.85x win | 34 / 144 |
| busy_ui_60fps | zerolatency | 95.5 | 7.75x win | 6.82x win | 7.96x win | 3.95x win | 34 / 150 |
| code_4k | zerolatency | 96.0 | 7.51x win | 6.58x win | 7.06x win | 3.92x win | 113 / 458 |
| code_editor | zerolatency | 95.8 | 6.32x win | 5.51x win | 6.38x win | 3.61x win | 34 / 146 |
| dark_mode | zerolatency | 95.5 | 6.51x win | 5.67x win | 5.00x win | 3.76x win | 34 / 151 |
| dashboard | zerolatency | 96.1 | 3.44x win | 3.08x win | 3.64x win | 2.17x win | 37 / 150 |
| full_motion | zerolatency | 88.1 | 1.65x win | 1.58x win | 1.21x win | 1.49x win | 46 / 142 |
| idle | zerolatency | 96.4 | 9.40x win | 8.32x win | 8.89x win | 4.40x win | 34 / 141 |
| slides | zerolatency | 96.2 | 4.84x win | 4.34x win | 3.86x win | 2.95x win | 39 / 149 |
| slow_typing | zerolatency | 96.4 | 7.15x win | 6.15x win | 7.16x win | 3.53x win | 34 / 148 |
| text_scroll | zerolatency | 96.3 | 3.90x win | 3.45x win | 3.12x win | 2.78x win | 38 / 149 |
| webcam_overlay | zerolatency | 96.2 | 5.17x win | 4.73x win | 4.60x win | 4.27x win | 39 / 142 |
- live 1 thread cpu: geometric mean 5.83x, min 1.61x (12/12 clips faster)
- live 1 thread wall: geometric mean 5.23x, min 1.54x (12/12 clips faster)
- live 4 threads cpu: geometric mean 5.87x, min 1.37x (12/12 clips faster)
- live 4 threads wall: geometric mean 3.46x, min 1.21x (12/12 clips faster)
- medium 1 thread cpu: geometric mean 5.53x, min 1.39x (12/12 clips faster)
- medium 1 thread wall: geometric mean 4.94x, min 1.33x (12/12 clips faster)
- medium 4 threads cpu: geometric mean 5.51x, min 1.22x (12/12 clips faster)
- medium 4 threads wall: geometric mean 3.15x, min 1.06x (12/12 clips faster)
- zerolatency 1 thread cpu: geometric mean 5.39x, min 1.65x (12/12 clips faster)
- zerolatency 1 thread wall: geometric mean 4.80x, min 1.58x (12/12 clips faster)
- zerolatency 4 threads cpu: geometric mean 4.90x, min 1.21x (12/12 clips faster)
- zerolatency 4 threads wall: geometric mean 3.26x, min 1.49x (12/12 clips faster)

