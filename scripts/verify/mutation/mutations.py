"""Regression mutation catalogue for the cap-verify mutation audit.

Each mutation is one realistic regression, modelled on a bug class from Cap's
history. `edits` are exact string replacements: `old` must occur exactly
`count` times in `file` (every occurrence is replaced). `suites` are the suites
the CI plan would run for the touched crate; `platforms` where the mutated code
path runs. `visible` is the a-priori judgement of whether a user could see or
hear the regression (refined after the runs).
"""

ENGINE = ["export", "playback", "seek", "audio", "captions", "editing"]
RENDER_ENGINE = ENGINE + ["dm"]

M = []


def mutation(id, area, title, history, file, edits, platforms, suites=None, visible=True):
    M.append(
        dict(
            id=id,
            area=area,
            title=title,
            history=history,
            file=file,
            edits=[dict(old=o, new=n, count=c) for (o, n, c) in edits],
            platforms=platforms,
            suites=suites or ENGINE,
            visible=visible,
        )
    )


CFG = "crates/project/src/configuration.rs"

# ---------------------------------------------------------------- timeline
mutation(
    "T01", "timeline", "segment boundary inclusive: a frame exactly on a cut maps to the previous clip",
    "inclusive/exclusive boundary bugs (91cc4eacc output_end, 727ac5a5f 1x clip mute across segments)",
    CFG,
    [("            if frame_time < accum_duration + segment.duration() {\n",
      "            if frame_time <= accum_duration + segment.duration() {\n", 1)],
    ["linux"],
)
mutation(
    "T02", "timeline", "speed mapping inverted: recording time = start + u / timescale",
    "speed mapping (embed playback speed, clip speed audio modes)",
    CFG,
    [("            Some(self.start + tick * self.timescale)\n",
      "            Some(self.start + tick / self.timescale)\n", 1)],
    ["linux"],
)
mutation(
    "T03", "timeline", "timeline duration no longer subtracts transition overlaps (export too long)",
    "duration/frame count off (hold-past-end duration bug found by CAPTIONS-EDITING)",
    CFG,
    [("        let segment_duration = if self.transitions.is_empty() {\n            segment_duration\n",
      "        let segment_duration = if true || self.transitions.is_empty() {\n            segment_duration\n", 1)],
    ["linux"],
)
mutation(
    "T04", "timeline", "transition outgoing clip frozen on its first overlap frame",
    "transition blend source time",
    CFG,
    [("                        outgoing_segment.duration() - transition.duration + elapsed,\n",
      "                        outgoing_segment.duration() - transition.duration,\n", 1)],
    ["linux"],
)
mutation(
    "T05", "timeline", "transition progress reversed (blend weights swapped)",
    "transition blend weights",
    CFG,
    [("                        progress: (elapsed / transition.duration).clamp(0.0, 1.0),\n",
      "                        progress: (1.0 - elapsed / transition.duration).clamp(0.0, 1.0),\n", 1)],
    ["linux"],
)
mutation(
    "T06", "timeline", "transition duration clamp allows the full clip length instead of half",
    "transition clamp (M8 in CAPTIONS-EDITING proof)",
    CFG,
    [("            .min(self.segments[segment_index].duration())\n            / 2.0;\n",
      "            .min(self.segments[segment_index].duration());\n", 1)],
    ["linux"],
)
mutation(
    "T07", "timeline", "overlapping fullscreen-text holds merged to the later end only",
    "hold window merging (d8a1ec8c2 hold projection)",
    CFG,
    [("                Some(last) if window.0 <= last.1 => last.1 = last.1.max(window.1),\n",
      "                Some(last) if window.0 <= last.1 => last.1 = window.1,\n", 1)],
    ["linux"],
)
mutation(
    "T08", "timeline", "clip interpolate end exclusive (tick >= duration -> None)",
    "boundary inclusive/exclusive; expected equivalent: callers only ask for tick < duration",
    CFG,
    [("        if tick > self.duration() {\n", "        if tick >= self.duration() {\n", 1)],
    ["linux"],
    visible=False,
)

# ---------------------------------------------------------------- render loop / export
LIB = "crates/rendering/src/lib.rs"
mutation(
    "R01", "render", "export frame count floor instead of ceil (last frame dropped)",
    "export frame count/duration off by one",
    LIB,
    [("    let total_frames = (fps as f64 * duration).ceil() as u32;\n",
      "    let total_frames = (fps as f64 * duration).floor() as u32;\n", 2)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R02", "render", "export prefetch decodes the current frame's time for the next frame (stale prefetch reuse)",
    "stale prefetch/reader reuse (#2603 class)",
    LIB,
    [("                    project.get_segment_time(next_frame_number as f64 / fps as f64)\n",
      "                    project.get_segment_time(current_frame_number as f64 / fps as f64)\n", 2)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R03", "render", "output frame time sampled at mid-frame ((n + 0.5) / fps)",
    "pts rounding of output frame times",
    LIB,
    [("        let frame_time = current_frame_number as f64 / fps as f64;\n",
      "        let frame_time = (current_frame_number as f64 + 0.5) / fps as f64;\n", 2)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R04", "render", "camera start alignment offset sign flipped",
    "camera offset sign/doubling (early-camera finding, camera-clip-offset-double-applied)",
    "crates/rendering/src/segment_timing.rs",
    [("                .map(|(latest_start_time, start_time)| latest_start_time - start_time)\n",
      "                .map(|(latest_start_time, start_time)| start_time - latest_start_time)\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R05", "render", "screen start alignment dropped (screen not aligned to the latest track start)",
    "A/V start alignment (recording-startup-drop-av-offset)",
    "crates/rendering/src/segment_timing.rs",
    [("                .map(|(latest_start_time, display_time)| latest_start_time - display_time)\n",
      "                .map(|(latest_start_time, display_time)| 0.0 * (latest_start_time - display_time))\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R06", "render", "user camera clip offset applied twice",
    "camera clip offset double-applied (memory: camera-clip-offset-double-applied)",
    "crates/rendering/src/segment_timing.rs",
    [("        segment_time + offsets.camera,\n", "        segment_time + 2.0 * offsets.camera,\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R07", "render", "output size rounds down to even instead of up (export 1-2 px smaller)",
    "crop/scale rounding",
    LIB,
    [("        (((value.ceil() as u32) + 1) & !1).max(2)\n",
      "        ((value.ceil() as u32) & !1).max(2)\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R08", "render", "camera bubble placed on the left when the project says right",
    "camera placement (c56b742b4 webcam placement)",
    LIB,
    [("        CameraXPosition::Right => output_size[0] - camera_padding - subject_size[0],\n",
      "        CameraXPosition::Right => camera_padding,\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R09", "render", "camera mirror setting inverted",
    "camera mirror (cam-preview mirror scratch)",
    LIB,
    [("                    mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },\n",
      "                    mirror_x: if project.camera.mirror { 0.0 } else { 1.0 },\n", 2)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R10", "render", "background crop ignored (full screen rendered)",
    "crop (cursor-crop-clip-zoom-remap)",
    LIB,
    [("        project.background.crop.as_ref().cloned().unwrap_or(Crop {\n",
      "        None::<Crop>.unwrap_or(Crop {\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "R11", "render", "RGBA to NV12 export conversion uses BT.709 luma/chroma weights (colour shift)",
    "colour conversion (f49e1830b NV12 fallback)",
    "crates/rendering/src/shaders/rgba_to_nv12.wgsl",
    [("    return u32(clamp(16.0 + 65.481 * r + 128.553 * g + 24.966 * b, 0.0, 255.0));\n",
      "    return u32(clamp(16.0 + 46.559 * r + 156.629 * g + 15.812 * b, 0.0, 255.0));\n", 1),
     ("    return u32(clamp(128.0 - 37.797 * r - 74.203 * g + 112.0 * b, 0.0, 255.0));\n",
      "    return u32(clamp(128.0 - 25.664 * r - 86.336 * g + 112.0 * b, 0.0, 255.0));\n", 1),
     ("    return u32(clamp(128.0 + 112.0 * r - 93.786 * g - 18.214 * b, 0.0, 255.0));\n",
      "    return u32(clamp(128.0 + 112.0 * r - 101.730 * g - 10.270 * b, 0.0, 255.0));\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)

MP4 = "crates/export/src/mp4.rs"
mutation(
    "E01", "export", "export audio budget one frame short (frame_number instead of frame_number + 1)",
    "export duration off by one",
    MP4,
    [("    let end = ((frame_number + 1) * sample_rate) / fps;\n",
      "    let end = (frame_number * sample_rate) / fps;\n", 1)],
    ["linux"],
)
mutation(
    "E02", "export", "exported video pts start one frame late (A/V offset of one frame)",
    "A/V start alignment in export",
    MP4,
    [("                            input.frame_number as i64,\n                        );\n",
      "                            input.frame_number as i64 + 1,\n                        );\n", 1)],
    ["linux"],
)
mutation(
    "E03", "export", "export video time base hard-coded to 1/30 (60 fps exports play at half speed)",
    "fps conversion",
    MP4,
    [("        video_info.time_base = ffmpeg::Rational::new(1, fps as i32);\n",
      "        video_info.time_base = ffmpeg::Rational::new(1, 30);\n", 1)],
    ["linux"],
)
mutation(
    "E04", "export", "export keyframe interval 20 s instead of 2 s",
    "keyframe interval (487e30d40 VideoToolbox export keyframe interval)",
    "crates/enc-ffmpeg/src/video/h264.rs",
    [("    let keyframe_interval_secs = DEFAULT_KEYFRAME_INTERVAL_SECS;\n",
      "    let keyframe_interval_secs = DEFAULT_KEYFRAME_INTERVAL_SECS * 10;\n", 1)],
    ["linux"],
)
mutation(
    "E05", "export", "GIF frame timestamps at twice the rate (GIF plays 2x fast)",
    "GIF timing",
    "crates/enc-gif/src/lib.rs",
    [("        let pts = (self.frame_index as f64) / (self.fps as f64);\n",
      "        let pts = (self.frame_index as f64) / (self.fps as f64 * 2.0);\n", 1)],
    ["linux"],
)

# ---------------------------------------------------------------- decoders
DEC = "crates/rendering/src/decoder"
mutation(
    "D01", "decoder", "pts-hole map evicts the widest hole instead of the narrowest",
    "#2595 camera runaway (narrowest-hole eviction)",
    f"{DEC}/mod.rs",
    [("            .min_by_key(|&(&s, &e)| e.saturating_sub(s))\n",
      "            .max_by_key(|&(&s, &e)| e.saturating_sub(s))\n", 1)],
    ["linux", "macos"],
    RENDER_ENGINE,
)
mutation(
    "D02", "decoder", "pts_to_frame floors instead of rounding (jittery pts labelled one slot early)",
    "pts rounding (floor vs round)",
    f"{DEC}/mod.rs",
    [("        .round() as u32\n}\n\npub const FRAME_CACHE_SIZE",
      "        .floor() as u32\n}\n\npub const FRAME_CACHE_SIZE", 1)],
    ["linux", "macos"],
    RENDER_ENGINE,
)
mutation(
    "D03", "decoder", "FFmpeg request frame rounds instead of floors",
    "seek time rounding",
    f"{DEC}/ffmpeg.rs",
    [("                let requested_frame = (requested_time * fps as f32).floor() as u32;\n\n                pending_requests.push(PendingRequest {\n                    time: requested_time,",
      "                let requested_frame = (requested_time * fps as f32).round() as u32;\n\n                pending_requests.push(PendingRequest {\n                    time: requested_time,", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "D04", "decoder", "FFmpeg backward lookback tolerance 2 -> 6 frames",
    "stale cached answers (FFmpeg lookback finding)",
    f"{DEC}/ffmpeg.rs",
    [("const MAX_FRAME_LOOKBACK_TOLERANCE: u32 = 2;\n", "const MAX_FRAME_LOOKBACK_TOLERANCE: u32 = 6;\n", 1)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "D05", "decoder", "FFmpeg known pts hole treated as inclusive of its end frame",
    "boundary inclusive/exclusive in hole lookup",
    f"{DEC}/ffmpeg.rs",
    [(".filter(|&(_, &end)| requested_frame < end)\n", ".filter(|&(_, &end)| requested_frame <= end)\n", 2)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "D06", "decoder", "FFmpeg overshoot answer picks the oldest at-or-before candidate",
    "stale answer selection",
    f"{DEC}/ffmpeg.rs",
    [("                        .into_iter()\n                        .flatten()\n                        .max();\n",
      "                        .into_iter()\n                        .flatten()\n                        .min();\n", 2)],
    ["linux"],
    RENDER_ENGINE,
)
mutation(
    "D07", "decoder", "AVAssetReader request frame rounds instead of floors",
    "seek time rounding",
    f"{DEC}/avassetreader.rs",
    [("let frame = (requested_time * fps as f32).floor() as u32;\n",
      "let frame = (requested_time * fps as f32).round() as u32;\n", 2)],
    ["macos"],
    RENDER_ENGINE,
)
mutation(
    "D08", "decoder", "AVAssetReader at-or-before answer excludes the requested frame (one frame stale)",
    "off-by-one frame selection",
    f"{DEC}/avassetreader.rs",
    [("                    let cached_before = cache\n                        .range(..=req.frame)\n",
      "                    let cached_before = cache\n                        .range(..req.frame)\n", 1),
     ("                                    let cached_before = cache\n                                        .range(..=req.frame)\n",
      "                                    let cached_before = cache\n                                        .range(..req.frame)\n", 1)],
    ["macos"],
    RENDER_ENGINE,
)
mutation(
    "D09", "decoder", "keyframe index returns the keyframe after the target (reader starts past the request)",
    "keyframe seek off-by-one (wrong-GOP seek, #2603)",
    "crates/video-decode/src/avassetreader.rs",
    [("            Err(i) => Some(self.keyframes[i - 1]),\n",
      "            Err(i) => Some(self.keyframes[i.min(self.keyframes.len() - 1)]),\n", 1)],
    ["macos"],
    RENDER_ENGINE,
)
mutation(
    "D10", "decoder", "decoder pool position rounds up (reader choice only)",
    "expected equivalent: changes which pooled reader serves a request, not the answer",
    f"{DEC}/multi_position.rs",
    [("        let frame = (requested_time * self.config.fps as f32).floor() as u32;\n",
      "        let frame = (requested_time * self.config.fps as f32).ceil() as u32;\n", 1)],
    ["macos"],
    RENDER_ENGINE,
    visible=False,
)

# ---------------------------------------------------------------- audio
AR = "crates/audio/src/renderer.rs"
EA = "crates/editor/src/audio.rs"
mutation(
    "A01", "audio", "mono tracks mixed at unity instead of -3 dB per channel (+3 dB)",
    "level/channel mixing",
    AR,
    [("sample * 0.707 * gain", "sample * gain", 4)],
    ["linux"],
)
mutation(
    "A02", "audio", "stereo tracks mixed with left and right swapped",
    "channel layout swap (audio-channel-layout-invariant)",
    AR,
    [("        StereoMode::Stereo => (left, right),\n", "        StereoMode::Stereo => (right, left),\n", 1)],
    ["linux"],
)
mutation(
    "A03", "audio", "-30 dB floor no longer mutes (track audible at 3% at the floor)",
    "mute applied wrongly",
    AR,
    [("        v if v <= -30.0 => f32::NEG_INFINITY,\n", "        v if v < -30.0 => f32::NEG_INFINITY,\n", 1)],
    ["linux"],
)
mutation(
    "A04", "audio", "per-track sample offset applied with the wrong sign",
    "audio sample offset (two-clock A/V sync)",
    AR,
    [("        let source_start = offset as i128 + track.offset as i128;\n",
      "        let source_start = offset as i128 - track.offset as i128;\n", 1)],
    ["linux"],
)
mutation(
    "A05", "audio", "dB to linear uses /10 (power) instead of /20 (amplitude)",
    "volume mapping",
    AR,
    [("    10.0_f32.powf(db / 20.0)\n", "    10.0_f32.powf(db / 10.0)\n", 1)],
    ["linux"],
)
mutation(
    "A06", "audio", "clip volume applied squared",
    "volume applied wrongly",
    EA,
    [("            *sample *= volume;\n", "            *sample *= volume * volume;\n", 1)],
    ["linux"],
)
mutation(
    "A07", "audio", "cross-fade audio gains swapped (incoming loud at the start of the fade)",
    "transition blend weights",
    EA,
    [("                (angle.cos() as f32, angle.sin() as f32)\n",
      "                (angle.sin() as f32, angle.cos() as f32)\n", 1)],
    ["linux"],
)
mutation(
    "A08", "audio", "track timing offset subtracted instead of added",
    "audio offset sign (mic/system alignment)",
    EA,
    [("        (self.get_offset)(offsets) + self.timing_offset_secs\n",
      "        (self.get_offset)(offsets) - self.timing_offset_secs\n", 1)],
    ["linux"],
)
mutation(
    "A09", "audio", "Studio Sound state not reset on seek (state reused across positions)",
    "Studio Sound state reuse (#2521)",
    EA,
    [("        self.voice_enhancement = VoiceEnhancementCache::default();\n\n        self.cursor = match",
      "\n        self.cursor = match", 1)],
    ["linux"],
)
mutation(
    "A10", "audio", "Studio Sound block reads one block behind (audio offset by a block)",
    "audio sample offset by a block",
    EA,
    [("        let cursor = cursor.samples + offset;\n",
      "        let cursor = cursor.samples + offset.saturating_sub(EXPORT_AUDIO_BLOCK_SAMPLES);\n", 1)],
    ["linux"],
)
mutation(
    "A11", "audio", "matchSpeed resample rate divided by the timescale (pitch and length inverted)",
    "speed mapping for audio",
    EA,
    [("            let rate = (AudioRenderer::SAMPLE_RATE as f64 * timescale).round() as u32;\n",
      "            let rate = (AudioRenderer::SAMPLE_RATE as f64 / timescale).round() as u32;\n", 1)],
    ["linux"],
)
mutation(
    "A12", "audio", "music trim start ignored",
    "music trim (editor music track)",
    EA,
    [("            let src_index = trim_sample + local - data.source_start_sample() as i64;\n",
      "            let src_index = local - data.source_start_sample() as i64 + 0 * trim_sample;\n", 1)],
    ["linux"],
)
mutation(
    "A13", "audio", "full decode drops the resampler tail (no flush)",
    "resampler delay; expected equivalent for 48 kHz fixtures (no resampling delay)",
    "crates/audio/src/audio_data.rs",
    [("                    flush_resampler(&mut resampler, &mut resampler_output, &mut samples)?;\n",
      "                    let _ = (&mut resampler, &mut resampler_output);\n", 1)],
    ["linux"],
)
mutation(
    "A14", "audio", "track offset truncated instead of rounded to the sample",
    "expected equivalent: at most one sample (0.02 ms)",
    EA,
    [("            offset: (track.offset(&offsets) * AudioRenderer::SAMPLE_RATE as f32).round() as isize,\n",
      "            offset: (track.offset(&offsets) * AudioRenderer::SAMPLE_RATE as f32) as isize,\n", 1)],
    ["linux"],
    visible=False,
)

# ---------------------------------------------------------------- recording
CORE = "crates/recording/src/output_pipeline/core.rs"
REC_SUITES = ENGINE + ["recording"]
mutation(
    "C01", "recording", "epoch-anchored audio: head silence before the first captured frame not synthesized",
    "Instant/loopback audio anchor (instant-audio-anchor findings)",
    CORE,
    [("        if !head.is_zero() {\n            let start_samples = state.timestamp_generator.total_samples;\n",
      "        if false && !head.is_zero() {\n            let start_samples = state.timestamp_generator.total_samples;\n", 1)],
    ["linux", "macos"],
    REC_SUITES,
)
mutation(
    "C02", "recording", "audio gaps no longer filled with silence (audio after a gap plays early)",
    "gap fill / drift (system-audio-sync-hardening)",
    CORE,
    [("        if gap > self.gap_threshold {\n", "        if false && gap > self.gap_threshold {\n", 1)],
    ["linux", "macos"],
    REC_SUITES,
)
mutation(
    "C03", "recording", "video timeline rebased onto the absolute wall clock after warm-up (revert of 11d249110)",
    "startup drops shifting video ahead of audio (11d249110)",
    CORE,
    [("        let corrected_secs = anchor_camera_secs + (wall_clock_secs - anchor_wall_secs).max(0.0);\n",
      "        let corrected_secs = wall_clock_secs + 0.0 * (anchor_camera_secs - anchor_wall_secs);\n", 1)],
    ["linux", "macos"],
    REC_SUITES,
)
mutation(
    "C04", "recording", "Instant finalize drops the last listed fragment",
    "finalize/remux dropping the last fragment (cb7554f6a, 2ee22a63f)",
    "crates/recording/src/recovery.rs",
    [("                    .collect();\n\n                if manifest_type == \"m4s_segments\" && init_segment.is_some() {\n",
      "                    .collect();\n                result.pop();\n\n                if manifest_type == \"m4s_segments\" && init_segment.is_some() {\n", 1)],
    ["linux", "macos"],
    REC_SUITES,
)
mutation(
    "C05", "recording", "epoch-anchored audio reports its first frame as the track start",
    "audio start time in metadata (A/V start alignment)",
    CORE,
    [("            if ctx.anchor == AudioAnchor::PipelineEpoch && ctx.video_start_gate.is_none() {\n                Timestamp::Instant(",
      "            if false && ctx.anchor == AudioAnchor::PipelineEpoch && ctx.video_start_gate.is_none() {\n                Timestamp::Instant(", 1)],
    ["linux", "macos"],
    REC_SUITES,
)

# ---------------------------------------------------------------- captions
CT = "crates/project/src/caption_timing.rs"
CAP = "crates/rendering/src/layers/captions.rs"
mutation(
    "K01", "captions", "caption projection multiplies by the clip speed instead of dividing",
    "caption retiming over speed changes (a85a344b2)",
    CT,
    [("        mapping.edited_start + (overlap_start - mapping.source_start) / mapping.timescale,\n        mapping.edited_start + (overlap_end - mapping.source_start) / mapping.timescale,\n",
      "        mapping.edited_start + (overlap_start - mapping.source_start) * mapping.timescale,\n        mapping.edited_start + (overlap_end - mapping.source_start) * mapping.timescale,\n", 1)],
    ["linux"],
)
mutation(
    "K02", "captions", "rendered caption visible through its end frame (end inclusive)",
    "caption boundary inclusive/exclusive",
    CAP,
    [("        if time >= segment.start && time < caption_segment_effective_end(segment) {\n",
      "        if time >= segment.start && time <= caption_segment_effective_end(segment) {\n", 1)],
    ["linux"],
)
mutation(
    "K03", "captions", "renderer ignores the 2.5 s last-word clamp (caption lingers until segment end)",
    "word clamp (48a9e4543)",
    CAP,
    [("        Some(last) => segment\n            .end\n            .min(last.start as f64 + MAX_CAPTION_WORD_DURATION),\n",
      "        Some(_) => segment.end,\n", 1)],
    ["linux"],
)
mutation(
    "K04", "captions", "caption projection ignores earlier recording segments' durations",
    "multi-segment caption offsets",
    CT,
    [("        recording_offsets.push(cumulative);\n        cumulative += duration;\n",
      "        recording_offsets.push(cumulative);\n        cumulative += 0.0 * duration;\n", 1)],
    ["linux"],
)
mutation(
    "K05", "captions", "hold adjustment of caption ends treats a caption ending at a hold start as after it",
    "hold projection boundary",
    CT,
    [("        if output > *start {\n", "        if output >= *start {\n", 1)],
    ["linux"],
)
mutation(
    "K06", "captions", "app segmentation: caption end taken from the first word",
    "caption segmentation (Parakeet token -> segment)",
    "apps/desktop-gpui/src/transcription.rs",
    [("            end: chunk.last().map_or(0.0, |word| word.end),\n",
      "            end: chunk.first().map_or(0.0, |word| word.end),\n", 1)],
    ["linux"],
    ["gpui"],
)

# ---------------------------------------------------------------- upload
UP = "apps/desktop-gpui/src/upload.rs"
mutation(
    "U01", "upload", "multipart parts completed in hash order (final sort removed)",
    "upload ordering",
    UP,
    [("    let mut parts = deduped.into_values().collect::<Vec<_>>();\n    parts.sort_by_key(|part| part.part_number);\n",
      "    let parts = deduped.into_values().collect::<Vec<_>>();\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U02", "upload", "failed parts are never retried",
    "upload retry",
    UP,
    [("    for (chunk, first_error) in failed {\n", "    for (chunk, first_error) in failed.into_iter().take(0) {\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U03", "upload", "minimum part size 4 MiB (below the S3 5 MiB minimum)",
    "part sizing (#2522 multipart)",
    UP,
    [("const MIN_CHUNK_SIZE: u64 = 5 * 1024 * 1024;\n", "const MIN_CHUNK_SIZE: u64 = 4 * 1024 * 1024;\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U04", "upload", "network retry of a part has no backoff",
    "retry budget",
    UP,
    [("                let delay = Duration::from_secs(2u64.saturating_pow(attempt).min(30));\n",
      "                let delay = Duration::from_millis(u64::from(attempt));\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U05", "upload", "network errors on a part are not retried in place",
    "retry budget (#2522 re-uploaded bytes)",
    UP,
    [("            Err(error) if is_network_error(&error) && attempt < 4 => {\n",
      "            Err(error) if is_network_error(&error) && attempt < 0 => {\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U06", "upload", "Instant segments get one attempt instead of three",
    "segment retry (#2505)",
    UP,
    [("const SEGMENT_UPLOAD_ATTEMPTS: u32 = 3;\n", "const SEGMENT_UPLOAD_ATTEMPTS: u32 = 1;\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U07", "upload", "deferred segment retries do not back off",
    "retry storm",
    UP,
    [("        .saturating_mul(1 << round.min(8))\n", "        .saturating_mul(1)\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U08", "upload", "progress manifest every 250 ms instead of every second",
    "request budget",
    UP,
    [("const MANIFEST_UPLOAD_INTERVAL: Duration = Duration::from_secs(1);\n",
      "const MANIFEST_UPLOAD_INTERVAL: Duration = Duration::from_millis(250);\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U09", "upload", "segment retry window 60 s instead of 5 min",
    "retry window (#2505)",
    UP,
    [("const SEGMENT_RETRY_WINDOW: Duration = Duration::from_secs(5 * 60);\n",
      "const SEGMENT_RETRY_WINDOW: Duration = Duration::from_secs(60);\n", 1)],
    ["linux"], ["gpui"],
)
mutation(
    "U10", "upload", "Studio progress reaches 100% before the upload completes",
    "progress reporting",
    UP,
    [("        progress((offset as f64 / file_size as f64).min(0.99));\n",
      "        progress((offset as f64 / file_size as f64).min(1.0));\n", 1)],
    ["linux"], ["gpui"],
)
