//! Device and source chaos: hostile synthetic frames, audio buffers and
//! control sequences through the product's recording pipelines
//! (`OutputPipeline` with the Studio and Instant muxers, the microphone and
//! camera feeds and sources, and the Studio and Instant recording actors).

use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use anyhow::anyhow;
use cap_media_info::{AudioInfo, Pixel, Sample, Type, VideoInfo};
use cap_recording::{
    AudioFrame, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
    ChannelVideoSourceConfig, OutputPipeline,
    ffmpeg::{
        DashSegmentedAudioMuxer, DashSegmentedAudioMuxerConfig, FFmpegVideoFrame,
        FragmentedAudioMuxer, FragmentedAudioMuxerConfig, Mp4Muxer, OggMuxer, OggMuxerConfig,
        SegmentedVideoMuxer, SegmentedVideoMuxerConfig,
    },
};
use cap_timestamp::{Timestamp, Timestamps};

use super::{
    harness::{Ctx, Probe, Verdict},
    media_check::judge_output,
};

/// Which clock a hostile frame is stamped with.
#[derive(Clone, Copy, Debug)]
pub enum Clock {
    /// `Instant`, offset seconds from the pipeline epoch (may be negative).
    Instant(f64),
    /// `SystemTime`, offset seconds from the epoch's wall clock.
    System(f64),
    /// The host clock real capture devices stamp (mach ticks on macOS).
    Host(f64),
}

fn timestamp(clock: Clock, timestamps: Timestamps) -> Timestamp {
    fn shift_instant(base: Instant, secs: f64) -> Instant {
        if secs >= 0.0 {
            base.checked_add(Duration::from_secs_f64(secs))
                .unwrap_or(base)
        } else {
            base.checked_sub(Duration::from_secs_f64(-secs))
                .unwrap_or(base)
        }
    }
    match clock {
        Clock::Instant(secs) => Timestamp::Instant(shift_instant(timestamps.instant(), secs)),
        Clock::System(secs) => {
            let base = timestamps.system_time();
            Timestamp::SystemTime(if secs >= 0.0 {
                base + Duration::from_secs_f64(secs)
            } else {
                base.checked_sub(Duration::from_secs_f64(-secs))
                    .unwrap_or(SystemTime::UNIX_EPOCH)
            })
        }
        Clock::Host(secs) => host(timestamps, secs),
    }
}

#[cfg(target_os = "macos")]
fn host(timestamps: Timestamps, secs: f64) -> Timestamp {
    let base = timestamps.mach_absolute_time();
    Timestamp::MachAbsoluteTime(if secs >= 0.0 {
        base + Duration::from_secs_f64(secs)
    } else {
        base - Duration::from_secs_f64(-secs)
    })
}

#[cfg(not(target_os = "macos"))]
fn host(timestamps: Timestamps, secs: f64) -> Timestamp {
    timestamp(Clock::Instant(secs), timestamps)
}

/// One hostile video frame.
#[derive(Clone, Debug)]
pub struct VFrame {
    pub width: u32,
    pub height: u32,
    pub format: Pixel,
    pub clock: Clock,
    /// Seconds to wait before handing it over (bursts are 0, stalls long).
    pub wait: f64,
}

#[derive(Clone, Debug)]
pub struct VideoScript {
    pub info: VideoInfo,
    pub frames: Vec<VFrame>,
    /// Some frame matches the declared format, so an empty output is wrong.
    pub expect_media: bool,
    /// Pause and resume the pipeline at these frame indices.
    pub pause_at: Vec<usize>,
    pub resume_at: Vec<usize>,
    /// Close the source channel after this many frames (the device vanished).
    pub vanish_after: Option<usize>,
}

fn steady(width: u32, height: u32, format: Pixel, fps: u32, count: usize) -> Vec<VFrame> {
    (0..count)
        .map(|i| VFrame {
            width,
            height,
            format,
            clock: Clock::Host(0.05 + i as f64 / f64::from(fps.max(1))),
            wait: 1.0 / f64::from(fps.max(1)),
        })
        .collect()
}

fn script(info: VideoInfo, frames: Vec<VFrame>, expect_media: bool) -> VideoScript {
    VideoScript {
        info,
        frames,
        expect_media,
        pause_at: Vec::new(),
        resume_at: Vec::new(),
        vanish_after: None,
    }
}

fn info(format: Pixel, width: u32, height: u32, fps: u32) -> VideoInfo {
    VideoInfo::from_raw_ffmpeg(format, width, height, fps)
}

/// The hostile video scripts, by name, for a source whose native format is
/// `format` (BGRA for FFmpeg frames, NV12 for ScreenCaptureKit buffers).
pub fn video_scripts(format: Pixel, other: Pixel) -> Vec<(&'static str, bool, VideoScript)> {
    let w = 320;
    let h = 180;
    let mut out: Vec<(&'static str, bool, VideoScript)> = vec![(
        "control",
        false,
        script(info(format, w, h, 30), steady(w, h, format, 30, 20), true),
    )];
    out.push((
        "info-zero-size",
        false,
        script(
            info(format, 0, 0, 30),
            steady(64, 64, format, 30, 10),
            false,
        ),
    ));
    out.push((
        "one-pixel",
        false,
        script(info(format, 1, 1, 30), steady(1, 1, format, 30, 10), false),
    ));
    out.push((
        "odd-size",
        false,
        script(
            info(format, 641, 361, 30),
            steady(641, 361, format, 30, 10),
            true,
        ),
    ));
    out.push((
        "info-huge",
        false,
        script(
            info(format, 16384, 16384, 30),
            steady(w, h, format, 30, 6),
            false,
        ),
    ));
    out.push((
        "huge-frames",
        true,
        script(
            info(format, 8192, 8192, 30),
            steady(8192, 8192, format, 30, 3),
            false,
        ),
    ));
    let mut changing = steady(w, h, format, 30, 6);
    changing.extend(steady(640, 360, format, 30, 6));
    changing.extend(steady(160, 90, format, 30, 6));
    changing.extend(steady(w + 1, h + 1, format, 30, 6));
    for (i, f) in changing.iter_mut().enumerate() {
        f.clock = Clock::Host(0.05 + i as f64 / 30.0);
    }
    out.push((
        "size-changes",
        false,
        script(info(format, w, h, 30), changing, true),
    ));
    out.push((
        "wrong-format",
        false,
        script(info(format, w, h, 30), steady(w, h, other, 30, 10), false),
    ));
    let mut backwards = steady(w, h, format, 30, 12);
    for (i, f) in backwards.iter_mut().enumerate() {
        f.clock = Clock::Host(1.0 - i as f64 / 30.0);
    }
    out.push((
        "ts-backwards",
        false,
        script(info(format, w, h, 30), backwards, true),
    ));
    let mut repeat = steady(w, h, format, 30, 12);
    for f in &mut repeat {
        f.clock = Clock::Host(0.1);
    }
    out.push((
        "ts-repeat",
        false,
        script(info(format, w, h, 30), repeat, true),
    ));
    let mut jump = steady(w, h, format, 30, 12);
    for (i, f) in jump.iter_mut().enumerate().skip(6) {
        f.clock = Clock::Host(3.0 * 3600.0 + i as f64 / 30.0);
    }
    out.push((
        "ts-jump-hours",
        false,
        script(info(format, w, h, 30), jump, true),
    ));
    let mut before = steady(w, h, format, 30, 12);
    for (i, f) in before.iter_mut().enumerate() {
        f.clock = Clock::Host(-10.0 + i as f64 / 30.0);
    }
    out.push((
        "ts-before-epoch",
        false,
        script(info(format, w, h, 30), before, true),
    ));
    let mut mixed = steady(w, h, format, 30, 12);
    for (i, f) in mixed.iter_mut().enumerate() {
        let t = 0.05 + i as f64 / 30.0;
        f.clock = match i % 3 {
            0 => Clock::Host(t),
            1 => Clock::Instant(t),
            _ => Clock::System(t),
        };
    }
    out.push((
        "ts-mixed-clocks",
        false,
        script(info(format, w, h, 30), mixed, true),
    ));
    let mut wall_past = steady(w, h, format, 30, 8);
    for (i, f) in wall_past.iter_mut().enumerate() {
        f.clock = Clock::System(-3600.0 + i as f64 / 30.0);
    }
    out.push((
        "ts-wallclock-past",
        false,
        script(info(format, w, h, 30), wall_past, true),
    ));
    for (name, fps) in [("fps-0", 0), ("fps-1", 1), ("fps-1000", 1000)] {
        out.push((
            name,
            false,
            script(
                info(format, w, h, fps),
                steady(w, h, format, fps.clamp(1, 240), 10),
                true,
            ),
        ));
    }
    let mut burst = steady(w, h, format, 30, 240);
    for f in &mut burst {
        f.wait = 0.0;
    }
    out.push(("burst", false, script(info(format, w, h, 30), burst, true)));
    let mut stall = steady(w, h, format, 30, 6);
    stall[3].wait = 5.0;
    for (i, f) in stall.iter_mut().enumerate().skip(3) {
        f.clock = Clock::Host(5.2 + i as f64 / 30.0);
    }
    out.push(("stall", false, script(info(format, w, h, 30), stall, true)));
    out.push((
        "no-frames",
        false,
        script(info(format, w, h, 30), Vec::new(), false),
    ));
    let mut paused = script(info(format, w, h, 30), steady(w, h, format, 30, 30), true);
    paused.pause_at = vec![0, 10, 11, 20];
    paused.resume_at = vec![5, 12, 25];
    out.push(("pause-resume-hostile", false, paused));
    let mut vanish = script(info(format, w, h, 30), steady(w, h, format, 30, 20), true);
    vanish.vanish_after = Some(5);
    out.push(("device-vanishes", false, vanish));
    out
}

/// An FFmpeg frame of `format` and size, with a deterministic pattern.
/// Frames FFmpeg cannot allocate are returned as allocated (empty planes),
/// like a converter that produced nothing.
fn ffmpeg_frame(format: Pixel, width: u32, height: u32, seed: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(format, width, height);
    let allocated = unsafe { !(*frame.as_ptr()).data[0].is_null() };
    if allocated {
        for plane in 0..frame.planes() {
            let data = frame.data_mut(plane);
            for (i, byte) in data.iter_mut().enumerate() {
                *byte = (i as u32).wrapping_mul(31).wrapping_add(seed) as u8;
            }
        }
    }
    frame
}

pub enum VideoMuxer {
    Mp4,
    Segmented,
    #[cfg(target_os = "macos")]
    MacFragmented,
    #[cfg(target_os = "macos")]
    MacOop,
    #[cfg(target_os = "macos")]
    MacAvfMp4,
}

impl VideoMuxer {
    fn output(&self, dir: &Path) -> std::path::PathBuf {
        match self {
            VideoMuxer::Mp4 => dir.join("out.mp4"),
            #[cfg(target_os = "macos")]
            VideoMuxer::MacAvfMp4 => dir.join("out.mp4"),
            _ => dir.join("display"),
        }
    }
}

async fn run_ffmpeg_video(
    ctx: &Ctx,
    muxer: &VideoMuxer,
    script: &VideoScript,
) -> anyhow::Result<Verdict> {
    let timestamps = Timestamps::now();
    let (tx, rx) = flume::bounded::<FFmpegVideoFrame>(64);
    let output = muxer.output(&ctx.scratch);
    let builder = OutputPipeline::builder(output.clone())
        .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(
            script.info,
            rx,
        ))
        .with_timestamps(timestamps);
    let built = match muxer {
        VideoMuxer::Mp4 => builder.build::<Mp4Muxer>(()).await,
        _ => {
            builder
                .build::<SegmentedVideoMuxer>(SegmentedVideoMuxerConfig {
                    segment_duration: Duration::from_secs(2),
                    ..Default::default()
                })
                .await
        }
    };
    let pipeline = match built {
        Ok(p) => p,
        Err(e) => return Ok(Verdict::rejected(format!("build: {e:#}"))),
    };
    let mut tx = Some(tx);
    for (i, f) in script.frames.iter().enumerate() {
        if script.pause_at.contains(&i) {
            pipeline.pause();
        }
        if script.resume_at.contains(&i) {
            pipeline.resume();
        }
        if script.vanish_after == Some(i) {
            tx = None;
        }
        if f.wait > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(f.wait)).await;
        }
        let Some(sender) = &tx else { break };
        let frame = FFmpegVideoFrame {
            inner: ffmpeg_frame(f.format, f.width, f.height, i as u32),
            timestamp: timestamp(f.clock, timestamps),
        };
        if sender.send_async(frame).await.is_err() {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let stopped = pipeline.stop().await;
    drop(tx);
    match stopped {
        Err(e) => Ok(Verdict::rejected(format!("stop: {e:#}"))),
        Ok(_) => Ok(judge_output(&output, script.expect_media)),
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use cap_recording::{
        MacOSFragmentedM4SMuxer, MacOSFragmentedM4SMuxerConfig, OutOfProcessFragmentedM4SMuxer,
        OutOfProcessFragmentedM4SMuxerConfig, screen_capture,
    };
    use cidre::{arc, cf, cm, cv};

    pub fn cv_format(format: Pixel) -> cv::PixelFormat {
        match format {
            Pixel::BGRA => cv::PixelFormat::_32_BGRA,
            Pixel::UYVY422 => cv::PixelFormat::_2VUY,
            Pixel::P010LE => cv::PixelFormat(u32::from_be_bytes(*b"x420")),
            Pixel::YUYV422 => cv::PixelFormat(u32::from_be_bytes(*b"yuvs")),
            Pixel::NV21 => cv::PixelFormat::_420F,
            _ => cv::PixelFormat::_420V,
        }
    }

    pub fn sample(
        format: Pixel,
        width: u32,
        height: u32,
        fps: u32,
        index: u32,
    ) -> anyhow::Result<arc::R<cm::SampleBuf>> {
        let io_surface_properties = cf::Dictionary::new();
        let keys: [&cf::Type; 1] = [cv::pixel_buffer::keys::io_surf_props().as_ref()];
        let values: [&cf::Type; 1] = [io_surface_properties.as_ref()];
        let attrs = cf::Dictionary::with_keys_values(&keys, &values)
            .ok_or_else(|| anyhow!("pixel buffer attributes"))?;
        let buf = cv::PixelBuf::new(
            width as usize,
            height as usize,
            cv_format(format),
            Some(&attrs),
        )
        .map_err(|e| anyhow!("pixel buffer {width}x{height} {format:?}: {e:?}"))?;
        let format_desc = cm::VideoFormatDesc::with_image_buf(&buf)
            .map_err(|e| anyhow!("format description: {e:?}"))?;
        let timing = cm::SampleTimingInfo {
            duration: cm::Time::new(1, fps.max(1) as i32),
            pts: cm::Time::new(i64::from(index), fps.max(1) as i32),
            dts: cm::Time::invalid(),
        };
        cm::SampleBuf::with_image_buf(&buf, true, None, std::ptr::null(), &format_desc, &timing)
            .map_err(|e| anyhow!("sample buffer: {e:?}"))
    }

    pub async fn run_screen(
        ctx: &Ctx,
        muxer: &VideoMuxer,
        script: &VideoScript,
    ) -> anyhow::Result<Verdict> {
        let timestamps = Timestamps::now();
        let (tx, rx) = flume::bounded::<screen_capture::VideoFrame>(64);
        let output = muxer.output(&ctx.scratch);
        let builder = OutputPipeline::builder(output.clone())
            .with_video::<ChannelVideoSource<screen_capture::VideoFrame>>(
                ChannelVideoSourceConfig::new(script.info, rx),
            )
            .with_timestamps(timestamps);
        let built = match muxer {
            VideoMuxer::MacFragmented => {
                builder
                    .build::<MacOSFragmentedM4SMuxer>(MacOSFragmentedM4SMuxerConfig::default())
                    .await
            }
            VideoMuxer::MacOop => {
                builder
                    .build::<OutOfProcessFragmentedM4SMuxer>(
                        OutOfProcessFragmentedM4SMuxerConfig::default(),
                    )
                    .await
            }
            _ => {
                builder
                    .build::<cap_recording::AVFoundationMp4Muxer>(
                        cap_recording::AVFoundationMp4MuxerConfig {
                            output_height: None,
                            instant_mode: false,
                            ultra_quality: false,
                            compatibility_quality: false,
                        },
                    )
                    .await
            }
        };
        let pipeline = match built {
            Ok(p) => p,
            Err(e) => return Ok(Verdict::rejected(format!("build: {e:#}"))),
        };
        let fps = script.info.fps();
        let mut tx = Some(tx);
        for (i, f) in script.frames.iter().enumerate() {
            if script.pause_at.contains(&i) {
                pipeline.pause();
            }
            if script.resume_at.contains(&i) {
                pipeline.resume();
            }
            if script.vanish_after == Some(i) {
                tx = None;
            }
            if f.wait > 0.0 {
                tokio::time::sleep(Duration::from_secs_f64(f.wait)).await;
            }
            let Some(sender) = &tx else { break };
            // A size no pixel buffer can have never reaches the recorder.
            let Ok(sample_buf) = sample(f.format, f.width, f.height, fps, i as u32) else {
                continue;
            };
            let frame = screen_capture::VideoFrame {
                sample_buf,
                timestamp: timestamp(f.clock, timestamps),
            };
            if sender.send_async(frame).await.is_err() {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let stopped = pipeline.stop().await;
        drop(tx);
        match stopped {
            Err(e) => Ok(Verdict::rejected(format!("stop: {e:#}"))),
            Ok(_) => Ok(judge_output(&output, script.expect_media)),
        }
    }
}

/// Video scripts every muxer runs in the FAST tier; FULL runs them all.
const FAST_VIDEO: &[&str] = &[
    "control",
    "info-zero-size",
    "size-changes",
    "wrong-format",
    "ts-backwards",
    "ts-jump-hours",
    "ts-wallclock-past",
    "fps-0",
    "no-frames",
    "device-vanishes",
];

/// Audio scripts every muxer but Ogg runs in the FAST tier.
const FAST_AUDIO: &[&str] = &[
    "control",
    "channels-0",
    "channels-3",
    "format-changes",
    "empty-buffers",
    "odd-lengths",
    "nan",
    "ts-backwards",
];

type NamedMuxer = (&'static str, fn() -> VideoMuxer);

fn video_probes(out: &mut Vec<Probe>) {
    let ffmpeg_muxers: [NamedMuxer; 2] = [
        ("mp4", || VideoMuxer::Mp4),
        ("segmented", || VideoMuxer::Segmented),
    ];
    for (muxer_name, muxer) in ffmpeg_muxers {
        for (name, full, script) in video_scripts(Pixel::BGRA, Pixel::YUV420P) {
            let probe = Probe::new(
                format!("chaos/record/video/{muxer_name}/{name}"),
                60,
                move |ctx| {
                    let muxer = muxer();
                    ctx.block_on(run_ffmpeg_video(ctx, &muxer, &script))
                },
            );
            out.push(if full || !FAST_VIDEO.contains(&name) {
                probe.full()
            } else {
                probe
            });
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mac_muxers: [NamedMuxer; 3] = [
            ("mac-fragmented", || VideoMuxer::MacFragmented),
            ("mac-oop", || VideoMuxer::MacOop),
            ("mac-avf-mp4", || VideoMuxer::MacAvfMp4),
        ];
        for (muxer_name, muxer) in mac_muxers {
            for (name, full, script) in video_scripts(Pixel::NV12, Pixel::BGRA) {
                let full = full || !FAST_VIDEO.contains(&name);
                let probe = Probe::new(
                    format!("chaos/record/video/{muxer_name}/{name}"),
                    60,
                    move |ctx| {
                        let muxer = muxer();
                        ctx.block_on(mac::run_screen(ctx, &muxer, &script))
                    },
                );
                out.push(if full { probe.full() } else { probe });
            }
        }
        for format in [
            Pixel::NV12,
            Pixel::NV21,
            Pixel::BGRA,
            Pixel::UYVY422,
            Pixel::YUYV422,
            Pixel::P010LE,
        ] {
            for (w, h) in [(1, 1), (2, 2), (641, 361), (3, 1080), (1920, 1)] {
                let id = format!(
                    "chaos/record/camera-convert/{}/{w}x{h}",
                    format!("{format:?}").to_lowercase()
                );
                out.push(Probe::new(id, 30, move |_ctx| {
                    let Ok(sample) = mac::sample(format, w, h, 30, 0) else {
                        return Ok(Verdict::Ok("no pixel buffer of this shape".into()));
                    };
                    Ok(match cap_camera_ffmpeg::sample_buf_as_ffmpeg(&sample) {
                        Ok(frame) => Verdict::Ok(format!(
                            "{}x{} {:?}",
                            frame.width(),
                            frame.height(),
                            frame.format()
                        )),
                        Err(e) => Verdict::rejected(e),
                    })
                }));
            }
        }
    }
}

/// One hostile audio buffer.
#[derive(Clone, Debug)]
pub struct AFrame {
    pub format: Sample,
    pub rate: u32,
    pub channels: u16,
    pub samples: usize,
    pub fill: Fill,
    pub clock: Clock,
    pub wait: f64,
}

#[derive(Clone, Copy, Debug)]
pub enum Fill {
    Tone,
    Nan,
    Inf,
    Huge,
}

#[derive(Clone, Debug)]
pub struct AudioScript {
    pub info: AudioInfo,
    pub frames: Vec<AFrame>,
    pub expect_media: bool,
}

const F32: Sample = Sample::F32(Type::Packed);

fn chunks(format: Sample, rate: u32, channels: u16, secs: f64, chunk: f64) -> Vec<AFrame> {
    let n = (secs / chunk).round() as usize;
    let samples = ((f64::from(rate) * chunk).round() as usize).max(1);
    (0..n)
        .map(|i| AFrame {
            format,
            rate,
            channels,
            samples,
            fill: Fill::Tone,
            clock: Clock::Host(0.05 + i as f64 * chunk),
            wait: chunk,
        })
        .collect()
}

pub fn audio_scripts() -> Vec<(&'static str, AudioScript)> {
    let ok = |name, frames| {
        (
            name,
            AudioScript {
                info: AudioInfo::new_raw(F32, 48_000, 1),
                frames,
                expect_media: true,
            },
        )
    };
    let mut out = vec![ok("control", chunks(F32, 48_000, 1, 1.0, 0.02))];
    for (name, rate) in [
        ("rate-0", 0),
        ("rate-1", 1),
        ("rate-8000", 8000),
        ("rate-44101", 44_101),
        ("rate-384000", 384_000),
    ] {
        out.push((
            name,
            AudioScript {
                info: AudioInfo::new_raw(F32, rate, 1),
                frames: chunks(F32, rate, 1, 1.0, 0.02),
                expect_media: rate >= 8000,
            },
        ));
    }
    for (name, channels) in [
        ("channels-0", 0u16),
        ("channels-3", 3),
        ("channels-8", 8),
        ("channels-32", 32),
    ] {
        out.push((
            name,
            AudioScript {
                info: AudioInfo::new_raw(F32, 48_000, channels),
                frames: chunks(F32, 48_000, channels, 1.0, 0.02),
                expect_media: channels > 0,
            },
        ));
    }
    let mut empty = chunks(F32, 48_000, 1, 0.4, 0.02);
    for f in &mut empty {
        f.samples = 0;
    }
    out.push((
        "empty-buffers",
        AudioScript {
            info: AudioInfo::new_raw(F32, 48_000, 1),
            frames: empty,
            expect_media: false,
        },
    ));
    let mut huge = chunks(F32, 48_000, 1, 0.2, 0.02);
    huge[0].samples = 48_000 * 20;
    out.push(ok("huge-buffer", huge));
    let mut odd = chunks(F32, 48_000, 1, 0.6, 0.02);
    for (i, f) in odd.iter_mut().enumerate() {
        f.samples = [1, 7, 333, 1023, 2][i % 5];
    }
    out.push(ok("odd-lengths", odd));
    for (name, fill) in [
        ("nan", Fill::Nan),
        ("inf", Fill::Inf),
        ("huge-values", Fill::Huge),
    ] {
        let mut frames = chunks(F32, 48_000, 1, 0.6, 0.02);
        for f in frames.iter_mut().skip(5) {
            f.fill = fill;
        }
        out.push(ok(name, frames));
    }
    let mut change = chunks(F32, 48_000, 1, 0.3, 0.02);
    change.extend(chunks(Sample::I16(Type::Packed), 48_000, 1, 0.3, 0.02));
    change.extend(chunks(F32, 44_100, 2, 0.3, 0.02));
    change.extend(chunks(Sample::F32(Type::Planar), 48_000, 2, 0.3, 0.02));
    change.extend(chunks(Sample::U8(Type::Packed), 8_000, 1, 0.3, 0.02));
    for (i, f) in change.iter_mut().enumerate() {
        f.clock = Clock::Host(0.05 + i as f64 * 0.02);
    }
    out.push(ok("format-changes", change));
    let mut backwards = chunks(F32, 48_000, 1, 0.5, 0.02);
    for (i, f) in backwards.iter_mut().enumerate() {
        f.clock = Clock::Host(1.0 - i as f64 * 0.02);
    }
    out.push(ok("ts-backwards", backwards));
    let mut jump = chunks(F32, 48_000, 1, 0.5, 0.02);
    for (i, f) in jump.iter_mut().enumerate().skip(10) {
        f.clock = Clock::Host(2.0 * 3600.0 + i as f64 * 0.02);
    }
    out.push(ok("ts-jump-hours", jump));
    let mut before = chunks(F32, 48_000, 1, 0.5, 0.02);
    for (i, f) in before.iter_mut().enumerate() {
        f.clock = Clock::Host(-30.0 + i as f64 * 0.02);
    }
    out.push(ok("ts-before-epoch", before));
    let mut wall = chunks(F32, 48_000, 1, 0.5, 0.02);
    for (i, f) in wall.iter_mut().enumerate() {
        f.clock = Clock::System(-60.0 + i as f64 * 0.02);
    }
    out.push(ok("ts-wallclock-past", wall));
    let mut repeat = chunks(F32, 48_000, 1, 0.5, 0.02);
    for f in &mut repeat {
        f.clock = Clock::Host(0.1);
    }
    out.push(ok("ts-repeat", repeat));
    let mut stall = chunks(F32, 48_000, 1, 0.4, 0.02);
    stall[10].wait = 4.0;
    for (i, f) in stall.iter_mut().enumerate().skip(10) {
        f.clock = Clock::Host(4.2 + i as f64 * 0.02);
    }
    out.push(ok("stall", stall));
    let mut burst = chunks(F32, 48_000, 1, 2.0, 0.02);
    for f in &mut burst {
        f.wait = 0.0;
    }
    out.push(ok("burst", burst));
    out.push((
        "no-frames",
        AudioScript {
            info: AudioInfo::new_raw(F32, 48_000, 1),
            frames: Vec::new(),
            expect_media: false,
        },
    ));
    out
}

fn audio_frame(f: &AFrame, index: usize) -> ffmpeg::frame::Audio {
    let layout = ffmpeg::util::channel_layout::ChannelLayout::default(i32::from(f.channels));
    let mut frame = ffmpeg::frame::Audio::new(f.format, f.samples, layout);
    frame.set_rate(f.rate);
    let allocated = unsafe { !(*frame.as_ptr()).data[0].is_null() };
    if !allocated {
        return frame;
    }
    let value = |n: usize| -> f32 {
        match f.fill {
            Fill::Tone => (0.4 * ((index * f.samples + n) as f64 * 0.0577).sin()) as f32,
            Fill::Nan => f32::NAN,
            Fill::Inf => {
                if n % 2 == 0 {
                    f32::INFINITY
                } else {
                    f32::NEG_INFINITY
                }
            }
            Fill::Huge => 1e30,
        }
    };
    for plane in 0..frame.planes() {
        let data = frame.data_mut(plane);
        match f.format {
            Sample::F32(_) => {
                for (n, chunk) in data.chunks_exact_mut(4).enumerate() {
                    chunk.copy_from_slice(&value(n).to_ne_bytes());
                }
            }
            Sample::I16(_) => {
                for (n, chunk) in data.chunks_exact_mut(2).enumerate() {
                    let v = (value(n).clamp(-1.0, 1.0) * 32767.0) as i16;
                    chunk.copy_from_slice(&v.to_ne_bytes());
                }
            }
            _ => {
                for (n, byte) in data.iter_mut().enumerate() {
                    *byte = (n % 251) as u8;
                }
            }
        }
    }
    frame
}

#[derive(Clone, Copy)]
pub enum AudioMuxerKind {
    Ogg,
    FragmentedM4a,
    Dash,
    /// Two sources mixed into the Instant muxer.
    Mixed,
}

async fn run_audio(
    ctx: &Ctx,
    muxer: AudioMuxerKind,
    script: &AudioScript,
) -> anyhow::Result<Verdict> {
    use futures::SinkExt;
    let timestamps = Timestamps::now();
    let output = match muxer {
        AudioMuxerKind::Ogg => ctx.path("audio.ogg"),
        AudioMuxerKind::FragmentedM4a => ctx.path("audio.m4a"),
        AudioMuxerKind::Dash | AudioMuxerKind::Mixed => ctx.path("audio"),
    };
    let (tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(64);
    let mut builder = OutputPipeline::builder(output.clone())
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(script.info, rx))
        .with_timestamps(timestamps);
    let mut second = None;
    if matches!(muxer, AudioMuxerKind::Mixed) {
        let (tx2, rx2) = futures::channel::mpsc::channel::<AudioFrame>(64);
        let stereo = AudioInfo::new_raw(F32, 48_000, 2);
        builder = builder
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(stereo, rx2));
        second = Some(tx2);
    }
    let built = match muxer {
        AudioMuxerKind::Ogg => builder.build::<OggMuxer>(OggMuxerConfig::default()).await,
        AudioMuxerKind::FragmentedM4a => {
            builder
                .build::<FragmentedAudioMuxer>(FragmentedAudioMuxerConfig {
                    shared_pause_state: None,
                    write_behind: false,
                })
                .await
        }
        AudioMuxerKind::Dash | AudioMuxerKind::Mixed => {
            builder
                .build::<DashSegmentedAudioMuxer>(DashSegmentedAudioMuxerConfig::default())
                .await
        }
    };
    let pipeline = match built {
        Ok(p) => p,
        Err(e) => return Ok(Verdict::rejected(format!("build: {e:#}"))),
    };
    let mut tx = tx;
    for (i, f) in script.frames.iter().enumerate() {
        if f.wait > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(f.wait)).await;
        }
        let at = timestamp(f.clock, timestamps);
        if let Some(second) = &mut second {
            let steady = AFrame {
                format: F32,
                rate: 48_000,
                channels: 2,
                samples: 960,
                fill: Fill::Tone,
                clock: Clock::Host(0.05 + i as f64 * 0.02),
                wait: 0.0,
            };
            let _ = second
                .send(AudioFrame::new(
                    audio_frame(&steady, i),
                    timestamp(steady.clock, timestamps),
                ))
                .await;
        }
        if tx
            .send(AudioFrame::new(audio_frame(f, i), at))
            .await
            .is_err()
        {
            break;
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let stopped = pipeline.stop().await;
    drop(tx);
    drop(second);
    match stopped {
        Err(e) => Ok(Verdict::rejected(format!("stop: {e:#}"))),
        Ok(_) => Ok(judge_output(&output, script.expect_media)),
    }
}

fn audio_probes(out: &mut Vec<Probe>) {
    for (muxer_name, muxer) in [
        ("ogg", AudioMuxerKind::Ogg),
        ("fragmented-m4a", AudioMuxerKind::FragmentedM4a),
        ("dash", AudioMuxerKind::Dash),
        ("mixed", AudioMuxerKind::Mixed),
    ] {
        for (name, script) in audio_scripts() {
            let full = !matches!(muxer, AudioMuxerKind::Ogg) && !FAST_AUDIO.contains(&name);
            let probe = Probe::new(
                format!("chaos/record/audio/{muxer_name}/{name}"),
                60,
                move |ctx| ctx.block_on(run_audio(ctx, muxer, &script)),
            );
            out.push(if full { probe.full() } else { probe });
        }
    }
}

/// Raw microphone callbacks through the real feed and `sources::Microphone`
/// (resampling to the recording format) into the Studio mic muxer.
#[derive(Clone, Debug)]
pub struct MicScript {
    pub rate: u32,
    pub channels: u16,
    /// (bytes, format, rate, channels) per callback.
    pub callbacks: Vec<MicCallback>,
    pub drop_feed_after: Option<usize>,
    pub expect_media: bool,
}

#[derive(Clone, Debug)]
pub struct MicCallback {
    pub bytes: usize,
    pub format: cpal::SampleFormat,
    pub rate: u32,
    pub channels: u16,
    pub fill: Fill,
}

fn mic_callbacks(rate: u32, channels: u16, secs: f64) -> Vec<MicCallback> {
    let per = ((f64::from(rate) * 0.01).round() as usize).max(1);
    (0..(secs / 0.01) as usize)
        .map(|_| MicCallback {
            bytes: per * usize::from(channels.max(1)) * 4,
            format: cpal::SampleFormat::F32,
            rate,
            channels,
            fill: Fill::Tone,
        })
        .collect()
}

pub fn mic_scripts() -> Vec<(&'static str, MicScript)> {
    let base = |name, rate: u32, channels: u16, expect_media| {
        (
            name,
            MicScript {
                rate,
                channels,
                callbacks: mic_callbacks(rate, channels, 0.8),
                drop_feed_after: None,
                expect_media,
            },
        )
    };
    let mut out = vec![
        base("control", 48_000, 1, true),
        base("rate-0", 0, 1, false),
        base("rate-1", 1, 1, false),
        base("rate-8000", 8_000, 1, true),
        base("rate-44101", 44_101, 2, true),
        base("rate-384000", 384_000, 2, true),
        base("channels-0", 48_000, 0, false),
        base("channels-3", 48_000, 3, true),
        base("channels-8", 48_000, 8, true),
        base("channels-32", 48_000, 32, true),
    ];
    let mut odd = base("odd-byte-lengths", 48_000, 2, true);
    for (i, c) in odd.1.callbacks.iter_mut().enumerate() {
        c.bytes = [1, 3, 5, 7, 4, 6, 9, 0][i % 8];
    }
    out.push(odd);
    let mut empty = base("empty-callbacks", 48_000, 1, false);
    for c in &mut empty.1.callbacks {
        c.bytes = 0;
    }
    out.push(empty);
    let mut huge = base("huge-callback", 48_000, 1, true);
    huge.1.callbacks[0].bytes = 48_000 * 4 * 30;
    out.push(huge);
    for (name, fill) in [("nan", Fill::Nan), ("inf", Fill::Inf)] {
        let mut s = base(name, 48_000, 1, true);
        for c in &mut s.1.callbacks {
            c.fill = fill;
        }
        out.push(s);
    }
    let mut change = base("format-changes", 48_000, 1, true);
    for (i, c) in change.1.callbacks.iter_mut().enumerate() {
        match (i / 10) % 5 {
            1 => {
                c.format = cpal::SampleFormat::I16;
                c.bytes /= 2;
            }
            2 => {
                c.rate = 44_100;
                c.channels = 2;
                c.bytes = 441 * 2 * 4;
            }
            3 => {
                c.format = cpal::SampleFormat::U8;
                c.bytes /= 4;
            }
            4 => {
                c.format = cpal::SampleFormat::I32;
                c.channels = 6;
                c.bytes = 480 * 6 * 4;
            }
            _ => {}
        }
    }
    out.push(change);
    let mut vanish = base("device-vanishes", 48_000, 1, true);
    vanish.1.drop_feed_after = Some(20);
    out.push(vanish);
    out
}

fn mic_bytes(c: &MicCallback, index: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(c.bytes);
    let mut n = 0usize;
    while out.len() < c.bytes {
        let v = match c.fill {
            Fill::Tone => (0.3 * ((index * 4096 + n) as f64 * 0.05).sin()) as f32,
            Fill::Nan => f32::NAN,
            Fill::Inf => f32::INFINITY,
            Fill::Huge => 1e30,
        };
        match c.format {
            cpal::SampleFormat::F32 => out.extend(v.to_ne_bytes()),
            cpal::SampleFormat::I16 => out.extend(((v * 32767.0) as i16).to_ne_bytes()),
            cpal::SampleFormat::I32 => out.extend(((v * 2.1e9) as i32).to_ne_bytes()),
            _ => out.push((v * 127.0 + 128.0) as u8),
        }
        n += 1;
    }
    out.truncate(c.bytes);
    out
}

async fn run_mic(ctx: &Ctx, script: &MicScript, fragmented: bool) -> anyhow::Result<Verdict> {
    use cap_recording::feeds::microphone::synthetic::SyntheticMicrophone;
    let mic = SyntheticMicrophone::spawn("Cap Chaos Microphone", script.rate, script.channels);
    let lock = match mic.lock().await {
        Ok(lock) => Arc::new(lock),
        Err(e) => return Ok(Verdict::rejected(format!("lock: {e:#}"))),
    };
    let timestamps = Timestamps::now();
    let output = if fragmented {
        ctx.path("audio-input.m4a")
    } else {
        ctx.path("audio-input.ogg")
    };
    let builder = OutputPipeline::builder(output.clone())
        .with_audio_source::<cap_recording::sources::Microphone>(lock.clone())
        .with_timestamps(timestamps);
    let built = if fragmented {
        builder
            .build::<FragmentedAudioMuxer>(FragmentedAudioMuxerConfig {
                shared_pause_state: None,
                write_behind: false,
            })
            .await
    } else {
        builder.build::<OggMuxer>(OggMuxerConfig::default()).await
    };
    let pipeline = match built {
        Ok(p) => p,
        Err(e) => return Ok(Verdict::rejected(format!("build: {e:#}"))),
    };
    let mut mic = Some(mic);
    for (i, c) in script.callbacks.iter().enumerate() {
        if script.drop_feed_after == Some(i) {
            mic = None;
        }
        let Some(feed) = &mic else { break };
        tokio::time::sleep(Duration::from_millis(10)).await;
        feed.push_raw(
            mic_bytes(c, i),
            c.format,
            c.rate,
            c.channels,
            host(timestamps, 0.05 + i as f64 * 0.01),
        )
        .await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let stopped = pipeline.stop().await;
    drop(mic);
    drop(lock);
    match stopped {
        Err(e) => Ok(Verdict::rejected(format!("stop: {e:#}"))),
        Ok(_) => Ok(judge_output(&output, script.expect_media)),
    }
}

fn mic_probes(out: &mut Vec<Probe>) {
    for (muxer, fragmented) in [("ogg", false), ("fragmented-m4a", true)] {
        for (name, script) in mic_scripts() {
            let probe = Probe::new(format!("chaos/record/mic/{muxer}/{name}"), 60, move |ctx| {
                ctx.block_on(run_mic(ctx, &script, fragmented))
            });
            out.push(
                if fragmented && name != "control" && name != "format-changes" {
                    probe.full()
                } else {
                    probe
                },
            );
        }
    }
}

pub fn probes() -> Vec<Probe> {
    let mut out = Vec::new();
    video_probes(&mut out);
    audio_probes(&mut out);
    mic_probes(&mut out);
    super::actors::probes(&mut out);
    out
}

#[cfg(target_os = "macos")]
pub use mac::sample as mac_sample;
