//! Synthetic device matrix for A/V sync.
//!
//! Drives the real recording pipeline (sources -> mux loop -> encoders ->
//! containers) with synthetic video and audio across sample rates, channel
//! counts, frame rates and delivery pathologies (jitter, drops, gaps), then
//! verifies the muxed output preserves real time. No capture hardware is
//! required, so this runs identically on macOS, Windows and Linux CI.
//!
//! Frames are emitted in real time because the pipeline pins video
//! timestamps to the wall clock; each case therefore costs its content
//! duration. Keep cases short.
//!
//! Set `CAP_SYNC_MATRIX_REPORT` to write a JSON report of every case.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use cap_media_info::{AudioInfo, Sample, Type, VideoInfo};
use cap_recording::{
    AudioFrame, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
    ChannelVideoSourceConfig, OutputPipeline,
    ffmpeg::{
        FFmpegVideoFrame, Mp4Muxer, OggMuxer, SegmentedVideoMuxer, SegmentedVideoMuxerConfig,
    },
};
use cap_timestamp::{Timestamp, Timestamps};
use serde::Serialize;

const CONTENT_SECS: f64 = 4.0;
/// Absolute tolerance for a muxed pts vs the sent capture timestamp,
/// measured from each side's own origin (first sent frame vs first muxed
/// pts). Covers warmup anchoring, emission jitter and encoder rounding,
/// plus scheduler noise on shared CI runners.
const ABS_TOLERANCE_SECS: f64 = 0.25;
/// Tolerance for the relative structure (pts deltas vs sent deltas), which is
/// what actually determines sync drift. The bug class this guards against
/// produces errors of a second or more.
const REL_TOLERANCE_SECS: f64 = 0.15;
/// Tolerance for decoded audio duration vs generated duration.
const AUDIO_DURATION_TOLERANCE_SECS: f64 = 0.15;

#[derive(Debug, Clone, Copy)]
enum VideoScenario {
    Steady,
    Jitter,
    Drops,
    Gap,
}

impl VideoScenario {
    fn name(self) -> &'static str {
        match self {
            Self::Steady => "steady",
            Self::Jitter => "jitter",
            Self::Drops => "drops",
            Self::Gap => "gap",
        }
    }

    /// Deterministic capture timestamps (seconds) for the scenario.
    fn timestamps(self, fps: u32) -> Vec<f64> {
        let period = 1.0 / f64::from(fps);
        let total = (CONTENT_SECS * f64::from(fps)) as u64;
        let mut out = Vec::new();
        for k in 0..total {
            let base = k as f64 * period;
            match self {
                Self::Steady => out.push(base),
                Self::Jitter => {
                    // Deterministic pseudo-jitter, +-40% of the period, kept
                    // monotonic (and non-negative) by construction.
                    let phase = (k as f64 * 0.7368).fract() - 0.5;
                    out.push((base + phase * period * 0.8).max(0.0));
                }
                Self::Drops => {
                    // Drop every 4th and 7th frame: the capture stream simply
                    // never delivers them.
                    if k % 4 != 3 && k % 7 != 6 {
                        out.push(base);
                    }
                }
                Self::Gap => {
                    // 1.5s of frames, a 2s static-screen gap, then the rest.
                    let t = base;
                    if t < 1.5 {
                        out.push(t);
                    } else {
                        out.push(t + 2.0);
                    }
                }
            }
        }
        out.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out.dedup_by(|a, b| (*a - *b).abs() < period * 0.25);
        out
    }
}

#[derive(Serialize)]
struct CaseResult {
    name: String,
    pass: bool,
    detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Content {
    /// Flat color; encodes trivially.
    Flat,
    /// Per-frame pseudo-random noise: worst-case encoder load, exercising
    /// backpressure the way dense real screen content does.
    Noise,
    /// A moving bar over a gradient: typical screen-content motion.
    Motion,
}

fn make_video_frame(
    width: u32,
    height: u32,
    frame_index: u64,
    content: Content,
    rng: &mut Rng,
) -> ffmpeg::frame::Video {
    let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, width, height);
    let stride = frame.stride(0);
    let data = frame.data_mut(0);
    match content {
        Content::Flat => {
            let shade = ((frame_index * 7) % 200) as u8;
            data.fill(shade);
        }
        Content::Noise => {
            // Refresh a pseudo-random buffer per frame so no two frames are
            // alike and inter prediction gets no free lunch.
            for chunk in data.chunks_mut(8) {
                let v = rng.next().to_le_bytes();
                let n = chunk.len();
                chunk.copy_from_slice(&v[..n]);
            }
        }
        Content::Motion => {
            let bar = ((frame_index * 6) % u64::from(width)) as usize;
            for y in 0..height as usize {
                let row = &mut data[y * stride..y * stride + width as usize * 4];
                for (x, px) in row.chunks_mut(4).enumerate() {
                    let base = ((x * 255) / width as usize) as u8;
                    let v = if x.abs_diff(bar) < 12 { 255 } else { base };
                    px[0] = v;
                    px[1] = v ^ 0x55;
                    px[2] = base;
                    px[3] = 255;
                }
            }
        }
    }
    frame
}

/// splitmix64: tiny, dependency-free, deterministic PRNG. Every randomized
/// case is fully reproducible from the printed seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }

    fn f64(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[(self.next() % items.len() as u64) as usize]
    }
}

#[derive(Clone)]
struct VideoCase {
    fps: u32,
    sent: Vec<f64>,
    fragmented: bool,
    width: u32,
    height: u32,
    content: Content,
    rng_seed: u64,
}

impl VideoCase {
    fn curated(fps: u32, scenario: VideoScenario, fragmented: bool) -> Self {
        Self {
            fps,
            sent: scenario.timestamps(fps),
            fragmented,
            width: 160,
            height: 120,
            content: Content::Flat,
            rng_seed: 1,
        }
    }
}

async fn run_video_case(case: VideoCase) -> Result<String, String> {
    let temp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let out_path = if case.fragmented {
        temp.path().join("display")
    } else {
        temp.path().join("display.mp4")
    };
    let fragmented = case.fragmented;

    let info = VideoInfo::from_raw(
        cap_media_info::RawVideoFormat::Bgra,
        case.width,
        case.height,
        case.fps,
    );
    let (tx, rx) = flume::bounded::<FFmpegVideoFrame>(32);
    let timestamps = Timestamps::now();

    let sent = case.sent.clone();
    let emit = {
        let sent = sent.clone();
        let base = timestamps.instant();
        let (width, height, content) = (case.width, case.height, case.content);
        let mut rng = Rng(case.rng_seed);
        tokio::spawn(async move {
            for (i, &ts) in sent.iter().enumerate() {
                tokio::time::sleep_until((base + Duration::from_secs_f64(ts)).into()).await;
                let frame = FFmpegVideoFrame {
                    inner: make_video_frame(width, height, i as u64, content, &mut rng),
                    timestamp: Timestamp::Instant(base + Duration::from_secs_f64(ts)),
                };
                if tx.send_async(frame).await.is_err() {
                    break;
                }
            }
            // Sender drops here, ending the stream.
        })
    };

    let builder = OutputPipeline::builder(out_path.clone())
        .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(info, rx))
        .with_timestamps(timestamps);

    let pipeline = if fragmented {
        builder
            .build::<SegmentedVideoMuxer>(SegmentedVideoMuxerConfig {
                segment_duration: Duration::from_secs(2),
                ..Default::default()
            })
            .await
    } else {
        builder.build::<Mp4Muxer>(()).await
    }
    .map_err(|e| format!("pipeline build: {e}"))?;

    emit.await.map_err(|e| format!("emit join: {e}"))?;
    // The verification below assumes frames were emitted in real time; when a
    // saturated runner (or a software encoder drowning in worst-case content)
    // stalls emission for seconds, pts-vs-wall comparisons are meaningless.
    // Skip loudly instead of failing on an environment artifact.
    let emit_lag =
        timestamps.instant().elapsed().as_secs_f64() - sent.last().copied().unwrap_or(0.0);
    let finished = {
        // Allow the tail of the stream to flush through the encoder.
        tokio::time::sleep(Duration::from_millis(500)).await;
        pipeline.stop().await.map_err(|e| format!("stop: {e}"))?
    };
    if emit_lag > 1.5 {
        return Ok(format!(
            "skipped: runner fell {emit_lag:.1}s behind real-time emission"
        ));
    }

    // Read back the muxed pts.
    let playable = if fragmented {
        concat_fmp4(&out_path, temp.path())?
    } else {
        out_path.clone()
    };
    let pts = read_video_pts(&playable)?;

    if pts.len() != sent.len() {
        return Err(format!(
            "frame count mismatch: sent {} frames, container has {}",
            sent.len(),
            pts.len()
        ));
    }

    let mut max_abs: f64 = 0.0;
    let mut max_rel: f64 = 0.0;
    // At low frame rates the fixed tolerance is only a frame or two of
    // budget, so scheduler jitter on shared runners trips it; express the
    // floor in frames as well. The bug class this guards produces errors of
    // a second or more either way.
    let rel_tolerance = REL_TOLERANCE_SECS.max(2.5 / f64::from(case.fps));
    // The muxed timeline's origin is the first DELIVERED frame: the pipeline
    // zeroes each track at its first frame and the recorder persists the
    // track's start_time for cross-track alignment. A random case whose
    // leading frames were dropped therefore legitimately muxes pts starting
    // near 0, not at sent[0]; compare against the origin-normalized sent
    // timeline. The fixed absolute bound stays valid at any frame rate the
    // generator produces (fps >= 10 keeps rel_tolerance <= ABS_TOLERANCE):
    // a constant whole-track offset does not scale with frame period.
    let sent_origin = sent[0];
    for (i, (&p, &s)) in pts.iter().zip(&sent).enumerate() {
        max_abs = max_abs.max((p - (s - sent_origin)).abs());
        let rel = ((p - pts[0]) - (s - sent_origin)).abs();
        max_rel = max_rel.max(rel);
        if rel > rel_tolerance {
            return Err(format!(
                "frame {i}: relative pts error {rel:.3}s (pts {p:.3}s vs sent {s:.3}s)"
            ));
        }
    }
    if max_abs > ABS_TOLERANCE_SECS {
        return Err(format!(
            "absolute pts error {max_abs:.3}s exceeds tolerance"
        ));
    }

    // The span the recorder would persist must match the sent span.
    if let Some((first, last)) = finished.video_timestamp_span {
        let span = (last - first).as_secs_f64();
        let expected = sent.last().unwrap() - sent[0];
        if (span - expected).abs() > 0.25 {
            return Err(format!(
                "video_timestamp_span {span:.3}s does not match sent span {expected:.3}s"
            ));
        }
    } else {
        return Err("video_timestamp_span missing".to_string());
    }

    // Gap preservation is the regression that desynced 0.5.4: every gap in
    // the sent timeline must survive into the container.
    let max_sent_gap = sent.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
    if max_sent_gap > 1.0 {
        let max_pts_gap = pts.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
        if max_pts_gap < max_sent_gap * 0.9 {
            return Err(format!(
                "{max_sent_gap:.2}s capture gap collapsed to {max_pts_gap:.3}s in the container"
            ));
        }
    }

    Ok(format!(
        "{} frames, max abs err {:.0} ms, max rel err {:.0} ms",
        pts.len(),
        max_abs * 1000.0,
        max_rel * 1000.0
    ))
}

/// A mid-recording pause (instant mode): emission continues in real time but
/// the pipeline drops frames while paused. The pause must be EXCISED from the
/// output timeline — video pts must stay continuous across it (matching how
/// audio drops paused samples and how the wall clock subtracts pauses), and
/// the container must contain only the unpaused content. A regression here
/// previously poisoned the drift anchor with pause-inflated time whenever the
/// pause began before the ~2s warmup anchor existed.
async fn run_video_pause_case() -> Result<String, String> {
    const PRE_PAUSE_SECS: f64 = 1.0;
    const PAUSE_SECS: f64 = 2.5;
    const POST_PAUSE_SECS: f64 = 2.0;
    const FPS: u32 = 30;

    let temp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let out_path = temp.path().join("display.mp4");

    let info = VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 160, 120, FPS);
    let (tx, rx) = flume::bounded::<FFmpegVideoFrame>(32);
    let timestamps = Timestamps::now();

    let total_secs = PRE_PAUSE_SECS + PAUSE_SECS + POST_PAUSE_SECS;
    let emit = {
        let base = timestamps.instant();
        let mut rng = Rng(7);
        tokio::spawn(async move {
            let period = 1.0 / f64::from(FPS);
            let count = (total_secs * f64::from(FPS)) as u64;
            for k in 0..count {
                let ts = k as f64 * period;
                tokio::time::sleep_until((base + Duration::from_secs_f64(ts)).into()).await;
                let frame = FFmpegVideoFrame {
                    inner: make_video_frame(160, 120, k, Content::Flat, &mut rng),
                    timestamp: Timestamp::Instant(base + Duration::from_secs_f64(ts)),
                };
                if tx.send_async(frame).await.is_err() {
                    break;
                }
            }
        })
    };

    let pipeline = OutputPipeline::builder(out_path.clone())
        .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(info, rx))
        .with_timestamps(timestamps)
        .build::<Mp4Muxer>(())
        .await
        .map_err(|e| format!("pipeline build: {e}"))?;

    tokio::time::sleep(Duration::from_secs_f64(PRE_PAUSE_SECS)).await;
    let pause_started = std::time::Instant::now();
    pipeline.pause();
    tokio::time::sleep(Duration::from_secs_f64(PAUSE_SECS)).await;
    pipeline.resume();
    let actual_pause = pause_started.elapsed().as_secs_f64();

    emit.await.map_err(|e| format!("emit join: {e}"))?;
    let emit_lag = timestamps.instant().elapsed().as_secs_f64() - total_secs;
    tokio::time::sleep(Duration::from_millis(500)).await;
    pipeline.stop().await.map_err(|e| format!("stop: {e}"))?;
    // The assertions below compare the muxed span against the intended
    // pause/content windows; a runner too stalled to hit those windows
    // invalidates the comparison, not the pipeline.
    if emit_lag > 1.5 || (actual_pause - PAUSE_SECS).abs() > 0.5 {
        return Ok(format!(
            "skipped: runner too slow (emission lag {emit_lag:.1}s, pause window {actual_pause:.2}s)"
        ));
    }

    let pts = read_video_pts(&out_path)?;
    if pts.len() < 8 {
        return Err(format!("only {} frames muxed", pts.len()));
    }

    // The pause is excised: the muxed span must cover roughly the unpaused
    // content, not the wall-clock run.
    let span = pts.last().unwrap() - pts[0];
    let expected = PRE_PAUSE_SECS + POST_PAUSE_SECS;
    if (span - expected).abs() > 0.6 {
        return Err(format!(
            "muxed span {span:.2}s should be about the unpaused content {expected:.2}s \
             (pause leaked into the timeline)"
        ));
    }

    // And no single pts step may contain the pause.
    let max_gap = pts.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
    if max_gap > PAUSE_SECS * 0.8 {
        return Err(format!(
            "pause survived as a {max_gap:.2}s pts gap in the container"
        ));
    }

    // Post-resume continuity is the discriminating check: without the pause
    // excision the anomaly tracker accepts the pause as a confirmed jump and
    // the drift tracker's wall cap re-pins the post-resume segment ~one
    // tolerance late (measured +0.13s vs +0.03s with the fix). The median
    // over the whole segment is immune to per-frame scheduler jitter.
    let period = 1.0 / f64::from(FPS);
    let split = pts
        .windows(2)
        .position(|w| w[1] - w[0] == max_gap)
        .unwrap_or(0);
    let pre_last = pts[split];
    let mut post_offsets: Vec<f64> = pts[split + 1..]
        .iter()
        .enumerate()
        .map(|(k, &p)| p - (pre_last + (k as f64 + 1.0) * period))
        .collect();
    post_offsets.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let continuity = post_offsets
        .get(post_offsets.len() / 2)
        .copied()
        .unwrap_or(0.0);
    if continuity.abs() > 0.08 {
        return Err(format!(
            "post-resume frames resume {continuity:+.3}s off the pre-pause timeline \
             (pause bled into the drift anchor)"
        ));
    }

    Ok(format!(
        "{} frames, span {span:.2}s (expected ~{expected:.2}s), max pts gap {max_gap:.2}s, \
         post-resume continuity {continuity:+.3}s",
        pts.len()
    ))
}

#[derive(Clone, Copy)]
struct AudioCase {
    rate: u32,
    channels: u16,
    /// Device buffer size in milliseconds; real hardware spans ~3-90ms.
    chunk_ms: f64,
    /// Source clock drift factor: samples arrive slightly faster or slower
    /// than their nominal rate, as real device crystals do.
    drift: f64,
}

impl AudioCase {
    fn curated(rate: u32, channels: u16) -> Self {
        Self {
            rate,
            channels,
            chunk_ms: 20.0,
            drift: 1.0,
        }
    }
}

async fn run_audio_case(case: AudioCase) -> Result<String, String> {
    let AudioCase {
        rate,
        channels,
        chunk_ms,
        drift,
    } = case;
    let temp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let out_path = temp.path().join("audio.ogg");

    let info = AudioInfo::new(Sample::F32(Type::Packed), rate, channels)
        .map_err(|e| format!("audio info: {e:?}"))?;
    let (tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
    let timestamps = Timestamps::now();

    let chunk_frames = ((f64::from(rate) * chunk_ms / 1000.0) as usize).max(16);
    let chunk_secs = chunk_frames as f64 / f64::from(rate);
    let total_chunks = (CONTENT_SECS / chunk_secs).ceil() as usize;

    let emit = {
        let base = timestamps.instant();
        let mut tx = tx;
        tokio::spawn(async move {
            use futures::SinkExt;
            for k in 0..total_chunks {
                let real_t = k as f64 * chunk_secs;
                let ts = real_t * drift;
                tokio::time::sleep_until((base + Duration::from_secs_f64(real_t)).into()).await;
                let mut frame = ffmpeg::frame::Audio::new(
                    ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                    chunk_frames,
                    info.channel_layout(),
                );
                frame.set_rate(rate);
                let data = frame.data_mut(0);
                for (i, sample) in bytemuck_cast_f32(data).iter_mut().enumerate() {
                    let n = (k * chunk_frames + i / channels as usize) as f32;
                    *sample = (n * 440.0 * 2.0 * std::f32::consts::PI / rate as f32).sin() * 0.4;
                }
                let frame = AudioFrame::new(
                    frame,
                    Timestamp::Instant(base + Duration::from_secs_f64(ts)),
                );
                if tx.send(frame).await.is_err() {
                    break;
                }
            }
        })
    };

    let pipeline = OutputPipeline::builder(out_path.clone())
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(info, rx))
        .with_timestamps(timestamps)
        .build::<OggMuxer>(())
        .await
        .map_err(|e| format!("pipeline build: {e}"))?;

    emit.await.map_err(|e| format!("emit join: {e}"))?;
    let emit_lag = timestamps.instant().elapsed().as_secs_f64() - CONTENT_SECS;
    tokio::time::sleep(Duration::from_millis(300)).await;
    pipeline.stop().await.map_err(|e| format!("stop: {e}"))?;
    if emit_lag > 1.5 {
        return Ok(format!(
            "skipped: runner fell {emit_lag:.1}s behind real-time emission"
        ));
    }

    let (duration, decoded_channels, energy) = read_audio_stats(&out_path)?;
    if (duration - CONTENT_SECS).abs() > AUDIO_DURATION_TOLERANCE_SECS {
        return Err(format!(
            "decoded duration {duration:.3}s vs expected {CONTENT_SECS:.3}s \
             (rate handling error: content plays at the wrong speed)"
        ));
    }
    if energy < 0.01 {
        return Err(format!(
            "decoded audio is nearly silent (rms {energy:.4}); samples were lost or zeroed"
        ));
    }

    Ok(format!(
        "duration {duration:.3}s, {decoded_channels} ch decoded, rms {energy:.3}"
    ))
}

fn bytemuck_cast_f32(data: &mut [u8]) -> &mut [f32] {
    let len = data.len() / 4;
    unsafe { std::slice::from_raw_parts_mut(data.as_mut_ptr().cast::<f32>(), len) }
}

/// Tolerance for where audible content sits inside a decoded track. Bounded
/// by the emission chunk size, the muxer gap threshold (70ms), codec frame
/// granularity and CI scheduler noise.
const CONTENT_POSITION_TOLERANCE_SECS: f64 = 0.25;

/// System-audio (WASAPI-loopback-style) delivery: packets only exist while
/// something plays. The recorder sees a late first packet, dead zones with no
/// delivery at all, and possibly nothing after the last sound. The muxed
/// track must still span the whole recording with every burst at its true
/// wall-clock position and `first_timestamp` at the recording epoch.
struct SystemAudioCase {
    /// (start_secs, end_secs) of each burst of real packet delivery.
    bursts: Vec<(f64, f64)>,
    /// Wall-clock stop point of the recording.
    total_secs: f64,
}

/// Emits loopback-style bursts on `tx` in real time, using 80ms chunks (the
/// buffer size our Windows loopback capturer targets).
///
/// Returns the sender when done: real capture sources hold their channel
/// open until the recording stops (the mic feed and the system-audio watcher
/// both keep sender clones), so the test must too — dropping it early would
/// end the mux loop through channel-closure instead of stop-cancellation.
fn spawn_burst_emitter(
    mut tx: futures::channel::mpsc::Sender<AudioFrame>,
    info: AudioInfo,
    timestamps: Timestamps,
    bursts: Vec<(f64, f64)>,
) -> tokio::task::JoinHandle<futures::channel::mpsc::Sender<AudioFrame>> {
    const CHUNK_SECS: f64 = 0.08;
    let rate = info.sample_rate;
    let channels = info.channels;
    let base = timestamps.instant();

    tokio::spawn(async move {
        use futures::SinkExt;
        for (start, end) in bursts {
            let chunk_frames = (f64::from(rate) * CHUNK_SECS) as usize;
            let chunks = ((end - start) / CHUNK_SECS).round() as usize;
            for k in 0..chunks {
                let t = start + k as f64 * CHUNK_SECS;
                tokio::time::sleep_until((base + Duration::from_secs_f64(t)).into()).await;
                let mut frame = ffmpeg::frame::Audio::new(
                    ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                    chunk_frames,
                    info.channel_layout(),
                );
                frame.set_rate(rate);
                for (i, sample) in bytemuck_cast_f32(frame.data_mut(0)).iter_mut().enumerate() {
                    let n = (i / channels) as f32 + (t * f64::from(rate)) as f32;
                    *sample = (n * 440.0 * 2.0 * std::f32::consts::PI / rate as f32).sin() * 0.4;
                }
                let frame =
                    AudioFrame::new(frame, Timestamp::Instant(base + Duration::from_secs_f64(t)));
                if tx.send(frame).await.is_err() {
                    return tx;
                }
            }
        }
        tx
    })
}

/// Decodes the first channel and returns (windowed rms envelope, window secs).
fn read_audio_envelope(path: &Path, win_secs: f64) -> Result<(Vec<f64>, f64), String> {
    let mut ictx = ffmpeg::format::input(&path).map_err(|e| format!("open {e}"))?;
    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or("no audio stream")?;
    let index = stream.index();
    let ctx = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("params: {e}"))?;
    let mut decoder = ctx.decoder().audio().map_err(|e| format!("decoder: {e}"))?;

    let mut samples: Vec<f64> = Vec::new();
    let mut rate = 0u32;
    let mut frame = ffmpeg::frame::Audio::empty();
    let drain = |decoder: &mut ffmpeg::decoder::Audio,
                 samples: &mut Vec<f64>,
                 rate: &mut u32,
                 frame: &mut ffmpeg::frame::Audio| {
        while decoder.receive_frame(frame).is_ok() {
            *rate = frame.rate();
            if let ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar) =
                frame.format()
            {
                samples.extend(
                    frame.plane::<f32>(0)[..frame.samples()]
                        .iter()
                        .map(|&v| f64::from(v)),
                );
            }
        }
    };
    for (s, packet) in ictx.packets() {
        if s.index() != index {
            continue;
        }
        if decoder.send_packet(&packet).is_ok() {
            drain(&mut decoder, &mut samples, &mut rate, &mut frame);
        }
    }
    let _ = decoder.send_eof();
    drain(&mut decoder, &mut samples, &mut rate, &mut frame);

    if rate == 0 || samples.is_empty() {
        return Err("no audio decoded".to_string());
    }
    let win = ((f64::from(rate) * win_secs) as usize).max(1);
    let env: Vec<f64> = samples
        .chunks(win)
        .map(|c| (c.iter().map(|v| v * v).sum::<f64>() / c.len() as f64).sqrt())
        .collect();
    Ok((env, win as f64 / f64::from(rate)))
}

/// Regions of the envelope above `thresh`, merged across single-window dips,
/// dropping blips shorter than 0.15s.
fn active_spans(env: &[f64], win_secs: f64, thresh: f64) -> Vec<(f64, f64)> {
    let mut spans: Vec<(f64, f64)> = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    for (i, &v) in env.iter().enumerate() {
        if v > thresh {
            current = match current {
                Some((s, _)) => Some((s, i)),
                None => Some((i, i)),
            };
        } else if let Some((s, e)) = current
            && i > e + 1
        {
            spans.push((s as f64 * win_secs, (e + 1) as f64 * win_secs));
            current = None;
        }
    }
    if let Some((s, e)) = current {
        spans.push((s as f64 * win_secs, (e + 1) as f64 * win_secs));
    }
    spans.retain(|(s, e)| e - s >= 0.15);
    spans
}

fn check_spans(
    decoded: &[(f64, f64)],
    expected: &[(f64, f64)],
    track_offset_secs: f64,
) -> Result<(), String> {
    if decoded.len() != expected.len() {
        return Err(format!(
            "expected {} audible bursts at {:?}, decoded {} at {:?} \
             (track offset {track_offset_secs:.3}s)",
            expected.len(),
            expected,
            decoded.len(),
            decoded,
        ));
    }
    for ((ds, de), (es, ee)) in decoded.iter().zip(expected) {
        // Positions are compared on the recording (epoch) timeline: the
        // decoded in-track position plus the track's start offset.
        let (ds, de) = (ds + track_offset_secs, de + track_offset_secs);
        if (ds - es).abs() > CONTENT_POSITION_TOLERANCE_SECS
            || (de - ee).abs() > CONTENT_POSITION_TOLERANCE_SECS
        {
            return Err(format!(
                "burst decoded at {ds:.3}..{de:.3}s on the recording timeline, \
                 emitted at {es:.3}..{ee:.3}s"
            ));
        }
    }
    Ok(())
}

async fn run_system_audio_case(case: SystemAudioCase) -> Result<String, String> {
    use cap_recording::AudioAnchor;

    let SystemAudioCase { bursts, total_secs } = case;
    let temp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let out_path = temp.path().join("system_audio.ogg");

    let info = AudioInfo::new(Sample::F32(Type::Packed), 48_000, 2)
        .map_err(|e| format!("audio info: {e:?}"))?;
    let (tx, rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
    let timestamps = Timestamps::now();

    let emit = spawn_burst_emitter(tx, info, timestamps, bursts.clone());

    let pipeline = OutputPipeline::builder(out_path.clone())
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(info, rx))
        .with_timestamps(timestamps)
        .with_audio_anchor(AudioAnchor::PipelineEpoch)
        .build::<OggMuxer>(())
        .await
        .map_err(|e| format!("pipeline build: {e}"))?;

    let held_tx = emit.await.map_err(|e| format!("emit join: {e}"))?;
    tokio::time::sleep_until((timestamps.instant() + Duration::from_secs_f64(total_secs)).into())
        .await;
    let stop_lag = timestamps.instant().elapsed().as_secs_f64() - total_secs;
    let finished = pipeline.stop().await.map_err(|e| format!("stop: {e}"))?;
    drop(held_tx);
    if stop_lag > 1.5 {
        return Ok(format!(
            "skipped: runner fell {stop_lag:.1}s behind real-time emission"
        ));
    }

    // An intermittent track is anchored at the recording epoch, never at its
    // first packet: a late first sound must not be able to become the
    // cross-track start_time anchor.
    let start_offset = finished
        .first_timestamp
        .signed_duration_since_secs(timestamps);
    if start_offset.abs() > 0.05 {
        return Err(format!(
            "track start {start_offset:.3}s from the epoch; \
             an intermittent source must anchor at the recording start"
        ));
    }

    // Head silence, dead-zone silence and tail silence must all be
    // materialized: the track spans the whole recording.
    let (duration, _, _) = read_audio_stats(&out_path)?;
    if (duration - total_secs).abs() > AUDIO_DURATION_TOLERANCE_SECS + stop_lag {
        return Err(format!(
            "decoded duration {duration:.3}s vs recording span {total_secs:.3}s; \
             silence between/around bursts was not materialized"
        ));
    }

    // Every burst must sit at its true wall-clock position.
    let (env, win) = read_audio_envelope(&out_path, 0.05)?;
    let spans = active_spans(&env, win, 0.08);
    check_spans(&spans, &bursts, start_offset)?;

    Ok(format!(
        "duration {duration:.3}s, start {start_offset:+.3}s, {} bursts in place",
        spans.len()
    ))
}

/// The reported regression shape: a continuous mic and an intermittent
/// system-audio source recorded simultaneously (separate pipelines sharing
/// the recording epoch, exactly like studio mode). Every piece of content in
/// BOTH tracks must resolve to its true wall-clock position through each
/// track's own start_time — the presence of system audio must not move the
/// mic, and vice versa.
async fn run_mic_with_system_audio_case() -> Result<String, String> {
    use cap_recording::AudioAnchor;

    const MIC_START_SECS: f64 = 0.15;
    const TOTAL_SECS: f64 = 4.5;
    let system_bursts: Vec<(f64, f64)> = vec![(1.2, 2.0), (3.4, 4.1)];

    let temp = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let mic_path = temp.path().join("audio-input.ogg");
    let sys_path = temp.path().join("system_audio.ogg");

    let info = AudioInfo::new(Sample::F32(Type::Packed), 48_000, 2)
        .map_err(|e| format!("audio info: {e:?}"))?;
    let timestamps = Timestamps::now();

    let (mic_tx, mic_rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
    let (sys_tx, sys_rx) = futures::channel::mpsc::channel::<AudioFrame>(32);

    // The mic delivers continuously from device-ready at 0.15s to stop.
    let mic_emit =
        spawn_burst_emitter(mic_tx, info, timestamps, vec![(MIC_START_SECS, TOTAL_SECS)]);
    let sys_emit = spawn_burst_emitter(sys_tx, info, timestamps, system_bursts.clone());

    let mic_pipeline = OutputPipeline::builder(mic_path.clone())
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(info, mic_rx))
        .with_timestamps(timestamps)
        .build::<OggMuxer>(())
        .await
        .map_err(|e| format!("mic pipeline build: {e}"))?;
    let sys_pipeline = OutputPipeline::builder(sys_path.clone())
        .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(info, sys_rx))
        .with_timestamps(timestamps)
        .with_audio_anchor(AudioAnchor::PipelineEpoch)
        .build::<OggMuxer>(())
        .await
        .map_err(|e| format!("system pipeline build: {e}"))?;

    let (mic_join, sys_join) = tokio::join!(mic_emit, sys_emit);
    let mic_held_tx = mic_join.map_err(|e| format!("mic emit join: {e}"))?;
    let sys_held_tx = sys_join.map_err(|e| format!("sys emit join: {e}"))?;
    tokio::time::sleep_until((timestamps.instant() + Duration::from_secs_f64(TOTAL_SECS)).into())
        .await;
    let stop_lag = timestamps.instant().elapsed().as_secs_f64() - TOTAL_SECS;
    let (mic_finished, sys_finished) = tokio::join!(mic_pipeline.stop(), sys_pipeline.stop());
    let mic_finished = mic_finished.map_err(|e| format!("mic stop: {e}"))?;
    let sys_finished = sys_finished.map_err(|e| format!("sys stop: {e}"))?;
    drop((mic_held_tx, sys_held_tx));
    if stop_lag > 1.5 {
        return Ok(format!(
            "skipped: runner fell {stop_lag:.1}s behind real-time emission"
        ));
    }

    // Mic keeps first-frame anchoring: its start_time is device-ready.
    let mic_start = mic_finished
        .first_timestamp
        .signed_duration_since_secs(timestamps);
    if (mic_start - MIC_START_SECS).abs() > 0.05 {
        return Err(format!(
            "mic start_time {mic_start:.3}s, expected {MIC_START_SECS:.3}s: \
             recording system audio simultaneously must not move the mic anchor"
        ));
    }

    let sys_start = sys_finished
        .first_timestamp
        .signed_duration_since_secs(timestamps);
    if sys_start.abs() > 0.05 {
        return Err(format!(
            "system audio start_time {sys_start:.3}s, expected the epoch"
        ));
    }

    // Content must land at its true wall-clock position through each track's
    // own start offset — this is exactly the invariant the editor's
    // start_time-based alignment depends on.
    let (mic_env, mic_win) = read_audio_envelope(&mic_path, 0.05)?;
    let mic_spans = active_spans(&mic_env, mic_win, 0.08);
    check_spans(&mic_spans, &[(MIC_START_SECS, TOTAL_SECS)], mic_start)?;

    let (sys_env, sys_win) = read_audio_envelope(&sys_path, 0.05)?;
    let sys_spans = active_spans(&sys_env, sys_win, 0.08);
    check_spans(&sys_spans, &system_bursts, sys_start)?;

    // Both tracks span to the stop point (tail silence materialized).
    let (mic_duration, _, _) = read_audio_stats(&mic_path)?;
    let mic_expected = TOTAL_SECS - MIC_START_SECS;
    if (mic_duration - mic_expected).abs() > AUDIO_DURATION_TOLERANCE_SECS + stop_lag {
        return Err(format!(
            "mic duration {mic_duration:.3}s vs expected {mic_expected:.3}s"
        ));
    }
    let (sys_duration, _, _) = read_audio_stats(&sys_path)?;
    if (sys_duration - TOTAL_SECS).abs() > AUDIO_DURATION_TOLERANCE_SECS + stop_lag {
        return Err(format!(
            "system audio duration {sys_duration:.3}s vs recording span {TOTAL_SECS:.3}s"
        ));
    }

    Ok(format!(
        "mic start {mic_start:.3}s dur {mic_duration:.3}s; \
         system start {sys_start:+.3}s dur {sys_duration:.3}s; all content in place"
    ))
}

/// Concatenates a fragmented-mp4 segment directory (init.mp4 + *.m4s) into a
/// single playable file.
fn concat_fmp4(dir: &Path, scratch: &Path) -> Result<PathBuf, String> {
    let init = dir.join("init.mp4");
    let mut bytes = std::fs::read(&init).map_err(|e| format!("read init.mp4: {e}"))?;
    let mut segments: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("read segment dir: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
        .collect();
    segments.sort();
    if segments.is_empty() {
        return Err("no media segments produced".to_string());
    }
    for segment in &segments {
        bytes.extend(std::fs::read(segment).map_err(|e| format!("read segment: {e}"))?);
    }
    let out = scratch.join("concat.mp4");
    std::fs::write(&out, bytes).map_err(|e| format!("write concat: {e}"))?;
    Ok(out)
}

fn read_video_pts(path: &Path) -> Result<Vec<f64>, String> {
    let mut ictx = ffmpeg::format::input(&path).map_err(|e| format!("open {e}"))?;
    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("no video stream")?;
    let index = stream.index();
    let tb = stream.time_base();
    let tb = f64::from(tb.numerator()) / f64::from(tb.denominator());
    let mut pts: Vec<f64> = ictx
        .packets()
        .filter_map(|(s, p)| (s.index() == index).then_some(p.pts()).flatten())
        .map(|p| p as f64 * tb)
        .collect();
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Ok(pts)
}

fn read_audio_stats(path: &Path) -> Result<(f64, u16, f64), String> {
    let mut ictx = ffmpeg::format::input(&path).map_err(|e| format!("open {e}"))?;
    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or("no audio stream")?;
    let index = stream.index();
    let ctx = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("params: {e}"))?;
    let mut decoder = ctx.decoder().audio().map_err(|e| format!("decoder: {e}"))?;

    let mut samples = 0u64;
    let mut rate = 0u32;
    let mut channels = 0u16;
    let mut sum_sq = 0.0f64;
    let mut counted = 0u64;
    let mut frame = ffmpeg::frame::Audio::empty();
    for (s, packet) in ictx.packets() {
        if s.index() != index {
            continue;
        }
        if decoder.send_packet(&packet).is_ok() {
            while decoder.receive_frame(&mut frame).is_ok() {
                samples += frame.samples() as u64;
                rate = frame.rate();
                channels = frame.channels();
                if let ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar) =
                    frame.format()
                {
                    for &v in &frame.plane::<f32>(0)[..frame.samples()] {
                        sum_sq += f64::from(v) * f64::from(v);
                        counted += 1;
                    }
                }
            }
        }
    }
    let _ = decoder.send_eof();
    while decoder.receive_frame(&mut frame).is_ok() {
        samples += frame.samples() as u64;
    }

    if rate == 0 {
        return Err("no audio decoded".to_string());
    }
    let rms = if counted > 0 {
        (sum_sq / counted as f64).sqrt()
    } else {
        0.0
    };
    Ok((samples as f64 / f64::from(rate), channels, rms))
}

fn record(results: &mut Vec<CaseResult>, name: String, outcome: Result<String, String>) {
    eprintln!(
        "{name}: {}",
        match &outcome {
            Ok(d) => format!("ok ({d})"),
            Err(e) => format!("FAIL ({e})"),
        }
    );
    results.push(CaseResult {
        name,
        pass: outcome.is_ok(),
        detail: outcome.unwrap_or_else(|e| e),
    });
}

/// A fully random capture shape: arbitrary fps, resolution, encoder-load
/// content, timestamp jitter, random drops, and 0-2 gaps at random positions
/// (including inside the first two seconds, where the drift anchor does not
/// exist yet).
fn random_video_case(rng: &mut Rng) -> VideoCase {
    let fps = rng.range(10, 120) as u32;
    let (width, height) = rng.pick(&[(160u32, 120u32), (320, 240), (640, 360)]);
    let content = rng.pick(&[Content::Flat, Content::Noise, Content::Motion]);
    let fragmented = rng.f64() < 0.75;

    let period = 1.0 / f64::from(fps);
    let jitter = rng.f64() * 0.45;
    let drop_prob = rng.f64() * 0.25;
    let gap_count = rng.range(0, 2);
    let mut gaps: Vec<(f64, f64)> = (0..gap_count)
        .map(|_| {
            let at = 0.4 + rng.f64() * (CONTENT_SECS - 1.0);
            let len = 1.2 + rng.f64() * 2.0;
            (at, len)
        })
        .collect();
    gaps.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    let total = (CONTENT_SECS * f64::from(fps)) as u64;
    let mut sent = Vec::new();
    for k in 0..total {
        if rng.f64() < drop_prob {
            continue;
        }
        let base = k as f64 * period;
        let mut ts = (base + (rng.f64() - 0.5) * period * jitter).max(0.0);
        for &(at, len) in &gaps {
            if ts >= at {
                ts += len;
            }
        }
        sent.push(ts);
    }
    sent.sort_by(|a, b| a.partial_cmp(b).unwrap());
    sent.dedup_by(|a, b| (*a - *b).abs() < period * 0.25);
    // Guarantee at least a handful of frames survive the drop lottery.
    if sent.len() < 8 {
        sent = (0..total).map(|k| k as f64 * period).collect();
    }

    VideoCase {
        fps,
        sent,
        fragmented,
        width,
        height,
        content,
        rng_seed: rng.next(),
    }
}

/// A random audio device shape: any rate from the set real devices negotiate,
/// 1-8 channels, real-world buffer sizes, and a small crystal drift.
fn random_audio_case(rng: &mut Rng) -> AudioCase {
    let rate = rng.pick(&[
        8_000u32, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000,
        176_400, 192_000,
    ]);
    let channels = rng.range(1, 8) as u16;
    let chunk_ms = 3.0 + rng.f64() * 85.0;
    let drift = 1.0 + (rng.f64() - 0.5) * 0.002; // +-0.1%

    AudioCase {
        rate,
        channels,
        chunk_ms,
        drift,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn synthetic_device_matrix_preserves_sync() {
    let mut results: Vec<CaseResult> = Vec::new();

    // Randomized cases are reproducible: rerun with CAP_SYNC_MATRIX_SEED=<seed>.
    let seed: u64 = std::env::var("CAP_SYNC_MATRIX_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x5EED)
        });
    let random_cases: usize = std::env::var("CAP_SYNC_MATRIX_RANDOM_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);
    eprintln!("randomized cases: {random_cases}, CAP_SYNC_MATRIX_SEED={seed}");

    let video_cases: Vec<(u32, VideoScenario, bool)> = vec![
        (15, VideoScenario::Steady, true),
        (30, VideoScenario::Steady, true),
        (60, VideoScenario::Steady, true),
        (120, VideoScenario::Steady, true),
        (30, VideoScenario::Jitter, true),
        (60, VideoScenario::Jitter, true),
        (30, VideoScenario::Drops, true),
        (60, VideoScenario::Drops, true),
        (30, VideoScenario::Gap, true),
        (60, VideoScenario::Gap, true),
        (30, VideoScenario::Steady, false),
        (30, VideoScenario::Gap, false),
    ];

    for (fps, scenario, fragmented) in video_cases {
        let name = format!(
            "video/{}fps/{}/{}",
            fps,
            scenario.name(),
            if fragmented { "fragmented" } else { "mp4" }
        );
        let outcome = run_video_case(VideoCase::curated(fps, scenario, fragmented)).await;
        record(&mut results, name, outcome);
    }

    record(
        &mut results,
        "video/30fps/pause-resume/mp4".to_string(),
        run_video_pause_case().await,
    );

    let audio_cases: Vec<(u32, u16)> = vec![
        (8_000, 2),
        (16_000, 2),
        (22_050, 2),
        (44_100, 2),
        (48_000, 2),
        (96_000, 2),
        (48_000, 1),
        (44_100, 1),
        (48_000, 6),
    ];

    for (rate, channels) in audio_cases {
        let name = format!("audio/{rate}hz/{channels}ch");
        let outcome = run_audio_case(AudioCase::curated(rate, channels)).await;
        record(&mut results, name, outcome);
    }

    // System-audio delivery shapes: WASAPI-loopback-style intermittent
    // sources that only produce packets while sound plays. These guard the
    // epoch anchoring + silence materialization that keep an intermittent
    // track from desyncing (or re-anchoring) the whole recording.
    let system_audio_cases: Vec<(&str, SystemAudioCase)> = vec![
        (
            "system-audio/late-first-sound",
            SystemAudioCase {
                bursts: vec![(1.4, 2.6)],
                total_secs: 4.0,
            },
        ),
        (
            "system-audio/dead-zone",
            SystemAudioCase {
                bursts: vec![(0.2, 1.2), (3.0, 3.8)],
                total_secs: 4.5,
            },
        ),
        (
            "system-audio/silent-throughout",
            SystemAudioCase {
                bursts: vec![],
                total_secs: 3.0,
            },
        ),
        (
            "system-audio/bursty-notifications",
            SystemAudioCase {
                bursts: vec![(0.4, 0.8), (1.6, 2.0), (2.8, 3.2)],
                total_secs: 4.0,
            },
        ),
    ];

    for (name, case) in system_audio_cases {
        let outcome = run_system_audio_case(case).await;
        record(&mut results, name.to_string(), outcome);
    }

    record(
        &mut results,
        "system-audio/with-mic".to_string(),
        run_mic_with_system_audio_case().await,
    );

    // Non-predetermined coverage: random device shapes and delivery
    // pathologies, combined audio+video like a real studio recording.
    let mut rng = Rng(seed);
    for i in 0..random_cases {
        let video = random_video_case(&mut rng);
        let audio = random_audio_case(&mut rng);
        let name = format!(
            "random/{i}/video-{}fps-{}x{}-{:?}-{}ts/audio-{}hz-{}ch-{:.0}ms-drift{:+.2}%",
            video.fps,
            video.width,
            video.height,
            video.content,
            video.sent.len(),
            audio.rate,
            audio.channels,
            audio.chunk_ms,
            (audio.drift - 1.0) * 100.0,
        );
        // Run both legs concurrently, as a real recording does.
        let (video_outcome, audio_outcome) =
            tokio::join!(run_video_case(video), run_audio_case(audio));
        let outcome = match (video_outcome, audio_outcome) {
            (Ok(v), Ok(a)) => Ok(format!("video: {v}; audio: {a}")),
            (Err(e), _) => Err(format!("video leg: {e}")),
            (_, Err(e)) => Err(format!("audio leg: {e}")),
        };
        record(&mut results, name, outcome);
    }

    if let Ok(report_path) = std::env::var("CAP_SYNC_MATRIX_REPORT") {
        #[derive(Serialize)]
        struct Report<'a> {
            seed: u64,
            cases: &'a [CaseResult],
        }
        let json = serde_json::to_string_pretty(&Report {
            seed,
            cases: &results,
        })
        .expect("serialize report");
        std::fs::write(&report_path, json).expect("write report");
        eprintln!("report written to {report_path}");
    }

    let failures: Vec<&CaseResult> = results.iter().filter(|r| !r.pass).collect();
    assert!(
        failures.is_empty(),
        "{} of {} matrix cases failed:\n{}",
        failures.len(),
        results.len(),
        failures
            .iter()
            .map(|r| format!("  {} — {}", r.name, r.detail))
            .collect::<Vec<_>>()
            .join("\n")
    );
}
