use super::core::{
    BlockingThreadFinish, DiskSpaceMonitor, HealthSender, SharedHealthSender,
    wait_for_blocking_thread_finish,
};
use super::oop_muxer::{
    MuxerSubprocessConfig, MuxerSubprocessError, RespawningMuxerSubprocess, VideoStreamInit,
    resolve_muxer_binary,
};
use crate::{
    AudioFrame, AudioMuxer, Muxer, SharedPauseState, TaskPool, VideoMuxer, screen_capture,
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::fragment_manifest::FragmentManifestTracker;
use cap_enc_ffmpeg::h264::{H264EncoderBuilder, H264Preset};
use cap_enc_ffmpeg::h264_packet::EncodePacketError;
use cap_enc_ffmpeg::segmented_stream::{DiskSpaceCallback, SegmentCompletedEvent};
use cap_media_info::{AudioInfo, VideoInfo};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::AtomicBool,
        mpsc::{RecvTimeoutError, SyncSender, sync_channel},
    },
    thread::JoinHandle,
    time::Duration,
};
use tracing::*;

const DEFAULT_MAX_RESPAWNS: u32 = 3;
const DEFAULT_MUXER_BUFFER_SIZE: usize = 240;

fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MUXER_BUFFER_SIZE)
}

struct FrameDropTracker {
    drops_in_window: u32,
    frames_in_window: u32,
    total_drops: u64,
    total_frames: u64,
    last_check: std::time::Instant,
    health_tx: SharedHealthSender,
    source: &'static str,
}

impl FrameDropTracker {
    fn new(health_tx: SharedHealthSender, source: &'static str) -> Self {
        Self {
            drops_in_window: 0,
            frames_in_window: 0,
            total_drops: 0,
            total_frames: 0,
            last_check: std::time::Instant::now(),
            health_tx,
            source,
        }
    }

    fn record_frame(&mut self) {
        self.frames_in_window += 1;
        self.total_frames += 1;
        self.check_drop_rate();
    }

    #[allow(dead_code)]
    fn record_drop(&mut self) {
        self.drops_in_window += 1;
        self.total_drops += 1;
        self.check_drop_rate();
    }

    fn check_drop_rate(&mut self) {
        if self.last_check.elapsed() >= Duration::from_secs(5) {
            let total_in_window = self.frames_in_window + self.drops_in_window;
            if total_in_window > 0 {
                let drop_rate = 100.0 * self.drops_in_window as f64 / total_in_window as f64;
                if drop_rate > 5.0 {
                    warn!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        total_frames = self.total_frames,
                        total_drops = self.total_drops,
                        "Windows OOP M4S muxer frame drop rate exceeds 5% threshold"
                    );
                    self.health_tx.emit(PipelineHealthEvent::FrameDropRateHigh {
                        source: self.source.to_string(),
                        rate_pct: drop_rate,
                    });
                } else if self.drops_in_window > 0 {
                    debug!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        "Windows OOP M4S muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }
}

type ScreenFrameItem = Option<(screen_capture::ScreenFrame, Duration)>;

struct EncoderState {
    video_tx: SyncSender<ScreenFrameItem>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct WindowsOOPFragmentedM4SMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
    pub segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    pub max_respawns: u32,
}

impl Default for WindowsOOPFragmentedM4SMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(2),
            preset: H264Preset::Ultrafast,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: None,
            shared_pause_state: None,
            disk_space_callback: None,
            segment_tx: None,
            max_respawns: DEFAULT_MAX_RESPAWNS,
        }
    }
}

pub struct WindowsOOPFragmentedM4SMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    bpp: f32,
    output_size: Option<(u32, u32)>,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    disk_space_callback: Option<DiskSpaceCallback>,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    health_tx: SharedHealthSender,
    max_respawns: u32,
}

impl Muxer for WindowsOOPFragmentedM4SMuxer {
    type Config = WindowsOOPFragmentedM4SMuxerConfig;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        _audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        _tasks: &mut TaskPool,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let video_config = video_config
            .ok_or_else(|| anyhow!("invariant: video config expected for OOP muxer"))?;

        std::fs::create_dir_all(&output_path).with_context(|| {
            format!("Failed to create Windows OOP segments directory: {output_path:?}")
        })?;

        let pause = config
            .shared_pause_state
            .unwrap_or_else(|| SharedPauseState::new(pause_flag));

        let mut muxer = Self {
            base_path: output_path,
            video_config,
            segment_duration: config.segment_duration,
            preset: config.preset,
            bpp: config.bpp,
            output_size: config.output_size,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(SharedHealthSender::new(), "muxer:windows-oop"),
            disk_space_callback: config.disk_space_callback,
            segment_tx: config.segment_tx,
            health_tx: SharedHealthSender::new(),
            max_respawns: config.max_respawns,
        };

        muxer.start_encoder()?;
        Ok(muxer)
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Windows OOP M4S encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(state) = self.state.take()
            && let Err(error) = finish_oop_encoder(state, timestamp)
        {
            return Ok(Err(error));
        }
        Ok(Ok(()))
    }

    fn set_health_sender(&mut self, tx: HealthSender) {
        self.health_tx.set(tx);
        self.frame_drops.health_tx = self.health_tx.clone();
    }
}

fn finish_oop_encoder(mut state: EncoderState, _timestamp: Duration) -> anyhow::Result<()> {
    if let Err(error) = state.video_tx.send(None) {
        trace!("Windows OOP encoder channel already closed during finish: {error}");
    }

    let thread_result = state
        .encoder_handle
        .take()
        .map(|handle| {
            wait_for_blocking_thread_finish(handle, Duration::from_secs(10), "Windows OOP encoder")
        })
        .unwrap_or(BlockingThreadFinish::Clean);

    match thread_result {
        BlockingThreadFinish::Clean => Ok(()),
        BlockingThreadFinish::Failed(error) => Err(error),
        BlockingThreadFinish::TimedOut(error) => Err(error),
    }
}

impl WindowsOOPFragmentedM4SMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "Windows OOP M4S muxer encoder channel buffer size"
        );

        let bin_path = resolve_muxer_binary()
            .with_context(|| "cap-muxer binary not found for Windows OOP muxer")?;

        let (video_tx, video_rx) = sync_channel::<ScreenFrameItem>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let base_path = self.base_path.clone();
        let video_config = self.video_config;
        let segment_duration = self.segment_duration;
        let preset = self.preset;
        let bpp = self.bpp;
        let output_size = self.output_size;
        let disk_space_callback = self.disk_space_callback.clone();
        let segment_tx = self.segment_tx.clone();
        let health_tx = self.health_tx.clone();
        let max_respawns = self.max_respawns;

        let encoder_handle = std::thread::Builder::new()
            .name("win-oop-m4s-segment-encoder".to_string())
            .spawn(move || {
                cap_mediafoundation_utils::thread_init();

                let mut builder = H264EncoderBuilder::new(video_config)
                    .with_preset(preset)
                    .with_bpp(bpp);

                if let Some((width, height)) = output_size {
                    match builder.with_output_size(width, height) {
                        Ok(b) => builder = b,
                        Err(e) => {
                            let err = anyhow!("Invalid output size: {e:?}");
                            let _ = ready_tx.send(Err(anyhow!("{err:#}")));
                            return Err(err);
                        }
                    }
                }

                let mut encoder = match builder.build_standalone() {
                    Ok(e) => e,
                    Err(e) => {
                        let err = anyhow!("Failed to open standalone H264 encoder: {e:?}");
                        let _ = ready_tx.send(Err(anyhow!("{err:#}")));
                        return Err(err);
                    }
                };

                let codec_name = encoder.codec_name().to_string();
                let extradata = encoder.extradata();

                debug!(
                    codec = %codec_name,
                    extradata_bytes = extradata.len(),
                    "Windows OOP standalone H264 encoder opened"
                );

                let video_init = VideoStreamInit {
                    codec: wire_codec_for(&codec_name),
                    width: encoder.output_width(),
                    height: encoder.output_height(),
                    frame_rate: (
                        encoder.frame_rate().numerator(),
                        encoder.frame_rate().denominator(),
                    ),
                    time_base: (
                        encoder.time_base().numerator(),
                        encoder.time_base().denominator(),
                    ),
                    extradata: extradata.clone(),
                    segment_duration_ms: segment_duration.as_millis().min(u32::MAX as u128) as u32,
                };

                let mut tracker = FragmentManifestTracker::new(
                    base_path.clone(),
                    &video_config,
                    segment_duration,
                );
                if let Some(tx) = segment_tx.clone() {
                    tracker.set_segment_callback(tx);
                }
                tracker.write_initial_manifest();

                let config = MuxerSubprocessConfig {
                    output_directory: base_path.clone(),
                    init_segment_name: FragmentManifestTracker::init_segment_name().to_string(),
                    media_segment_pattern: FragmentManifestTracker::media_segment_pattern()
                        .to_string(),
                    video_init: Some(video_init),
                    audio_init: None,
                };

                let mut subprocess = match RespawningMuxerSubprocess::new(
                    bin_path,
                    config,
                    health_tx.get(),
                    max_respawns,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        let err = anyhow!("Failed to spawn cap-muxer subprocess: {e:#}");
                        let _ = ready_tx.send(Err(anyhow!("{err:#}")));
                        return Err(err);
                    }
                };

                let mut disk_monitor = DiskSpaceMonitor::new();
                let _ = disk_space_callback;
                disk_monitor.poll(&base_path, &health_tx);

                if ready_tx.send(Ok(())).is_err() {
                    let err = anyhow!("Windows OOP encoder ready signal receiver dropped");
                    return Err(err);
                }

                let frame_interval = Duration::from_secs_f64(1.0 / video_config.fps() as f64);
                let mut last_ffmpeg_frame: Option<ffmpeg::frame::Video> = None;
                let mut last_timestamp: Option<Duration> = None;
                let mut first_timestamp: Option<Duration> = None;
                let mut total_frames = 0u64;
                let mut duplicated_frames = 0u64;
                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                const SLOW_THRESHOLD_MS: u128 = 5;

                let normalize_timestamp =
                    |ts: Duration, first: &mut Option<Duration>| -> Duration {
                        if let Some(first_ts) = *first {
                            ts.checked_sub(first_ts).unwrap_or(Duration::ZERO)
                        } else {
                            *first = Some(ts);
                            Duration::ZERO
                        }
                    };

                let mut encode_one =
                    |encoder: &mut cap_enc_ffmpeg::h264_packet::H264PacketEncoder,
                     subprocess: &mut RespawningMuxerSubprocess,
                     tracker: &mut FragmentManifestTracker,
                     ffmpeg_frame: ffmpeg::frame::Video,
                     normalized_ts: Duration,
                     slow_encode_count: &mut u32,
                     total_frames: &mut u64|
                     -> anyhow::Result<()> {
                        let encode_start = std::time::Instant::now();
                        let subprocess_ref = &mut *subprocess;
                        let encode_result = encoder.encode_frame(
                            ffmpeg_frame,
                            normalized_ts,
                            |pkt| dispatch_packet(subprocess_ref, pkt),
                        );
                        let encode_elapsed_ms = encode_start.elapsed().as_millis();
                        if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                            *slow_encode_count += 1;
                            if *slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                                debug!(
                                    elapsed_ms = encode_elapsed_ms,
                                    count = *slow_encode_count,
                                    "Windows OOP encode_frame exceeded {}ms threshold",
                                    SLOW_THRESHOLD_MS
                                );
                            }
                        }

                        match encode_result {
                            Ok(()) => {
                                tracker.on_frame(normalized_ts);
                                *total_frames += 1;
                                Ok(())
                            }
                            Err(EncodePacketError::Converter(e)) => {
                                warn!("Windows OOP encoder converter failure: {e}");
                                Ok(())
                            }
                            Err(EncodePacketError::Encode(e)) => {
                                let err_str = format!("{e:?}");
                                if err_str.contains("Crashed")
                                    || err_str.contains("RespawnExhausted")
                                {
                                    error!(
                                        reason = %err_str,
                                        "Windows OOP subprocess crash propagated from encoder loop; aborting"
                                    );
                                    tracker.flush_pending_segments();
                                    tracker.finalize(normalized_ts);
                                    return Err(anyhow!(
                                        "Windows OOP subprocess crashed: {err_str}"
                                    ));
                                }
                                warn!("Windows OOP encoder ffmpeg error: {err_str}");
                                Ok(())
                            }
                        }
                    };

                loop {
                    match disk_monitor.poll(&base_path, &health_tx) {
                        super::core::DiskSpacePollResult::Exhausted { .. }
                        | super::core::DiskSpacePollResult::Stopped => {
                            tracker.flush_pending_segments();
                            tracker.finalize(
                                last_timestamp
                                    .map(|t| normalize_timestamp(t, &mut first_timestamp))
                                    .unwrap_or(Duration::ZERO),
                            );
                            break;
                        }
                        _ => {}
                    }

                    let convert_start = std::time::Instant::now();

                    let (ffmpeg_frame, timestamp) = match video_rx.recv_timeout(frame_interval) {
                        Ok(Some((frame, ts))) => match frame.as_ffmpeg() {
                            Ok(f) => {
                                last_ffmpeg_frame = Some(f.clone());
                                last_timestamp = Some(ts);
                                (Some(f), ts)
                            }
                            Err(e) => {
                                warn!("Windows OOP failed to convert D3D11 frame: {e:?}");
                                match (&last_ffmpeg_frame, last_timestamp) {
                                    (Some(f), Some(last_ts)) => {
                                        let new_ts = last_ts.saturating_add(frame_interval);
                                        last_timestamp = Some(new_ts);
                                        duplicated_frames += 1;
                                        (Some(f.clone()), new_ts)
                                    }
                                    _ => (None, Duration::ZERO),
                                }
                            }
                        },
                        Ok(None) | Err(RecvTimeoutError::Disconnected) => {
                            let drain_start = std::time::Instant::now();
                            let drain_timeout = Duration::from_millis(500);
                            loop {
                                match video_rx.recv_timeout(Duration::from_millis(10)) {
                                    Ok(Some((frame, ts))) => {
                                        if let Ok(f) = frame.as_ffmpeg() {
                                            let normalized_ts = normalize_timestamp(
                                                ts,
                                                &mut first_timestamp,
                                            );
                                            if let Err(e) = encode_one(
                                                &mut encoder,
                                                &mut subprocess,
                                                &mut tracker,
                                                f,
                                                normalized_ts,
                                                &mut slow_encode_count,
                                                &mut total_frames,
                                            ) {
                                                warn!("Failed to encode drained frame: {e}");
                                                break;
                                            }
                                        }
                                    }
                                    Ok(None) => break,
                                    Err(RecvTimeoutError::Timeout) => {
                                        if drain_start.elapsed() > drain_timeout {
                                            break;
                                        }
                                    }
                                    Err(RecvTimeoutError::Disconnected) => break,
                                }
                            }
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            match (&last_ffmpeg_frame, last_timestamp) {
                                (Some(f), Some(last_ts)) => {
                                    let new_ts = last_ts.saturating_add(frame_interval);
                                    last_timestamp = Some(new_ts);
                                    duplicated_frames += 1;
                                    (Some(f.clone()), new_ts)
                                }
                                _ => continue,
                            }
                        }
                    };

                    let convert_elapsed_ms = convert_start.elapsed().as_millis();
                    if convert_elapsed_ms > SLOW_THRESHOLD_MS {
                        slow_convert_count += 1;
                        if slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                            debug!(
                                elapsed_ms = convert_elapsed_ms,
                                count = slow_convert_count,
                                "Windows OOP D3D11 frame conversion exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    let Some(ffmpeg_frame) = ffmpeg_frame else {
                        match video_rx.recv() {
                            Ok(Some((frame, ts))) => {
                                if let Ok(f) = frame.as_ffmpeg() {
                                    last_ffmpeg_frame = Some(f);
                                    last_timestamp = Some(ts);
                                }
                            }
                            Ok(None) | Err(_) => break,
                        }
                        continue;
                    };

                    let normalized_ts = normalize_timestamp(timestamp, &mut first_timestamp);
                    if let Err(e) = encode_one(
                        &mut encoder,
                        &mut subprocess,
                        &mut tracker,
                        ffmpeg_frame,
                        normalized_ts,
                        &mut slow_encode_count,
                        &mut total_frames,
                    ) {
                        return Err(e);
                    }
                }

                let final_ts = last_timestamp
                    .map(|t| normalize_timestamp(t, &mut first_timestamp))
                    .unwrap_or(Duration::ZERO);

                let subprocess_ref_flush = &mut subprocess;
                if let Err(e) = encoder.flush(|pkt| dispatch_packet(subprocess_ref_flush, pkt)) {
                    warn!("Windows OOP encoder flush error: {e:?}");
                }

                let subprocess_report = match subprocess.finish() {
                    Ok(report) => Some(report),
                    Err(e) => {
                        warn!("Windows OOP subprocess finish error: {e:#}");
                        None
                    }
                };

                tracker.flush_pending_segments();
                tracker.finalize(final_ts);

                if total_frames > 0 {
                    debug!(
                        total_frames = total_frames,
                        duplicated_frames = duplicated_frames,
                        slow_converts = slow_convert_count,
                        slow_encodes = slow_encode_count,
                        slow_convert_pct = format!(
                            "{:.1}%",
                            100.0 * slow_convert_count as f64 / total_frames as f64
                        ),
                        slow_encode_pct = format!(
                            "{:.1}%",
                            100.0 * slow_encode_count as f64 / total_frames as f64
                        ),
                        subprocess_packets = subprocess_report
                            .as_ref()
                            .map(|r| r.packets_written)
                            .unwrap_or(0),
                        "Windows OOP M4S encoder timing summary"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("Windows OOP M4S encoder thread ended unexpectedly"))??;

        self.state = Some(EncoderState {
            video_tx,
            encoder_handle: Some(encoder_handle),
        });

        info!(
            path = %self.base_path.display(),
            "Started Windows OOP M4S fragmented video encoder subprocess"
        );
        Ok(())
    }
}

fn wire_codec_for(codec: &str) -> String {
    match codec {
        "h264_videotoolbox" | "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf" | "libx264" => {
            "libx264".to_string()
        }
        other => other.to_string(),
    }
}

fn dispatch_packet(
    subprocess: &mut RespawningMuxerSubprocess,
    pkt: cap_enc_ffmpeg::h264_packet::EncodedPacket,
) -> Result<(), EncodePacketError> {
    match subprocess.write_video_packet(
        pkt.pts,
        pkt.dts,
        pkt.duration.max(0) as u64,
        pkt.is_keyframe,
        &pkt.data,
    ) {
        Ok(()) => Ok(()),
        Err(MuxerSubprocessError::Crashed(reason)) => {
            warn!(
                reason,
                "Windows OOP subprocess crash reported to encoder loop"
            );
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
        Err(MuxerSubprocessError::RespawnExhausted { attempts }) => {
            error!(attempts, "Windows OOP subprocess respawn budget exhausted");
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
        Err(MuxerSubprocessError::DiskFull(reason)) => {
            warn!(reason, "Windows OOP subprocess exited with disk full");
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
        Err(other) => {
            warn!(error = ?other, "Windows OOP subprocess transient error");
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
    }
}

impl VideoMuxer for WindowsOOPFragmentedM4SMuxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let Some(adjusted_timestamp) = self.pause.adjust(timestamp)? else {
            return Ok(());
        };

        if let Some(state) = &self.state {
            match state.video_tx.send(Some((frame.frame, adjusted_timestamp))) {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(_) => {
                    return Err(anyhow!("Windows OOP M4S encoder channel disconnected"));
                }
            }
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsOOPFragmentedM4SMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}
