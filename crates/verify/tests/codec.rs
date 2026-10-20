//! Marker codec robustness: the video code must survive lossy encoding,
//! scaling, compositing and blur, and the audio markers must be located to
//! well under a millisecond after lossy encoding and resampling.

use cap_verify::{
    audio_code::{self, AudioSource},
    media::{self, AudioCodec, VideoCodec, VideoWriter, VideoWriterConfig},
    oracle::{self, StreamExpectation},
    video_code::{self, FrameMarker, PackedFrame, PixelOrder, Readout, StreamKind},
};

struct Rgba {
    data: Vec<u8>,
    w: usize,
    h: usize,
}

impl Rgba {
    fn new(w: usize, h: usize, rgb: [u8; 3]) -> Self {
        let mut data = vec![255u8; w * h * 4];
        for px in data.chunks_exact_mut(4) {
            px[..3].copy_from_slice(&rgb);
        }
        Self { data, w, h }
    }

    fn view(&self) -> PackedFrame<'_> {
        PackedFrame {
            data: &self.data,
            width: self.w,
            height: self.h,
            stride: self.w * 4,
            order: PixelOrder::Rgba,
        }
    }

    fn get(&self, x: usize, y: usize) -> [u8; 4] {
        let i = (y * self.w + x) * 4;
        [
            self.data[i],
            self.data[i + 1],
            self.data[i + 2],
            self.data[i + 3],
        ]
    }

    /// Bilinear resample of a source rectangle into a new image.
    fn crop_scale(&self, sx: f64, sy: f64, sw: f64, sh: f64, w: usize, h: usize) -> Rgba {
        let mut out = Rgba::new(w, h, [0, 0, 0]);
        for y in 0..h {
            for x in 0..w {
                let fx = sx + (x as f64 + 0.5) * sw / w as f64 - 0.5;
                let fy = sy + (y as f64 + 0.5) * sh / h as f64 - 0.5;
                let x0 = fx.floor().clamp(0.0, (self.w - 1) as f64) as usize;
                let y0 = fy.floor().clamp(0.0, (self.h - 1) as f64) as usize;
                let x1 = (x0 + 1).min(self.w - 1);
                let y1 = (y0 + 1).min(self.h - 1);
                let ax = (fx - x0 as f64).clamp(0.0, 1.0);
                let ay = (fy - y0 as f64).clamp(0.0, 1.0);
                let i = (y * w + x) * 4;
                for c in 0..3 {
                    let v = |px: [u8; 4]| f64::from(px[c]);
                    let top = v(self.get(x0, y0)) * (1.0 - ax) + v(self.get(x1, y0)) * ax;
                    let bottom = v(self.get(x0, y1)) * (1.0 - ax) + v(self.get(x1, y1)) * ax;
                    out.data[i + c] = (top * (1.0 - ay) + bottom * ay).round() as u8;
                }
            }
        }
        out
    }

    /// Pastes `src` at (x, y) through a rounded-rectangle mask of radius `r`
    /// (r = half the side gives a circle), anti-aliased over one pixel.
    fn paste_rounded(&mut self, src: &Rgba, ox: usize, oy: usize, r: f64) {
        for y in 0..src.h {
            for x in 0..src.w {
                let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                let cx = px.clamp(r, src.w as f64 - r);
                let cy = py.clamp(r, src.h as f64 - r);
                let d = (px - cx).hypot(py - cy) - r;
                let alpha = (0.5 - d).clamp(0.0, 1.0);
                let (tx, ty) = (ox + x, oy + y);
                if tx >= self.w || ty >= self.h || alpha == 0.0 {
                    continue;
                }
                let i = (ty * self.w + tx) * 4;
                let j = (y * src.w + x) * 4;
                for c in 0..3 {
                    let blended = f64::from(self.data[i + c]) * (1.0 - alpha)
                        + f64::from(src.data[j + c]) * alpha;
                    self.data[i + c] = blended.round() as u8;
                }
            }
        }
    }

    fn box_blur(&self) -> Rgba {
        let mut out = Rgba::new(self.w, self.h, [0, 0, 0]);
        for y in 0..self.h {
            for x in 0..self.w {
                for c in 0..3 {
                    let mut sum = 0u32;
                    let mut n = 0u32;
                    for dy in -1i32..=1 {
                        for dx in -1i32..=1 {
                            let xx = x as i32 + dx;
                            let yy = y as i32 + dy;
                            if xx >= 0
                                && yy >= 0
                                && (xx as usize) < self.w
                                && (yy as usize) < self.h
                            {
                                sum += u32::from(self.get(xx as usize, yy as usize)[c]);
                                n += 1;
                            }
                        }
                    }
                    out.data[(y * self.w + x) * 4 + c] = (sum / n) as u8;
                }
            }
        }
        out
    }
}

fn marker_frame(marker: FrameMarker, w: usize, h: usize) -> Rgba {
    Rgba {
        data: video_code::marker_rgba(marker, w, h),
        w,
        h,
    }
}

/// A composited editor-like output: background, padded screen with rounded
/// corners, circular camera bubble bottom right.
fn composite(screen: u32, camera: u32, out_w: usize, out_h: usize, blur: bool) -> Rgba {
    let screen_src = marker_frame(FrameMarker::new(StreamKind::Screen, 0, screen), 1280, 720);
    let camera_src = marker_frame(FrameMarker::new(StreamKind::Camera, 0, camera), 640, 360);
    let mut out = Rgba::new(out_w, out_h, [60, 60, 60]);
    let pad = out_w as f64 * 0.06;
    let sw = out_w as f64 - 2.0 * pad;
    let sh = sw * 9.0 / 16.0;
    let screen_img = screen_src.crop_scale(0.0, 0.0, 1280.0, 720.0, sw as usize, sh as usize);
    let sy = ((out_h as f64 - sh) / 2.0).max(0.0);
    out.paste_rounded(&screen_img, pad as usize, sy as usize, sw * 0.03);
    let bubble = (out_h as f64 * 0.3).round() as usize;
    let camera_img = camera_src.crop_scale(140.0, 0.0, 360.0, 360.0, bubble, bubble);
    let bx = out_w - bubble - (out_w as f64 * 0.03) as usize;
    let by = out_h - bubble - (out_h as f64 * 0.04) as usize;
    out.paste_rounded(&camera_img, bx, by, bubble as f64 / 2.0);
    if blur { out.box_blur() } else { out }
}

fn encode_decode(
    frames: &[Rgba],
    codec: VideoCodec,
    bitrate: u64,
    dir: &std::path::Path,
) -> Option<Vec<media::Picture>> {
    let (w, h) = (frames[0].w as u32, frames[0].h as u32);
    let mut config = VideoWriterConfig::new(w, h, 30);
    config.codec = codec;
    config.bitrate = Some(bitrate);
    config.gop = 30;
    let path = dir.join(format!("{codec:?}-{w}x{h}-{bitrate}.mp4"));
    let mut writer = match VideoWriter::create(&path, &config) {
        Ok(writer) => writer,
        Err(error) if codec == VideoCodec::Hevc => {
            eprintln!("skipping HEVC: {error}");
            return None;
        }
        Err(error) => panic!("{error:?}"),
    };
    for (i, frame) in frames.iter().enumerate() {
        writer.write_rgba(&frame.data, i as f64 / 30.0).unwrap();
    }
    writer.finish().unwrap();
    let mut pictures = Vec::new();
    media::decode_video(&path, |p| pictures.push(p)).unwrap();
    Some(pictures)
}

#[test]
fn video_code_survives_low_bitrate_h264_and_hevc_on_full_frames() {
    let dir = tempfile::tempdir().unwrap();
    for (kind, w, h) in [
        (StreamKind::Screen, 640, 360),
        (StreamKind::Camera, 320, 240),
    ] {
        let indices: Vec<u32> = (0..45).map(|i| (i * 977 + 13) % 65_536).collect();
        let frames: Vec<Rgba> = indices
            .iter()
            .map(|&i| marker_frame(FrameMarker::new(kind, 1, i), w, h))
            .collect();
        for codec in [VideoCodec::H264, VideoCodec::Hevc] {
            let Some(pictures) = encode_decode(&frames, codec, 120_000, dir.path()) else {
                continue;
            };
            assert_eq!(pictures.len(), frames.len());
            for (picture, &index) in pictures.iter().zip(&indices) {
                let readout = video_code::read_stream(&picture.view(), kind);
                assert_eq!(
                    readout.marker(),
                    Some(FrameMarker::new(kind, 1, index)),
                    "{codec:?} {kind:?} at {:.3}s: {readout:?}",
                    picture.pts_secs
                );
            }
        }
    }
}

#[test]
fn video_code_survives_compositing_scaling_rounding_bubble_and_blur() {
    let dir = tempfile::tempdir().unwrap();
    // 640x360 is a typical verification output; 320x180 puts the screen at
    // a quarter of its source size and the camera code cells at ~6 px.
    for (out_w, out_h, bitrate) in [(640, 360, 150_000), (320, 180, 80_000)] {
        for blur in [false, true] {
            let pairs: Vec<(u32, u32)> = (0..40).map(|i| (i * 3 + 100, i / 2 + 7)).collect();
            let frames: Vec<Rgba> = pairs
                .iter()
                .map(|&(s, c)| composite(s, c, out_w, out_h, blur))
                .collect();
            for (raw, &(s, c)) in frames.iter().zip(&pairs) {
                let readout = video_code::read_frame(&raw.view());
                assert_eq!(readout.screen.marker().map(|m| m.index), Some(s));
                assert_eq!(readout.camera.marker().map(|m| m.index), Some(c));
            }
            for codec in [VideoCodec::H264, VideoCodec::Hevc] {
                let Some(pictures) = encode_decode(&frames, codec, bitrate, dir.path()) else {
                    continue;
                };
                for (picture, &(s, c)) in pictures.iter().zip(&pairs) {
                    let readout = video_code::read_frame(&picture.view());
                    assert_eq!(
                        (
                            readout.screen.marker().map(|m| m.index),
                            readout.camera.marker().map(|m| m.index)
                        ),
                        (Some(s), Some(c)),
                        "{codec:?} {out_w}x{out_h} blur={blur}: {readout:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn damaged_codes_read_as_unreadable_never_as_another_frame() {
    let w = 320;
    let h = 180;
    let marker = FrameMarker::new(StreamKind::Screen, 0, 4242);
    let mut hits = 0;
    // Smear a grey bar across successive rows of the code: every damaged
    // picture must read as the true marker or as unreadable.
    for bar in 0..h {
        let mut frame = marker_frame(marker, w, h);
        for y in bar..(bar + 6).min(h) {
            for x in 0..w {
                let i = (y * w + x) * 4;
                frame.data[i..i + 3].copy_from_slice(&[128, 128, 128]);
            }
        }
        match video_code::read_stream(&frame.view(), StreamKind::Screen) {
            Readout::Marker { marker: m, .. } => {
                assert_eq!(m, marker);
                hits += 1;
            }
            Readout::Unreadable { .. } | Readout::Absent | Readout::Blend { .. } => {}
        }
    }
    assert!(hits > 0);
}

#[test]
fn camera_crossfade_oracle_detects_the_wrong_incoming_frame_after_encode() {
    let dir = tempfile::tempdir().unwrap();
    let frames: Vec<_> = [76, 84]
        .into_iter()
        .map(|incoming| {
            let mut outgoing = composite(8, 8, 320, 180, false);
            let incoming = composite(8, incoming, 320, 180, false);
            for (a, b) in outgoing.data.iter_mut().zip(incoming.data) {
                *a = (f64::from(*a) * 0.8 + f64::from(b) * 0.2).round() as u8;
            }
            outgoing
        })
        .collect();
    let pictures = encode_decode(&frames, VideoCodec::H264, 1_728_000, dir.path()).unwrap();
    assert_eq!(pictures.len(), 2);
    let expected = vec![
        StreamExpectation::Blend {
            outgoing: (0, vec![8]),
            incoming: (0, vec![76]),
            progress: 0.2,
        };
        2
    ];
    let observed: Vec<_> = pictures
        .iter()
        .zip(&expected)
        .map(|(picture, expectation)| {
            oracle::read_expecting(&picture.view(), StreamKind::Camera, expectation)
        })
        .collect();
    let report = oracle::check_stream(StreamKind::Camera, &expected, &observed, 30);
    assert_eq!(report.mismatches.len(), 1, "{report:?}");
    assert_eq!(report.ahead, 1);
    assert_eq!(report.max_ahead, 8);
    assert_eq!(report.mismatches[0].output_frame, 1);
    assert_eq!(report.mismatches[0].expected, Some((0, 76)));
    assert_eq!(report.mismatches[0].observed, Some((0, 84)));
}

#[test]
fn sequence_oracle_flags_wrong_duplicated_and_missing_frames_after_encode() {
    let dir = tempfile::tempdir().unwrap();
    let expected: Vec<u32> = (0..60).collect();
    let mut shown = expected.clone();
    shown[10] = 9; // duplicate of the previous frame (stale)
    shown[20] = 23; // a frame from the future
    shown.remove(30); // one frame skipped...
    shown.insert(31, 31); // ...and one repeated to keep the length
    let frames: Vec<Rgba> = shown
        .iter()
        .map(|&i| marker_frame(FrameMarker::new(StreamKind::Screen, 0, i), 320, 180))
        .collect();
    let pictures = encode_decode(&frames, VideoCodec::H264, 100_000, dir.path()).unwrap();
    let observed: Vec<Readout> = pictures
        .iter()
        .map(|p| video_code::read_stream(&p.view(), StreamKind::Screen))
        .collect();
    let expectations: Vec<StreamExpectation> = expected
        .iter()
        .map(|&i| StreamExpectation::frame(0, i))
        .collect();
    let report = oracle::check_stream(StreamKind::Screen, &expectations, &observed, 30);
    let wrong: Vec<u32> = report.mismatches.iter().map(|m| m.output_frame).collect();
    assert_eq!(wrong, vec![10, 20, 30]);
    assert_eq!(report.stale, 1);
    assert_eq!(report.ahead, 2);
    assert_eq!(report.skipped_source_frames, vec![10, 20, 30]);
    assert_eq!(report.repeated_source_frames, vec![9, 23, 31]);
}

#[test]
fn audio_markers_locate_within_a_millisecond_after_lossy_codecs_and_resampling() {
    let dir = tempfile::tempdir().unwrap();
    let rate = 48_000;
    let secs = 8.0;
    let mut mix = vec![0.0f32; (secs * f64::from(rate)) as usize];
    let mut schedules = Vec::new();
    for source in [AudioSource::Mic, AudioSource::System] {
        let schedule = audio_code::standard_schedule(source, 0.25, secs - 0.5, 0.5);
        audio_code::render_markers(&mut mix, rate, source, &schedule, 0.25);
        schedules.push((source, schedule));
    }
    for (codec, ext, bitrate) in [
        (AudioCodec::Aac, "m4a", 64_000),
        (AudioCodec::Opus, "ogg", 32_000),
    ] {
        let path = dir.path().join(format!("markers.{ext}"));
        media::write_audio(&path, &[mix.clone(), mix.clone()], rate, codec, bitrate).unwrap();
        for out_rate in [None, Some(44_100), Some(16_000)] {
            let decoded = media::decode_audio(&path, out_rate).unwrap();
            let mono = decoded.mono();
            for (source, schedule) in &schedules {
                let found = audio_code::locate_markers(&mono, decoded.sample_rate, *source);
                assert_eq!(
                    found.len(),
                    schedule.len(),
                    "{codec:?} {out_rate:?} {source:?}"
                );
                let mut worst = 0.0f64;
                for (f, e) in found.iter().zip(schedule) {
                    assert_eq!(f.index, Some(e.index), "{codec:?} {out_rate:?} {source:?}");
                    let error = (f.time_secs + decoded.start_secs - e.time_secs).abs();
                    worst = worst.max(error);
                    assert!((f.gain / 0.25 - 1.0).abs() < 0.4, "gain {}", f.gain);
                }
                assert!(
                    worst < 0.001,
                    "{codec:?} {out_rate:?} {source:?}: worst error {:.3} ms",
                    worst * 1e3
                );
                eprintln!(
                    "{codec:?} {out_rate:?} {source:?}: {} markers, worst {:.3} ms",
                    found.len(),
                    worst * 1e3
                );
            }
        }
    }
}
