# Progress

**Headline (main `1a1794a`; the 12-clip speed table in `SCOREBOARD.md` is still `00fecf7`, before concurrent B-frames, and `--bframes 0` matches that encoder): at matched VMAF that table is faster than x264 veryfast on every clip in every mode, on CPU and on wall clock, at 1 and at 4 threads (36/36). Geometric mean CPU 4.9-5.9x, wall 3.2-5.2x. Concurrent B-frames are now the default. On full_motion in the benchmark lane, 4-thread wall is 1.35-1.40x medium and 1.44-1.50x live (the same sessions measured the previous main at 1.09-1.10x and 1.19-1.21x). The other 11 clips were not retimed. Peak memory on the 12-clip run is 3-8x under x264. Quality on this encoder is the `fff504d` result (bitstreams match): level, 17-20 wins of 36 clip-metrics per mode. The pending quality branch `rd-next` wins VMAF on 12/12 clips and PSNR on 11/12, and still loses SSIM on 6-8 clips. SSIM round 3 (`ssim` `b72e995`, not on main; base is `rd-next` plus main `08b3b02`, 84 commits behind) lowers light flat and smooth IDR macroblocks above QP 34 and moves the 12-clip SSIM mean from about 0 to −1.4% on medium and live. It still loses SSIM on dashboard (+10.0% medium), busy UI, code, webcam, and full motion. Intra rounding and IDR rate-distortion (`intra-rd` `99822eb`, not on main) pass the 0.5% gate against main on all 12 clips in medium, live, and zerolatency. All-intra wins against x264 veryfast keyint 1 go from 7 to 12 of 36. The screen-clip SSIM and PSNR losses shrink and do not flip. All-intra CPU stays ahead of x264; full_motion is 1.01× and a round reaches 1.00×. Line and edge AQ (`dashboard` `4ca9f20`, on `rd-next`, not on main) cuts dashboard's loss to x264 veryfast from SSIM +12.8% to +6.2% and PSNR-YUV +3.2% to +1.7% in medium, and from +14.0% to +7.3% and +3.8% to +2.4% in live. Zerolatency dashboard wins all three metrics. No other clip gets worse by more than 0.5 against x264.**

Threads: deterministic wavefront (rows claimed in order, each macroblock waits for the row above to pass its top-right neighbour), output byte-identical for any thread count.

## Intra RD (not on main)

`intra-rd` `99822eb` (rounding `719dab7` plus CABAC SSD choice among close I4/I8/I16 SATD candidates; `--no-intra-rd` matches the rounding commit). All-intra uses round-to-nearest above the first luma level, and textured or natural macroblocks use a 0.4 offset (chroma 0.36). In a normal GOP, IDRs keep main's rounding except lasting textured or natural macroblocks, which take the 0.4 offset. Against main, every clip in medium, live, and zerolatency is inside the 0.5% gate; the worst cells are live slides VMAF +0.28% and zerolatency webcam_overlay PSNR-Y +0.27%. Against x264, wins go from 19 to 20 (medium), 17 to 20 (live), and 19 to 22 (zerolatency). All-intra mean versus main is VMAF −13.2%, PSNR-YUV −1.0%, SSIM −1.7%. `tov test` 85/85, thread identity, TSan 0, `verify.py` 23/23. Not merged: it changes bitstreams, and full_motion all-intra speed is only 1.01× x264.

## Dashboard lines (not on main)

`dashboard` `4ca9f20` (docs `b74f140`) sits on `rd-next` `d0cce5e`. Macroblocks whose 16 rows or 16 columns are constant split into lines and edges. Edges take −4 QP in every frame. Lines on IDRs take −8, or −12 when the range is under 16; lines in P and B frames take −4. Flags: `--aq-stroke`, `--aq-line`, `--aq-faint-line`. full_motion stays byte-identical. The worst change outside dashboard against x264 is slow_typing medium VMAF +0.38. `tov test` 65/65, `verify.py` bit-exact on busy_ui and full_motion, 1 and 4 threads identical in 18 configurations. Instructions rise at most 0.38%. Not merged: medium and live dashboard still lose SSIM (+6.2%, +7.3%) and PSNR-YUV (+1.7%, +2.4%) to x264, and the base is `rd-next`.

## Scoreboard vs x264 veryfast (goal: win every row)

Quality: harness standard tier on 12 clips (1080p, 10 s) with capcodec's CRF ladder reaching 44 so both curves overlap (42-88%; the old ladder compared only 15-24% of screen-clip curves and flattered capcodec). Speed: `bench/speedcmp.py` in the benchmark lane (CRF matched to x264 CRF 23's VMAF, interleaved rounds, rest of the machine paused). Clip counts are wins out of 12.

| Metric | main `fff504d` | quality branch `rd-next` | status |
|---|---|---|---|
| VMAF BD, medium / live / zerolatency | 8 / 6 / 7 | 12 / 12 / 12 (-12% to -81%) | win after rd-next |
| PSNR BD, medium / live / zerolatency | 5 / 6 / 6 | 11 / 11 / 12 | lose dashboard (+3.2% / +3.8%) |
| SSIM BD, medium / live / zerolatency | 5 / 5 / 6 | 4 / 4 / 6 | lose on rd-next: dashboard +12.8%, busy_ui +6.5%, busy_ui_60fps +6.4%, code_4k +5.0%, webcam_overlay +3.4%, code_editor +2.5%, slow_typing +2.2%, full_motion +1.5% (live +6.8%). `ssim` `9b329be` (not merged): medium 27/36 wins, SSIM mean −1.36% (dashboard +10.0, busy_ui +3.5, busy_ui_60fps +0.9, code_4k +3.8, code_editor +1.7, webcam +3.4, full_motion +1.5); zerolatency 31/36, slow_typing SSIM becomes a win |
| CPU at matched VMAF, 1 thread | 36/36 faster; geomean medium 5.53x, live 5.83x, zerolatency 5.39x; min 1.39x (full_motion medium) | | win |
| CPU at matched VMAF, 4 threads | 36/36; geomean 5.51x / 5.87x / 4.90x; min 1.21x (full_motion zerolatency) | | win |
| Wall at matched VMAF, 1 thread | 36/36; geomean 4.94x / 5.23x / 4.80x | | win |
| Wall at matched VMAF, 4 threads | 36/36; geomean 3.15x / 3.46x / 3.26x; min 1.06x (full_motion medium), live 1.21x, zerolatency 1.49x | | win (`bench/out/speedcmp-00fecf7`; other processes stopped, frozen median about 690); with the concurrent B-frames after merging `e20b7fe`, full_motion medium 1.35-1.40x and live 1.44-1.50x in the benchmark lane (main 1.09-1.10x and 1.19-1.21x in the same sessions) |
| Keyframe-only CPU at matched VMAF (`speedcmp.py --keyint1`, main `558481e`) | 1.07-1.75x at 1 thread, 1.06-1.76x at 4 (full_motion 1.07x / 1.06x, busy_ui 1.21x / 1.28x); 4-thread wall fps full_motion 149 vs 136 | | win on every clip; busy_ui needs 12% more bits than x264 at matched VMAF in all-intra |
| Peak memory, 4 threads | 34-308 MiB vs 141-1304 MiB on the `00fecf7` rerun | | win |
| Delay before output | live 2 frames (5 with B-frames), medium 10 (steady 13), zerolatency 0 | | win vs x264 at 4 threads (17) and auto (19); medium steady lag 13 vs 10 at 1 thread |
| Startup | 0.9-1.2 ms vs 1.3-1.5 ms (64x64 frame); first 1080p frame 30.5 vs 54.9 ms at default threads | | win; 1-thread medium first 1080p frame 48.9 vs 40.3 ms (keyframe speed) |
| Decode CPU of the output at matched VMAF | 0.58-1.54 s vs 1.59-2.40 s (dashboard, dark_mode, webcam_overlay, slow_typing, idle) | | win |
| Binary | 550 KB vs 1.29 MB (minimal x264 build) / 2.5 MB (CLI) | | win |
| Build CPU time | about 12 s vs 36.5 s (minimal x264) / 71 s (full) | | win |
| Bitrate accuracy at Cap targets (10 s, reachable) | two-pass 4.9% vs 5.5%; one-pass 7.7% vs 5.5% | | two-pass win, one-pass lose (rate-control round in progress) |

## State

| Milestone | State |
|---|---|
| 0 Benchmark harness | Done. Corpus: 12 clips including full-motion video (Big Buck Bunny, CC BY 3.0) and 4K; scripts and manifest in `bench/corpus/`, sources outside git. |
| 1 Minimal stream | Done |
| 2 Full intra | Done |
| 3 CABAC | Done; byte-oriented arithmetic coder, bit-exact with the spec engine (`src/cabac_ref.tov`, randomised equivalence tests) |
| 4 P frames | Done; global shift candidates (column/row profile matching) find slide push/cover transitions |
| 5 Screen-aware side info | Done; IDR frames reuse unchanged macroblocks of the previous IDR (decisions, coefficients and reconstruction) |
| 6 Text-aware AQ | Done (defaults under review) |
| 7 Rate control | Done; weighted prediction for fades added; lookahead QP from macroblock lifetime (`--lookahead`, 10 frames on fast/medium/slow) |
| 8 Speed | SIMD kernels (SAD, SATD, SA8D, half-pel, transforms, quantisation, deblocking, classification, hashing, chroma MC) and wavefront threads; IDR entropy and deblocking still serial |
| 9 Integration | Media server prototype on Cap branch `cursor/capcodec-integration-aa45` (draft PR #2429); C ABI and WASM wait on Tov |
| Muxers | Done: MP4 faststart, fragmented MP4, HLS |
| B-frames | Done: `--bframes 0-3` (default 3, 0 with `--zerolatency`), adaptive by default (`--no-b-adapt`), B-pyramid (default with the B-frames except on live, `--no-b-pyramid`; the middle B-frame of a run is a reference at the anchor's QP + 5), `--b-qp-offset` (6); one reference per list, B_Skip / B_Direct_16x16 / 16x16 L0, L1, Bi; the B-frames of a run are coded concurrently and alongside the next anchor; MP4, fMP4 and HLS (edit lists remove the reorder delay) |
| Read-ahead | On main. More than one thread already overlapped the next frame's read and lookahead (one extra ring slot) at `fff504d`. `f4781c5` (`cli/main.tov` only) reads further frames while a B run is coded (`--read-ahead`, default 3; off when B-frames are off). `a9b86d5` matched `/tmp/capcodec-main-latest18` in 459/459 configurations (verify.py 10/10, tov test 81/81, TSan 0 reports). A pin7 rebuild of `f4781c5` matched that baseline on busy_ui and full_motion for default, live, zerolatency, fast, `--bframes 0`, `--lookahead 0`, bitrate and `--keyint 1` at 1 and 4 threads (32/32; full_motion default and live also matched at 90 frames). `--read-ahead 0` and `5` are new flags; on these clips they hash the same as the default encode. Retimed on `00fecf7` with other processes stopped: full_motion 4-thread wall is 1.06x medium and 1.21x live (was 0.89x and 0.97x) |

Every capcodec bitstream decodes without errors in JM 19 and ffmpeg and is bit-exact with the encoder's reconstruction (every harness tier, and `tools/verify.py` after each change). B-frames, after merging intra-speed and me-speed: 51 verify cases (bframes 1-3 x live/medium/slow x CABAC/CAVLC, keyint 7, stream ends 1-15 frames, ABR, constant QP, fixed pattern, no side info, adaptive runs on five screen clips, 300-frame encodes of four clips) are JM and ffmpeg bit-exact and identical for 1 and 4 threads; `--bframes 0` is byte-identical to main `dc8d9fb` (full_motion, busy_ui, slides x live/medium x 1/4 threads x CABAC/CAVLC, and MP4/fMP4/HLS); ffmpeg presentation and decode checks pass in all three containers (bframes 1-3, VFR drops), and Chrome 148 plays MP4, fMP4 and HLS (MSE) with B-frames in order. B-frames round 2 (speed, concurrent runs, pyramid; `6765509`): the 53-case verify matrix (the same kinds of cases as above, now 53) is JM and ffmpeg bit-exact and identical for 1 and 4 threads with and without the pyramid, every speed step that claims it is byte-identical (P-only, slow and screen clips where the decisions do not change), the reconstruction written with `--recon` matches ffmpeg's decode, and the container checks pass with reorder depth 2. After merging main `08b3b02` (`149f001`): B-frame configurations are byte-identical to the branch at `c12ee19` (36 configurations with 1-4 threads, and `--keyint 1` with the default B-frames), P-only configurations to main `08b3b02` (16 configurations with 1-4 threads, including the window tail at `--bframes 0 --keyint 250` and `300`, and all-intra), the 53-case matrix is JM and ffmpeg bit-exact and identical for 1 and 4 threads, ThreadSanitizer finds nothing in 43 scenarios, and the container checks and `tov test` pass. After merging main `1859bac` (`f1c6e24`): B-frame configurations are byte-identical to `812670f` (36 configurations with 1-4 threads, and footprint's odd sizes, synthetic pans, mixed content and live / zerolatency at 1080p, 1440p and 4K), P-only configurations to main `1859bac` (15 configurations with 1-4 threads), the 51-case matrix is JM and ffmpeg bit-exact and identical for 1 and 4 threads, ThreadSanitizer finds nothing in 43 scenarios, and the container checks and `tov test` pass. After merging main `e20b7fe` (`0c662ea`): B-frame configurations are byte-identical to `70ebc48` (the same 36 configurations and footprint sweeps) and to themselves with `--read-ahead 0`, 3 and 5 on 2 and 4 threads (10 configurations), P-only configurations to main `e20b7fe` (15 configurations with 1-4 threads), `--keyint 1` and `2` with the default B-frames to its `--bframes 0` (3 clips x 3 presets x 1-4 threads), the 51-case matrix is JM and ffmpeg bit-exact and identical for 1 and 4 threads, ThreadSanitizer finds nothing in 57 scenarios (14 of them with the read-ahead running), and the container checks and `tov test` (86) pass.

## Numbers

Standard tier, 1080p 10 s, VMAF BD-rate vs x264 veryfast (negative = fewer bits than x264 for the same VMAF), 2026-10-07 07:21, before weighted prediction:

| clip | capcodec-live | capcodec-medium |
|---|---|---|
| busy_ui | +9.9% | +9.3% |
| code_editor | +10.5% | +7.5% |
| slides | +7.0% (was +65%) | +5.5% (was +57%) |
| text_scroll | −7.5% | −7.8% |
| full_motion | +67.7% | +39.0% |

Since then: weighted prediction (slides −6.6% live / −6.9% medium, now fewer bits than x264 veryfast) and texture AQ off by default (capcodec-medium: busy_ui +9.4%, code_editor +7.5%, slides −8.3%, text_scroll −7.8%, full_motion +35.3%; mean +7.2%).

Where full_motion loses: x264 veryfast's B-frames. Without them x264 is +47.5% on full_motion (and +0.0%/+2.2% on busy_ui/code_editor), so capcodec-medium's P-only +35.3% beats x264 veryfast without B-frames by about 12 points (`/tmp/std7`, `/tmp/std8`). capcodec's own B-frames close the gap (next section).

### B-frames

Standard tier, B-frames round 2 (2026-10-08, `/tmp/bf-r2`, branch `bframes` at `ca086f8`, which `6765509` reproduces byte for byte; variants via `CAPCODEC_VARIANTS`, side info on, lookahead on except on live). fast and medium are the defaults (three adaptive B-frames with the pyramid). VMAF BD-rate vs x264 veryfast, PSNR (YUV) in brackets:

| clip | live | live b3 | live b3 pyramid | fast | medium | medium no pyramid | medium P-only |
|---|---|---|---|---|---|---|---|
| full_motion | +39.3% (+64.5%) | −8.5% (−4.4%) | −11.0% (−5.2%) | −14.3% (−7.9%) | −15.0% (−11.1%) | −12.7% (−10.3%) | +25.5% (+41.5%) |
| busy_ui | +5.1% | +5.2% | +5.2% | +1.7% | +1.3% | +1.3% | +1.3% |
| code_editor | +4.1% | +4.1% | +4.1% | −0.0% | −2.8% | −2.8% | −2.9% |
| slides | −9.8% | −9.8% | −9.8% | −21.1% | −20.9% | −20.9% | −20.7% |
| text_scroll | −14.0% | −14.0% | −14.0% | −16.3% | −16.1% | −16.1% | −16.2% |
| mean | +4.9% (+14.8%) | −4.6% (+0.9%) | −5.1% (+0.7%) | −10.0% (−1.3%) | −10.7% (−2.7%) | −10.3% (−2.5%) | −2.6% (+7.9%) |

Against P-only of the same preset (VMAF/PSNR): full_motion medium −34.1/−37.8%, medium without the pyramid −32.4/−37.1%, live b3 −34.5/−41.7%, live b3 with the pyramid −36.2/−42.2%; the screen clips stay within ±0.1% because adaptive B usage codes them almost entirely as P frames. Main before round 2 (`0c7af6c`, same harness, full_motion, `/tmp/bf-r2-main`): medium −12.2% (−10.0%), live b3 −6.9% (−3.7%). Against main on `tune.py` (full_motion, 120 frames, CRF 22-34, VMAF/PSNR BD-rate): medium −2.94/−1.48%, medium without the pyramid −0.45/−0.34%, fast −4.08/−2.29%, slow −2.22/−1.21%, live b3 −1.50/−0.65%, live b3 with the pyramid −4.27/−1.68%.

Matched-VMAF speed vs x264 veryfast CRF 23 (capcodec CRF from the harness: full_motion live 25, live b3 24, fast and medium 22, and main's medium 22 and live b3 24; busy_ui live 29, fast and medium 32; code_editor 31 and 32; slides 30; text_scroll 30 and 33), 300 frames, interleaved best of 3 per variant, 1 and 4 threads for both encoders, load average 21-27 on the 4-core VM (`/tmp/bfdbg/abtime_r2final.log`, `/tmp/bfdbg/abtime_r2screen.log`):

| | live | live b3 | live b3 pyramid | fast | medium | medium no pyramid | main medium | main live b3 |
|---|---|---|---|---|---|---|---|---|
| full_motion, 1 thread, CPU | 1.04x | 1.37x | 1.32x | 1.18x | 1.11x | 1.07x | 0.91x | 1.01x |
| full_motion, 4 threads, CPU | 0.82x | 1.14x | 1.10x | 1.03x | 0.99x | 1.02x | 0.78x | 0.89x |
| full_motion, 4 threads, wall | 0.45x | 1.03x | 1.21x | 1.04x | 1.03x | 0.98x | 0.48x | 0.55x |
| 5 clips geometric mean, 1 thread, CPU | 3.77x | 3.84x | 3.84x | 3.56x | 3.47x | 3.49x | | |
| 5 clips geometric mean, 4 threads, CPU | 3.39x | 3.55x | 3.58x | 3.32x | 3.23x | 3.27x | | |
| 5 clips geometric mean, 4 threads, wall | 1.87x | 2.07x | 2.35x | 1.98x | 1.94x | 1.83x | | |

Main was timed on full_motion only. x264's best 4-thread wall time on full_motion was 1.6x its CPU time (it got 0.63 cores at this load), so the 4-thread wall ratios mostly measure the load; the full_motion CPU ratios repeat within about ±3%. On the screen clips live and live b3 make the same decisions on nearly every frame (BD-rate within 0.1%), so their CPU differences of up to 9% (text_scroll, about 1 s encodes) are load noise. Callgrind (x86-64-v2, full_motion 31 frames CRF 24) against main: medium 7.516G → 5.664G instructions (−24.6%), live b3 7.116G → 5.126G (−28.0%); the steps are in DECISIONS.md under B-frames. Peak RSS at 1080p: medium 112.6 MiB on one thread and 151.8 MiB on four (main 91.1 and 95.5), live b3 72.0 and 114.5 MiB (main 60.7 and 65.3); the extra on four threads is the state of concurrently coded B-frames.

Merging thread-efficiency (main `7189fa4`) took 5-8% off the 4-thread CPU time of the B-frame encodes (pipelined entropy, row prep inside the wavefront, adaptive spin-waits) and left 1-thread CPU unchanged (`/tmp/bfdbg/timing_m7.log`, `timing_m8.log`, timed at load 29-57).

After merging main `08b3b02` (`149f001`), in the benchmark lane (`bench/lane.sh run "python3 bench/speedcmp.py ..."`: capcodec's CRF matched in quarter steps to the VMAF of x264 veryfast CRF 23, 300 frames with side info, five interleaved rounds, the rest of the machine paused for each timed run), two sessions for each binary (`/tmp/bfdbg/m9/lane-merged`, `lane-merged-r2`, `lane-main`, `lane-main-r2`). x264's median time over capcodec's (above 1 is faster), first / second session:

| clip, mode | CPU, 1 thread | main | wall, 1 thread | main | CPU, 4 threads | main | wall, 4 threads | main |
|---|---|---|---|---|---|---|---|---|
| full_motion medium | 1.46 / 1.49x | 1.32 / 1.27x | 1.39 / 1.42x | 1.27 / 1.21x | 1.31 / 1.33x | 1.17 / 1.16x | 1.15 / 1.16x | 0.92 / 0.92x |
| full_motion live | 1.69 / 1.63x | 1.41 / 1.40x | 1.62 / 1.56x | 1.35 / 1.34x | 1.47 / 1.50x | 1.19 / 1.21x | 1.32 / 1.33x | 0.96 / 0.97x |
| full_motion zerolatency | 1.41 / 1.41x | 1.42 / 1.43x | 1.32 / 1.34x | 1.26 / 1.36x | 1.00 / 1.00x | 1.01 / 0.99x | 1.19 / 1.22x | 1.07 / 1.16x |
| webcam_overlay medium | 3.79 / 3.76x | 3.78 / 3.83x | 3.42 / 3.40x | 3.40 / 3.46x | 3.85 / 3.68x | 3.69 / 3.66x | 2.63 / 2.55x | 2.52 / 2.45x |
| webcam_overlay live | 4.09 / 4.08x | 4.16 / 4.00x | 3.09 / 3.68x | 3.76 / 3.62x | 3.84 / 3.93x | 4.09 / 3.90x | 2.32 / 2.75x | 2.90 / 2.76x |
| webcam_overlay zerolatency | 4.38 / 4.46x | 4.41 / 4.42x | 4.00 / 4.09x | 4.05 / 4.03x | 3.94 / 3.90x | 3.87 / 3.87x | 3.65 / 3.60x | 3.57 / 3.65x |
| busy_ui medium | 6.53 / 6.61x | 6.52 / 6.28x | 5.75 / 5.77x | 5.76 / 5.53x | 6.99 / 7.16x | 7.07 / 7.34x | 3.13 / 3.38x | 3.27 / 3.35x |
| busy_ui live | 6.70 / 6.73x | 6.81 / 6.70x | 5.78 / 5.91x | 6.01 / 5.88x | 7.91 / 7.71x | 7.52 / 7.45x | 3.79 / 3.56x | 3.57 / 3.51x |
| busy_ui zerolatency | 6.17 / 6.16x | 6.06 / 6.20x | 5.36 / 5.39x | 5.27 / 5.41x | 6.13 / 6.09x | 6.16 / 6.04x | 3.61 / 3.67x | 3.68 / 3.57x |

full_motion's 4-thread wall clock, main's last speed loss on the scoreboard, is a win: medium 1.94 / 1.86 s against x264's 2.23 / 2.15 s (main 2.48 / 2.34 s), live 1.65 / 1.59 s against 2.18 / 2.11 s (main 2.29 / 2.14 s), from the concurrent and asynchronous B runs; with B-frames full_motion also takes 12-19% less CPU time than on main (round 2's B search and pyramid steps). The matched CRFs are the same for both binaries (full_motion 22.5 / 22.25 / 25.75 for medium / live / zerolatency, webcam_overlay 28.5 / 28.25 / 26.25, busy_ui 32.25 / 32.25 / 25). zerolatency output is byte-identical to main's, and on the screen clips adaptive B usage codes nearly every frame as P, so those rows differ only by the sessions' spread; webcam_overlay live's first session (wall 3.09x and 2.32x) had slow runs, and a 7-round lane recheck put the branch, `c12ee19` and main at 0.75, 0.76 and 0.78 s on one thread and 0.43 s each on four. Peak RSS at 1080p on 1 / 4 threads: full_motion medium 115 / 155 MiB (main 97 / 102, x264 253-260 / 373-385), live 82 / 125 (main 72-73 / 78), zerolatency 52 / 54 as on main; webcam_overlay medium 104 / 119-120 (main 91 / 96), live 70 / 88 (main 67 / 71-72). The extra is the concurrently coded B-frames' state (DECISIONS.md).

After merging main `1859bac` (`f1c6e24`: footprint rounds 3-4, intra-speed round 2; B-frame output byte-identical to `812670f`), each concurrently coded B-frame packs its coefficients into its own chunk store, which halves the B-frames' extra memory. Peak RSS at 1080p on 1 / 2 / 4 threads (90 frames, CRF 26): full_motion live 59 / 85 / 89 MiB (main `1859bac` 58 / 63 / 64, `812670f` 73 / 108 / 112), medium 94 / 116 / 120 (main 83 / 87 / 89, `812670f` 109 / 141 / 144); zerolatency 39 on 4 threads and busy_ui 30-64 as on main; full_motion 4K live 218 / 315 on 1 / 4 threads (main 214 / 229, `812670f` 274 / 416). `--keyint 1` and `2` no longer declare B-frames in the SPS and are byte-identical to `--bframes 0`. In the benchmark lane (two sessions per binary, matched VMAF against x264 veryfast, ratios on 1 / 4 threads), full_motion medium takes 1.58-1.63x / 1.41-1.47x less CPU time and 1.45-1.55x / 1.16-1.25x less wall clock than x264 (main 1.31-1.32x / 1.19-1.22x and 1.26x / 0.94-0.97x), live 1.69-1.72x / 1.56-1.57x and 1.61-1.64x / 1.38-1.39x (main 1.45-1.49x / 1.24-1.30x and 1.39-1.43x / 1.01-1.02x); the 4-thread wall clock is 1.72-1.88 s on medium against x264's 2.15-2.17 s (main 2.16-2.31 s) and 1.48-1.49 s on live against 2.06 s (main 2.01-2.62 s).

After merging main `e20b7fe` (`0c662ea`: read-ahead during B runs, pin7 CABAC round), in the benchmark lane (two sessions per binary), full_motion medium takes 1.69-1.71x / 1.48-1.49x less CPU time and 1.62-1.64x / 1.35-1.40x less wall clock than x264 veryfast on 1 / 4 threads (main `e20b7fe` 1.43-1.45x / 1.25-1.26x and 1.37-1.39x / 1.09-1.10x), live 1.88-1.93x / 1.60-1.66x and 1.80-1.85x / 1.44-1.50x (main 1.58-1.61x / 1.34-1.36x and 1.52-1.54x / 1.19-1.21x); the 4-thread wall clock is 1.51-1.53 s on medium against x264's 2.04-2.15 s (main 1.91-2.01 s) and 1.42-1.53 s on live against 2.13-2.20 s (main 1.71-1.81 s). Peak RSS at 1080p on 1 / 2 / 4 threads (90 frames, CRF 26): full_motion live 59 / 95 / 98 MiB (main 58 / 72 / 73), medium 94 / 126 / 130 (main 82 / 96 / 98); the read-ahead's three extra raw frames add 9-10 MiB on 2 and 4 threads to both, and 38 MiB at 4K (live on 4 threads 353, main 268).

Recommended settings: the defaults (three adaptive B-frames with the pyramid on fast, medium and slow) wherever the reorder delay is acceptable (exports, uploads, the media server and render farm); live also defaults to three adaptive B-frames (no pyramid, 2 frames of lookahead), with `--zerolatency` for no reorder delay and the least memory.

OCR (text-region character error, 3 frames per clip, `bench.py ocr`): the text AQ lowers character errors on scrolling text by about a third at equal bitrate; other clips are within noise.

Lookahead (10 frames, on by default except live), VMAF BD-rate against the encoder without it (busy_ui, code_editor, full_motion, slides, text_scroll; mean): fast −1.6/−5.0/−1.3/−12.6/−4.5 (−5.0%), medium −1.7/−5.0/−0.7/−12.5/−4.5 (−4.9%), slow −1.4/−5.1/−1.7/−14.9/−4.9 (−5.6%). Against x264 veryfast, medium goes from +4.8% to +2.3% and slow from +6.8% to +2.0%. Single-thread instructions −3% to +4% per clip, 10 frames of delay, +31 MB at 1080p; OCR character error is unchanged on text_scroll and lower on code_editor. At equal CRF video gets fewer bits and long-lived screen content more (full_motion CRF 20 13.3 → 7.4 Mbit/s, text_scroll CRF 26 +13%). With 250-frame GOPs full_motion is still about 2% worse than without lookahead while the screen clips gain 3-18%.

Lookahead with adaptive B-frames (the fast, medium and slow defaults since `9bce84f`; DECISIONS.md): every picture is coded with the lookahead map of its own display index, B-frames take the anchor's macroblock QP + 6, and an anchor gains lifetime from the B-frames that predict from it through list 1. VMAF BD-rate against main `9bce84f` (B-frames, no lookahead) of the same preset (busy_ui, code_editor, full_motion, slides, text_scroll; mean): fast −1.6/−5.0/−2.8/−12.6/−4.5 (−5.3%), medium −1.7/−5.0/−2.5/−12.7/−4.5 (−5.3%), slow −1.4/−5.1/−1.8/−15.0/−4.9 (−5.6%); without the list-1 credit medium full_motion is −0.7%. Against x264 veryfast the mean goes from +1.5% to −3.4% (fast), from −0.9% to −5.6% (medium) and from −0.4% to −5.4% (slow). webcam_overlay gains 8.9-11.6%, all of it from main's CRF 20 point (about +2% without it). Single-thread CPU at CRF 26 (best of 5, interleaved, loaded machine) over the six clips: fast +2.8%, medium +1.4%, slow +2.9%; callgrind instructions for medium −2.4/−2.0/+1.4/−0.6/+4.1% (+1.3%). The 5-10% on the shortest screen clips (0.4-1.2 s encodes) is about 8,000 more page faults from first touching the lookahead buffers plus noise; their user time is −3% to +3.5%. Up to 13 frames of output delay (10 lookahead + 3 B-frames), +31 MB at 1080p. OCR character error: busy_ui 3.96 → 4.00, code_editor 4.77 → 4.54, text_scroll 2.02 → 2.03; on slides 0.54 → 0.79 comes from icon and bullet glyphs and source misreads (the P-only lookahead gives 0.80) with equal or higher PSNR in the text regions. At equal CRF full_motion gets 23-29% fewer bits (2-9 VMAF points below main) and the screen clips 4-14% more; holding the mean offset at or below zero keeps main's quality at every CRF but costs 11% CPU at equal CRF (DECISIONS.md).

Lookahead round 3 (2026-10-08, standard tier, six clips; DECISIONS.md): with more than one thread the read-ahead thread runs the propagation for the next frame (main-thread instructions -9.1% full_motion, -29.7% slides at 4 threads); the change map without side info is vectorised (media-server busy_ui -40% instructions); without B-frames, content that a video frame (at least half the macroblocks changed) replaces is assumed to decay geometrically to the horizon. fast, medium, slow, live and `--lookahead 0` are byte-identical to main. The media-server settings (medium, `--keyint 250 --noise 3 --no-sideinfo`) now gain on every clip against `--lookahead 0` (full_motion -1.6%, mean -7.5%); with `--bframes 0` full_motion is still +2.4% (+2.9% before the geometric tail). SATD, half-pel and i16 intra costs in the lookahead gained at most 0.9% (P-only full_motion) for +2.7 to +14% instructions. Live with a short lookahead (VMAF BD-rate against live; instructions at CRF 26 against live; peak memory at 1080p, one thread):

| `--preset live` | busy_ui | code_editor | full_motion | slides | text_scroll | webcam_overlay | mean | vs x264 veryfast | instructions | delay at 30 fps | memory |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `--lookahead 0` (default) | | | | | | | | -0.4% | | 0 | 41-52 MB |
| `--lookahead 1` | -3.4 | -3.3 | +1.9 | -16.5 | -4.0 | -9.8 | -5.9% | -3.8% | -5.3% | 33 ms | +3 MB |
| `--lookahead 2` | -3.3 | -3.5 | -1.0 | -15.2 | -4.1 | -10.9 | -6.3% | -4.5% | -4.9% | 67 ms | +6 MB |
| `--lookahead 4` | -3.3 | -3.9 | -1.2 | -14.4 | -4.1 | -12.6 | -6.6% | -4.6% | -4.5% | 133 ms | +12 MB |

Live reads 2 frames ahead by default since `b0d85fb` (67 ms at 30 fps); `--zerolatency` keeps 0. OCR character error at depth 2: text_scroll 1.81 -> 1.41%, slides 0.48 -> 0.45%, code_editor 4.70 -> 4.80%, busy_ui 3.68 -> 4.33% with equal text-region PSNR (-0.29 to +0.25 dB at matched bitrate); the busy_ui rise is icon glyphs Tesseract fuses onto words, and the word-level `ocr_word_cer` stays at or below 0.7% for every clip from ~400 kbps. Medium at depth 6 or 4 saves 12 or 19 MB for +0.06% mean but loses 0.54 or 0.78% on full_motion; the ring of raw frames is the encoder's input delay, so the memory stays.

Lookahead round 4 (2026-10-08, DECISIONS.md): the media server's settings (medium, `--keyint 250 --noise 3`, no side info) spent most of their time in the encoder's scalar per-macroblock change test. Change detection is now one vector pass per frame, two macroblocks per vector row with an exact-equality test first, and the encoder reuses the lookahead's map wherever its source copy is current. Every preset default and `--lookahead 0` is byte-identical to main `52510d7`, and after merging main `7189fa4` to it (270/270 gate runs identical to the pre-merge branch; instructions against `7189fa4` -83.1/-84.3/-88.4/-1.0/-73.0%). At the media-server settings against main `52510d7` (CPU is user + system time, best of 5 interleaved runs on a loaded 4-core VM; full_motion at one thread is the median of 10 paired runs, whose best-of-5 moved between -3 and +4%):

| | busy_ui | code_editor | slides | full_motion | webcam_overlay |
|---|---|---|---|---|---|
| instructions, 60 frames, 1 thread | -83.6% | -84.7% | -88.9% | -1.0% | -73.2% |
| CPU, 300 frames, 1 thread | -62.6% | -66.1% | -40.1% | -0.6% | -32.1% |
| CPU, 300 frames, default threads | -61.1% | -58.8% | -36.2% | | -31.7% |

P-only GOPs longer than 2 s (`--bframes 0 --keyint 250`) end content that a video frame replaces at the window edge: -0.76% mean VMAF BD-rate (slides -2.78, webcam_overlay -1.24, full_motion -0.50%, no clip worse), full_motion +1.67% against `--lookahead 0` (was +2.37%). The busy_ui OCR difference under the live lookahead is icon glyphs that OCR reads as characters, in mostly unchanging text, with higher text PSNR and a sign that flips between CRFs and regions; capping the lookahead's QP raise on text macroblocks does not change it and gives up a fifth to a third of the BD-rate gain, so live keeps reading 2 frames ahead as measured (its default since `b0d85fb`).

Single-thread speed at 1080p (live preset, warm page cache): busy_ui ~590 fps (a third of it is the kernel copying the raw input file; a library integration would not pay that), code_editor ~450, text_scroll ~140, slides ~160, full_motion ~21.5. x264 veryfast on this VM: ~110-145 fps on one core, ~150-370 on four.

Intra coding at equal QP (all-intra, AQ off): capcodec frames are 2.5% larger than x264 veryfast's with luma PSNR within 0.1 dB; chroma is ~1 dB lower because x264 uses chroma_qp_index_offset −2 (VMAF ignores chroma).

Change-proportional cost (slow_typing, earlier measurement): static frame 0.18% of a full frame with side info; 1.7% with the pixel-difference fallback.

## Speed rounds (profile-driven; each round worked on the top stage)

| Round | Top stage | Change | Effect |
|---|---|---|---|
| 1-4 | ME, intra | sub-pel prediction, cached half-pel tiles, intra early exits, table-driven directional intra | full-change frame 265 → 125 ms |
| 5 | entropy (IDR) | byte-oriented CABAC | IDR entropy 31 → 14 ms |
| 6 | mode + tq (IDR) | IDR macroblock reuse | IDR ~95 → ~45 ms on typing/editor/UI clips (79-99% of macroblocks reused) |
| 7 | bookkeeping | one MV per macroblock, untouched skip state | 10-20% on motion-heavy clips |
| 8 | deblock | batched edges, flat-line skip | busy_ui deblock 38 → 27 ms total |
| 9 | ME/mode (video) | SIMD SAD/SATD/SA8D/half-pel/qpel | full_motion 10.3 → 16.1 fps |
| 10 | tq (video) | SIMD 4x4 transforms and quantisation | 16.1 → 18.6 fps |
| 11 | analysis | SIMD classification, row hashing, copies | 19.8 → 21.5 fps |

Current full-motion profile (live, per frame): tq 16, motion 14, analysis 9.5, mode 6.7, deblock 3.9, entropy 2.8 ms.

## Research applied

- OpenAI math preprints (`~/work/openai-math`, 722 papers): the algorithmic results (DFT in O(n (log n)^(1−10⁻¹³)), complex matrix multiplication below 2.258, integer multiplication below n log n, finite tensor savings for Fourier circuits) are asymptotic and do not reduce work at H.264's 4x4/8x8 integer butterflies, which are already at minimal add counts; the bottleneck is vector throughput and memory traffic. Recorded in DECISIONS.md.
- Applied from video-coding practice: hash/profile-based global motion (screen content coding), byte-oriented CABAC (x264/FFmpeg style), weighted prediction for fades, x264-style decimation and fast skip, SIMD kernels. Tried and reverted: EPZS-style cursor and dominant-motion predictors for every macroblock (no gain on the corpus, slides +0.7%).

## Tov

`encoder-features` branch (all committed): binary fs I/O, `--unchecked`, typed arrays, SIMD vectors, threads and Atomics, borrowed typed-array field arguments (`976bb78`), loop hoisting of array fields (`dee1ec3`), module init order (`d8a0f81`), `Math.clz32`/`imul` (`eced999`), C library output `tov build --lib` (`5cb7538`: `libname.a/.so` + `name.h`, typed arrays borrowed zero-copy, opaque class handles, `name_last_error`), function-value adapters (`7b58f21`), `--target wasm32-wasi` for programs and libraries (`3bee8b1`; a thread-free capcodec build is byte-identical to native at 1.86x the CPU per frame). The installed compiler is `encoder-features` 20ea68f (from `~/work/tov-pin7`, installed 2026-10-09 07:50; capcodec builds byte-identically to 538446e; adds horizontal `min`/`max`/`minIndex`/`maxIndex` (`phminposuw`), vector records returned in registers, `mulHigh`/`mulWideLow`/`mulWideHigh`, `@inline`/`@noinline`, Buffer-style `readUInt32LE`/`writeUInt32BE`/... on `Uint8Array`; 538446e stays at `/usr/local/cargo/bin/tov.pin6-538446e`). Previously 538446e (from `~/work/tov-pin6`, installed 2026-10-08 23:50; against 64982fa: capcodec unchecked 620,816 -> 550,024 bytes, 0.8-1.8% fewer instructions, clean builds compiled as 16 parallel C units, `Math.select`, run-time `T.shuffle`, `pushFrom`, `Math.idiv`, `Target.vectorBits`, narrowing stores, `discard`; byte-identical encodes; 64982fa stays at `/usr/local/cargo/bin/tov.pin5-64982fa`). Previously 64982fa (from `~/work/tov-pin5`; 2.9-5.2% fewer capcodec instructions than 548ff6b, byte-identical output, multi-target `--target-cpu x86-64-v3,x86-64-v4` binaries, `--profile-generate`, module constants as C constants, smaller binaries): element borrows folded in (72b793b), serial threads on wasm (3b00bba), 512-bit vectors and concat/low/high, register-resident sums, mask/ctz/popcount, branch-free `?:`, borrowed typed-array locals, integer-quotient rounding, Atomics memory orders, Int64Array and 64-bit lanes, Channel, parallelFor options; capcodec builds byte-identically with it. See TOV_GAPS.md.

## How to resume

```sh
export PATH=$HOME/tools/bin:$PATH          # static ffmpeg 8.1 (libx264, libopenh264, libvmaf), JM ldecod
cd ~/work/tov-pin2 && git log --oneline -1 && cargo +1.88.0 install --path crates/tov   # elem-borrow 02a302a on top of encoder-features
cd ~/work/capcodec && bench/build_encoder.sh
python3 bench/bench.py smoke                 # < 60 s, regression gate
python3 bench/bench.py standard --encoders "capcodec-live,capcodec-medium,x264-veryfast"
python3 tools/profile.py full_motion busy_ui --presets live,medium     # per-stage times
python3 tools/verify.py slides --binary build/capcodec-unchecked --preset medium   # JM + ffmpeg bit-exact check
```

Backups (git bundles of capcodec and the Tov branch, PROGRESS.md) are written to `/cursor/stores/self/backups` by `tools/backup.sh`.

## Next steps

1. Parallel entropy coding for IDR frames (a few row-band slices, about +0.5% bits) and row-parallel deblocking: IDR frames are now the serial bottleneck on typing/editor/UI clips.
2. Full-motion efficiency: live preset is +68% BD vs medium's +39% without B-frames; stronger motion search where the frame is video-like, SIMD 8x8 transforms, intra in P frames. B-frames next steps: B sub-partitions (16x8, 8x16, 8x8 and direct 8x8), lookahead to choose the B run length per scene (and to credit the middle B-frame of a pyramid run), a second reference per list, and entropy coding of B rows as they finish so concurrent B-frames need a few rows of coefficients instead of a frame.
3. Screen-content BD-rate: tune I/P offset, refresh, lifetime AQ and AQ strength with harness variants; transient-content QP for animations.
4. C ABI build for crates/export, WASM build for the browser export, FINDINGS.md.
5. Lookahead: choose the B run length and reference structure from its lifetimes (the changed-macroblock count alone lost 5% on pulldown, DECISIONS.md); an opt-in quality-anchored CRF (the one-sided offset clamp) where CRF has to mean the same quality on video; P-only long GOPs, where full_motion still loses 1.7% (a per-macroblock tail from how long each block's motion has lasted, or intra refresh of the decayed content); a changed-macroblock ring sharing the encoder's buffers.
6. Media-server CPU after the change-detection round: CABAC (163M of busy_ui's 558M instructions over 60 frames, about 70M of it the first IDR frame), the change map (70M, nearly all of it the lookahead's pass, which already runs on the read-ahead thread with more than one thread), intra decisions (41M, mostly the IDR frame), and letting B-run anchors take the lookahead's map (full_motion: 3 of 17 anchors can today).
