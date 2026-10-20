# Findings: capcodec against each Cap surface's encoder

Status: 2026-10-07, interim (threads, the C ABI build and the WASM build are not in yet). Every number comes from the harness's standard tier: 1080p, 10 s of each clip, VMAF (every 5th frame), BD-rate over the overlapping quality range, `/tmp/std9` and `/tmp/std10` (results.csv, summary.json, report.html). Clips: busy_ui, code_editor, text_scroll, slides (screen recordings) and full_motion (a film playing full screen, the worst case). Negative BD-rate means capcodec needs fewer bits than the surface's encoder for the same VMAF.

Speeds are single-core CPU frames per second for the harness's quality encodes (capcodec has no threads yet; the x264 surfaces run with `-threads 1` for these runs). Every capcodec stream decoded without error in JM and ffmpeg and matched the encoder's reconstruction bit for bit.

The surfaces' settings come from CAP_BASELINES.md; hardware encoders (VideoToolbox, NVENC, Quick Sync, AMF, Media Foundation) cannot run on this Linux VM and are not compared.

## Summary

| Surface (today's encoder) | capcodec VMAF BD-rate | Bitrate capcodec needs at Cap's production point | Single-core speed, capcodec vs today | Verdict |
|---|---|---|---|---|
| Web recorder, PR 2312 (Chrome MediaRecorder H.264) | −51% (medium), −49% (live) | 0.15-0.66x | not comparable (browser) | capcodec wins on bits; needs the WASM build to replace it |
| Browser export, PR 2312 (WebCodecs) | −63% (medium), −59% (live) | 0.20-0.94x | not comparable (browser) | capcodec wins on bits; needs the WASM build |
| Desktop recording, Linux (x264 ultrafast zerolatency, ABR bpp 0.3) | −67% (medium), −63% (live) | 0.22-0.54x | ultrafast is faster on video (108 vs 23 fps), capcodec faster on screen content | capcodec wins on bits; speed depends on content |
| Desktop export and render-farm libx264 override (x264 veryfast ABR, no B-frames, 2 s GOP) | −34% (medium), −29% (live) | 0.29-0.73x on screen clips, 1.0x on video | 2.2-2.4x faster on screen clips, 0.4-0.5x on video | capcodec wins on screen content, ties on video bits but is slower there |
| Render-farm source transcode (x264 veryfast CRF 18, no B-frames, 1 s IDR) | −38% (medium), −32% (live) | 0.49-0.76x | 2.3x faster on screen clips, 0.5x on video | capcodec wins on screen content |
| Desktop export "Optimize file size" (x264 slow CRF 24-36, B-frames) | +27% (medium), +37% (live) | 1.2-1.3x on screen clips, 2x on video | 5x faster on screen clips | x264 slow wins on bits; capcodec is far cheaper |
| Media server transcode (x264 medium CRF 23, 250-frame GOP, B-frames) | +27% (medium, same GOP), +41% (live) | 1.28-1.38x on screen clips, 0.63x on scrolling text, 1.9x on video | 4-5x faster on screen clips, 1.1x on video | x264 medium wins on bits except scrolling text; capcodec costs a quarter of the CPU |
| Media server edit render (x264 fast CRF 18, 250-frame GOP) | +26% (medium, same GOP) | 1.25-1.44x, 0.61x on scrolling text | 4x faster on screen clips | as above |

Matched-VMAF speed against x264 veryfast (wall clock, capcodec on one core, x264 on four), from `/tmp/std9`: capcodec-live busy_ui 1.62x, code_editor 1.58x, slides 0.86x, text_scroll 0.68x, full_motion 0.23x; geometric mean 0.81x (CPU time: 1.48x).

## Per surface

### Web recorder (PR 2312: Chrome MediaRecorder, `video/mp4;codecs="avc1.64002A"`, 4 Mbit/s at 1080p30)

- **Does capcodec beat it?** Yes, by about half the bits at equal VMAF on every clip: busy_ui −47%, code_editor −48%, slides −75%, full_motion −34% (medium). Chrome's software H.264 encoder (OpenH264) has no screen-content tools, no CABAC and a fixed bitrate tier.
- **Speed and CPU.** Not comparable here: the browser encodes in real time at its own pace. The replacement path is the WASM build of capcodec running in the page, which waits on Tov's WASM target.
- **Where it loses.** Nowhere on quality; the integration is the open item.

### Browser export (PR 2312: WebCodecs `avc1.6400LL`, bpp model)

- **Does capcodec beat it?** Yes: −63% (medium) / −59% (live) BD-rate, text_scroll −80%. At Cap's production points capcodec needs 0.2x-0.94x of the bitrate for the same quality.
- **Speed.** Not comparable (headless Chrome software path); same WASM dependency as the recorder.

### Desktop recording on Linux (x264 ultrafast, tune zerolatency, Constrained Baseline, ABR at bpp 0.3, 2 s DASH segments)

- **Does capcodec beat it?** Yes: −67% (medium) / −63% (live) on the clips where the curves overlap (text_scroll −67%, full_motion −68%). Ultrafast disables CABAC, B-frames and most analysis.
- **Speed.** Ultrafast is the faster encoder on full-motion video (108 vs 23 fps on one core); on screen content capcodec's change-proportional coding is faster (280-330 fps on busy_ui/code_editor, ultrafast 220-240).
- **macOS and Windows** use VideoToolbox and GPU encoders, which cannot be measured here.

### Desktop export (Linux default) and render-farm libx264 override (x264 veryfast ABR, bf 0, rc-lookahead 10, 2 s GOP)

- **Does capcodec beat it?** Yes on screen content: busy_ui −32%, code_editor −31%, slides −48%, text_scroll −44% (medium). On full_motion medium is −16% and live +6%.
- **Production points.** At the export presets capcodec needs 0.29x (slides, Social) to 0.73x (code_editor, Potato) of the bitrate for the same quality; on full_motion about the same bitrate.
- **Speed.** 2.2-2.4x faster on screen clips on one core; about half the speed on full-motion video.
- **Integration.** Cap calls libx264 from Rust (crates/export); the drop-in needs the C ABI build (Tov `--lib`, in progress).

### Render-farm source transcode (x264 veryfast CRF 18, bf 0, IDR every 1 s)

- −38% (medium) BD-rate; 2.3x faster on screen clips, half the speed on video. Production renders use NVENC p1 on GPUs, which isn't measurable here.

### Desktop export "Optimize file size" (x264 slow CRF 24/28/32/36, 3 B-frames)

- **Does capcodec beat it?** No: +27% (medium) on average, +25% to +31% on screen clips and +78% on full_motion; it wins on text_scroll (−24%).
- **Cost.** capcodec is about 5x faster on one core on screen clips (280 vs 55 fps).
- **Where it loses.** x264 slow's RDO, trellis quantisation, B-frames and macroblock-tree rate control.

### Media server transcode (x264 medium CRF 23, High 4.2, default 250-frame GOP, 3 B-frames)

- **Like for like** (capcodec with `--keyint 250`): capcodec-medium needs 27% more bits on average: busy_ui +20%, code_editor +35%, slides +29%, full_motion +87%, and 36% fewer on text_scroll. With capcodec's default 2 s keyframes the gap is +95%, which is a GOP difference, not a coding one: on static screens keyframes dominate the bitrate.
- **Cost.** capcodec uses about a quarter of the CPU on screen clips (280-330 vs 65-72 fps on one core) and about the same on video.
- **End to end** (prototype in Cap branch `cursor/capcodec-integration-aa45`, draft PR #2429, 10 s 1080p typing clip from a VP9 upload): libx264 2.10 s, 309 KB, VMAF 92.9; capcodec 2.56 s, 531 KB, VMAF 93.7 (before this session's speed work and with 2 s keyframes).
- **Where it loses.** B-frames and macroblock-tree rate control (x264 veryfast without B-frames is +47.5% on full_motion; capcodec medium is +35%), and the noise of lossy uploads.

## What is missing before capcodec can replace these encoders

1. **Threads.** Wavefront coding is implemented and bit-identical for any thread count (`typed-planes` branch, commit `482440a`), but it is slower than one thread until Tov stops doing atomic reference counting on every typed-array field access (TOV_GAPS.md, in progress in Tov). Expected 2.5-3.5x wall clock on four cores for heavy frames.
2. **B-frames** for camera and video content (the media server, the render farm with webcam overlays) were x264's whole advantage on full_motion. They are now in, opt-in (`--bframes 1-3`, adaptive): on full_motion `--preset medium --bframes 3` needs 4.6% fewer bits than x264 veryfast for the same VMAF (P-only medium: +32.6%) and the screen clips are unchanged (standard tier, `/tmp/bf-post`, see PROGRESS.md). The surface comparisons above predate them. Still missing against x264 medium and slow: B sub-partitions, B-frames as references (pyramid), several references per list, and lookahead / macroblock-tree rate control.
3. **The C ABI build** for crates/export and the desktop app, and **the WASM build** for the browser recorder and export (both in progress in Tov).
4. **Hardware encoder comparisons** on macOS and Windows (VideoToolbox, NVENC, Media Foundation): run the harness's hardware adapters on those machines (see CAP_BASELINES.md section 9 and bench/harness/adapters/hardware.py).

## Footprint and raw speed against x264 (2026-10-07)

x264 built here from source (commit 0480cb0, `--enable-static`, nasm 2.16); capcodec main `ec8d3ac`. 4-core Sapphire Rapids VM, best of 3 interleaved runs on an idle machine.

| | capcodec | x264 |
|---|---|---|
| Binary | 506 KB (498 KB stripped) | 2.50 MB (2.32 MB stripped) |
| Runtime dependencies | libc, libm | libc, libm |
| Clean build | 8.9 s (one C translation unit; 0.06 s when cached) | 17.1 s with `make -j4`, 59.7 s with `-j1`; needs nasm |
| Source | 8.8K non-blank lines of Tov, tests included | 79.7K lines of C, 60.1K lines of assembly |
| Startup, one 64x64 frame | 1.1 ms | 1.4 ms (veryfast) |
| Peak memory, 1080p | 46-53 MB | 152-249 MB (veryfast, 1-4 threads) |
| Output delay | 0 frames (N with `--bframes N`) | 3 B-frames + 10-frame lookahead (veryfast) |

Since these measurements the fast, medium and slow presets use adaptive B-frames (`--bframes 3`) and read 10 frames ahead (`--lookahead`): up to 13 frames of output delay, about 31 MB more at 1080p, and a mean VMAF BD-rate against x264 veryfast of −3.4% (fast), −5.6% (medium) and −5.4% (slow) over busy_ui, code_editor, full_motion, slides and text_scroll; live is unchanged. At the media server's settings (medium, 250-frame GOP, `--noise 3` without side info) the lookahead gains on every clip, full_motion included (−1.6%), and since round 4 the change detection there is one vector pass per frame shared with the lookahead: single-thread instructions against main `52510d7` busy_ui −84%, code_editor −85%, slides −89%, webcam_overlay −73%, full_motion −1% (CPU at 300 frames on one thread −63%, −66%, −40%, −32% and −1%), with identical output. For desktop recording, `--preset live --lookahead 2` adds 2 frames of delay (67 ms at 30 fps) and 6 MB at 1080p for −6.3% VMAF BD-rate against live (every clip better) at 4.9% fewer instructions, and moves live from −0.4% to −4.5% against x264 veryfast over the six clips including webcam_overlay (PROGRESS.md).

| Raw speed, 1080p | capcodec | x264 veryfast |
|---|---|---|
| busy_ui, 4 threads, no side info | 433 fps, 0.9 s CPU | 343 fps, 2.2 s CPU |
| full_motion, 1 thread (live CRF 30, 3.4 Mbit/s vs CRF 23, 3.7 Mbit/s) | 34.6 fps | 46.3 fps |
| full_motion, 4 threads | 65 fps, 11.4 s CPU | 115.5 fps, 6.6 s CPU |
| 30 keyframes (keyint 1), 1 / 4 threads | 20 / 32 fps | 65 / 210 fps |

At similar bitrates x264's full-motion quality is much higher (VMAF BD-rate: capcodec-medium +35.5%, live +63.5%). Keyframe coding is the slowest path (scalar intra transforms, poor 4-thread scaling) but keyframe reuse hides it on typical screen recordings.
