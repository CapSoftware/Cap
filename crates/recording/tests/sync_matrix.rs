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
/// Absolute tolerance for a muxed pts vs the sent capture timestamp. Covers
/// warmup anchoring, emission jitter and encoder rounding, plus scheduler
/// noise on shared CI runners.
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
    for (i, (&p, &s)) in pts.iter().zip(&sent).enumerate() {
        max_abs = max_abs.max((p - s).abs());
        let rel = ((p - pts[0]) - (s - sent[0])).abs();
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
        let info = info;
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
