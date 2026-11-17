//! Fixtures recorded through the real recording pipeline.
//!
//! Synthetic sources (marker frames, marker audio) are fed through the same
//! channel sources the sync matrix uses into `OutputPipeline` with the
//! product's muxers and encoders (`Mp4Muxer` for screen and camera,
//! `OggMuxer` for microphone and system audio). Frames are emitted in real
//! time because the pipeline pins video timestamps to the wall clock, so a
//! fixture costs its duration; keep them short. The timing that lands in
//! the files is whatever the pipeline produced: tests read the truth back
//! from the files ([`crate::fixture::SourceTruth`]), never from the spec.

use std::{path::Path, time::Duration};

use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, RawVideoFormat, Sample, Type, VideoInfo};
use cap_project::{AudioMeta, MultipleSegment, VideoMeta};
use cap_recording::{
    AudioFrame, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
    ChannelVideoSourceConfig, OutputPipeline,
    ffmpeg::{FFmpegVideoFrame, Mp4Muxer, OggMuxer, OggMuxerConfig},
};
use cap_timestamp::{Timestamp, Timestamps};
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};

use crate::{
    audio_code::{self, AudioSource},
    fixture::{Rng, segment_dir, write_project_files},
    video_code::{self, FrameMarker, PixelOrder, StreamKind},
};

const AUDIO_RATE: u32 = 48_000;
const AUDIO_CHUNK_SECS: f64 = 0.02;

/// How a synthetic video device delivers frames.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Delivery {
    /// Every slot of the nominal rate.
    Steady,
    /// No frames inside the (start, length) windows: a static screen.
    Holds(Vec<(f64, f64)>),
    /// Slots skipped at random (1..=3 slots apart), like a camera in low
    /// light.
    Jittery { seed: u64 },
}

impl Delivery {
    /// The slots a device with this delivery emits over `duration` seconds:
    /// the generator's truth for what a recording must contain.
    pub fn slots(&self, fps: u32, duration: f64) -> Vec<u32> {
        let end = (duration * f64::from(fps)) as u32;
        match self {
            Delivery::Steady => (0..end).collect(),
            Delivery::Holds(holds) => (0..end)
                .filter(|&k| {
                    let t = f64::from(k) / f64::from(fps);
                    !holds.iter().any(|&(s, l)| t > s && t < s + l)
                })
                .collect(),
            Delivery::Jittery { seed } => {
                let mut rng = Rng::new(*seed);
                let mut out = Vec::new();
                let mut k = 0;
                while k < end {
                    out.push(k);
                    k += rng.range(1, 3) as u32;
                }
                out
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecordedVideo {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub delivery: Delivery,
    /// Seconds after the segment starts before the device delivers.
    pub start_delay: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecordedSegment {
    pub duration: f64,
    pub screen: RecordedVideo,
    pub camera: Option<RecordedVideo>,
    /// Microphone starting this many seconds in (continuous delivery).
    pub mic_delay: Option<f64>,
    /// System audio delivered loopback-style (packets only while a marker
    /// plays; the recorder synthesises the silence between).
    pub system_audio: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecordedSpec {
    pub name: String,
    pub segments: Vec<RecordedSegment>,
}

impl RecordedSpec {
    /// Key for the fixture cache: the spec plus the recording code that made
    /// the fixture ([`product_source_hash`]).
    pub fn cache_key(&self) -> String {
        crate::fixture::cache_key(&self.name, &(self, product_source_hash()))
    }
}

/// Workspace crates whose code shapes a recorded fixture (capture pipeline,
/// muxers, encoders, timestamps, audio conversion).
const RECORDING_SOURCE_CRATES: &[&str] = &[
    "recording",
    "cap-muxer",
    "cap-muxer-protocol",
    "enc-ffmpeg",
    "enc-avfoundation",
    "enc-mediafoundation",
    "media-info",
    "media",
    "timestamp",
    "audio",
    "frame-converter",
    "project",
];

/// Hash of the product sources that recorded fixtures are made by. Recorded
/// fixtures are product output: keying them by the spec alone would let a
/// cached fixture recorded by older code (the CI fixture cache is keyed by
/// the generator sources only) hide a regression in the recording pipeline.
/// With this in the key, any change to those crates, to Cargo.lock or to
/// this recorder harness re-records the fixtures.
pub fn product_source_hash() -> u64 {
    static HASH: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *HASH.get_or_init(|| {
        fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n != "target") {
                        collect(&path, out);
                    }
                } else if path
                    .extension()
                    .is_some_and(|e| e == "rs" || e == "toml" || e == "wgsl" || e == "metal")
                {
                    out.push(path);
                }
            }
        }
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = manifest
            .join("../..")
            .canonicalize()
            .unwrap_or_else(|_| manifest.join("../.."));
        let mut files = Vec::new();
        for name in RECORDING_SOURCE_CRATES {
            collect(&root.join("crates").join(name), &mut files);
        }
        files.push(root.join("Cargo.lock"));
        files.push(root.join("crates/verify/src/pipeline.rs"));
        files.sort();
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for &byte in bytes {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
        };
        for file in &files {
            let Ok(contents) = std::fs::read(file) else {
                continue;
            };
            feed(
                file.strip_prefix(&root)
                    .unwrap_or(file)
                    .to_string_lossy()
                    .as_bytes(),
            );
            feed(&contents);
        }
        hash
    })
}

fn bgra_frame(marker: FrameMarker, width: u32, height: u32) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, width, height);
    let stride = frame.stride(0);
    video_code::draw_marker(
        marker,
        frame.data_mut(0),
        width as usize,
        height as usize,
        stride,
        PixelOrder::Bgra,
    );
    frame
}

/// Marker track for a whole segment, mono, sample 0 = segment start.
fn marker_track(source: AudioSource, duration: f64) -> Vec<f32> {
    let mut mono = vec![0.0f32; (duration * f64::from(AUDIO_RATE)) as usize];
    let schedule = audio_code::standard_schedule(source, 0.1, duration - 0.1, 0.5);
    audio_code::render_markers(
        &mut mono,
        AUDIO_RATE,
        source,
        &schedule,
        audio_code::DEFAULT_AMPLITUDE,
    );
    mono
}

fn audio_chunk(track: &[f32], chunk_t: f64, info: &AudioInfo) -> ffmpeg::frame::Audio {
    let frames = (f64::from(AUDIO_RATE) * AUDIO_CHUNK_SECS) as usize;
    let mut frame = ffmpeg::frame::Audio::new(
        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
        frames,
        info.channel_layout(),
    );
    frame.set_rate(AUDIO_RATE);
    let start = (chunk_t * f64::from(AUDIO_RATE)).round() as usize;
    let channels = usize::from(info.channels as u16);
    let data = frame.data_mut(0);
    for (i, sample) in data.chunks_exact_mut(4 * channels).enumerate() {
        let v = track.get(start + i).copied().unwrap_or(0.0);
        for ch in sample.chunks_exact_mut(4) {
            ch.copy_from_slice(&v.to_le_bytes());
        }
    }
    frame
}

/// Emitters wait for this before their first frame, so every device starts
/// delivering only once all pipelines are built. Emitting from the pipeline
/// epoch instead queued the frames of a slow setup and delivered them as a
/// burst, which the recorder (rightly) treats as stale overlap and drops.
type StartGate = tokio::sync::watch::Receiver<Option<std::time::Instant>>;

async fn started(mut gate: StartGate) -> std::time::Instant {
    loop {
        if let Some(base) = *gate.borrow() {
            return base;
        }
        if gate.changed().await.is_err() {
            return std::time::Instant::now();
        }
    }
}

struct VideoLeg {
    pipeline: OutputPipeline,
    emit: tokio::task::JoinHandle<()>,
    rel: RelativePathBuf,
    fps: u32,
}

#[allow(clippy::too_many_arguments)]
async fn video_leg(
    dir: &Path,
    rel: RelativePathBuf,
    kind: StreamKind,
    segment: u8,
    video: &RecordedVideo,
    duration: f64,
    timestamps: Timestamps,
    start: StartGate,
) -> anyhow::Result<VideoLeg> {
    let info = VideoInfo::from_raw(RawVideoFormat::Bgra, video.width, video.height, video.fps);
    let (tx, rx) = flume::bounded::<FFmpegVideoFrame>(32);
    let slots = video
        .delivery
        .slots(video.fps, duration - video.start_delay);
    let (fps, width, height, delay) = (video.fps, video.width, video.height, video.start_delay);
    let emit = tokio::spawn(async move {
        let base = started(start).await;
        for slot in slots {
            let t = delay + f64::from(slot) / f64::from(fps);
            let at = base + Duration::from_secs_f64(t);
            tokio::time::sleep_until(at.into()).await;
            let frame = FFmpegVideoFrame {
                inner: bgra_frame(FrameMarker::new(kind, segment, slot), width, height),
                timestamp: Timestamp::Instant(at),
            };
            if tx.send_async(frame).await.is_err() {
                break;
            }
        }
    });
    let pipeline = OutputPipeline::builder(dir.join(rel.as_str()))
        .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(info, rx))
        .with_timestamps(timestamps)
        .build::<Mp4Muxer>(())
        .await
        .map_err(|e| anyhow!("{kind:?} pipeline: {e}"))?;
    Ok(VideoLeg {
        pipeline,
        emit,
        rel,
        fps: video.fps,
    })
}

type AudioEmit = tokio::task::JoinHandle<futures::channel::mpsc::Sender<AudioFrame>>;

async fn record_segment(
    dir: &Path,
    index: usize,
    spec: &RecordedSegment,
) -> anyhow::Result<MultipleSegment> {
    let seg = segment_dir(index);
    std::fs::create_dir_all(dir.join(&seg))?;
    let rel = |file: &str| RelativePathBuf::from(format!("{seg}/{file}"));
    let timestamps = Timestamps::now();
    let (start_tx, start) = tokio::sync::watch::channel(None);

    let screen = video_leg(
        dir,
        rel("display.mp4"),
        StreamKind::Screen,
        index as u8,
        &spec.screen,
        spec.duration,
        timestamps,
        start.clone(),
    )
    .await?;
    let camera = match &spec.camera {
        Some(camera) => Some(
            video_leg(
                dir,
                rel("camera.mp4"),
                StreamKind::Camera,
                index as u8,
                camera,
                spec.duration,
                timestamps,
                start.clone(),
            )
            .await?,
        ),
        None => None,
    };

    let mono_info = AudioInfo::new(Sample::F32(Type::Packed), AUDIO_RATE, 1)
        .map_err(|e| anyhow!("audio info: {e:?}"))?;
    let stereo_info = AudioInfo::new(Sample::F32(Type::Packed), AUDIO_RATE, 2)
        .map_err(|e| anyhow!("audio info: {e:?}"))?;

    let mut mic: Option<(OutputPipeline, AudioEmit, RelativePathBuf)> = None;
    if let Some(delay) = spec.mic_delay {
        let track = marker_track(AudioSource::Mic, spec.duration);
        let (mut tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
        let duration = spec.duration;
        let gate = start.clone();
        let emit = tokio::spawn(async move {
            use futures::SinkExt;
            let base = started(gate).await;
            let first = (delay / AUDIO_CHUNK_SECS).ceil() as usize;
            let last = (duration / AUDIO_CHUNK_SECS) as usize;
            for k in first..last {
                let t = k as f64 * AUDIO_CHUNK_SECS;
                let at = base + Duration::from_secs_f64(t);
                tokio::time::sleep_until(at.into()).await;
                let frame =
                    AudioFrame::new(audio_chunk(&track, t, &mono_info), Timestamp::Instant(at));
                if tx.send(frame).await.is_err() {
                    break;
                }
            }
            tx
        });
        let pipeline = OutputPipeline::builder(dir.join(rel("audio-input.ogg").as_str()))
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(mono_info, rx))
            .with_timestamps(timestamps)
            .build::<OggMuxer>(OggMuxerConfig::default())
            .await
            .map_err(|e| anyhow!("mic pipeline: {e}"))?;
        mic = Some((pipeline, emit, rel("audio-input.ogg")));
    }

    let mut system: Option<(OutputPipeline, AudioEmit, RelativePathBuf)> = None;
    if spec.system_audio {
        let track = marker_track(AudioSource::System, spec.duration);
        let schedule =
            audio_code::standard_schedule(AudioSource::System, 0.1, spec.duration - 0.1, 0.5);
        let (mut tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
        let gate = start.clone();
        let emit = tokio::spawn(async move {
            use futures::SinkExt;
            let base = started(gate).await;
            for placement in schedule {
                let first = (placement.time_secs / AUDIO_CHUNK_SECS).floor() as usize;
                let last = ((placement.time_secs + audio_code::MARKER_SECS) / AUDIO_CHUNK_SECS)
                    .ceil() as usize;
                for k in first..last {
                    let t = k as f64 * AUDIO_CHUNK_SECS;
                    let at = base + Duration::from_secs_f64(t);
                    tokio::time::sleep_until(at.into()).await;
                    let frame = AudioFrame::new(
                        audio_chunk(&track, t, &stereo_info),
                        Timestamp::Instant(at),
                    );
                    if tx.send(frame).await.is_err() {
                        return tx;
                    }
                }
            }
            tx
        });
        let pipeline = OutputPipeline::builder(dir.join(rel("system_audio.ogg").as_str()))
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(stereo_info, rx))
            .with_timestamps(timestamps)
            .with_audio_anchor(cap_recording::AudioAnchor::PipelineEpoch)
            .build::<OggMuxer>(OggMuxerConfig::default())
            .await
            .map_err(|e| anyhow!("system audio pipeline: {e}"))?;
        system = Some((pipeline, emit, rel("system_audio.ogg")));
    }

    let _ = start_tx.send(Some(std::time::Instant::now() + Duration::from_millis(50)));

    // Wait for every device to finish delivering, keeping the audio senders
    // open (real devices deliver until stop), then stop like the recorder.
    screen.emit.await.context("screen emit")?;
    let camera = match camera {
        Some(leg) => {
            let VideoLeg {
                pipeline,
                emit,
                rel,
                fps,
            } = leg;
            emit.await.context("camera emit")?;
            Some((pipeline, rel, fps))
        }
        None => None,
    };
    let mut held = Vec::new();
    let mut audio_pipelines = Vec::new();
    for (name, leg) in [("mic", mic), ("system", system)] {
        if let Some((pipeline, emit, rel)) = leg {
            held.push(emit.await.context("audio emit")?);
            audio_pipelines.push((name, pipeline, rel));
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let finished_screen = screen
        .pipeline
        .stop()
        .await
        .map_err(|e| anyhow!("screen stop: {e}"))?;
    let start = |first: Timestamp| first.signed_duration_since_secs(timestamps);
    let display = VideoMeta {
        path: screen.rel,
        fps: screen.fps,
        start_time: Some(start(finished_screen.first_timestamp)),
        device_id: None,
    };
    let camera = match camera {
        Some((pipeline, rel, fps)) => {
            let finished = pipeline
                .stop()
                .await
                .map_err(|e| anyhow!("camera stop: {e}"))?;
            Some(VideoMeta {
                path: rel,
                fps,
                start_time: Some(start(finished.first_timestamp)),
                device_id: None,
            })
        }
        None => None,
    };
    let mut mic_meta = None;
    let mut system_meta = None;
    for (name, pipeline, rel) in audio_pipelines {
        let finished = pipeline
            .stop()
            .await
            .map_err(|e| anyhow!("{name} stop: {e}"))?;
        let meta = AudioMeta {
            path: rel,
            start_time: Some(start(finished.first_timestamp)),
            device_id: None,
            gap_summary: finished
                .audio_gap_summary
                .map(|s| cap_project::AudioGapSummary {
                    total_overlap_trimmed_ms: s.total_overlap_trimmed_ms,
                    startup_overlap_trimmed_ms: s.startup_overlap_trimmed_ms,
                    overlap_dropped_frames: s.overlap_dropped_frames,
                    startup_overlap_drops: s.startup_overlap_drops,
                }),
            digital_silence_ms: finished.digital_silence_ms,
        };
        if name == "mic" {
            mic_meta = Some(meta);
        } else {
            system_meta = Some(meta);
        }
    }
    drop(held);
    Ok(MultipleSegment {
        display,
        camera,
        mic: mic_meta,
        system_audio: system_meta,
        cursor: None,
        keyboard: None,
        display_notch: None,
    })
}

/// The emitters sleep until each frame's time. Windows wakes timers on its
/// default 15.6 ms tick, which by itself makes frames up to a tick late
/// (more under load); the product raises the timer resolution the same way
/// for playback and export.
fn high_resolution_timer() {
    #[cfg(windows)]
    {
        #[link(name = "winmm")]
        unsafe extern "system" {
            fn timeBeginPeriod(period: u32) -> u32;
        }
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            assert_eq!(
                unsafe { timeBeginPeriod(1) },
                0,
                "set Windows timer resolution"
            );
        });
    }
}

pub async fn record_studio(spec: &RecordedSpec, dir: &Path) -> anyhow::Result<()> {
    high_resolution_timer();
    crate::media::init();
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    let mut segments = Vec::new();
    for (i, segment) in spec.segments.iter().enumerate() {
        segments.push(record_segment(dir, i, segment).await?);
    }
    write_project_files(dir, &spec.name, segments)?;
    Ok(())
}

/// An Instant recording: segmented screen video and one mixed audio track
/// (microphone and system audio) through the Instant muxers, finalised into
/// `content/output.mp4` by the product's `finalize_instant_output`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct InstantSpec {
    pub name: String,
    pub duration: f64,
    pub screen: RecordedVideo,
    pub mic_delay: Option<f64>,
    pub system_audio: bool,
    /// System audio delivered continuously from the start (macOS capture)
    /// instead of loopback-style packets only while a marker plays.
    #[serde(default)]
    pub system_continuous: bool,
    /// Arm a recording start gate this many seconds after the sources start
    /// (the app's start cue); `None` records from the first frame.
    #[serde(default)]
    pub arm_at: Option<f64>,
}

impl InstantSpec {
    /// Key for the fixture cache, including [`product_source_hash`].
    pub fn cache_key(&self) -> String {
        crate::fixture::cache_key(
            &format!("instant-{}", self.name),
            &(self, product_source_hash()),
        )
    }
}

/// Where each marker was emitted, on the recording clock (seconds after the
/// pipeline epoch). Written next to the project as `verify-emitted.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Emitted {
    /// (slot, emit time) of every screen frame.
    pub screen: Vec<(u32, f64)>,
    pub fps: u32,
    /// (source, marker index, chirp time) of every audio marker.
    pub audio: Vec<(AudioSource, u32, f64)>,
    /// (slot, time the frame was actually handed to the pipeline), to tell a
    /// late emitter (a starved test runtime) from late processing.
    #[serde(default)]
    pub screen_sent: Vec<(u32, f64)>,
}

pub async fn record_instant(spec: &InstantSpec, dir: &Path) -> anyhow::Result<()> {
    high_resolution_timer();
    use cap_recording::{DashSegmentedAudioMuxer, DashSegmentedAudioMuxerConfig};
    crate::media::init();
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    let content = dir.join("content");
    std::fs::create_dir_all(&content)?;
    let timestamps = Timestamps::now();
    let base = timestamps.instant();
    // Mirrors the product's Instant gate: the screen track starts at the arm
    // point, where the epoch-anchored audio below starts.
    let gate = spec.arm_at.map(|_| {
        let gate = cap_recording::RecordingStartGate::new();
        gate.set_video_origin_at_arm();
        gate
    });
    let mut emitted = Emitted {
        fps: spec.screen.fps,
        ..Default::default()
    };

    let video = &spec.screen;
    let info = VideoInfo::from_raw(RawVideoFormat::Bgra, video.width, video.height, video.fps);
    let (tx, rx) = flume::bounded::<FFmpegVideoFrame>(32);
    let slots = video
        .delivery
        .slots(video.fps, spec.duration - video.start_delay);
    for &slot in &slots {
        emitted.screen.push((
            slot,
            video.start_delay + f64::from(slot) / f64::from(video.fps),
        ));
    }
    let (fps, width, height, delay) = (video.fps, video.width, video.height, video.start_delay);
    let video_emit = tokio::spawn(async move {
        let mut sent = Vec::new();
        for slot in slots {
            let t = delay + f64::from(slot) / f64::from(fps);
            let at = base + Duration::from_secs_f64(t);
            tokio::time::sleep_until(at.into()).await;
            let frame = FFmpegVideoFrame {
                inner: bgra_frame(FrameMarker::new(StreamKind::Screen, 0, slot), width, height),
                timestamp: Timestamp::Instant(at),
            };
            if tx.send_async(frame).await.is_err() {
                break;
            }
            sent.push((slot, base.elapsed().as_secs_f64()));
        }
        sent
    });
    let mut video_builder = OutputPipeline::builder(content.join("display"))
        .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(info, rx))
        .with_timestamps(timestamps);
    if let Some(gate) = &gate {
        video_builder = video_builder.with_start_gate(Some(gate.clone()));
    }
    let video_pipeline = video_builder
        .build::<cap_recording::ffmpeg::SegmentedVideoMuxer>(
            cap_recording::ffmpeg::SegmentedVideoMuxerConfig {
                segment_duration: Duration::from_secs(2),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| anyhow!("instant video pipeline: {e}"))?;

    let mono_info = AudioInfo::new(Sample::F32(Type::Packed), AUDIO_RATE, 1)
        .map_err(|e| anyhow!("audio info: {e:?}"))?;
    let stereo_info = AudioInfo::new(Sample::F32(Type::Packed), AUDIO_RATE, 2)
        .map_err(|e| anyhow!("audio info: {e:?}"))?;
    let mut audio_emits: Vec<AudioEmit> = Vec::new();
    let mut builder = OutputPipeline::builder(content.join("audio")).with_timestamps(timestamps);
    if let Some(gate) = &gate {
        builder = builder.with_start_gate(Some(gate.clone()));
    }
    // Mirrors the product's Instant audio pipeline: anchored at the recording
    // epoch behind a start gate, and on Linux.
    if gate.is_some() || cfg!(target_os = "linux") {
        builder = builder.with_audio_anchor(cap_recording::AudioAnchor::PipelineEpoch);
    }
    let has_audio = spec.mic_delay.is_some() || spec.system_audio;
    if spec.system_audio {
        let track = marker_track(AudioSource::System, spec.duration);
        let schedule =
            audio_code::standard_schedule(AudioSource::System, 0.1, spec.duration - 0.1, 0.5);
        emitted.audio.extend(
            schedule
                .iter()
                .map(|p| (AudioSource::System, p.index, p.time_secs)),
        );
        let (mut tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
        let continuous = spec.system_continuous;
        let duration = spec.duration;
        audio_emits.push(tokio::spawn(async move {
            use futures::SinkExt;
            if continuous {
                for k in 0..(duration / AUDIO_CHUNK_SECS) as usize {
                    let t = k as f64 * AUDIO_CHUNK_SECS;
                    let at = base + Duration::from_secs_f64(t);
                    tokio::time::sleep_until(at.into()).await;
                    let frame = AudioFrame::new(
                        audio_chunk(&track, t, &stereo_info),
                        Timestamp::Instant(at),
                    );
                    if tx.send(frame).await.is_err() {
                        break;
                    }
                }
                return tx;
            }
            for placement in schedule {
                let first = (placement.time_secs / AUDIO_CHUNK_SECS).floor() as usize;
                let last = ((placement.time_secs + audio_code::MARKER_SECS) / AUDIO_CHUNK_SECS)
                    .ceil() as usize;
                for k in first..last {
                    let t = k as f64 * AUDIO_CHUNK_SECS;
                    let at = base + Duration::from_secs_f64(t);
                    tokio::time::sleep_until(at.into()).await;
                    let frame = AudioFrame::new(
                        audio_chunk(&track, t, &stereo_info),
                        Timestamp::Instant(at),
                    );
                    if tx.send(frame).await.is_err() {
                        return tx;
                    }
                }
            }
            tx
        }));
        builder = builder.with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
            stereo_info,
            rx,
        ));
    }
    if let Some(delay) = spec.mic_delay {
        let track = marker_track(AudioSource::Mic, spec.duration);
        let schedule =
            audio_code::standard_schedule(AudioSource::Mic, 0.1, spec.duration - 0.1, 0.5);
        emitted.audio.extend(
            schedule
                .iter()
                .filter(|p| p.time_secs >= delay)
                .map(|p| (AudioSource::Mic, p.index, p.time_secs)),
        );
        let (mut tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
        let duration = spec.duration;
        audio_emits.push(tokio::spawn(async move {
            use futures::SinkExt;
            let first = (delay / AUDIO_CHUNK_SECS).ceil() as usize;
            let last = (duration / AUDIO_CHUNK_SECS) as usize;
            for k in first..last {
                let t = k as f64 * AUDIO_CHUNK_SECS;
                let at = base + Duration::from_secs_f64(t);
                tokio::time::sleep_until(at.into()).await;
                let frame =
                    AudioFrame::new(audio_chunk(&track, t, &mono_info), Timestamp::Instant(at));
                if tx.send(frame).await.is_err() {
                    break;
                }
            }
            tx
        }));
        builder = builder
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(mono_info, rx));
    }
    let audio_pipeline = if has_audio {
        Some(
            builder
                .build::<DashSegmentedAudioMuxer>(DashSegmentedAudioMuxerConfig::default())
                .await
                .map_err(|e| anyhow!("instant audio pipeline: {e}"))?,
        )
    } else {
        None
    };

    if let (Some(gate), Some(arm_at)) = (&gate, spec.arm_at) {
        tokio::time::sleep_until((base + Duration::from_secs_f64(arm_at)).into()).await;
        gate.arm();
    }
    emitted.screen_sent = video_emit.await.context("video emit")?;
    let mut held = Vec::new();
    for emit in audio_emits {
        held.push(emit.await.context("audio emit")?);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    video_pipeline
        .stop()
        .await
        .map_err(|e| anyhow!("instant video stop: {e}"))?;
    if let Some(audio) = audio_pipeline {
        audio
            .stop()
            .await
            .map_err(|e| anyhow!("instant audio stop: {e}"))?;
    }
    drop(held);
    let output = content.join("output.mp4");
    let display_dir = content.join("display");
    let audio_dir = content.join("audio");
    if !audio_dir.exists() {
        std::fs::create_dir_all(&audio_dir)?;
    }
    tokio::task::spawn_blocking(move || {
        cap_recording::recovery::RecoveryManager::finalize_instant_output(
            &display_dir,
            &audio_dir,
            &output,
        )
    })
    .await?
    .map_err(|e| anyhow!("finalize instant output: {e}"))?;
    let meta = cap_project::RecordingMeta {
        platform: Some(cap_project::Platform::default()),
        project_path: dir.to_path_buf(),
        pretty_name: spec.name.clone(),
        sharing: None,
        inner: cap_project::RecordingMetaInner::Instant(
            cap_project::InstantRecordingMeta::Complete {
                fps: spec.screen.fps,
                sample_rate: has_audio.then_some(AUDIO_RATE),
            },
        ),
        upload: None,
    };
    meta.save_for_project()
        .map_err(|e| anyhow!("save instant meta: {e:?}"))?;
    if let Some(arm_at) = spec.arm_at {
        // Frames and markers within a frame of the arm instant may land on
        // either side of it.
        let margin = 0.05;
        emitted.screen.retain(|e| e.1 >= arm_at + margin);
        emitted.audio.retain(|e| e.2 >= arm_at + margin);
    }
    std::fs::write(
        dir.join("verify-emitted.json"),
        serde_json::to_string(&emitted)?,
    )?;
    Ok(())
}

/// Records one epoch-anchored audio track the way the product records
/// loopback system audio (`AudioAnchor::PipelineEpoch`, no start gate):
/// the first captured frame is stamped `head` seconds after the pipeline
/// epoch and a continuous 1 kHz tone follows for `tone` seconds, in 20 ms
/// chunks delivered in real time. Returns the file and the track start the
/// pipeline reports, in seconds after the epoch.
pub async fn record_epoch_audio(
    dir: &Path,
    head: f64,
    tone: f64,
) -> anyhow::Result<(std::path::PathBuf, f64)> {
    let stereo_info = AudioInfo::new(Sample::F32(Type::Packed), AUDIO_RATE, 2)
        .map_err(|e| anyhow!("audio info: {e:?}"))?;
    let samples = (tone * f64::from(AUDIO_RATE)) as usize;
    let track: Vec<f32> = (0..samples)
        .map(|n| {
            let t = n as f64 / f64::from(AUDIO_RATE);
            (0.5 * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()) as f32
        })
        .collect();
    let path = dir.join("system_audio.ogg");
    let timestamps = Timestamps::now();
    let (mut tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
    let pipeline = OutputPipeline::builder(path.clone())
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(stereo_info, rx))
        .with_timestamps(timestamps)
        .with_audio_anchor(cap_recording::AudioAnchor::PipelineEpoch)
        .build::<OggMuxer>(OggMuxerConfig::default())
        .await
        .map_err(|e| anyhow!("epoch audio pipeline: {e}"))?;
    {
        use futures::SinkExt;
        let chunks = (tone / AUDIO_CHUNK_SECS).round() as usize;
        for k in 0..chunks {
            let t = k as f64 * AUDIO_CHUNK_SECS;
            let at = timestamps.instant() + Duration::from_secs_f64(head + t);
            tokio::time::sleep_until(at.into()).await;
            let frame =
                AudioFrame::new(audio_chunk(&track, t, &stereo_info), Timestamp::Instant(at));
            tx.send(frame)
                .await
                .map_err(|e| anyhow!("send audio: {e}"))?;
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let finished = pipeline
        .stop()
        .await
        .map_err(|e| anyhow!("epoch audio stop: {e}"))?;
    drop(tx);
    Ok((
        path,
        finished
            .first_timestamp
            .signed_duration_since_secs(timestamps),
    ))
}
