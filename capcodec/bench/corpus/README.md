# Lossless screen-recording corpus

Synthetic but app-like screen recordings for benchmarking the capcodec
screen-content H.264 encoder. Every clip is a real-time `x11grab` capture of
Chrome on a private Xvfb display, driven by scripted human-like input. The
captures are stored losslessly next to per-frame side info: dirty rects,
cursor position and scroll vectors. One clip, `full_motion`, is the worst
case for a screen encoder: a natural video (Big Buck Bunny) playing full
screen.

Scripts, pages and the manifest live here (`bench/corpus/`). Captures and side
info go to `$CAPCODEC_CORPUS`, which defaults to `/home/ubuntu/work/corpus` and is
never committed.

## Regenerating

```sh
cd bench/corpus
python3 generate.py --list                      # clip table
python3 generate.py --clip slides               # one clip (repeatable)
python3 generate.py --all                       # everything (~20 min)
python3 generate.py --all --missing             # only clips without outputs
python3 generate.py --clip idle --sideinfo-only # recompute side info, previews, manifest entry
python3 generate.py --verify-lossless           # codec round-trip check
```

Run long jobs inside tmux (`tmux new-session -d -s corpus-gen ...`). Each run
is idempotent: the clip's work dir (`$CAPCODEC_CORPUS/.work/<name>`, which
holds the raw capture and the Chrome profile) is wiped, every output is
overwritten, and the clip's manifest entry is replaced. The work dir is
deleted again once the outputs are written. Clips are written to
`manifest.json` in `CLIPS` order.

Environment:

| variable | default |
|---|---|
| `CAPCODEC_CORPUS` | `/home/ubuntu/work/corpus` |
| `CAPCODEC_CACHE` | `/home/ubuntu/work/cache/capcodec-corpus` (downloaded source video, segment, match features; outside git) |
| `CAPCODEC_FFMPEG` | `/home/ubuntu/tools/bin/ffmpeg` (8.1) |
| `CAPCODEC_FFPROBE` | `ffprobe` next to `CAPCODEC_FFMPEG` |

Requirements: Xvfb, xdotool, python3 with `python3-xlib`, `numpy` and
Playwright, and Google Chrome (`channel="chrome"`, tested with 148). The pages
use locally installed fonts (Noto Sans, Liberation, Inter, JetBrains Mono,
Bitstream Charter). `sudo -n renice` is used when available. Displays: `:99` at
1920x1080x24 is reused if it is already running (otherwise it is started), and
`:98` at 3840x2160x24 is started and stopped for `code_4k`. `:1` is refused.
Pages are `file://` URLs and all data (code, article text, board data) is
embedded in `pages/data/*.js`. The only network access is the one-time
download of the `full_motion` source video into `$CAPCODEC_CACHE`, which is
verified by sha256. Captures never touch the network.

## Clips

| name | size @ fps | s | page | content |
|---|---|---|---|---|
| slow_typing | 1920x1080@30 | 40 | `docs.html` | Docs-like editor, 15px text, human typing with pauses and BackSpace fixes |
| code_editor | 1920x1080@30 | 40 | `code.html` | VS Code Light+, 13px JetBrains Mono, typing with auto-indent, wheel/PageDown/caret |
| text_scroll | 1920x1080@30 | 40 | `article.html` | Wikipedia-like article: notches, flicks, eased smooth scroll, selection, hovers |
| slides | 1920x1080@30 | 40 | `slides.html` | deck advancing every ~3 s: cuts, fades, push/cover slide-ins, builds |
| busy_ui | 1920x1080@30 | 40 | `board.html` | dense issue board, constant curved pointer motion, menus, drags, scroll |
| dashboard | 1920x1080@30 | 40 | `dashboard.html` | 11-12px tables, KPI tiles, 1 s updates, animated charts and sparklines |
| dark_mode | 1920x1080@30 | 40 | `dark.html` | VS Code Dark+ and a terminal streaming logs, occasional typing |
| idle | 1920x1080@30 | 60 | `idle.html` | static desktop/PDF viewer, ticking clock, 3 toasts, 4 pointer moves |
| webcam_overlay | 1920x1080@30 | 40 | `slides.html?webcam=1` | slides with a 320px circular canvas webcam (gradient, figure, noise), dragged 4 times |
| busy_ui_60fps | 1920x1080@60 | 20 | `board.html` | short busy_ui variant at 60 fps |
| code_4k | 3840x2160@30 | 20 | `code.html` | DSF 2 on a 4K Xvfb, code typing and scrolling |
| full_motion | 1920x1080@30 | 30 | `video.html` | Big Buck Bunny 27.47-57.43 s full screen in a `<video>`: camera push-in over grass and foliage, dark burrow close-up, bunny in the meadow; no input, cursor hidden |

Scenario timelines are in `scenarios.py` (`SCENARIOS`), and clip parameters
(page, seed, start pointer, settle time, encoder threads) are in `generate.py`
(`CLIPS`). Page animations use seeded PRNGs (mulberry32) and virtual clocks.
Scenarios use seeded `random.Random`. Re-captures therefore follow the same
script, but they are not bit-identical because real-time scheduling varies by a
few ms.

## Outputs per clip (`$CAPCODEC_CORPUS`)

| file | content |
|---|---|
| `<name>.mkv` | lossless H.264 (libx264rgb `-qp 0`, High 4:4:4 Predictive, GBR planes), CFR pts `n/fps` |
| `<name>.sideinfo.jsonl` | one line per frame (format below) |
| `<name>.events.jsonl` | merged timeline sorted by wallclock: `scroll` (page scroll reports), `page` (app events such as slide, toast, menu_open, drop), `input` (DOM key/mouse/wheel events), `action` (injected input), `pointer` (deduplicated pointer samples), `capture` (first/last frame) |
| `<name>.pointer.jsonl` | raw 240 Hz pointer samples `{t, x, y, rtt}` |
| `<name>.capture.json` | per-frame wallclock, interval stats, ffmpeg command, grab latency, scenario start/end offsets, page info |
| `<name>.capture.log` | full ffmpeg log |
| `previews/<name>_fNNNNN.png`, `previews/<name>_sheet.png` | frames 0, n/3, 2n/3, n-1 and the frame with the largest dirty area, plus a 2x2 sheet |
| `full_motion.playback.json` | playback check: source frame shown by every captured frame, match distances, Chrome presentation stats, dirty fractions vs the source |

`manifest.json` (here) has one entry per clip with `name, file, width, height,
fps, frames, duration_s, sha256, tags, description, text_regions, sideinfo,
capture{codec, dropped_frames, duplicated_frames, method, ...},
scroll_validation, generator{script, args}`. It also includes
`avg_dirty_fraction`, `cursor_check` and file pointers, plus a top-level
`lossless_check`. `text_regions` holds 2-4 screen-pixel rects with dense text,
taken from each page's `capTextRegions()` at capture start. It is empty for
`full_motion`, which has no text. `full_motion` also has `source_video`
(title, URL, sha256 hashes, segment, source range, licence and attribution)
and `playback_check` (the summary of `full_motion.playback.json`). Its
`capture` block adds `phase_lock` and `trim`.

Side info line:

```json
{"frame": 12, "t_ms": 400.1, "dirty": [[x,y,w,h], ...], "cursor": [x,y] | null,
 "scroll": [{"rect": [x,y,w,h], "dx": 0, "dy": -57, "id": "editor", "valid": true,
             "align": "latency", "match": 0.9993}]}
```

- `t_ms` is the capture wallclock relative to frame 0.
- `dirty` is the exact diff against the previous decoded frame. Frame 0 is the
  whole frame. Changed pixels mark 16x16 tiles. Each tile row is merged into
  horizontal runs, then runs are merged vertically when consecutive rows have
  the same x-extent. Rects are 16-aligned and clipped to the frame (the last
  1080p tile row is 8 px tall).
- `scroll` has one entry per tracked scroll container whose offset changed.
  `(dx, dy)` is the screen-pixel motion of the content inside `rect`, and `dy`
  is negative when content moves up. `valid` records whether the pixels confirm
  the vector, and is null when the jump exceeds the container (for example
  Ctrl+Home), so nothing overlaps.

`sideinfo.py` is reusable. Use `compute()` as a module, or the CLI:
`python3 sideinfo.py --video X.mkv --capture X.capture.json --events
X.events.jsonl --pointer X.pointer.jsonl --out X.sideinfo.jsonl`. It streams
`bgr0` frames from an ffmpeg pipe into numpy and makes two decode passes.

## How a capture works

1. Calibrate. Run a 120-frame `x11grab -framerate 1000` against the null muxer.
   The median frame gap gives the per-grab latency (0.5-1 ms at 1080p, ~2 ms at
   4K), and the first frame's wallclock gives ffmpeg's startup delay.
2. Launch Chrome with `launch_persistent_context(channel="chrome",
   headless=False, no_viewport=True, ignore_default_args=["--enable-automation"])`
   and `--kiosk --force-device-scale-factor=N --force-color-profile=srgb`, with
   background networking off and no infobars. There is no window manager, so
   `xdotool windowmove/windowsize` pins the window to exactly WxH, and the
   generator checks `[innerWidth, innerHeight, devicePixelRatio]`.
3. Get keyboard focus. Without a WM, Chrome reports `document.hasFocus()` but
   drops X key events until the first click. The generator calls
   `page.bring_to_front()`, then presses Shift through xdotool and waits for the
   page to see the keydown. If the page never sees it, the capture aborts.
4. Wait for `capReady` (fonts loaded, two rAFs). Then warp the pointer, run
   the clip's `prepare_js` and settle for 1.2-2.5 s.
5. Start `pointer_sampler.py` (240 Hz), then ffmpeg:

   ```
   ffmpeg -f x11grab -framerate FPS -video_size WxH -draw_mouse 1 -use_wallclock_as_timestamps 1 -i :99
          -copyts -fps_mode passthrough -enc_time_base:v demux -frames:v N
          -c:v libx264rgb -preset ultrafast -qp 0 -g 5*FPS -threads T
          -stats_enc_pre frames.txt -stats_enc_pre_fmt "{n} {tb} {pts}" -progress progress.txt raw.mkv
   ```

   ffmpeg and Xvfb are reniced to -10. The scenario thread starts at the
   expected first-frame instant. Pointer motion goes through XTest
   (`fake_input`): cubic Bezier paths with minimum-jerk timing at 120 Hz,
   Fitts-like durations and random curvature. The wheel uses buttons 4-7 (one
   notch is deltaY 120, smooth-scrolled by Chrome). Typing uses `xdotool type
   --delay N` with N drawn per word, plus punctuation and hesitation pauses.
   Keys use `xdotool key`. The main thread only pumps Playwright and answers
   the scenario's `page.evaluate` requests.
6. End cleanly. Scenarios stop 1.4 s before the clip ends: a step that would
   overrun raises `ScenarioOutOfTime`, logged as `scenario.truncated`, and all
   buttons and keys are released. ffmpeg stops by itself after exactly N frames.
7. Finalize. Check that the encoder saw N frames with strictly increasing
   wallclock. Then remux with `-c copy -bsf:v setts=ts=N/(FPS*TB)` to clean CFR
   pts, verify the packet count and size with ffprobe, and write the logs,
   events, side info, previews and manifest entry.

## Natural video (`full_motion`)

1. Source. `prepare_video()` downloads
   `bbb_sunflower_1080p_30fps_normal.mp4.zip` from download.blender.org into
   `$CAPCODEC_CACHE` once and checks the sha256 of the zip and the mp4. It then
   stream-copies 1325 frames from the keyframe at 16.3 s (`-c copy -an`, no
   re-encode) and checks every decoded segment frame against the matching
   source frame with framemd5. The clip starts at the shot cut at 27.467 s
   (segment frame 335). The 11 s before it leave room for phase locking.
2. Playback. `pages/video.html` holds `<video autoplay muted loop playsinline>`
   with no controls, sized 100vw x 100vh with `object-fit: cover`, so the
   1920x1080 source maps 1:1 onto the screen. The page sets `cursor: none`,
   the pointer is parked at (1919, 1079) and ffmpeg runs with `-draw_mouse 0`,
   so `cursor` is null in the side info. Chrome decodes in software. A
   `requestVideoFrameCallback` loop logs every presented frame as a
   `video_frame` page event (`media_time`, `presented_frames`,
   `expected_display`, `presentation`). `capReady` is set after 45 presented
   frames.
3. Phase lock. x11grab grabs on a fixed grid: its start time plus k/30 s. The
   start time is random to tens of ms, and pausing ffmpeg does not move the
   grid. A grid that sits next to Chrome's frame swaps catches single frames
   early or late, which shows up as a repeat followed by a skip.
   - Measurements (1000 fps probes): Chrome's presentation phase (expected
     display time E) drifts only ~1.6 ms over 40 s, and the framebuffer
     switches to the next frame 3.5-14 ms after E. Content matching shows
     that frame k is already on screen ~26 ms before E(k).
   - Locking: the generator launches the real capture command and reads the
     first 16 frames' wallclock pts from `-stats_enc_pre`. It accepts when
     the grid phase is E + 25 ± 4.5 ms, the middle of the safe window.
     Otherwise it kills ffmpeg by PID and relaunches.
   - If the cut gets closer than 2.5 s, playback restarts from 0. The
     attempts are recorded in `capture.json` under `phase_lock`.
   - Every thread of the Chrome instance is reniced to -10 as well, like
     ffmpeg and Xvfb. `renice -p` only affects one thread on Linux, so the
     generator walks `/proc/<pid>/task` for each Chrome process.
4. Trim. ffmpeg records the lead plus 900 + 45 frames. `trim_to_cut()` maps
   the raw frames around the predicted cut onto source frames (step 5) and
   keeps the first raw frame that shows the cut frame. Raw frames
   [first, first + 900) are decoded and re-encoded with libx264rgb `-qp 0`, and
   verified against the raw capture with framemd5 (bgr0). The steps from step 7
   of the capture flow follow.
5. Playback check (`playback.py`).
   - Matching: captured and source frames are area-downscaled to 480x270
     luma, high-passed (minus a 9x9 box blur), 2x2-averaged and normalised.
     Each captured frame is matched to a source frame by
     1 - normalised cross-correlation along a monotonic Viterbi path (offset
     band ±6, penalty 0.004 per offset change). This makes it insensitive to
     Chrome's YUV->RGB conversion. On a synthetic test with a deliberately
     wrong BT.601 conversion and 6 injected repeats and 6 skips per run,
     2699/2700 frames were mapped correctly.
   - `playback_check` reports the source frame steps, repeats and skips,
     match distances and Chrome's presentation stats: media-time steps,
     presented-frame steps and display intervals in vsyncs. It also reports
     `getVideoPlaybackQuality()` dropped frames (sampled every 5 s) and the
     per-frame dirty distribution.
   - It compares the captured dirty fraction with the source's own fraction
     of 16x16 tiles whose Y, U or V samples changed (`dirty_vs_source`).
6. Recapture. A run is clean when the check shows source frames 335..1234
   in steps of exactly 1, with no repeats, skips or dropped grabs. Otherwise
   the generator captures again, up to 3 runs in total
   (`SOURCE_CAPTURE_RUNS`). The rejected runs are summarised in
   `capture.json` under `capture_runs` and in the manifest's `capture.runs`.
   If the last run is still not clean, the clip is reported as failed.

## Timing method

All clocks are CLOCK_REALTIME: Python's `time.time()`, Chrome's `Date.now()`
and `performance.timeOrigin + performance.now()` (records carry both `t` in ms
and `tp` in sub-ms), and ffmpeg's `av_gettime()` behind
`-use_wallclock_as_timestamps`.

- Frame time comes from `-stats_enc_pre`, which gives each frame's wallclock
  pts in µs. `-enc_time_base:v demux` matters here: with the default 1/fps
  encoder time base, wallclock pts are rounded onto the frame grid, and the mkv
  itself only stores ms.
- Frame accounting:
  - `dropped_frames` counts missed capture slots: intervals over 1.5x nominal,
    each counted as `round(interval/nominal) - 1`.
  - `duplicated_frames` counts catch-up grabs: intervals under 0.5x nominal.
  - ffmpeg's own `dup_frames`/`drop_frames` from `-progress` are recorded too.
    They are 0 by construction with `-fps_mode passthrough`, which is why the
    interval-based numbers are the meaningful ones.
- Cursor: x11grab paints the pointer after grabbing the image, right before
  the wallclock pts is taken. `cursor` is the latest 240 Hz sample at or before
  `T_frame + C`. C is fitted per clip in [-12, +12] ms to maximise the fraction
  of moved frames whose hotspot tile is dirty at both the old and new position
  (it lands at 0 to +4 ms). The manifest `cursor_check` reports the
  chosen offset, the fraction at that offset and at 0, and how many frames
  moved.
- Scroll: pages report `scrollLeft/scrollTop` and the container rect on every
  scroll event and every rAF through an `expose_binding`. Offsets are converted
  to screen px (x DSF).
  - Pass 1 fits one global report-to-screen latency L in -70..70 ms. For each
    L, every resulting per-frame vector is checked against the pixels, and the
    plateau centre of (valid - invalid) wins.
  - Pass 2 walks the frames in order. For each container it uses the offset
    reported at `T - L` if the pixels confirm it (`align: "latency"`). If the
    container did not change on screen, it holds the previous offset.
    Otherwise it picks whichever other offset reported within ±1 frame the
    pixels confirm (`"realigned"`). If nothing fits, the latency value is kept
    with `valid: false`.
  - A vector is confirmed when the shifted previous frame matches at least 90%
    of the overlap and removes at least 75% of the mismatches of the unshifted
    comparison, or matches at least 99.95% of it. Cursor boxes (±34 px, ±60 at
    DSF 2) are masked out. The residual criterion exists because ±1 px
    shifts of mostly white pages still match about 95%.
  - `scroll_validation` reports the fraction over verifiable frames, the
    latency-only fraction, the align counts and L.

## Lossless check

`--verify-lossless` feeds one x11grab input, captured while the dashboard
animates at 1080p and while the 4K editor scrolls, into two outputs in the same
ffmpeg process: rawvideo NUT and libx264rgb `-qp 0`. It then compares the
`framemd5` of both decoded to bgr0, frame by frame. Results go to
`lossless_check.json` and to the manifest's `lossless_check`.

## Decisions

- libx264rgb `-preset ultrafast -qp 0` instead of FFV1. It is lossless for
  bgr0 sources (verified above) and keeps up in real time at 4K@30 and
  1080p@60 with 2-3 threads. It is also H.264, the format being benchmarked.
- No window manager: there are no decorations or focus quirks beyond the one
  handled by the keyboard-focus probe. The pointer is the default X/Chrome
  cursor as drawn by `-draw_mouse 1`.
- Text uses the VM's fontconfig defaults: RGB subpixel antialiasing with slight
  hinting, i.e. ClearType-like colour fringes, as on Windows or Linux
  desktops. macOS-style grayscale AA is not represented.
- The 4K clip uses device scale factor 2, so it has a HiDPI layout with 26px
  code rather than four times the content.
- `full_motion` plays the original stream without a pre-transcode. Chrome
  software-decodes 1080p30 H.264 High (~3 Mbit/s) under Xvfb with 0 dropped
  frames, and every media-time step is exactly one frame, both in a 40 s test
  and during the capture.
- The `full_motion` window was chosen by computing the per-frame changed-tile
  fraction for the whole film up to the credits (~512 s). 27.47-57.43 s is the
  best 30 s window by mean (0.949) and by 1st percentile (0.66). Every other
  window has near-static frames, because Big Buck Bunny has many locked-off
  shots whose static backgrounds H.264 reproduces bit-identically.
  - The first 12 s (a camera push-in over grass and foliage) average 0.996,
    and every frame there is >= 0.969 except frame 1. Source frame 336
    nearly repeats 335 right after the cut: only 8.6% of tiles change.
  - The dark burrow close-up and the meadow shot keep static regions
    (0.92 average, minimum 0.40), so the clip averages 0.949 rather than
    1.0. Per frame, the capture matches the source's own changed-tile
    fraction within 0.0011.
- Content sources: `difflib.py` comes from CPython (PSF License), `inflate.c`
  from zlib (zlib License), and the article text is adapted from the English
  Wikipedia "Typewriter" article (CC BY-SA 4.0). The docs, slides, board,
  dashboard and PDF content are original.
- `full_motion` contains a 30 s excerpt (27.47-57.43 s) of Big Buck Bunny, (c)
  copyright 2008, Blender Foundation / www.bigbuckbunny.org, licensed under
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). It uses the 2013
  "sunflower" 1080p 30 fps edition, unmodified apart from being played back
  and screen-captured.

## Limitations

- These are Chrome renderings of mock apps, not native apps. Compositor
  effects such as window shadows and blur are absent. Only `full_motion`
  covers video playback, and only full screen (no UI around it, no
  picture-in-picture or windowed video).
- Capture timing is real time on a shared 4-core VM. Each run reports missed
  slots and interval stdev; re-run a clip if `dropped_frames` > 0.
- `full_motion`: even when phase-locked, about one run in two shows a single
  repeat followed by a skip (roughly one event per 900 frames). Chrome's own
  counters stay clean (0 dropped, every presented-frame step 1). The cause is
  a late paint or an early buffer switch under CPU load, which the grab grid
  cannot avoid. The recapture step handles it.
- The cursor position comes from 240 Hz polling, so it is about ±4 ms
  uncertain. Fast moves can therefore be off by a few px on single frames.
  `cursor_check` quantifies this.
- Scroll vectors describe container offsets. Content that moves without a
  scroll offset is not reported as scroll: CSS push/cover slide transitions,
  the dashboard's chart shift, the events feed inserting rows, drag ghosts. A
  scroll entry can still have extra dirty content inside its rect (sticky
  headers, caret, hover, new terminal lines). Smooth-scroll frames rendered between two rAF
  reports are matched by realignment and are flagged when no reported offset
  fits.
- The docs page in `slow_typing` scrolls only ~31 px, so that clip has just a
  few scroll frames.
- `busy_ui_60fps` and `code_4k` are 20 s by spec, and their scenarios end about
  1-2 s early to guarantee a clean ending.
