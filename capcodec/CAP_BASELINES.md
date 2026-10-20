# Cap H.264 production encoding baselines

This file lists the exact H.264 encoder settings used by each Cap surface, so a benchmark harness can reproduce them on Linux.

## Sources and environment

| Item | Value |
|---|---|
| Cap repo | `/workspace` on branch `main`, commit `d327051c1` (read only) |
| PR 2312 | `FETCH_HEAD` = `549c5afa9` (`origin/feature/web-editor-desktop-parity`), read with `git show FETCH_HEAD:<path>` |
| Rust ffmpeg bindings | `ffmpeg-next`, CapSoftware fork rev `49db1fede112` |
| Verification ffmpeg | 6.1.1-3ubuntu5 |
| Verification libx264 | core 164 r3108 |
| Verification Chrome | Google Chrome 148.0.7778.96 at `/usr/local/bin/google-chrome`, headless |
| Verification CPU | `nproc` = 4 |

Line numbers refer to `main` unless marked "PR".

A value marked "verified" was observed in an encode on this VM, either in ffprobe output or in the x264 SEI options string. A value marked "source" was read from code but not run. Hardware encoders (VideoToolbox, NVENC, QSV, AMF, Media Foundation, AVFoundation) cannot run on this VM.

## Contents

0. Conventions and shared facts
1. Media server
2. Web app server-side ffmpeg
3. Render farm
4. Desktop recording
5. Desktop export
6. Web recorders on `main` (MediaRecorder)
7. Browser WebCodecs encoders on `main`
8. PR 2312 differences
9. Running browser surfaces in headless Chrome with Playwright
10. Ambiguities and assumptions
11. Summary table

---

## 0. Conventions and shared facts

### 0.1 Placeholders

| Placeholder | Meaning |
|---|---|
| `W`, `H` | Output width and height |
| `FPS` | Frame rate |
| `B` | Target bitrate in bit/s |
| `M` | maxrate, always `B * 3 / 2` with integer division where Cap sets it |
| `K` | Keyframe interval in frames |
| `N` | `nproc` |

All ffmpeg reproductions read raw input with:

```
-f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv
```

### 0.2 Shared bits-per-pixel (bpp) bitrate model

Desktop export, desktop recording through `enc-ffmpeg`, the render farm, and the PR browser export all use this model.

| Implementation | Location |
|---|---|
| `get_bitrate` | `crates/enc-ffmpeg/src/video/h264.rs` lines 1651-1658 |
| `bitrate` | `crates/render-farm/src/video.rs` lines 184-187 |
| `exportBitrate` (PR) | `packages/editor-solid-web/src/browser-export-estimate.ts` |

The formula is:

```
B = W * H * ((max(FPS - 30, 0) * 0.6) + 30) * bpp
M = B * 3 / 2        (Rust only: encoder.set_max_bit_rate(bitrate * 3 / 2))
```

How each implementation computes it:

- **Rust:** bpp is an `f32`, widened to `f64`, and the result is truncated to `usize`. That gives slightly odd values, for example 29,859,841.
- **PR browser export:** uses JavaScript `f64` with `Math.round`.

Worked values for the Rust model, shown as `B (M)`:

| bpp | 1280x720@30 | 1920x1080@30 | 1920x1080@60 | 3840x2160@30 |
|---|---|---|---|---|
| 1.0 | 27,648,000 (41,472,000) | 62,208,000 (93,312,000) | 99,532,800 (149,299,200) | 248,832,000 (373,248,000) |
| 0.3 | 8,294,400 (12,441,600) | 18,662,400 (27,993,600) | 29,859,841 (44,789,761) | 74,649,602 (111,974,403) |
| 0.18 | 4,976,640 (7,464,960) | 11,197,440 (16,796,160) | 17,915,904 (26,873,856) | 44,789,761 (67,184,641) |
| 0.15 | 4,147,200 (6,220,800) | 9,331,200 (13,996,800) | 14,929,920 (22,394,880) | 37,324,801 (55,987,201) |
| 0.08 | 2,211,839 (3,317,758) | 4,976,639 (7,464,958) | 7,962,623 (11,943,934) | 19,906,559 (29,859,838) |
| 0.04 | 1,105,919 (1,658,878) | 2,488,319 (3,732,478) | 3,981,311 (5,971,966) | 9,953,279 (14,929,918) |

Browser model (`Math.round`, `f64`), B only:

| bpp | 1280x720@30 | 1920x1080@30 | 1920x1080@60 | 3840x2160@30 |
|---|---|---|---|---|
| 0.3 | 8,294,400 | 18,662,400 | 29,859,840 | 74,649,600 |
| 0.15 | 4,147,200 | 9,331,200 | 14,929,920 | 37,324,800 |
| 0.08 | 2,211,840 | 4,976,640 | 7,962,624 | 19,906,560 |
| 0.04 | 1,105,920 | 2,488,320 | 3,981,312 | 9,953,280 |

### 0.3 Shared keyframe interval

`crates/enc-ffmpeg/src/video/h264.rs` lines 1223-1239:

```
DEFAULT_KEYFRAME_INTERVAL_SECS = 2
K = round(2 * FPS).max(1)
```

| FPS | K |
|---|---|
| 30 | 60 |
| 60 | 120 |

The render farm uses `fps * 2` with integer fps (`crates/render-farm/src/video.rs` line 473; keyframe secs = 2 at line 629). That gives the same values.

### 0.4 How Cap's x264 options reach libx264 (applies to every `enc-ffmpeg` and render-farm libx264 path)

Options are passed as an AVDictionary to `open_as_with`, which calls `avcodec_open2`. Keys that libx264/AVCodecContext does not recognise are silently left unconsumed and ignored.

| Key | Status |
|---|---|
| `preset`, `tune`, `crf`, `threads`, `bf`, `rc-lookahead`, `aq-mode`, `trellis`, `g`, `keyint_min` | Consumed |
| `b-adapt` | Ignored. The real option name is `b_strategy`. |
| `ref` | Ignored. The real option name is `refs`. |
| `subme` | Ignored. The real option name is `subq`. |
| `pix_fmt` | Ignored. It is not a codec option. |

Effect, verified from the x264 SEI string:

- The export/render-farm "fast" set produces `ref=1 subme=2`, which are the veryfast preset defaults. The intended `ref 2` never applies.
- `subme 2` and `trellis 0` happen to equal the veryfast defaults.
- `b-adapt` is irrelevant because `bf 0`.

Two more x264 behaviours, both verified:

- **`maxrate` is ignored.** Cap sets `rc_max_rate` (`M`) but never sets `rc_buffer_size`. x264 logs `VBV maxrate specified, but no bufsize, ignored`, so every Cap libx264 bitrate encode is plain ABR (`rc=abr`, no VBV).
- **`keyint_min` is clamped.** Cap sets `keyint_min = K`. x264 clamps it to `K/2 + 1`, so 60 becomes 31 and 120 becomes 61.

### 0.5 Shared `enc-ffmpeg` encoder context

Source: `crates/enc-ffmpeg/src/video/h264.rs` lines 775-816.

**Threading:** `threads = available_parallelism()` via `set_threading(Config::count(...))`.

**Colour tags:**
- colorspace BT709
- color_range MPEG (limited)
- color_primaries BT709
- color_trc BT709

**Rate control:**
- CRF mode: `bit_rate = 0`.
- Otherwise: `bit_rate = get_bitrate(out_w, out_h, fps, bpp)` and `max_bit_rate = bit_rate * 3 / 2`.

**Timing:**
- Encoder time base is the input `VideoInfo.time_base`.
- Muxer stream time base is `1/90000` (lines 286 and 413).

**Pixel format (lines 671-688):**
- Uses the input format if the encoder supports it.
- Otherwise YUV420P for libx264 and NV12 for the others.

**Scaler (lines 627-657):**
- BICUBIC when resizing, FAST_BILINEAR otherwise.
- RGB input uses BT.709 coefficients, full-range in, limited-range out.

**Encoder priority:**

| Platform | Order |
|---|---|
| macOS | `h264_videotoolbox`, `libx264` |
| Windows, NVIDIA GPU | `h264_nvenc`, `h264_mf`, `h264_qsv`, `h264_amf`, `libx264` |
| Windows, AMD GPU | `h264_amf`, `h264_mf`, `h264_nvenc`, `h264_qsv`, `libx264` |
| Windows, Intel GPU | `h264_qsv`, `h264_mf`, `h264_nvenc`, `h264_amf`, `libx264` |
| Windows, other or unknown GPU | `h264_nvenc`, `h264_qsv`, `h264_amf`, `h264_mf`, `libx264` |
| Windows, GPU without hardware encoding | `libx264` |
| Linux with `/dev/nvidiactl` present | `h264_nvenc`, `libx264` |
| Linux otherwise | `libx264` |

Sources: `get_default_encoder_priority` at lines 1133-1173 and `linux_encoder_priority` at lines 1124-1131.

**Priority overrides:**
- `CAP_EXPORT_FORCE_SOFTWARE_ENCODER` set to `1`, `true`, `yes` or `on` forces `libx264` (line 1192).
- `requires_software_encoder` (line 1062) never applies to exports. For recordings it forces `libx264` when:
  - the preset is `HighThroughput`, or
  - on macOS/Windows, FPS is above 0.9 times the estimated hardware maximum.
- A CRF request always forces `libx264` (line 1241).
- Windows export with an AMD GPU uses `h264_amf`, `h264_mf`, `h264_nvenc`, `h264_qsv`, `libx264` (lines 1201-1221).

**Fallback:** encoders are tried in priority order, and the first that opens is used.

### 0.6 Option sets per encoder

Source: `crates/enc-ffmpeg/src/video/h264.rs` lines 1258-1357, quoted literally.

**`h264_videotoolbox`**

| Mode | Options |
|---|---|
| Export | `realtime=false`, `profile=main`, `allow_sw=0` |
| Recording | `realtime=true`, `prio_speed=true`, `profile=main` |

No `g` is set in either mode.

**`h264_nvenc`**

| Mode | Options |
|---|---|
| Export | `preset=p5`, `tune=hq`, `rc=vbr`, `spatial-aq=1`, `temporal-aq=1`, `b_ref_mode=middle`, `g=K` |
| Recording | `preset=p4`, `tune=ll`, `rc=vbr`, `spatial-aq=1`, `temporal-aq=1`, `g=K` |

**`h264_qsv`**

| Mode | Options |
|---|---|
| Export | `preset=medium`, `look_ahead=1`, `look_ahead_depth=20`, `g=K` |
| Recording | `preset=faster`, `look_ahead=1`, `g=K` |

**`h264_amf`**

| Mode | Options |
|---|---|
| Export | `quality=quality`, `rc=vbr_peak`, `g=K` |
| Recording | `quality=balanced`, `rc=vbr_latency`, `g=K` |

**`h264_mf`**

| Mode | Options |
|---|---|
| Export | `hw_encoding=true`, `scenario=0`, `quality=0`, `g=K` |
| Recording | `hw_encoding=true`, `scenario=4`, `quality=1`, `g=K` |

**`libx264`**, which branch applies:

| Condition | Options |
|---|---|
| CRF requested | `preset=slow`, `crf=<crf>`, `pix_fmt=yuv420p` (ignored) |
| Export, preset Slow | `preset=slow` |
| Export, preset Medium | `preset=medium` |
| Export, any other preset | `preset=veryfast`, `threads=N`, `bf=0`, `rc-lookahead=10`, `b-adapt=0` (ignored), `aq-mode=1`, `ref=2` (ignored), `subme=2` (ignored), `trellis=0` |
| Recording, Slow or Medium | `preset=veryfast`, `tune=zerolatency` |
| Recording, Ultrafast or HighThroughput | `preset=ultrafast`, `tune=zerolatency` |

All `libx264` branches also set `g=K` and `keyint_min=K`.

### 0.7 VideoToolbox and NVENC defaults that Cap inherits (source: FFmpeg 7.1)

**VideoToolbox (`libavcodec/videotoolboxenc.c`):**
- `vt_defaults` only sets `b`, `qmin` and `qmax`, so `gop_size` keeps the AVCodecContext default of 12.
- Because Cap never sets `g` for VideoToolbox, `MaxKeyFrameInterval = 12` frames. This is not 2 s.
- `max_b_frames` defaults to 0, so `AllowFrameReordering = false` (no B-frames).
- `profile=main` maps to `kVTProfileLevel_H264_Main_AutoLevel`.
- `rc_max_rate` maps to `kVTCompressionPropertyKey_DataRateLimits` as `[M/8 bytes, 1 s]`.

**NVENC:**
- `g` is set by Cap.
- `bf` stays at -1, meaning the preset decides.
- `refs` stays at 0 (default).
- `rc-lookahead` and `bufsize` are not set by Cap.

### 0.8 Audio summary

| Surface | Audio |
|---|---|
| Media server processVideo | AAC 128k |
| Media server edit | AAC 160k |
| Render farm | AAC 320 kbps, 48 kHz |
| Desktop `enc-ffmpeg` | AAC 320 kbps |

The desktop value comes from `crates/enc-ffmpeg/src/audio/aac.rs` line 33: `OUTPUT_BITRATE: usize = 320 * 1000; // 128k`. The trailing comment is stale.

---

## 1. Media server (`apps/media-server`)

Image: `apps/media-server/Dockerfile` uses `FROM oven/bun:1.4.0` plus apt `ffmpeg`, with no version pinned.

### 1.1 MS-TRANSCODE: `processVideo` video transcode

**Location:** `apps/media-server/src/lib/media-video.ts`.

| Lines | What |
|---|---|
| 162-172 | `DEFAULT_OPTIONS` |
| 47-50 | Level size constants |
| 1288-1302 | `needsVideoTranscode` |
| 1304-1306 | `needsAudioTranscode` |
| 1405-1420 | `pickMobileSafeH264Level` |
| 1483-1581 | `processVideo` |

**Constants resolved from `DEFAULT_OPTIONS`:**

| Option | Value |
|---|---|
| maxWidth | 1920 |
| maxHeight | 1080 |
| crf | 23 |
| preset | `"medium"` |
| audioBitrate | `"128k"` |
| videoBitrate | `"5M"` (defined, never used in any argument) |
| remuxOnly | false |
| normalizeH264Level | false |

**Literal argument vector when `videoTranscode` is true:**

```
ffmpeg -threads 2 [extraInputArgs] -i <in>
  -c:v libx264 -preset medium -crf 23
  -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"
  -pix_fmt yuv420p -level:v <4.2|5.1|5.2>
  [-bf 0]                                  # only when source codec is vp8 or vp9
  <-c:a aac -b:a 128k | -c:a copy | -an>
  -movflags +faststart [extraOutputArgs] -progress pipe:2 -y <out>.mp4
```

**When it runs.** `needsVideoTranscode` is true when any of these hold:

- source width > maxWidth, or height > maxHeight
- the codec is not `h264`
- the probed source H.264 level is above the target level

**Level choice** (`pickMobileSafeH264Level`) uses the target size `(min(srcW, maxW), min(srcH, maxH))`:

| Target size | Level |
|---|---|
| ≤2048x1088 | `4.2` |
| ≤4096x2304 | `5.1` |
| Larger | `5.2` |

With the defaults every transcode is level 4.2.

**Callers:**

| Caller | Options passed | Effect |
|---|---|---|
| Web workflows (`process-video.ts`, admin reprocess) | No size or quality options | Defaults apply: a 1080p cap, level 4.2 |
| `/video/convert` (`routes/video.ts` line 594) | Source dimensions as max | No downscale; 4K gets level 5.1 |
| Multipart (`multipart.ts` line 977) | `remuxOnly: true` for web MP4 | Video and audio copied |

**Audio:**
- Source audio is AAC: `-c:a copy`.
- Other source audio: `-c:a aac -b:a 128k`.
- No audio: `-an`.

**Resilient mode.** The retry path adds these flags, built at `routes/video.ts` lines 842-847:

| Position | Flags |
|---|---|
| Input | `-err_detect ignore_err -fflags +genpts+discardcorrupt` |
| Output | `-max_muxing_queue_size 1024` |

**Encoder settings:**

| Setting | Value |
|---|---|
| Encoder | libx264 |
| Rate control | CRF 23. No bitrate cap or VBV. |
| GOP | x264 defaults: keyint 250, keyint_min 25, scenecut 40 (verified) |
| B-frames, VP8/VP9 source | `-bf 0` (verified bframes=0) |
| B-frames, other sources | x264 medium default bframes=3 |
| Preset / tune | `medium`, no tune |
| x264 internals at medium | ref=3, subme=7, trellis=1, rc_lookahead=40 (verified) |
| Profile | High (x264 automatic, verified) |
| Level | Forced by `-level:v` (verified 42) |
| Pixel format | yuv420p |

**Threads.** `-threads 2` is placed before `-i`, so it applies to the decoder only. The encoder uses ffmpeg's automatic count: verified threads=6 on 4 cores.

**Colour.** No colour options are set, so tags are passed through from the decoder. Untagged sources stay untagged.

**Scaling:**
- First: fit inside 1920x1080, preserving aspect ratio, never upscaling.
- Then: round both dimensions down to even.
- Scaler flags: swscale default (bicubic).

**Frame rate:**
- No `-r`, no fps filter, no `-fps_mode`/`-vsync`.
- The ffmpeg CLI `fps_mode auto` picks CFR for the MP4 muxer, so VFR browser captures are duplicated/dropped to the rate ffmpeg guesses for the input.
- Verified: a VFR WebM tagged 30/1 came out as 90 frames at 30/1.

**Container:** MP4 with `+faststart`. Audio, when transcoded, is AAC 128k.

**Reproduction on Linux (verified):**

```
ffmpeg -y -threads 2 -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -c:v libx264 -preset medium -crf 23 \
  -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -pix_fmt yuv420p -level:v 4.2 -an -movflags +faststart ms_transcode.mp4
```

- **MS-TRANSCODE-VPX:** add `-bf 0` before `-an`. This is the variant that applies to Chrome WebM recordings on `main`.
- **3840x2160 input:** with default options, the output is 1920x1080 at level 4.2.

### 1.2 MS-LEVELFIX: level rewrite without re-encode (dormant)

**Location:** `media-video.ts` lines 1533-1539.

```
ffmpeg -threads 2 -i <in> -c:v copy -bsf:v h264_metadata=level=<4.2|5.1|5.2> ... -movflags +faststart -progress pipe:2 -y <out>
```

It runs only when `opts.normalizeH264Level` is true and the source fits inside the size limits with a level above the target. No caller sets `normalizeH264Level`, so this is not reached in production. A too-high level instead causes a full MS-TRANSCODE.

### 1.3 Other media-server ffmpeg invocations (no H.264 encode)

**Copy path:** `-c:v copy` in `processVideo`, used for H.264 sources within the size and level limits.

**Container repair** (`media-video.ts` lines 1325-1361):

```
ffmpeg -threads 2 -err_detect ignore_err -fflags +genpts+igndts -i <in> -c copy -y <out>.mkv
```

**Edit concat** (`media-edit.ts` `buildConcatArgs`, line 207):

```
ffmpeg -hide_banner -y -f concat -safe 0 -i <list> -map 0 -c copy -movflags +faststart <out>
```

**Unused:** `buildTranscodeSegmentArgs` and `buildStreamCopySegmentArgs` in `media-edit.ts` have no callers.

### 1.4 MS-EDIT: edited-video render (`renderEditedVideo`)

**Location:** `apps/media-server/src/lib/media-edit.ts`.

| Lines | What |
|---|---|
| 83-87 | `getOutputFps` |
| 151-205 | `buildTranscodeEditArgs` |
| 446-469 | `renderEditedVideo` |

It is called from `routes/video.ts` line 1168.

**Inputs and constants:**
- `fps` is the probed `metadata.fps`.
- `getOutputFps(fps) = min(120, max(1, round(fps*100)/100))`, or `DEFAULT_OUTPUT_FPS` = 30 when fps is missing or invalid.
- Up to `MAX_TRANSCODE_RANGES_PER_BATCH` = 4 ranges per ffmpeg run. Multiple batches are joined by the concat copy in section 1.3.

**Literal arguments:**

```
ffmpeg -hide_banner -y
  (-ss <start> -t <dur> -i <in>) x ranges
  -filter_complex "[i:v:0]fps=F,setpts=PTS-STARTPTS[vi];[i:a:0]asetpts=PTS-STARTPTS[ai];...;[v0][a0]...concat=n=R:v=1:a=1[v][a]"
  -map [v] -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -enc_time_base:v 1/F
  (-map [a] -c:a aac -b:a 160k | -an)
  -movflags +faststart <out>
```

Without audio, each video filter is `[i:v:0]fps=F,setpts=PTS-STARTPTS[vi]` and the concat is `concat=n=R:v=1:a=0[v]`.

**Encoder settings:**

| Setting | Value |
|---|---|
| Encoder | libx264 |
| Rate control | CRF 18 |
| GOP | x264 default keyint 250, min 25 |
| B-frames | x264 fast default bframes=3, b_adapt=1 (verified has_b_frames=2) |
| Preset / tune | `fast`, no tune |
| x264 internals at fast | ref=2, subme=6, rc_lookahead=30 (verified) |
| Profile | High (verified) |
| Level | x264 automatic (verified 3.1 at 720p30) |
| Pixel format | yuv420p |
| Colour | Passed through from input |

**Frame rate:** CFR at `F`, enforced by the `fps` filter, with `-enc_time_base:v 1/F`.

**Container and audio:** MP4 with `+faststart`; AAC 160k.

**Reproduction on Linux** (single range, no audio, exactly the filter string the code builds; verified):

```
ffmpeg -hide_banner -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -filter_complex "[0:v:0]fps=FPS,setpts=PTS-STARTPTS[v0];[v0]concat=n=1:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -enc_time_base:v 1/FPS \
  -an -movflags +faststart ms_edit.mp4
```

---

## 2. Web app server-side ffmpeg

### 2.1 WEB-LOOM-FFMPEG: Loom download conversion

**Location:** `apps/web/lib/video-convert.ts`, used by `app/api/tools/loom-download/route.ts`.

It first tries a remux (line 212):

```
ffmpeg -y -i <url> -c copy -movflags +faststart <out>
```

If the remux fails, it re-encodes (line 223):

```
ffmpeg -y -i <url> -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart <out>
```

**Encoder settings:**

| Setting | Value |
|---|---|
| Rate control | CRF 23 (libx264 default, no `-crf` given) |
| GOP | 250/25 |
| B-frames | veryfast default bframes=3 (verified has_b_frames=2) |
| Profile / level | High, automatic level (verified 3.1 at 720p30) |
| Frame rate | CLI auto, so CFR for MP4 |
| Colour | Passed through |
| Container | MP4 `+faststart` |
| Audio | AAC 128k |

**Reproduction on Linux (verified):**

```
ffmpeg -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -an -movflags +faststart web_loom_ffmpeg.mp4
```

---

## 3. Render farm

### 3.1 Runtime configuration

**Location:** `apps/render-farm/Dockerfile`.

- Base image: Debian trixie, using Debian's ffmpeg.
- Lines 47-49:
  ```
  ENV RF_ENCODER=h264_nvenc
  ENV RF_NVENC_PRESET=p1
  ENV RF_REQUIRE_GPU=1
  ```

**Encoder selection and fallback:**
- In code, `RF_ENCODER` defaults to `"libx264"` (`crates/render-farm/src/video.rs` line 425). Production sets NVENC through the Dockerfile.
- There is no automatic NVENC to libx264 fallback.
- If NVENC is unavailable, `find_by_name` fails (`"{encoder_name} unavailable"`).
- `RF_REQUIRE_GPU` checks at `video.rs` lines 257 and 364 fail fast without a GPU.
- libx264 is used only when `RF_ENCODER` is overridden.

**Job defaults** (`apps/render-farm/src/coordinator.ts` lines 374-384):

| Field | Value |
|---|---|
| compression | `Maximum` |
| fps | 30 |
| resolution | `[1920, 1080]` |
| Worker threads per task | 8 (line 1067) |

**Compression map** (`apps/render-farm/src/protocol.ts` `COMPRESSION_BPP`):

| Compression | bpp |
|---|---|
| Maximum | 0.3 |
| Social | 0.15 |
| Web | 0.08 |
| Potato | 0.04 |

### 3.2 RF-RENDER-NVENC and RF-RENDER-X264: chunked render encode

**Location:** `crates/render-farm/src/video.rs` `encode`, lines 415-512.

**Common settings, both encoders:**

| Setting | Value |
|---|---|
| Input pixel format | NV12, or CUDA surfaces when NVENC and the renderer produced GPU frames (Linux) |
| Time base | `1/fps` |
| Frame rate | `fps/1` (CFR; frame-numbered) |
| Colour | BT709 colorspace, MPEG (limited) range, BT709 primaries, BT709 trc |
| Bitrate | `bit_rate = bitrate(W, H, fps, bpp)`, `max_bit_rate = B * 3 / 2` |
| Flags | `GLOBAL_HEADER` |
| K | `fps * 2` |

**NVENC dictionary (production):**

| Option | Value |
|---|---|
| preset | `RF_NVENC_PRESET` or `"p1"` |
| tune | `RF_NVENC_TUNE` or `"hq"` |
| rc | `constqp` with `qp=0` if tune is `"lossless"`, otherwise `vbr` |
| spatial-aq | `RF_NVENC_SAQ` or `"1"` |
| temporal-aq | `RF_NVENC_TAQ` or `"1"` |
| bf | `0` |
| g | K |
| forced-idr | `1` |

NVENC does not get the thread setting.

**libx264 dictionary (override only):**

| Option | Value |
|---|---|
| preset | `veryfast` |
| threads | `8` |
| bf | `0` |
| rc-lookahead | `10` |
| b-adapt | `0` (ignored) |
| aq-mode | `1` |
| ref | `2` (ignored) |
| subme | `2` (ignored) |
| trellis | `0` |
| g | K |
| keyint_min | K |

The context threading count is also 8.

**Rate control:**
- NVENC: VBR with average B and max M. bufsize is not set, so NVENC's default VBV applies.
- libx264: ABR at B, maxrate ignored (verified `rc=abr bitrate=8294` at 720p30, Maximum).

**GOP:**
- NVENC: K with forced IDR. Each HLS segment of `round(fps*2)` frames is one GOP.
- libx264: keyint K, keyint_min clamped to K/2+1 (verified 60/31), scenecut 40, no B-frames.

**Profile and level:**
- NVENC: not set, so the encoder picks it. The preset decides profile; High is expected.
- libx264: High, automatic level (verified High).

**Container.** The farm writes its own boxes rather than using ffmpeg's muxer:

- **MP4** (`apps/render-farm/src/mp4.ts`):
  - `buildHeader` (line 654) writes `ftyp` (major `isom`, minor `0x200`, brands `isom iso2 avc1 mp41`), then `moov`, `free`, `mdat`. The moov is up front.
  - Video timescale is `fps*1000` and sample delta is 1000 (CFR).
  - The `avc1` entry (line 584) carries `colr nclx 1/1/1/0` and `pasp`.
- **HLS** (`RF_HLS` is on unless it is `"0"`; `RF_HLS_SEGMENT_SECONDS` defaults to 2; `coordinator.ts` lines 94-95):
  - Segments are fMP4 with `init.mp4` (line 1981) plus `styp+moof+mdat` `.m4s` files.
  - Segment keys are `${prefix}/c${chunk}-p${firstPart}-${index}.m4s` (`hls.ts` line 40).
  - `segmentFrames = round(fps*2)` (line 1087).
  - The playlist (`fmp4.ts` lines 267-285) has `#EXT-X-VERSION:7`, `#EXT-X-TARGETDURATION:<HLS_SEGMENT_SECONDS+2>` = 4, `#EXT-X-MEDIA-SEQUENCE:0`, `#EXT-X-PLAYLIST-TYPE:EVENT`, `#EXT-X-INDEPENDENT-SEGMENTS`, `#EXT-X-MAP`, `#EXTINF:<toFixed(3)>` and `#EXT-X-ENDLIST`.

**Audio:** AAC at 320,000 bit/s and 48,000 Hz (`crates/render-farm/src/audio.rs`).

**Worked bitrates at Maximum (bpp 0.3):**

| Resolution | B | M |
|---|---|---|
| 1920x1080@30 (job default) | 18,662,400 | 27,993,600 |
| 1920x1080@60 | 29,859,841 | 44,789,761 |
| 1280x720@30 | 8,294,400 | |
| 3840x2160@30 | 74,649,602 | |

Other compressions follow the table in section 0.2.

**Reproduction on Linux.**

RF-RENDER-X264 (verified; the x264 SEI matches `ref=1 subme=2 trellis=0 threads=8 keyint=60 keyint_min=31 rc_lookahead=10 rc=abr bitrate=8294`):

```
ffmpeg -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -pix_fmt nv12 -c:v libx264 -preset veryfast -threads 8 -b:v B -maxrate M \
  -bf 0 -rc-lookahead 10 -aq-mode 1 -trellis 0 -g K -keyint_min K \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -an -movflags +faststart rf_render_x264.mp4
```

- `-maxrate` is included because the production code sets it. It has no effect without `-bufsize`.
- The farm's own MP4 writer is approximated with `-movflags +faststart` (moov first).

HLS approximation (verified to produce `#EXT-X-VERSION:7`, `PLAYLIST-TYPE:EVENT`, `INDEPENDENT-SEGMENTS`, `EXT-X-MAP init.mp4`). Replace the last line of the previous command with:

```
  -f hls -hls_time 2 -hls_segment_type fmp4 -hls_playlist_type event \
  -hls_fmp4_init_filename init.mp4 -hls_flags independent_segments out/rf.m3u8
```

This approximation differs from production in two ways:
- ffmpeg writes TARGETDURATION 2, while the farm writes 4.
- Segment names differ.

RF-RENDER-X264-INTENDED is not production. It shows what the dictionary was meant to do: add `-refs 2 -subq 2 -b_strategy 0`.

RF-RENDER-NVENC cannot run on this VM. On an NVIDIA host:

```
ffmpeg -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -pix_fmt nv12 -c:v h264_nvenc -preset p1 -tune hq -rc vbr -b:v B -maxrate M \
  -spatial-aq 1 -temporal-aq 1 -bf 0 -g K -forced-idr 1 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -an -movflags +faststart rf_render_nvenc.mp4
```

### 3.3 RF-TRANSCODE: source preparation before rendering

**Location:** `apps/render-farm/src/transcode.ts`.

| Lines | What |
|---|---|
| 7-49 | `transcodeArgs` |
| 56 | `MAX_REMUX_KEYFRAME_GAP_SECONDS = 4` |
| 77-111 | `canRemux` |
| 113 | `remuxArgs` |

`worker.ts` line 705 sets `TRANSCODE_ENCODER = process.env.RF_TRANSCODE_ENCODER ?? "h264_nvenc"`. `keyframeSeconds` is `TRANSCODE_KEYFRAME_SECONDS = 1` (`coordinator.ts` line 1551).

**Remux path.** It is used when `canRemux` is true:
- codec h264
- `yuv420p`
- `has_b_frames=0`
- every packet has pts == dts
- keyframe gaps ≤ 4 s, including the tail

```
ffmpeg -hide_banner -nostdin -y -loglevel error -progress pipe:1 -nostats -i <in> -map 0:v:0 -an -c:v copy -movflags +faststart <out>
```

**Transcode path, literal** (with `keyframeSeconds = 1`):

```
ffmpeg -hide_banner -nostdin -y -loglevel error -progress pipe:1 -nostats
  [-hwaccel cuda]                          # NVENC only
  -i <in> -map 0:v:0 -an -fps_mode passthrough -pix_fmt yuv420p -c:v <encoder>
  NVENC:   -preset p1 -rc vbr -cq 19 -b:v 0
  libx264: -preset veryfast -crf 18
  -bf 0 -force_key_frames "expr:gte(t,n_forced*1)"
  [-forced-idr 1]                          # NVENC only
  -movflags +faststart <out>
```

**Encoder settings:**

| Setting | NVENC (production default) | libx264 |
|---|---|---|
| Rate control | Constant-quality VBR, `-cq 19`, `-b:v 0` | CRF 18 |
| Preset | p1 | veryfast |
| Keyframes | Forced every 1 s, as IDR | Forced every 1 s, on top of x264 keyint 250 / min 25 / scenecut 40 |
| B-frames | None | None |

- **Profile and level:** encoder automatic. libx264 verified High.
- **Frame rate:** `-fps_mode passthrough` keeps the source VFR timestamps.
- **Colour:** passed through.
- **Container:** MP4 `+faststart`, video only.
- **Hardware decode:** `-hwaccel cuda` decodes on the GPU but frames are downloaded (no `-hwaccel_output_format`), so `-pix_fmt yuv420p` applies.

**Reproduction on Linux.**

RF-TRANSCODE-X264 (verified keyframes at 0, 1, 2 s, bframes=0, High):

```
ffmpeg -hide_banner -nostdin -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -map 0:v:0 -an -fps_mode passthrough -pix_fmt yuv420p -c:v libx264 -preset veryfast -crf 18 \
  -bf 0 -force_key_frames "expr:gte(t,n_forced*1)" -movflags +faststart rf_transcode_x264.mp4
```

RF-TRANSCODE-NVENC cannot run on this VM:

```
ffmpeg -hide_banner -nostdin -y -hwaccel cuda -i in.mp4 -map 0:v:0 -an -fps_mode passthrough \
  -pix_fmt yuv420p -c:v h264_nvenc -preset p1 -rc vbr -cq 19 -b:v 0 -bf 0 \
  -force_key_frames "expr:gte(t,n_forced*1)" -forced-idr 1 -movflags +faststart rf_transcode_nvenc.mp4
```

---

## 4. Desktop recording

### 4.1 Common facts

**Defaults** (`crates/recording/src/defaults.rs`):

| Constant | Value |
|---|---|
| `DEFAULT_STUDIO_MAX_FPS` | 60 |
| `CAMERA_ACTIVE_STUDIO_MAX_FPS` | 30 |
| `DEFAULT_INSTANT_MODE_FPS` | 30 |
| `FREE_INSTANT_MODE_MAX_RESOLUTION` | 1280 |
| `PRO_INSTANT_MODE_MAX_RESOLUTION` | 1920 |
| `DEFAULT_CRASH_RECOVERY_RECORDING` | true, so fragmented recording is the default |
| `DEFAULT_OUT_OF_PROCESS_MUXER` | false |

- Default studio quality is `Compatibility` if total RAM is under 16 GiB, else `Balanced`. `Ultra` is opt-in.
- Instant mode clamps the output to fit `(max, max*9/16)`: 1280x720 for free users, 1920x1080 for Pro (`instant_recording.rs` lines 719-734).

**Timestamps (all `enc-ffmpeg` recording paths):**
- `VideoInfo.time_base = 1/1_000_000` (`crates/media-info/src/lib.rs` lines 47, 58, 89).
- `update_pts` (`crates/enc-ffmpeg/src/base.rs` lines 76-104) sets `pts = round(capture_ts_secs * 1e6) - first_pts`.
- So output is VFR, following capture timestamps.
- `frame_rate` is the capture rate. It is used only for bitrate and K.

**Fragmented container.** `SegmentedVideoEncoder` (`crates/enc-ffmpeg/src/mux/segmented_stream.rs` lines 195-240) uses the ffmpeg `dash` muxer writing `dash_manifest.mpd`:

| Muxer option | Value |
|---|---|
| `init_seg_name` | `init.mp4` |
| `media_seg_name` | `segment_$Number%03d$.m4s` |
| `seg_duration` | `<secs>` |
| `use_timeline` | `1` |
| `use_template` | `1` |
| `single_file` | `0` |
| `hls_playlist` | `1` |

Output files, verified: `init.mp4`, `segment_001.m4s`, ..., `master.m3u8`, and `media_0.m3u8` (`#EXT-X-VERSION:6` with `PROGRAM-DATE-TIME`).

### 4.2 Linux (X11 capture)

**Location:** `crates/recording/src/capture_pipeline.rs` lines 374-430, and `crates/recording/src/output_pipeline/ffmpeg.rs`.

**Studio:** `SegmentedVideoMuxer`, 2 s segments, preset `Medium` when quality is Ultra, otherwise `Ultrafast`.

**Instant:** `SegmentedVideoMuxer`, 2 s segments, preset `Ultrafast`, output size clamped as in section 4.1.

**bpp is always 0.3.** `start_encoder` (`ffmpeg.rs` lines 648-672) hardcodes `bpp: H264EncoderBuilder::QUALITY_BPP` (0.3) for every quality and for instant mode. Instant mode does not use 0.15 here, unlike macOS and Windows. `prefer_videotoolbox_hw_input` is false.

**Camera:** `SegmentedVideoMuxer` with a 3 s segment (line 825). The muxer default is 3 s (line 471).

**Encoder:** `/dev/nvidiactl` present gives `h264_nvenc` (recording set: p4, ll, vbr, AQ, `g=K`), otherwise `libx264`.

**libx264 settings:**

| Quality | Preset / tune |
|---|---|
| Balanced or Compatibility | `ultrafast` + `zerolatency` |
| Ultra (preset Medium) | `veryfast` + `zerolatency` |

| Setting | Value |
|---|---|
| Rate control | ABR at B (bpp 0.3), maxrate ignored |
| GOP | keyint K, keyint_min clamped to K/2+1 |
| Scenecut | 0 (zerolatency) |
| B-frames | None |
| Pixel format | yuv420p, converted from capture format by swscale (BT.709, full-range in, limited out) |
| Colour | BT.709 tags |

**Verified ultrafast/zerolatency output at 720p30:**
- Constrained Baseline, level 3.2
- `cabac=0 ref=1 subme=0 trellis=0 8x8dct=0 sliced_threads=1 bframes=0 keyint=60 keyint_min=31 scenecut=0 rc=abr mbtree=0 aq=0`

**Worked B at bpp 0.3:**

| Resolution | B |
|---|---|
| 1280x720@30 | 8,294,400 |
| 1920x1080@30 | 18,662,400 |
| 1920x1080@60 | 29,859,841 |
| 3840x2160@30 | 74,649,602 |

K is 60 at 30 fps and 120 at 60 fps.

**Audio:** AAC 320 kbps via `enc-ffmpeg`.

**Reproduction on Linux.**

DESK-REC-X264 (verified):

```
mkdir -p out && ffmpeg -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -c:v libx264 -preset ultrafast -tune zerolatency -threads N -b:v B -maxrate M -g K -keyint_min K \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -an \
  -f dash -seg_duration 2 -use_timeline 1 -use_template 1 -single_file 0 -hls_playlist 1 \
  -init_seg_name init.mp4 -media_seg_name 'segment_$Number%03d$.m4s' out/dash_manifest.mpd
```

DESK-REC-X264-ULTRA: the same command with `-preset veryfast`. B stays at bpp 0.3 on Linux.

Difference from production: the raw input is CFR. Production uses VFR capture timestamps in a 1/1e6 time base.

### 4.3 macOS (cannot run on this VM)

**Fragmented studio (default)** (`capture_pipeline.rs` lines 113-226):

- Muxer: `MacOSFragmentedM4SMuxer`, or the out-of-process muxer when enabled. Both use `SegmentedVideoEncoder`.
- `prefer_videotoolbox_hw_input` is true for screen (`macos_fragmented_m4s.rs` line 295) and false for camera (line 682).
- Defaults (lines 185-187): 2 s segments, `Ultrafast`, bpp 0.3.

| Quality | bpp | Preset |
|---|---|---|
| Ultra | 1.0 | Medium |
| Compatibility | 0.15 | Ultrafast |
| Balanced | 0.3 | Ultrafast |

**DESK-REC-VT** (`h264_videotoolbox`, recording set):

| Setting | Value |
|---|---|
| Options | `realtime=true`, `prio_speed=true`, `profile=main` |
| Bitrate | B; `DataRateLimits` = M/8 bytes per 1 s |
| GOP | 12 frames (FFmpeg default; Cap sets no `g`) |
| B-frames | None (frame reordering off) |
| Level | Main AutoLevel |
| Input | NV12 hardware surfaces, no scaling |
| Colour | BT.709 tags |
| Fallback | libx264 (section 0.6 recording set) when VideoToolbox fails to open or fps exceeds 0.9 times the estimated VideoToolbox maximum |

Platform command (not runnable here):

```
ffmpeg -f rawvideo -pix_fmt nv12 -s WxH -r FPS -i in.nv12 -c:v h264_videotoolbox -realtime true -prio_speed true -profile:v main -b:v B -maxrate M -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv out.mp4
```

Production passes no `-g`, so the ffmpeg CLI default `gop_size` (12) also applies here.

**Non-fragmented studio:** `AVFoundationMp4Muxer` (`crates/recording/src/output_pipeline/macos.rs` lines 326-352) builds `cap_enc_avfoundation::MP4Encoder` (`crates/enc-avfoundation/src/mp4.rs`).

| Setting | Value |
|---|---|
| Settings base | `OutputSettingsAssistant::with_preset(h264_3840x2160)` (line 251) |
| Output height | `ensure_even(output_height or source height)` |
| Output width | Proportional, even (lines 260-268) |
| Bitrate | `AVVideoAverageBitRateKey` from the formulas below |
| `AVVideoAllowFrameReorderingKey` | `ultra && !instant` |
| `AVVideoExpectedSourceFrameRateKey` | fps |
| `AVVideoMaxKeyFrameIntervalKey` | `floor(0.75 * fps).max(1)` |
| Colour | `ITU_R_709_2` for transfer, primaries and matrix (lines 325-339) |
| Writer | `expects_media_data_in_real_time` true |
| Profile, level, entropy coding | AVFoundation defaults |

Bitrate formulas (lines 1070-1109), with `pixels = W*H` and `f = min(fps, 60)/30`:

| Profile | Formula |
|---|---|
| Balanced | `max(pixels*f*5, 8,000,000)` |
| Ultra | `clamp(pixels*f*10, 8,000,000, 120,000,000)` |
| Compatibility | `clamp(pixels*f*2.5, 2,500,000, 10,000,000)` |
| Instant | `1,500,000 + pixels/(1920*1080)*1,500,000 + f*500,000` |

Worked values:

| Profile | 1280x720@30 | 1920x1080@30 | 1920x1080@60 | 3840x2160@30 |
|---|---|---|---|---|
| Balanced | 8,000,000 | 10,368,000 | 20,736,000 | 41,472,000 |
| Ultra | 9,216,000 | 20,736,000 | 41,472,000 | 82,944,000 |
| Compatibility | 2,500,000 | 5,184,000 | 10,000,000 | 10,000,000 |
| Instant | 2,666,666 | 3,500,000 | 4,000,000 | 8,000,000 |

Keyframe interval: 22 at 30 fps, 45 at 60 fps.

**Instant mode:**
- Screen: `MacOSFragmentedM4SMuxer` with bpp 0.15 through VideoToolbox, 2 s segments.
- Camera-only instant: AVFoundation `init_instant_mode` (instant formula, no reordering).

**Studio camera:** `AVFoundationCameraMuxer` (`macos.rs` lines 973-995), using the Compatibility profile when the compatibility flag is set, otherwise Balanced. Reordering is off.

AVFoundation reproduction is a platform API (`AVAssetWriter` with the keys above). There is no ffmpeg equivalent.

### 4.4 Windows (cannot run on this VM)

**Fragmented studio (default)** (`capture_pipeline.rs` lines 247-369, `win_fragmented_m4s.rs`):

- `SegmentedVideoEncoder` with 2 s segments (line 232). The camera uses 3 s (line 659).
- Hardware input is false.

| Quality | bpp | Preset |
|---|---|---|
| Ultra | 1.0 | Medium |
| Other | 0.3 | Ultrafast |

The encoder follows the Windows priority in section 0.5, with the recording option sets from section 0.6.

NVENC example (platform command):

```
ffmpeg ... -c:v h264_nvenc -preset p4 -tune ll -rc vbr -spatial-aq 1 -temporal-aq 1 -g K -b:v B -maxrate M -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -f dash ...
```

**Instant:** 2 s segments, `Ultrafast`, bpp 0.15.

**Non-fragmented studio:** `WindowsMuxer` (`output_pipeline/win.rs`).

| Setting | Value |
|---|---|
| `frame_rate` | 30 |
| `bitrate_multiplier` | 0.3 for Ultra, else 0.15 |
| `fragmented` | false |
| `frag_duration_us` | 2,000,000 |

- Encoder: `cap_enc_mediafoundation::H264Encoder` (`crates/enc-mediafoundation/src/video/h264.rs`).
  - `MF_MT_AVG_BITRATE` (line 359) = `calculate_bitrate` (lines 693-696): `W*H*((max(fps-30,0)/2)+30)*multiplier`, with fps 30.
  - `MF_MT_FRAME_RATE` = `frame_rate/1` (line 366).
  - No GOP, profile or rate-control mode is set, so these are Media Foundation transform defaults.
- Frame pacing at `1/frame_rate` (`win.rs` line 340) gives CFR at 30 fps.

Worked MF bitrates (fps fixed at 30):

| Multiplier | 1280x720 | 1920x1080 | 1920x1080 (60 fps capture) | 3840x2160 |
|---|---|---|---|---|
| 0.3 | 8,294,400 | 18,662,400 | 18,662,400 | 74,649,600 |
| 0.15 | 4,147,200 | 9,331,200 | 9,331,200 | 37,324,800 |

**Software fallback** (`win.rs` lines 229-243): `H264Encoder::builder(video_config)` with builder defaults (bpp 0.3, `Ultrafast`, recording mode, default priority). It is used when:
- software is forced
- the primary GPU is AMD (so AMD goes through `h264_amf` with `quality=balanced`, `rc=vbr_latency` first)
- Media Foundation init or validation fails

**Camera:** Media Foundation multiplier 0.2 at the camera fps (`win.rs` line 763).

---

## 5. Desktop export

**Location:** `crates/export/src/mp4.rs`.

**Compression map:**

| Compression | bpp (lines 147-152) | CRF (lines 156-161) |
|---|---|---|
| Maximum | 0.3 | 24 |
| Social | 0.15 | 28 |
| Web | 0.08 | 32 |
| Potato | 0.04 | 36 |

**`Mp4ExportSettings`** (lines 180-190):

| Field | Notes |
|---|---|
| `fps` | |
| `resolution_base` | |
| `compression` | |
| `custom_bpp` | |
| `force_ffmpeg_decoder` | |
| `optimize_filesize` | serde default false |

- `effective_bpp` (line 193) is `custom_bpp` if set, else the map.
- `VideoInfo` is NV12 with `time_base = 1/fps` (lines 365-367). Frames are numbered, so output is CFR.
- Builder chain: `with_bpp`, `with_export_priority` (`is_export = true`), `with_export_settings`, `with_external_conversion`, plus `with_crf(crf)` if `optimize_filesize`.
- The builder preset stays at its default `Ultrafast`, which selects the libx264 "fast" set.
- Container: `MP4File::init("output", path, self.optimize_filesize, ...)`. `+faststart` is written only when `optimize_filesize` is true (`crates/enc-ffmpeg/src/mux/mp4.rs` lines 44-90). Default exports have the moov at the end.
- Audio: AAC 320 kbps.
- macOS: `want_hw_input = !optimize_filesize && frame is a Surface`.

**UI defaults** (`apps/desktop/src/routes/editor/ExportPage.tsx`):

| Setting | Value |
|---|---|
| Format | Mp4 |
| fps | 30 (options 15/30/60, lines 79-83) |
| Resolution | 720p 1280x720 |
| Compression | Maximum |
| `optimizeFilesize` | false |
| Custom bpp slider | 0.02 to 0.5, step 0.01 (lines 1408-1410) |

- Resolution options (`Header.tsx` lines 33-37): 720p 1280x720, 1080p 1920x1080, 4K 3840x2160.
- Output size is rounded: width up to a multiple of 4, height up to even (`crates/rendering/src/lib.rs` `get_output_size`, lines 3228-3242).

### 5.1 DESK-EXPORT-X264-{Maximum,Social,Web,Potato}: default export on Linux, or any platform's software fallback

Encoder settings: libx264 export "fast" set plus `g=K`, `keyint_min=K`, `threads=N`.

| Setting | Value |
|---|---|
| Rate control | ABR at B, maxrate ignored |
| GOP | K, min K/2+1 |
| B-frames | None |
| Preset / tune | veryfast, no tune |
| Effective internals | ref=1, subme=2, trellis=0, rc_lookahead=10 |
| Profile / level | High, automatic level |
| Colour | BT.709 limited |
| Container | MP4 without faststart; track time base 1/90000 |

Verified at 720p30 Maximum: SEI identical to the render farm except `threads=4`.

Worked B per quality (Rust model, section 0.2):

| Compression | 1280x720@30 | 1920x1080@30 | 1920x1080@60 | 3840x2160@30 |
|---|---|---|---|---|
| Maximum | 8,294,400 | 18,662,400 | 29,859,841 | 74,649,602 |
| Social | 4,147,200 | 9,331,200 | 14,929,920 | 37,324,801 |
| Web | 2,211,839 | 4,976,639 | 7,962,623 | 19,906,559 |
| Potato | 1,105,919 | 2,488,319 | 3,981,311 | 9,953,279 |

K is 60 at 30 fps and 120 at 60 fps. The desktop UI also offers 15 fps, where K = 30.

**Reproduction on Linux (verified):**

```
ffmpeg -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -pix_fmt nv12 -c:v libx264 -preset veryfast -threads N -b:v B -maxrate M \
  -bf 0 -rc-lookahead 10 -aq-mode 1 -trellis 0 -g K -keyint_min K \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -an -video_track_timescale 90000 desk_export_x264.mp4
```

### 5.2 DESK-EXPORT-CRF-{24,28,32,36}: "Optimize file size"

CRF forces libx264. Dictionary: `preset=slow`, `crf=<24|28|32|36>`, `pix_fmt=yuv420p` (ignored), `g=K`, `keyint_min=K`. Threading is N through the context. No bitrate is set (`bit_rate = 0`).

| Setting | Value |
|---|---|
| Rate control | CRF |
| GOP | K, min K/2+1 |
| B-frames | x264 slow default: bframes=3, b_adapt=1 |
| Preset | slow |
| Effective internals | ref=5, subme=8, trellis=2, rc_lookahead=50 |
| Profile | High |
| Colour | BT.709 limited |
| Container | MP4 with `+faststart` |

Verified at 720p30, CRF 24: `ref=5 subme=8 trellis=2 threads=4 bframes=3 keyint=60 keyint_min=31 rc_lookahead=50 rc=crf crf=24.0`.

Compression maps to CRF as Maximum 24, Social 28, Web 32, Potato 36.

**Reproduction on Linux (verified):**

```
ffmpeg -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -pix_fmt nv12 -c:v libx264 -preset slow -crf 24 -threads N -g K -keyint_min K \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -an -movflags +faststart -video_track_timescale 90000 desk_export_crf24.mp4
```

### 5.3 Hardware export variants (cannot run on this VM)

All variants use the same B and M as section 5.1.

**DESK-EXPORT-VT (macOS default):**
- Options: `realtime=false`, `profile=main`, `allow_sw=0`; b B, maxrate M.
- GOP is 12 frames because no `g` is set. There are no B-frames.
- Input is NV12 surfaces.

```
ffmpeg ... -c:v h264_videotoolbox -realtime false -profile:v main -allow_sw 0 -b:v B -maxrate M ...
```

**DESK-EXPORT-NVENC** (Windows NVIDIA, or Linux with `/dev/nvidiactl`):

```
-c:v h264_nvenc -preset p5 -tune hq -rc vbr -spatial-aq 1 -temporal-aq 1 -b_ref_mode middle -g K -b:v B -maxrate M
```

**DESK-EXPORT-QSV:**

```
-c:v h264_qsv -preset medium -look_ahead 1 -look_ahead_depth 20 -g K -b:v B -maxrate M
```

**DESK-EXPORT-AMF:**

```
-c:v h264_amf -quality quality -rc vbr_peak -g K -b:v B -maxrate M
```

**DESK-EXPORT-MF:**

```
-c:v h264_mf -hw_encoding true -scenario 0 -quality 0 -g K -b:v B -maxrate M
```

---

## 6. Web recorders on `main` (MediaRecorder)

### 6.1 BR-MR-MAIN: dashboard web recorder

**Locations:**
- `packages/recorder-core/src/recorder-constants.ts`
- `packages/recorder-core/src/recorder-utils.ts`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder.ts`

**Capture constraints** (`recorder-constants.ts` lines 9-19): `{frameRate:{ideal:30}, width:{ideal:1920}, height:{ideal:1080}}`. These are ideal values, not exact.

**MIME candidates:**

| List | Candidates |
|---|---|
| `WEBM_MIME_TYPES` (lines 94-97), withAudio | `video/webm;codecs=vp9,opus`, `video/webm;codecs=vp8,opus` |
| `WEBM_MIME_TYPES`, videoOnly | `video/webm;codecs=vp9`, `video/webm;codecs=vp8`, `video/webm` |
| `MP4_MIME_TYPES` (lines 82-92), withAudio | `video/mp4;codecs="avc1.42E01E,mp4a.40.2"`, `video/mp4;codecs="avc1.4d401e,mp4a.40.2"` |
| `MP4_MIME_TYPES`, videoOnly | `video/mp4;codecs="avc1.42E01E"`, `video/mp4;codecs="avc1.4d401e"`, `video/mp4` |

**Pipeline selection** (`selectRecordingPipelineFromSupport`, lines 140-190):

1. WebM is supported and `preferStreamingUpload !== false`: mode `streaming-webm`.
2. Otherwise the first supported MP4 candidate: mode `buffered-raw`.
3. Otherwise WebM in mode `buffered-raw`.

`shouldPreferStreamingUpload` (lines 105-130) returns false for iOS, Firefox and Safari, and true for Chromium brands.

**Recorder options** (`getMediaRecorderOptions`, lines 36-41):

```
{ mimeType, videoKeyFrameIntervalDuration: 2_000 }
```

No `videoBitsPerSecond` is set, so the browser default applies (Chrome: 2.5 Mbps video, 128 kbps audio). It is constructed at `useWebRecorder.ts` line 1101.

**Timeslice:**
- `streaming-webm`: `start(1000)` (`INSTANT_UPLOAD_REQUEST_INTERVAL_MS`, line 75).
- If that throws: `start()` with manual flushing.
- `buffered-raw`: `start(200)` (line 1141).

**What each browser records:**

| Browser | Output |
|---|---|
| Chrome / Edge | VP9 + Opus WebM. This is not H.264. |
| Safari | H.264 MP4, `avc1.42E01E,mp4a.40.2` (Constrained Baseline 3.0 requested; Safari's own encoder) |
| Firefox | First supported MP4 candidate, else WebM |

`videoInstantCreate` is called with `videoCodec: "h264"` (line 1056).

**Server step:**
- Chrome VP9 is transcoded by MS-TRANSCODE-VPX: libx264 medium, CRF 23, `-bf 0`, capped at 1080p, level 4.2, CFR, AAC 128k.
- Safari H.264 at or below 1080p and level 4.2 is copied.
- `recording-conversion.ts` `convertToMp4` (line 127) is unused.

**Reproduction on Linux.** Chrome via Playwright:

```js
new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus", videoKeyFrameIntervalDuration: 2000 })
recorder.start(1000)
```

Then apply MS-TRANSCODE-VPX to the WebM (use `-i rec.webm` in place of the rawvideo input).

**BR-MR-MAIN-MP4 (Safari-path equivalent in Chrome):** `{ mimeType: 'video/mp4;codecs="avc1.42E01E"', videoKeyFrameIntervalDuration: 2000 }` with `start(200)`. Linux Chrome has no AAC MediaRecorder encoder, so the `mp4a.40.2` variants are unsupported there.

### 6.2 BR-MR-EXT-MAIN: Chrome extension

**Location:** `apps/chrome-extension/src/offscreen/recorder.ts`.

- `new MediaRecorder(recordingStream, { mimeType: pipeline.mimeType })` at lines 944-946.
- No keyframe or bitrate options.
- `start(RECORDING_TIMESLICE_MS)` with `RECORDING_TIMESLICE_MS` = 1000 (lines 70, 1086).
- In Chrome this gives VP9/Opus WebM at the Chrome default bitrate, then MS-TRANSCODE-VPX.

Reproduction: `new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus" }); recorder.start(1000)`.

### 6.3 BR-MR-TOOLS: SpeedController and TrimmingTool

**Location:** `apps/web/components/tools/SpeedController.tsx` and `TrimmingTool.tsx`.

- Source: `canvas.captureStream(60)` (SpeedController line 243, TrimmingTool line 408).
- Options: `{ mimeType: selectedMimeType, videoBitsPerSecond: 5000000 }` (SpeedController line 263, TrimmingTool line 446).
- Timeslice: `start(1000)` in SpeedController (line 296), `start(100)` in TrimmingTool (line 485).

MIME list for MP4 input (non-MP4 input uses the same WebM entries first, then `video/mp4`):

```
"video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"
```

Reproduction: `new MediaRecorder(canvas.captureStream(60), { mimeType: "video/mp4", videoBitsPerSecond: 5000000 })`. The codec Chrome picks for bare `video/mp4` is browser-dependent.

---

## 7. Browser WebCodecs encoders on `main`

### 7.1 BR-WC-REMOTION: Remotion `convertMedia`

**Packages:** `@remotion/webcodecs` 4.0.484 and mediabunny 1.49.0, unpacked to `/tmp` for reading.

**Callers:**
- `apps/web/app/s/[videoId]/_components/timeline/recording/convert-comment-media.ts` lines 25-32: `convertMedia({ container: "mp4", videoCodec: "h264", audioCodec: "aac" })` with `installAvcLevelClamp()` active. It skips conversion when the input is already MP4 or `canConvertToMp4InBrowser` (probe `avc1.42E01F` 1280x720 plus AAC) fails.
- `apps/web/components/tools/MediaFormatConverter.tsx` lines 650-657: `convertMedia({ container: "mp4", videoCodec: "h264" })` with no clamp.

**VideoEncoderConfig built by Remotion:**

| Field | Value |
|---|---|
| bitrate | Not set in Chrome. Safari: 3,000,000. |
| framerate | Source fps |
| hardwareAcceleration | Tries `prefer-hardware`, then `prefer-software` |
| Keyframes | Every 40 frames |
| Codec | `avc1.64` + `00` + level from Remotion's width/height/fps table (profile byte always 0x64) |

**Level clamp.** `installAvcLevelClamp` (`avc-level-clamp.ts`) patches `VideoEncoder.prototype.configure` to replace the codec with `pickMobileSafeAvcCodec(width, height)`:

| Size | Codec |
|---|---|
| ≤2048x1088 | `avc1.64002A` |
| ≤4096x2304 | `avc1.640033` |
| Larger | `avc1.640034` |

**Chromium default bitrate** when none is given (`media/base/video_encoder.cc` `GetDefaultVideoEncodeBitrate`, source only):

```
2,000,000 * clamp(fps,1,300) * clamp(W*H,1,64M) / (1280*720*30)
```

The result is clamped to at least 10,000.

**Worked values:**

| | 1280x720@30 | 1920x1080@30 | 1920x1080@60 | 3840x2160@30 |
|---|---|---|---|---|
| Chromium default bitrate | 2,000,000 | 4,500,000 | 9,000,000 | 18,000,000 |
| Codec without clamp | `avc1.64001F` | `avc1.64002A` | `avc1.64002A` | `avc1.640034` |
| Codec with clamp | `avc1.64002A` | `avc1.64002A` | `avc1.64002A` | `avc1.640033` |

**Container:** MP4 written by Remotion. Audio is AAC; Linux Chrome has no AAC AudioEncoder, so comment media with audio is left as WebM there.

**Reproduction on Linux** (Playwright, Google Chrome):

```js
new VideoEncoder(...).configure({
  codec: "avc1.64002A",            // with clamp; "avc1.64001F" etc. without
  width: W,
  height: H,
  framerate: FPS,
  hardwareAcceleration: "prefer-software",
})
```

Set `keyFrame: true` every 40th frame and leave `bitrate` unset. Headless Linux Chrome rejects `prefer-hardware` (verified), so Remotion's software retry is the path that runs.

### 7.2 BR-WC-MEDIABUNNY-LOOM: Loom browser conversion

**Location:** `apps/web/lib/loom-browser-conversion.ts` (same on `main` and the PR).

DASH WebM path (lines 644-662):

```js
new Mp4OutputFormat({ fastStart: false })
new VideoSampleSource({ codec: "avc", bitrate: QUALITY_HIGH, hardwareAcceleration: "prefer-hardware", alpha: "discard" })
new AudioSampleSource({ codec: "aac", bitrate: QUALITY_MEDIUM })
```

Conversion path (lines 857-873):

```js
Mp4OutputFormat({ fastStart: false })
Conversion.init({
  video: { codec: "avc", bitrate: QUALITY_HIGH, hardwareAcceleration: "prefer-hardware" },
  audio: { codec: "aac", bitrate: QUALITY_MEDIUM },
})
```

**mediabunny 1.49.0 behaviour (source):**
- Quality factors: VERY_LOW 0.3, LOW 0.6, MEDIUM 1, HIGH 2, VERY_HIGH 4.
- Video bitrate: `ceil(3e6 * (W*H/2073600)^0.95 * 1.0(avc) * 2 / 1000) * 1000`. It does not depend on fps.
- `keyFrameInterval` defaults to 2 s, by timestamp.
- `latencyMode` defaults to quality.
- Codec is `avc1.6400LL` from mediabunny's AVC level table, chosen by macroblocks and bitrate.
- The config adds `avc: { format: "avc" }`.
- Timestamps are passed through from the source (VFR).
- AAC QUALITY_MEDIUM is 128,000 bit/s.

**Worked values:**

| | 1280x720 | 1920x1080 (any fps) | 3840x2160 |
|---|---|---|---|
| Video bitrate | 2,778,000 | 6,000,000 | 22,393,000 |
| Codec | `avc1.64001F` | `avc1.640028` | `avc1.640033` |

**Container:** MP4 with the moov at the end (`fastStart: false`).

**Reproduction on Linux:**

```js
VideoEncoder.configure({
  codec: "avc1.640028",
  width: 1920,
  height: 1080,
  bitrate: 6000000,
  framerate: FPS,
  hardwareAcceleration: "no-preference",
  alpha: "discard",
  avc: { format: "avc" },
})
```

`prefer-hardware` is unsupported in headless Linux Chrome (verified). Force a keyframe every 2 s of timestamp.

---

## 8. PR 2312 differences (`FETCH_HEAD` 549c5afa9)

The PR does not change:
- `crates/enc-ffmpeg`
- `crates/export/src/mp4.rs`
- `crates/render-farm/src/video.rs`
- the desktop capture pipelines

### 8.1 BR-MR-PR-SCREEN, BR-MR-PR-CAMERA, BR-MR-PR-OVERLAY: web recorder

**Location (PR):** `packages/recorder-core/src/recorder-encoding.ts`.

**MIME candidates:** `recorder-constants.ts` lines 96-102 add:

| List | Candidates |
|---|---|
| `STREAMING_MP4_MIME_TYPES`, withAudio | `video/mp4;codecs="avc1.64002A,mp4a.40.2"`, `video/mp4;codecs="avc1.64002A,opus"` |
| `STREAMING_MP4_MIME_TYPES`, videoOnly | `video/mp4;codecs="avc1.64002A"` |

**Pipeline selection** (`recorder-utils.ts` lines 139-211):
- If `preferStreamingUpload !== false`: streaming MP4, else streaming WebM. Both use mode `"streaming"`.
- Otherwise buffered MP4 (`avc1.42E01E` list), else buffered WebM.
- `getMediaRecorderOptions` is removed.

**Bitrate tiers** (`BITRATES`, lines 45-49), in bit/s for captures with ≤1280x720, ≤1920x1088, ≤2560x1600 and larger pixel counts:

| Content | ≤720p | ≤1080p | ≤1600p | Larger |
|---|---|---|---|---|
| screen | 2,500,000 | 4,000,000 | 6,000,000 | 10,000,000 |
| camera | 2,600,000 | 4,500,000 | 6,500,000 | 10,000,000 |
| cameraOverlay | 2,000,000 | 3,500,000 | 5,000,000 | 8,000,000 |

- `recordingBitrate` (lines 57-74): above 40 fps, `Math.round(base * 1.5)`.
- Missing width/height default to 1920x1080. Missing fps defaults to 30.

**Recorder options** (`recorderOptions`, lines 87-117):

```
{ mimeType, videoBitsPerSecond: round(tier * bitrateScale * (vp8 ? 1.3 : 1)), videoKeyFrameIntervalDuration: 2000 }
```

- For a `video/mp4` MIME containing `avc1.xxxxxx`, the codec is rewritten to `pickMobileSafeAvcCodec(track W, H)`: `64002A`, `640033` or `640034`. The rewrite is kept only if `isTypeSupported`.
- The `avc1.42E01E` Safari candidate is also rewritten.
- W, H and fps come from `track.getSettings()`.

**Quality settings** (`web-recorder-dialog/recording-quality.ts`, PR):

| Setting | Value |
|---|---|
| Default | `screenHeight` 1080, `frameRate` 30, `cameraHeight` 1080, `level` standard |
| Screen height options | 1080 / 1440 / 2160 |
| fps options | 30 / 60 |
| Camera height options | 720 / 1080 |
| `qualityBitrateScale` | high = 1.6, standard = 1 |
| Storage | `localStorage` `"cap-web-recorder-quality"` |

**Capture constraints** (`capture-streams.ts`): `{ frameRate: { ideal: q.frameRate ?? 30 }, width: { ideal: round(h*16/9) }, height: { ideal: h } }`. `DEFAULT_CAMERA_QUALITY` is 1080@30.

**useWebRecorder (PR):**
- The display recorder uses `recorderOptions(pipeline.mimeType, mixedStream.getVideoTracks()[0], isSupported, qualityBitrateScale(quality), recordingMode === "camera" ? "camera" : "screen")` (lines 1753-1762 of the PR file).
- The separate camera recorder records a video-only stream with `"cameraOverlay"` (lines 1764-1775).
- `selectPairedCameraPipeline` (lines 77-93): if the display pipeline is buffered-raw MP4 (Safari), the camera uses `video/webm;codecs=vp8` in streaming mode, so the 1.3 VP8 scale applies.
- Timeslice: `start(1000)` for streaming, else `start(200)`. The camera recorder uses `start(1000)`.

**Worked videoBitsPerSecond:**

| Content | Scale | 1280x720@30 | 1920x1080@30 | 1920x1080@60 | 3840x2160@30 |
|---|---|---|---|---|---|
| screen | standard | 2,500,000 | 4,000,000 | 6,000,000 | 10,000,000 |
| screen | high (1.6) | 4,000,000 | 6,400,000 | 9,600,000 | 16,000,000 |
| camera | standard | 2,600,000 | 4,500,000 | 6,750,000 | 10,000,000 |
| camera | high (1.6) | 4,160,000 | 7,200,000 | 10,800,000 | 16,000,000 |
| cameraOverlay | standard | 2,000,000 | 3,500,000 | 5,250,000 | 8,000,000 |
| cameraOverlay | high (1.6) | 3,200,000 | 5,600,000 | 8,400,000 | 12,800,000 |
| cameraOverlay, VP8 (Safari camera) | standard | 2,600,000 | 4,550,000 | 6,825,000 | 10,400,000 |

At 2560x1440@30 (the PR's 1440 option), screen standard is 6,000,000.

**Observed Chrome 148 behaviour on Linux (verified, canvas source, 1280x720, 2,500,000 bit/s, `avc1.64002A`, 2 s keyframes):**

| Property | Observed |
|---|---|
| Reported `recorder.mimeType` | `video/mp4;codecs=avc1.640020`. Chrome picked level 3.2 itself. |
| Profile | High |
| B-frames | `has_b_frames=0` |
| Colour tags | smpte170m, tv range |
| Container | Fragmented MP4: `ftyp`, `moov`, then `moof`/`mdat` per 1 s timeslice |
| Timestamps | VFR (avg 29.8 fps) |
| Keyframes | At 0, 2.03 and 4.06 s, plus extra encoder-chosen IDRs on scene changes |
| Achieved rate | 1.94 Mbit/s on synthetic content |
| Supported withAudio MIME | `avc1.64002A,opus` (no AAC) |

**Server step:**
- PR media server: H.264 at or below 1080p and level 4.2 has its video copied; Opus audio is transcoded to AAC 128k.
- 1440p and 2160p captures are transcoded down to 1080p with MS-TRANSCODE. The PR `process-video` still passes no size options.
- Render-farm sources from these recordings usually take the remux path, because they have 2 s keyframes and no B-frames.

**Reproduction on Linux** (Playwright, Google Chrome, fake-camera track from `in.y4m`; see section 9):

```js
// BR-MR-PR-SCREEN at 1920x1080@30, standard
new MediaRecorder(stream, { mimeType: 'video/mp4;codecs="avc1.64002A,opus"', videoBitsPerSecond: 4000000, videoKeyFrameIntervalDuration: 2000 }); rec.start(1000);
// BR-MR-PR-CAMERA at 1920x1080@30: videoBitsPerSecond 4500000
// BR-MR-PR-OVERLAY at 1920x1080@30: videoBitsPerSecond 3500000
// 3840x2160: mimeType 'video/mp4;codecs="avc1.640033,opus"' (only if isTypeSupported), bitrate per table
```

### 8.2 Chrome extension (PR)

`recorder.ts` lines 1318-1340 (PR):
- `recorderOptions(pipeline.mimeType, recordingStream.getVideoTracks()[0], isSupported, 1, request.mode === "camera" ? "camera" : "screen")` for the main track.
- `"cameraOverlay"` for the camera track.
- Timeslice 1000.

The bitrates match the standard rows of the table in section 8.1.

### 8.3 BR-MR-CLIP-PR: editor clip recorder

**Location:** `apps/web/lib/editor-clip-recorder.ts`.

- `new MediaRecorder(stream, { mimeType })`, with the MIME from `selectRecordingPipelineFromSupport`.
- No bitrate or keyframe option.
- `start(1000)`.
- In Chrome this records `avc1.64002A` streaming MP4 at the Chrome default (2.5 Mbps).

Reproduction: `new MediaRecorder(stream, { mimeType: 'video/mp4;codecs="avc1.64002A,opus"' }); rec.start(1000)`.

### 8.4 BR-WC-EXPORT-PR: browser local export (WebCodecs)

**Locations (PR):**
- `packages/editor-solid-web/src/browser-export-worker.ts` lines 779-806
- `browser-export-encoder.ts`
- `browser-export-estimate.ts`
- `browser-export-audio.ts`
- `browser-local-export.ts`

**Job inputs:**
- fps is clamped to 1-120.
- `bitsPerPixel` is `custom_bpp` or `COMPRESSION_BPP`: Maximum 0.3, Social 0.15, Web 0.08, Potato 0.04.
- `optimize_filesize`, GIF and cursor-only exports are not handled locally and go to the server.

**Constants:**

| Constant | Safari | Other browsers |
|---|---|---|
| `HOLDS_QUALITY_FRAMES` | true | false |
| `KEYFRAME_SECONDS` | 5 | 2 |
| `BITRATE_SCALE` | 1.35 | 1 |

**Config, literal:**

```ts
const bitrate = Math.round(exportBitrate(width, height, job.fps, job.bitsPerPixel) * BITRATE_SCALE);
// guarded by mediabunny canEncodeVideo("avc", { width, height, bitrate })
const encoderConfig: VideoEncoderConfig = {
  codec: avcCodecString(width, height, bitrate),
  width, height, bitrate,
  framerate: job.fps,
  latencyMode: HOLDS_QUALITY_FRAMES ? "realtime" : "quality",
  hardwareAcceleration: "prefer-hardware",
  alpha: "discard",
  avc: { format: "avc" },
};
```

**Codec string** (`avcCodecString`): `avc1.6400LL`, where LL is the first entry of `AVC_LEVELS` with `ceil(W/16)*ceil(H/16) <= maxMacroblocks` and `bitrate <= maxBitrate`. The table mirrors mediabunny.

**Frames and keyframes:**
- `VideoFrame` timestamp is `trunc(frame/fps*1e6)`, and duration is `trunc(1e6/fps)`. This is CFR.
- A keyframe is requested when `floor(frame/fps/KEYFRAME_SECONDS)` changes: every 2 s, or every 5 s on Safari.
- Up to 4 frames are queued in the encoder.

**Container and audio:**
- `Mp4OutputFormat({ fastStart: file ? "reserve" : "in-memory" })`. Either way the moov is at the front.
- Packets are re-stamped `frame/fps`.
- Audio: 48 kHz stereo, AAC at `EXPORT_AUDIO_BITRATE` = 320,000 if `canEncodeAudio`, else Opus.

**Fallback:**
- An error before the first progress message becomes `BrowserLocalExportUnavailable`.
- `tauri-bridge.ts` lines 248-271 then switches to the server export (section 8.6).
- In headless Linux Chrome, `isConfigSupported` with `prefer-hardware` returns unsupported (verified), so the PR as written falls back to the server there.

**Worked values (non-Safari, Maximum 0.3):**

| | 1280x720@30 | 1920x1080@30 | 1920x1080@60 | 3840x2160@30 |
|---|---|---|---|---|
| Bitrate | 8,294,400 | 18,662,400 | 29,859,840 | 74,649,600 |
| Codec | `avc1.64001F` | `avc1.640028` | `avc1.640029` | `avc1.640033` |

Codecs at Social, Web and Potato: `64001F`, `640028`, `640028`, `640033`.

Safari at Maximum (×1.35): 11,197,440 / 25,194,240 / 40,310,784 / 100,776,960.

K is 60 at 30 fps and 120 at 60 fps (Safari: 150 at 30 fps).

**Reproduction on Linux** (Playwright, Google Chrome; substitute `hardwareAcceleration`):

```js
VideoEncoder.configure({
  codec: "avc1.640028",
  width: 1920,
  height: 1080,
  bitrate: 18662400,
  framerate: 30,
  latencyMode: "quality",
  hardwareAcceleration: "no-preference",   // production: "prefer-hardware"
  alpha: "discard",
  avc: { format: "avc" },
})
// encode(frame, { keyFrame: Math.floor(i/30/2) !== Math.floor((i-1)/30/2) || i === 0 })
```

**Observed Chrome 148 software path on Linux (verified, 1280x720, `avc1.640028` requested, 4,976,640 bit/s):**
- avcC `profile_idc` 100 with constraint byte `0x0C` (Constrained High).
- `level_idc` 31, not the requested 0x28.
- No B-frames.
- Requested keyframes were honoured, with extra encoder-inserted IDRs on scene changes.

### 8.5 BR-WC-AUDIO2VIDEO-PR: audio-only to video

**Location:** `apps/web/lib/audio-to-video.ts`.

```js
// 1280x720 canvas
new Mp4OutputFormat({ fastStart: "in-memory" })
new CanvasSource(canvas, { codec: "avc", bitrate: 150_000, keyFrameInterval: 60, latencyMode: "realtime" })
// frameRate 1
// audio: AAC (Opus if unsupported) at 160_000
```

- Codec: `avc1.64001F` (mediabunny).
- Keyframe interval: 60 s, which is 60 frames at 1 fps.

Reproduction:

```js
VideoEncoder.configure({
  codec: "avc1.64001F",
  width: 1280,
  height: 720,
  bitrate: 150000,
  framerate: 1,
  latencyMode: "realtime",
  hardwareAcceleration: "no-preference",
  avc: { format: "avc" },
})
```

Set `keyFrame` every 60th frame.

### 8.6 Server export and web Save (PR)

**Server export:**
- `apps/media-server/src/lib/editor-exports.ts` validates settings with zod (fps 1-60, x ≤ 3840, y ≤ 2160, `custom_bpp` ≤ 1, `optimize_filesize` optional).
- It spawns the native `export` binary (`crates/export/src/bin/web-editor.rs` `export()`, lines 512-566).
- That binary clamps fps to `1..=60`, caps size at 3840x2160, sets `force_ffmpeg_decoder = true`, and calls `Mp4ExportSettings.export`.
- So it is identical to section 5: on a Linux server, DESK-EXPORT-X264-* by default, DESK-EXPORT-CRF-* with optimize file size, and NVENC p5 if `/dev/nvidiactl` exists.

**Web Save** (`apps/web/lib/render-farm-start.ts`):

| Setting | Value |
|---|---|
| Resolution | `SAVE_RESOLUTION = [1920, 1080]` |
| fps | `clamp(round(fps ?? 30), 24, 60)` |
| Format | Mp4 |
| Compression | Maximum |
| `custom_bpp` | null |

- Rendered by RF-RENDER-NVENC in production.
- At 30 fps: B = 18,662,400, M = 27,993,600, K = 60. At 60 fps: B = 29,859,841, K = 120.
- The fallback worker save uses the same `workerSaveSettings` without `optimize_filesize`, so it has no faststart.

### 8.7 PR-PREVIEW-X264: live editor preview stream

**Locations:**
- `crates/editor/src/bin/web-editor-service/preview_h264.rs`
- `web-editor-service.rs` (default preview_fps 60 at line 1255; bpp 18/100 at line 990; `{"bitrate":"low"}` gives 4/100 and `{"bitrate":"high"}` gives 18/100, lines 1053-1056)

**Configuration:**
- `VideoInfo`: RGBA, `time_base 1/1_000_000`, `frame_rate fps/1`.
- Validation: fps `1..=60`, bpp `0.04..=0.18`.
- Builder: `.with_bpp(bpp).with_encoder_priority_override(&["libx264"]).build_standalone()`.
- Preset is the builder default `Ultrafast` in non-export mode, giving `preset=ultrafast`, `tune=zerolatency`, `g=K`, `keyint_min=K`.

**Encoder settings:**

| Setting | Value |
|---|---|
| Rate control | ABR at B, maxrate ignored |
| GOP | 2*fps, so 120 at the default 60 fps |
| Profile | Constrained Baseline (verified) |
| Colour | BT.709 limited, from RGBA via swscale |
| Output | Raw AVC packets with avcC description, sent to the browser decoder. There is no container. |

**Worked B:**

| Resolution | bpp 0.18 | bpp 0.04 |
|---|---|---|
| 1280x720@60 | 7,962,624 | 1,769,471 |
| 1920x1080@60 | 17,915,904 | 3,981,311 |

**Reproduction on Linux** (verified at 720p30):

```
ffmpeg -y -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv \
  -c:v libx264 -preset ultrafast -tune zerolatency -threads N -b:v B -maxrate M -g K -keyint_min K \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -an -f h264 preview.h264
```

The production defaults are FPS=60, K=120 and bpp 0.18.

### 8.8 PR media server and render farm changes

**`media-video.ts` (PR):**
- `getOrientedLimits` swaps the max width and height for portrait sources, so the limit becomes 1080x1920.
- Level selection uses the long and short edge.
- `AUDIO_RUN_ARGS = ["-chunk_duration", "1000000"]` is appended after `+faststart` when audio is present, and in `muxMediaTracksToMp4`.
- Video encoder arguments are unchanged.

**Render farm (PR):**
- `transcode.ts` only adds `downloadSource`.
- `worker.ts` line 721 keeps `RF_TRANSCODE_ENCODER ?? "h264_nvenc"`.
- `protocol.ts` adds a `CursorTask` that runs the external `cap-cursor-service` binary. Its encoding settings are not in this repo.

---

## 9. Running browser surfaces in headless Chrome with Playwright

1. Use Google Chrome, not Playwright's bundled Chromium, which lacks proprietary H.264/MP4 support:
   ```js
   chromium.launch({ executablePath: "/usr/local/bin/google-chrome", args: [...] })
   ```
   `channel: "chrome"` also works.
2. Feed the source frames:
   - **MediaRecorder:** convert the raw input to y4m and use it as the fake camera:
     ```
     ffmpeg -f rawvideo -pix_fmt yuv420p -s WxH -r FPS -i in.yuv -f yuv4mpegpipe in.y4m
     ```
     Launch with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-video-capture=/abs/in.y4m`. Then call `getUserMedia({ video: { width: { exact: W }, height: { exact: H }, frameRate: { exact: FPS } } })`. The fake device loops the file. Content type changes only the bitrate tier, so the same track works for the screen, camera and overlay variants.
   - **WebCodecs:** serve `in.yuv` over HTTP. Slice `W*H*3/2` bytes per frame and build:
     ```js
     new VideoFrame(buf, { format: "I420", codedWidth: W, codedHeight: H, timestamp: Math.trunc(i/FPS*1e6), duration: Math.trunc(1e6/FPS) })
     ```
3. Replace `hardwareAcceleration: "prefer-hardware"` with `"no-preference"` or `"prefer-software"`. Headless Linux Chrome 148 reports `prefer-hardware` unsupported, while `no-preference` and `prefer-software` (OpenH264) work. This changes the encoder compared with production on Windows/macOS.
4. Linux Chrome supports neither AAC in MediaRecorder nor AAC in `AudioEncoder`. Use the `,opus` MIME variants, or video-only.
5. Avoid `--dump-dom --virtual-time-budget` for encoder probes. Virtual time stalls the encoders. Post results from the page to a local HTTP endpoint instead (used here: about 8 s per probe).

---

## 10. Ambiguities and assumptions

- **Media-server ffmpeg version:** `oven/bun:1.4.0` plus apt `ffmpeg` is unpinned. It is probably Debian's 5.1.x but not verified. Verification here used 6.1.1. The x264 presets and the `fps_mode auto` choice of CFR for MP4 are expected to match.
- **Media-server output frame rate:** for VFR WebM input, the output rate is whatever ffmpeg guesses (`r_frame_rate`, often the stream's nominal 30/1 or a 1000/1 time base fallback). The repro uses the raw input rate.
- **VideoToolbox GOP of 12** comes from the FFmpeg 7.1 source (AVCodecContext `gop_size` default, `vt_defaults`). It is not observed on a Mac. The FFmpeg version linked into the desktop app was not checked.
- **NVENC, QSV, AMF, Media Foundation and AVFoundation:** B-frames, profile, level, VBV and lookahead not set by Cap come from encoder or preset defaults. These were not observed.
- **Rust f32 model:** f32-to-f64 rounding makes some values 1-3 bit/s off the browser model. Benchmarks should use the Rust values for Rust surfaces.
- **getDisplayMedia and getUserMedia** use `ideal` constraints, so actual capture size and fps may differ. The PR bitrate uses `track.getSettings()`, so it follows the actual size.
- **Chrome MediaRecorder** chooses its own H.264 level (it reported `avc1.640020` for 720p) and inserts scene-change IDRs. On Windows/macOS Chrome uses platform hardware encoders, whose output will differ from Linux OpenH264.
- **Chromium default WebCodecs bitrate** comes from the Chromium source. The probe's achieved rate on synthetic content was dominated by scene-change IDRs, so it is not evidence either way.
- **The `video/mp4` MIME without codecs** (web tools) leaves the codec choice to the browser.
- **Instant-mode output size** on desktop is clamped to fit within (max, max*9/16). The free/Pro limit comes from the account, which is outside the encoder code.
- **`cap-cursor-service`** (PR cursor-only render) is an external binary whose encoding is unknown.
- **libx264 dictionary keys:** the "ignored" list is based on FFmpeg option names and on observed `ref=1` in the output. A different FFmpeg build linked into the desktop app could accept other aliases. This was not checked.

---

## 11. Summary table

| surface | encoder | rate control | GOP | preset/tune | profile/level | container | repro command id |
|---|---|---|---|---|---|---|---|
| Media server processVideo (non-H.264, >1080p or level too high) | libx264 | CRF 23, no cap | x264 default 250/25, scenecut; `-bf 0` for VP8/VP9 source, else 3 B-frames | medium / none | High / forced 4.2 (5.1, 5.2 above 2048x1088) | MP4 `+faststart`, CFR (auto), AAC 128k | MS-TRANSCODE, MS-TRANSCODE-VPX |
| Media server level fix (dormant) | copy + `h264_metadata` | n/a | source | n/a | level rewritten | MP4 `+faststart` | MS-LEVELFIX |
| Media server edit render | libx264 | CRF 18 | 250/25, 3 B-frames | fast / none | High / auto | MP4 `+faststart`, CFR via fps filter, AAC 160k | MS-EDIT |
| Web Loom download fallback | libx264 | CRF 23 (default) | 250/25, 3 B-frames | veryfast / none | High / auto | MP4 `+faststart`, AAC 128k | WEB-LOOM-FFMPEG |
| Render farm render (production) | h264_nvenc | VBR B, max 1.5B (bpp model, default Maximum 0.3) | 2*fps, forced IDR, bf 0 | p1 / hq, spatial+temporal AQ | encoder default | Custom MP4 (moov first) or fMP4 HLS 2 s, AAC 320k | RF-RENDER-NVENC |
| Render farm render (override) | libx264 | ABR B, maxrate ignored | 2*fps, min fps+1, bf 0 | veryfast (ref 1, rc-lookahead 10) | High / auto | as above | RF-RENDER-X264 |
| Render farm source transcode (production) | h264_nvenc | VBR CQ 19, b:v 0 | forced IDR every 1 s, bf 0 | p1 / none | encoder default | MP4 `+faststart`, VFR passthrough, no audio | RF-TRANSCODE-NVENC |
| Render farm source transcode (override) | libx264 | CRF 18 | forced every 1 s plus 250/25, bf 0 | veryfast / none | High / auto | MP4 `+faststart`, VFR passthrough | RF-TRANSCODE-X264 |
| Desktop recording Linux (Balanced/Compat/Instant) | libx264 (h264_nvenc p4/ll if `/dev/nvidiactl`) | ABR B at bpp 0.3, maxrate ignored | 2*fps, min fps+1, scenecut 0, bf 0 | ultrafast / zerolatency | Constrained Baseline / auto (3.2 at 720p30) | DASH fMP4 2 s + HLS playlists, VFR, AAC 320k | DESK-REC-X264 |
| Desktop recording Linux Ultra | libx264 | ABR B at bpp 0.3 | 2*fps, min fps+1, bf 0 | veryfast / zerolatency | auto | DASH fMP4 2 s | DESK-REC-X264-ULTRA |
| Desktop recording macOS fragmented (default) | h264_videotoolbox (libx264 fallback) | ABR B (bpp 0.3 / 1.0 Ultra / 0.15 Compat or Instant), DataRateLimits 1.5B per s | 12 frames (not set), no B-frames | realtime, prio_speed | Main / AutoLevel | DASH fMP4 2 s, VFR | DESK-REC-VT (not runnable) |
| Desktop recording macOS non-fragmented and camera | AVFoundation | AverageBitRate (Balanced/Ultra/Compat/Instant formulas) | floor(0.75*fps); reordering only Ultra | n/a | AVFoundation default | MP4 (AVAssetWriter) | DESK-REC-AVF (not runnable) |
| Desktop recording Windows fragmented (default) | nvenc/mf/qsv/amf, then libx264 | VBR B (bpp 0.3 / 1.0 Ultra / 0.15 Instant), max 1.5B | 2*fps | NVENC p4/ll; QSV faster; AMF balanced vbr_latency; MF scenario 4 | encoder default | DASH fMP4 2 s | DESK-REC-WIN-HW (not runnable) |
| Desktop recording Windows non-fragmented | Media Foundation | AVG_BITRATE, fps fixed 30, multiplier 0.15 (0.3 Ultra) | MFT default | MFT default | MFT default | MP4, CFR 30 | DESK-REC-WINMF (not runnable) |
| Desktop export (default, Linux or software) | libx264 | ABR B: 0.3 / 0.15 / 0.08 / 0.04 | 2*fps, min fps+1, bf 0 | veryfast (ref 1, rc-lookahead 10, trellis 0) | High / auto | MP4, moov at end, CFR, AAC 320k | DESK-EXPORT-X264-{Maximum,Social,Web,Potato} |
| Desktop export, Optimize file size | libx264 | CRF 24 / 28 / 32 / 36 | 2*fps, min fps+1, 3 B-frames | slow / none | High / auto | MP4 `+faststart` | DESK-EXPORT-CRF-{24,28,32,36} |
| Desktop export macOS | h264_videotoolbox | ABR B, DataRateLimits 1.5B | 12 frames (not set) | realtime false, allow_sw 0 | Main / AutoLevel | MP4, moov at end | DESK-EXPORT-VT (not runnable) |
| Desktop export Windows/Linux NVIDIA | h264_nvenc | VBR B, max 1.5B | 2*fps | p5 / hq, b_ref_mode middle, AQ | encoder default | MP4, moov at end | DESK-EXPORT-NVENC (not runnable) |
| Desktop export QSV / AMF / MF | h264_qsv / h264_amf / h264_mf | VBR(-peak) B, max 1.5B | 2*fps | medium la 20 / quality vbr_peak / scenario 0 quality 0 | encoder default | MP4, moov at end | DESK-EXPORT-QSV, -AMF, -MF (not runnable) |
| Web recorder main, Chrome | MediaRecorder VP9 (H.264 made by MS-TRANSCODE-VPX) | browser default 2.5 Mbps | 2 s requested | n/a | VP9 | WebM streaming, 1 s slices | BR-MR-MAIN |
| Web recorder main, Safari/Firefox | MediaRecorder H.264 | browser default | 2 s requested | n/a | `avc1.42E01E` / `4d401e` requested | MP4 buffered, 200 ms slices | BR-MR-MAIN-MP4 |
| Chrome extension main | MediaRecorder VP9 | browser default | browser default | n/a | VP9 | WebM, 1 s slices | BR-MR-EXT-MAIN |
| Web tools (speed, trim) | MediaRecorder | 5,000,000 | browser default | n/a | browser choice for `video/mp4` | MP4 or WebM | BR-MR-TOOLS |
| Comment media / format converter | WebCodecs via Remotion | none (Chromium default formula; Safari 3M) | 40 frames | prefer-hardware, then software | 0x64, level table; clamp to `64002A/640033/640034` for comments | MP4 (AAC) | BR-WC-REMOTION |
| Loom browser conversion | WebCodecs via mediabunny | QUALITY_HIGH (2.778M / 6M / 22.393M) | 2 s | prefer-hardware, latency quality | `6400LL` from mediabunny table | MP4 moov at end, AAC 128k | BR-WC-MEDIABUNNY-LOOM |
| PR web recorder screen/camera/overlay | MediaRecorder H.264 | tier bit/s × 1.5 above 40 fps × 1.6 high × 1.3 VP8 | 2 s requested | n/a | `avc1.64002A` / `640033` / `640034` (Chrome picks actual level) | fragmented MP4 streaming, 1 s slices | BR-MR-PR-SCREEN, -CAMERA, -OVERLAY |
| PR editor clip recorder | MediaRecorder H.264 | browser default | browser default | n/a | `avc1.64002A` | fragmented MP4, 1 s slices | BR-MR-CLIP-PR |
| PR browser export | WebCodecs | bpp model × (Safari 1.35) | 2 s (Safari 5 s) | prefer-hardware, latency quality (Safari realtime) | `avc1.6400LL` from table | MP4 moov first, AAC 320k or Opus | BR-WC-EXPORT-PR |
| PR audio-to-video | WebCodecs via mediabunny | 150,000 | 60 frames at 1 fps | latency realtime | `avc1.64001F` | MP4 moov first, audio 160k | BR-WC-AUDIO2VIDEO-PR |
| PR editor preview stream | libx264 | ABR bpp 0.18 (low 0.04) | 2*fps (120 at 60 fps), min fps+1 | ultrafast / zerolatency | Constrained Baseline / auto | raw AVC packets | PR-PREVIEW-X264 |
| PR server export | as desktop export | as desktop export | as desktop export | as desktop export | as desktop export | MP4 | DESK-EXPORT-X264-*, DESK-EXPORT-CRF-* |
| PR web Save | as render farm render, 1920x1080 Maximum, fps 24-60 | VBR B, max 1.5B | 2*fps | p1 / hq | encoder default | Custom MP4 or fMP4 HLS | RF-RENDER-NVENC |
