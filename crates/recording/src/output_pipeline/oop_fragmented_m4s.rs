use super::core::{
    BlockingThreadFinish, DiskSpaceMonitor, HealthSender, PipelineHealthEvent, SharedHealthSender,
    wait_for_blocking_thread_finish,
};
use super::macos_frame_convert::{
    FramePool, ffmpeg_pixel_format_for_cap, fill_frame_from_sample_buf,
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
    sync::{Arc, atomic::AtomicBool},
    thread::JoinHandle,
    time::Duration,
};
use tracing::*;

fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60)
}

const DEFAULT_MAX_RESPAWNS: u32 = 3;

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
                        "OOP M4S muxer frame drop rate exceeds 5% threshold"
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
                        "OOP M4S muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }
}

type VideoFrameItem = Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>;

struct EncoderState {
    video_tx: std::sync::mpsc::SyncSender<VideoFrameItem>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct OutOfProcessFragmentedM4SMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub bpp: f32,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
    pub segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    pub max_respawns: u32,
}

impl Default for OutOfProcessFragmentedM4SMuxerConfig {
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

pub struct OutOfProcessFragmentedM4SMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    bpp: f32,
    output_size: Option<(u32, u32)>,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    disk_space_callback: Option<DiskSpaceCallback>,
    segment_tx: Option<std::sync::mpsc::Sender<SegmentCompletedEvent>>,
    health_tx: SharedHealthSender,
    max_respawns: u32,
}

impl Muxer for OutOfProcessFragmentedM4SMuxer {
    type Config = OutOfProcessFragmentedM4SMuxerConfig;

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

        std::fs::create_dir_all(&output_path)
            .with_context(|| format!("Failed to create OOP segments directory: {output_path:?}"))?;

        let pause = config
            .shared_pause_state
            .unwrap_or_else(|| SharedPauseState::new(pause_flag));

        Ok(Self {
            base_path: output_path,
            video_config,
            segment_duration: config.segment_duration,
            preset: config.preset,
            bpp: config.bpp,
            output_size: config.output_size,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(SharedHealthSender::new(), "muxer:macos-oop"),
            started: false,
            disk_space_callback: config.disk_space_callback,
            segment_tx: config.segment_tx,
            health_tx: SharedHealthSender::new(),
            max_respawns: config.max_respawns,
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state {
            if state.video_tx.try_send(None).is_ok() {
                return;
            }
            for _ in 0..5 {
                std::thread::sleep(Duration::from_millis(50));
                match state.video_tx.try_send(None) {
                    Ok(()) => return,
                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                        trace!("OOP M4S encoder channel closed during stop retry");
                        return;
                    }
                    Err(std::sync::mpsc::TrySendError::Full(_)) => {}
                }
            }
            warn!(
                "OOP M4S encoder channel still full after retries, finish() will deliver sentinel"
            );
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
        trace!("OOP encoder channel already closed during finish: {error}");
    }

    let thread_result = state
        .encoder_handle
        .take()
        .map(|handle| {
            wait_for_blocking_thread_finish(handle, Duration::from_secs(10), "OOP encoder")
        })
        .unwrap_or(BlockingThreadFinish::Clean);

    match thread_result {
        BlockingThreadFinish::Clean => Ok(()),
        BlockingThreadFinish::Failed(error) => Err(error),
        BlockingThreadFinish::TimedOut(error) => Err(error),
    }
}

impl OutOfProcessFragmentedM4SMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "OOP M4S muxer encoder channel buffer size"
        );

        let bin_path =
            resolve_muxer_binary().with_context(|| "cap-muxer binary not found for OOP muxer")?;

        let (video_tx, video_rx) = std::sync::mpsc::sync_channel::<VideoFrameItem>(buffer_size);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<anyhow::Result<()>>(1);

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
            .name("oop-m4s-segment-encoder".to_string())
            .spawn(move || {
                let mut last_timestamp: Option<Duration> = None;
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

                let rebuild_builder = builder.clone();
                let encoder = match builder.build_standalone() {
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
                    "OOP standalone H264 encoder opened"
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

                let subprocess = match RespawningMuxerSubprocess::new(
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
                    let err = anyhow!("OOP encoder ready signal receiver dropped");
                    return Err(err);
                }

                let pixel_format = ffmpeg_pixel_format_for_cap(video_config.pixel_format);
                let mut frame_pool =
                    FramePool::new(pixel_format, video_config.width, video_config.height);

                let mut encoder = encoder;
                let mut subprocess = subprocess;

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                let mut subprocess_fatal = false;
                let mut disk_exhausted = false;
                let mut keyframe_emitted = false;
                let mut encoder_rebuild_attempts: u32 = 0;
                const MAX_ENCODER_REBUILD_ATTEMPTS: u32 = 1;
                const SLOW_THRESHOLD_MS: u128 = 5;

                while let Ok(Some((sample_buf, timestamp))) = video_rx.recv() {
                    last_timestamp = Some(timestamp);

                    match disk_monitor.poll(&base_path, &health_tx) {
                        super::core::DiskSpacePollResult::Exhausted { .. } => {
                            disk_exhausted = true;
                        }
                        super::core::DiskSpacePollResult::Stopped => {
                            disk_exhausted = true;
                        }
                        _ => {}
                    }

                    if disk_exhausted {
                        continue;
                    }

                    if subprocess_fatal || subprocess.is_exhausted() {
                        continue;
                    }

                    let convert_start = std::time::Instant::now();
                    let frame = frame_pool.get_frame();
                    let fill_result = fill_frame_from_sample_buf(&sample_buf, frame);
                    let convert_elapsed_ms = convert_start.elapsed().as_millis();

                    if convert_elapsed_ms > SLOW_THRESHOLD_MS {
                        slow_convert_count += 1;
                        if slow_convert_count <= 5 || slow_convert_count.is_multiple_of(100) {
                            debug!(
                                elapsed_ms = convert_elapsed_ms,
                                count = slow_convert_count,
                                "OOP fill_frame_from_sample_buf exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    match fill_result {
                        Ok(()) => {
                            let owned_frame = frame_pool.take_frame();
                            let encode_start = std::time::Instant::now();
                            let subprocess_ref = &mut subprocess;
                            let keyframe_emitted_ref = &mut keyframe_emitted;
                            let encode_result = encoder.encode_frame(
                                owned_frame,
                                timestamp,
                                |pkt| {
                                    if pkt.is_keyframe {
                                        *keyframe_emitted_ref = true;
                                    }
                                    dispatch_packet(subprocess_ref, pkt)
                                },
                            );
                            let encode_elapsed_ms = encode_start.elapsed().as_millis();
                            if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                                slow_encode_count += 1;
                                if slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                                    debug!(
                                        elapsed_ms = encode_elapsed_ms,
                                        count = slow_encode_count,
                                        "OOP encode_frame exceeded {}ms threshold",
                                        SLOW_THRESHOLD_MS
                                    );
                                }
                            }

                            match encode_result {
                                Ok(()) => {
                                    tracker.on_frame(timestamp);
                                }
                                Err(EncodePacketError::Converter(e)) => {
                                    warn!("OOP encoder converter failure: {e}");
                                }
                                Err(EncodePacketError::Encode(e)) => {
                                    if subprocess.is_exhausted() {
                                        error!(
                                            respawn_attempts = subprocess.respawn_attempts(),
                                            max_consecutive_fast_failures =
                                                subprocess.max_consecutive_fast_failures(),
                                            "OOP subprocess respawn budget exhausted; draining further frames to disk-only fragments"
                                        );
                                        subprocess_fatal = true;
                                    } else if keyframe_emitted
                                        && encoder_rebuild_attempts
                                            < MAX_ENCODER_REBUILD_ATTEMPTS
                                    {
                                        encoder_rebuild_attempts += 1;
                                        warn!(
                                            attempt = encoder_rebuild_attempts,
                                            error = ?e,
                                            "OOP encoder mid-stream error; attempting same-codec rebuild"
                                        );
                                        let _ = encoder.flush(|pkt| {
                                            if pkt.is_keyframe {
                                                keyframe_emitted = true;
                                            }
                                            dispatch_packet(&mut subprocess, pkt)
                                        });
                                        match rebuild_builder.clone().build_standalone() {
                                            Ok(new_enc) => {
                                                let old_name = encoder.codec_name().to_string();
                                                let new_name = new_enc.codec_name().to_string();
                                                info!(
                                                    old_codec = %old_name,
                                                    new_codec = %new_name,
                                                    attempt = encoder_rebuild_attempts,
                                                    "OOP encoder rebuilt mid-stream"
                                                );
                                                encoder = new_enc;
                                                health_tx.emit(
                                                    super::core::PipelineHealthEvent::EncoderRebuilt {
                                                        backend: new_name,
                                                        attempt: encoder_rebuild_attempts,
                                                    },
                                                );
                                            }
                                            Err(rebuild_err) => {
                                                error!(
                                                    error = ?rebuild_err,
                                                    "OOP encoder rebuild failed"
                                                );
                                            }
                                        }
                                    } else {
                                        warn!(
                                            "OOP encoder transient ffmpeg error (subprocess still active)"
                                        );
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            warn!("OOP failed to convert frame: {e:?}");
                        }
                    }

                    total_frames += 1;
                }

                let final_ts = last_timestamp.unwrap_or(Duration::ZERO);

                if !subprocess_fatal && !subprocess.is_exhausted() {
                    let subprocess_ref_flush = &mut subprocess;
                    let flush_result =
                        encoder.flush(|pkt| dispatch_packet(subprocess_ref_flush, pkt));
                    if let Err(e) = flush_result {
                        warn!("OOP encoder flush error: {e:?}");
                    }
                }

                let subprocess_report = match subprocess.finish() {
                    Ok(report) => Some(report),
                    Err(e) => {
                        warn!("OOP subprocess finish error: {e:#}");
                        None
                    }
                };

                tracker.flush_pending_segments();
                tracker.finalize(final_ts);

                if total_frames > 0 {
                    debug!(
                        total_frames = total_frames,
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
                        "OOP M4S encoder timing summary"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("OOP M4S encoder thread ended unexpectedly"))??;

        self.state = Some(EncoderState {
            video_tx,
            encoder_handle: Some(encoder_handle),
        });
        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started OOP M4S fragmented video encoder subprocess"
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
            warn!(reason, "OOP subprocess crash reported to encoder loop");
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
        Err(MuxerSubprocessError::RespawnExhausted { .. }) => {
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
        Err(MuxerSubprocessError::DiskFull(reason)) => {
            warn!(reason, "OOP subprocess exited with disk full");
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
        Err(other) => {
            warn!(error = ?other, "OOP subprocess transient error");
            Err(EncodePacketError::Encode(ffmpeg::Error::Other {
                errno: ffmpeg::ffi::AVERROR_EXTERNAL,
            }))
        }
    }
}

impl VideoMuxer for OutOfProcessFragmentedM4SMuxer {
    type VideoFrame = screen_capture::VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let Some(adjusted_timestamp) = self.pause.adjust(timestamp)? else {
            return Ok(());
        };

        if !self.started {
            self.start_encoder()?;
        }

        if let Some(state) = &self.state {
            match state
                .video_tx
                .try_send(Some((frame.sample_buf, adjusted_timestamp)))
            {
                Ok(()) => {
                    self.frame_drops.record_frame();
                }
                Err(e) => match e {
                    std::sync::mpsc::TrySendError::Full(_) => {
                        self.frame_drops.record_drop();
                    }
                    std::sync::mpsc::TrySendError::Disconnected(_) => {
                        return Err(anyhow!("OOP M4S encoder channel disconnected"));
                    }
                },
            }
        }

        Ok(())
    }
}

impl AudioMuxer for OutOfProcessFragmentedM4SMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}
