use crate::output_pipeline::win::{NativeCameraFrame, upload_mf_buffer_to_texture};
use crate::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoMuxer, fragmentation};
use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, VideoInfo};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{SyncSender, sync_channel},
    },
    thread::JoinHandle,
    time::Duration,
};
use tracing::*;
use windows::{Foundation::TimeSpan, Graphics::SizeInt32};

#[derive(Debug, Clone)]
struct SegmentInfo {
    path: PathBuf,
    index: u32,
    duration: Duration,
    file_size: Option<u64>,
}

#[derive(Serialize)]
struct FragmentEntry {
    path: String,
    index: u32,
    duration: f64,
    is_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
}

const MANIFEST_VERSION: u32 = 2;

#[derive(Serialize)]
struct Manifest {
    version: u32,
    fragments: Vec<FragmentEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_duration: Option<f64>,
    is_complete: bool,
}

struct SegmentState {
    video_tx: SyncSender<Option<(NativeCameraFrame, Duration)>>,
    output: Arc<Mutex<ffmpeg::format::context::Output>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

struct PauseTracker {
    flag: Arc<AtomicBool>,
    paused_at: Option<Duration>,
    offset: Duration,
}

struct FrameDropTracker {
    count: u32,
    last_warning: std::time::Instant,
}

impl FrameDropTracker {
    fn new() -> Self {
        Self {
            count: 0,
            last_warning: std::time::Instant::now(),
        }
    }

    fn record_drop(&mut self) {
        self.count += 1;
        if self.count >= 30 && self.last_warning.elapsed() > Duration::from_secs(5) {
            warn!(
                "Dropped {} camera frames due to encoder backpressure",
                self.count
            );
            self.count = 0;
            self.last_warning = std::time::Instant::now();
        }
    }

    fn reset(&mut self) {
        if self.count > 0 {
            trace!(
                "Camera frame drop count at segment boundary: {}",
                self.count
            );
        }
        self.count = 0;
    }
}

impl PauseTracker {
    fn new(flag: Arc<AtomicBool>) -> Self {
        Self {
            flag,
            paused_at: None,
            offset: Duration::ZERO,
        }
    }

    fn adjust(&mut self, timestamp: Duration) -> anyhow::Result<Option<Duration>> {
        if self.flag.load(Ordering::Relaxed) {
            if self.paused_at.is_none() {
                self.paused_at = Some(timestamp);
            }
            return Ok(None);
        }

        if let Some(start) = self.paused_at.take() {
            let delta = timestamp.checked_sub(start).ok_or_else(|| {
                anyhow!(
                    "Frame timestamp went backward during unpause (resume={start:?}, current={timestamp:?})"
                )
            })?;

            self.offset = self.offset.checked_add(delta).ok_or_else(|| {
                anyhow!(
                    "Pause offset overflow (offset={:?}, delta={delta:?})",
                    self.offset
                )
            })?;
        }

        let adjusted = timestamp.checked_sub(self.offset).ok_or_else(|| {
            anyhow!(
                "Adjusted timestamp underflow (timestamp={timestamp:?}, offset={:?})",
                self.offset
            )
        })?;

        Ok(Some(adjusted))
    }
}

pub struct WindowsSegmentedCameraMuxer {
    base_path: PathBuf,
    segment_duration: Duration,
    current_index: u32,
    segment_start_time: Option<Duration>,
    completed_segments: Vec<SegmentInfo>,

    current_state: Option<SegmentState>,

    video_config: VideoInfo,
    output_height: Option<u32>,
    encoder_preferences: crate::capture_pipeline::EncoderPreferences,

    pause: PauseTracker,
    frame_drops: FrameDropTracker,
}

pub struct WindowsSegmentedCameraMuxerConfig {
    pub output_height: Option<u32>,
    pub segment_duration: Duration,
    pub encoder_preferences: crate::capture_pipeline::EncoderPreferences,
}

impl Default for WindowsSegmentedCameraMuxerConfig {
    fn default() -> Self {
        Self {
            output_height: None,
            segment_duration: Duration::from_secs(3),
            encoder_preferences: crate::capture_pipeline::EncoderPreferences::new(),
        }
    }
}

impl Muxer for WindowsSegmentedCameraMuxer {
    type Config = WindowsSegmentedCameraMuxerConfig;

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
        let video_config =
            video_config.ok_or_else(|| anyhow!("invariant: video config expected"))?;

        std::fs::create_dir_all(&output_path)
            .with_context(|| format!("Failed to create segments directory: {output_path:?}"))?;

        Ok(Self {
            base_path: output_path,
            segment_duration: config.segment_duration,
            current_index: 0,
            segment_start_time: None,
            completed_segments: Vec::new(),
            current_state: None,
            video_config,
            output_height: config.output_height,
            encoder_preferences: config.encoder_preferences,
            pause: PauseTracker::new(pause_flag),
            frame_drops: FrameDropTracker::new(),
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.current_state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Camera encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        let segment_path = self.current_segment_path();
        let segment_start = self.segment_start_time;

        if let Some(mut state) = self.current_state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Camera encoder channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        if let Err(panic_payload) = handle.join() {
                            warn!(
                                "Camera encoder thread panicked during finish: {:?}",
                                panic_payload
                            );
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "Camera encoder thread did not finish within {:?}, abandoning",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            let mut output = state
                .output
                .lock()
                .map_err(|_| anyhow!("Failed to lock output"))?;
            output.write_trailer()?;

            fragmentation::sync_file(&segment_path);

            if let Some(start) = segment_start {
                let final_duration = timestamp.saturating_sub(start);
                let file_size = std::fs::metadata(&segment_path).ok().map(|m| m.len());

                self.completed_segments.push(SegmentInfo {
                    path: segment_path,
                    index: self.current_index,
                    duration: final_duration,
                    file_size,
                });
            }
        }

        self.finalize_manifest();

        Ok(Ok(()))
    }
}

impl WindowsSegmentedCameraMuxer {
    fn current_segment_path(&self) -> PathBuf {
        self.base_path
            .join(format!("fragment_{:03}.mp4", self.current_index))
    }

    fn write_manifest(&self) {
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            fragments: self
                .completed_segments
                .iter()
                .map(|s| FragmentEntry {
                    path: s
                        .path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    index: s.index,
                    duration: s.duration.as_secs_f64(),
                    is_complete: true,
                    file_size: s.file_size,
                })
                .collect(),
            total_duration: None,
            is_complete: false,
        };

        let manifest_path = self.base_path.join("manifest.json");
        if let Err(e) = fragmentation::atomic_write_json(&manifest_path, &manifest) {
            warn!(
                "Failed to write manifest to {}: {e}",
                manifest_path.display()
            );
        }
    }

    fn finalize_manifest(&self) {
        let total_duration: Duration = self.completed_segments.iter().map(|s| s.duration).sum();

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            fragments: self
                .completed_segments
                .iter()
                .map(|s| FragmentEntry {
                    path: s
                        .path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    index: s.index,
                    duration: s.duration.as_secs_f64(),
                    is_complete: true,
                    file_size: s.file_size,
                })
                .collect(),
            total_duration: Some(total_duration.as_secs_f64()),
            is_complete: true,
        };

        let manifest_path = self.base_path.join("manifest.json");
        if let Err(e) = fragmentation::atomic_write_json(&manifest_path, &manifest) {
            warn!(
                "Failed to write final manifest to {}: {e}",
                manifest_path.display()
            );
        }
    }

    fn create_segment(&mut self, first_frame: &NativeCameraFrame) -> anyhow::Result<()> {
        use crate::output_pipeline::win::camera_frame_to_ffmpeg;

        let segment_path = self.current_segment_path();

        let input_size = SizeInt32 {
            Width: self.video_config.width as i32,
            Height: self.video_config.height as i32,
        };

        let output_height = self.output_height.unwrap_or(self.video_config.height);
        let output_width = (self.video_config.width * output_height) / self.video_config.height;
        let output_width = output_width & !1;
        let output_height = output_height & !1;

        let output_size = SizeInt32 {
            Width: output_width as i32,
            Height: output_height as i32,
        };

        let frame_rate = self.video_config.fps();
        let bitrate_multiplier = 0.2f32;
        let input_format = first_frame.dxgi_format();
        let video_config = self.video_config;
        let encoder_preferences = self.encoder_preferences.clone();

        let (video_tx, video_rx) = sync_channel::<Option<(NativeCameraFrame, Duration)>>(30);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);
        let output = ffmpeg::format::output(&segment_path)?;
        let output = Arc::new(Mutex::new(output));
        let output_clone = output.clone();

        let encoder_handle = std::thread::Builder::new()
            .name(format!("camera-segment-encoder-{}", self.current_index))
            .spawn(move || {
                cap_mediafoundation_utils::thread_init();

                let d3d_device = match crate::capture_pipeline::create_d3d_device() {
                    Ok(device) => device,
                    Err(e) => {
                        let _ = ready_tx.send(Err(anyhow!("Failed to create D3D device: {e}")));
                        return Err(anyhow!("Failed to create D3D device: {e}"));
                    }
                };

                let encoder = (|| {
                    let fallback = |reason: Option<String>| {
                        encoder_preferences.force_software_only();
                        if let Some(reason) = reason.as_ref() {
                            error!(
                                "Falling back to software H264 encoder for camera segment: {reason}"
                            );
                        } else {
                            info!("Using software H264 encoder for camera segment");
                        }

                        let mut output_guard = match output_clone.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => {
                                return Err(anyhow!(
                                    "CameraSegmentSoftwareEncoder: failed to lock output mutex: {}",
                                    poisoned
                                ));
                            }
                        };

                        cap_enc_ffmpeg::h264::H264Encoder::builder(video_config)
                            .with_output_size(output_width, output_height)
                            .and_then(|builder| builder.build(&mut output_guard))
                            .map(either::Right)
                            .map_err(|e| anyhow!("CameraSegmentSoftwareEncoder/{e}"))
                    };

                    if encoder_preferences.should_force_software() {
                        return fallback(None);
                    }

                    match cap_enc_mediafoundation::H264Encoder::new_with_scaled_output(
                        &d3d_device,
                        input_format,
                        input_size,
                        output_size,
                        frame_rate,
                        bitrate_multiplier,
                    ) {
                        Ok(encoder) => {
                            if let Err(e) = encoder.validate() {
                                return fallback(Some(format!(
                                    "Camera hardware encoder validation failed: {e}"
                                )));
                            }

                            let muxer = {
                                let mut output_guard = match output_clone.lock() {
                                    Ok(guard) => guard,
                                    Err(poisoned) => {
                                        return fallback(Some(format!(
                                            "Failed to lock output mutex: {poisoned}"
                                        )));
                                    }
                                };

                                cap_mediafoundation_ffmpeg::H264StreamMuxer::new(
                                    &mut output_guard,
                                    cap_mediafoundation_ffmpeg::MuxerConfig {
                                        width: output_width,
                                        height: output_height,
                                        fps: frame_rate,
                                        bitrate: encoder.bitrate(),
                                        fragmented: false,
                                        frag_duration_us: 0,
                                    },
                                )
                            };

                            match muxer {
                                Ok(muxer) => Ok(either::Left((encoder, muxer))),
                                Err(err) => fallback(Some(err.to_string())),
                            }
                        }
                        Err(err) => fallback(Some(err.to_string())),
                    }
                })();

                let encoder = match encoder {
                    Ok(encoder) => {
                        if ready_tx.send(Ok(())).is_err() {
                            error!("Failed to send ready signal - receiver dropped");
                            return Ok(());
                        }
                        encoder
                    }
                    Err(e) => {
                        error!("Camera segment encoder setup failed: {:#}", e);
                        let _ = ready_tx.send(Err(anyhow!("{e}")));
                        return Err(anyhow!("{e}"));
                    }
                };

                match encoder {
                    either::Left((mut encoder, mut muxer)) => {
                        info!(
                            "Camera segment encoder started (hardware): {:?} {}x{} -> NV12 {}x{} @ {}fps",
                            input_format,
                            input_size.Width,
                            input_size.Height,
                            output_size.Width,
                            output_size.Height,
                            frame_rate
                        );

                        let mut first_timestamp: Option<Duration> = None;

                        let result = encoder.run(
                            Arc::new(AtomicBool::default()),
                            || {
                                let Ok(Some((frame, timestamp))) = video_rx.recv() else {
                                    trace!("No more camera frames available for segment");
                                    return Ok(None);
                                };

                                let relative = if let Some(first) = first_timestamp {
                                    timestamp.checked_sub(first).unwrap_or(Duration::ZERO)
                                } else {
                                    first_timestamp = Some(timestamp);
                                    Duration::ZERO
                                };

                                let texture = upload_mf_buffer_to_texture(&d3d_device, &frame)?;
                                Ok(Some((texture, duration_to_timespan(relative))))
                            },
                            |output_sample| {
                                let mut output = output_clone.lock().map_err(|e| {
                                    windows::core::Error::new(
                                        windows::core::HRESULT(-1),
                                        format!("Mutex poisoned: {e}"),
                                    )
                                })?;
                                muxer
                                    .write_sample(&output_sample, &mut output)
                                    .map_err(|e| {
                                        windows::core::Error::new(
                                            windows::core::HRESULT(-1),
                                            format!("WriteSample: {e}"),
                                        )
                                    })
                            },
                        );

                        match result {
                            Ok(health_status) => {
                                info!(
                                    "Camera segment encoder finished (hardware): {} frames encoded",
                                    health_status.total_frames_encoded
                                );
                                Ok(())
                            }
                            Err(e) => {
                                if e.should_fallback() {
                                    error!(
                                        "Camera hardware encoder failed with recoverable error, marking for software fallback: {}",
                                        e
                                    );
                                    encoder_preferences.force_software_only();
                                }
                                Err(anyhow!("Camera hardware encoder error: {}", e))
                            }
                        }
                    }
                    either::Right(mut encoder) => {
                        info!(
                            "Camera segment encoder started (software): {}x{} -> {}x{} @ {}fps",
                            video_config.width,
                            video_config.height,
                            output_width,
                            output_height,
                            frame_rate
                        );

                        let mut first_timestamp: Option<Duration> = None;

                        while let Ok(Some((frame, timestamp))) = video_rx.recv() {
                            let relative = if let Some(first) = first_timestamp {
                                timestamp.checked_sub(first).unwrap_or(Duration::ZERO)
                            } else {
                                first_timestamp = Some(timestamp);
                                Duration::ZERO
                            };

                            let ffmpeg_frame = match camera_frame_to_ffmpeg(&frame) {
                                Ok(f) => f,
                                Err(e) => {
                                    warn!("Failed to convert camera frame: {e}");
                                    continue;
                                }
                            };

                            let Ok(mut output_guard) = output_clone.lock() else {
                                continue;
                            };

                            if let Err(e) =
                                encoder.queue_frame(ffmpeg_frame, relative, &mut output_guard)
                            {
                                warn!("Failed to queue camera frame: {e}");
                            }
                        }

                        if let Ok(mut output_guard) = output_clone.lock()
                            && let Err(e) = encoder.flush(&mut output_guard)
                        {
                            warn!("Failed to flush software encoder: {e}");
                        }

                        Ok(())
                    }
                }
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("Camera encoder thread ended unexpectedly"))??;

        output.lock().unwrap().write_header()?;

        self.current_state = Some(SegmentState {
            video_tx,
            output,
            encoder_handle: Some(encoder_handle),
        });

        Ok(())
    }

    fn rotate_segment(
        &mut self,
        timestamp: Duration,
        next_frame: &NativeCameraFrame,
    ) -> anyhow::Result<()> {
        let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
        let segment_duration = timestamp.saturating_sub(segment_start);
        let completed_segment_path = self.current_segment_path();

        if let Some(mut state) = self.current_state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Camera encoder channel already closed during rotation: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        if let Err(panic_payload) = handle.join() {
                            warn!(
                                "Camera encoder thread panicked during rotation: {:?}",
                                panic_payload
                            );
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "Camera encoder thread did not finish within {:?} during rotation, abandoning",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            let mut output = state
                .output
                .lock()
                .map_err(|_| anyhow!("Failed to lock output"))?;
            output.write_trailer()?;

            fragmentation::sync_file(&completed_segment_path);

            let file_size = std::fs::metadata(&completed_segment_path)
                .ok()
                .map(|m| m.len());

            self.completed_segments.push(SegmentInfo {
                path: completed_segment_path,
                index: self.current_index,
                duration: segment_duration,
                file_size,
            });

            self.write_manifest();
        }

        self.frame_drops.reset();
        self.current_index += 1;
        self.segment_start_time = Some(timestamp);

        self.create_segment(next_frame)?;
        self.write_in_progress_manifest();

        info!(
            "Camera rotated to segment {} at {:?}",
            self.current_index, timestamp
        );

        Ok(())
    }

    fn write_in_progress_manifest(&self) {
        let mut fragments: Vec<FragmentEntry> = self
            .completed_segments
            .iter()
            .map(|s| FragmentEntry {
                path: s
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                index: s.index,
                duration: s.duration.as_secs_f64(),
                is_complete: true,
                file_size: s.file_size,
            })
            .collect();

        fragments.push(FragmentEntry {
            path: self
                .current_segment_path()
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            index: self.current_index,
            duration: 0.0,
            is_complete: false,
            file_size: None,
        });

        let manifest = Manifest {
            version: MANIFEST_VERSION,
            fragments,
            total_duration: None,
            is_complete: false,
        };

        let manifest_path = self.base_path.join("manifest.json");
        if let Err(e) = fragmentation::atomic_write_json(&manifest_path, &manifest) {
            warn!(
                "Failed to write in-progress manifest to {}: {e}",
                manifest_path.display()
            );
        }
    }
}

impl VideoMuxer for WindowsSegmentedCameraMuxer {
    type VideoFrame = NativeCameraFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let Some(adjusted_timestamp) = self.pause.adjust(timestamp)? else {
            return Ok(());
        };

        if self.current_state.is_none() {
            self.segment_start_time = Some(adjusted_timestamp);
            self.create_segment(&frame)?;
            self.write_in_progress_manifest();
        }

        if self.segment_start_time.is_none() {
            self.segment_start_time = Some(adjusted_timestamp);
        }

        let segment_elapsed =
            adjusted_timestamp.saturating_sub(self.segment_start_time.unwrap_or(Duration::ZERO));

        if segment_elapsed >= self.segment_duration {
            self.rotate_segment(adjusted_timestamp, &frame)?;
        }

        if let Some(state) = &self.current_state
            && let Err(e) = state.video_tx.try_send(Some((frame, adjusted_timestamp)))
        {
            match e {
                std::sync::mpsc::TrySendError::Full(_) => {
                    self.frame_drops.record_drop();
                }
                std::sync::mpsc::TrySendError::Disconnected(_) => {
                    trace!("Camera encoder channel disconnected");
                }
            }
        }

        Ok(())
    }
}

impl AudioMuxer for WindowsSegmentedCameraMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}

fn duration_to_timespan(duration: Duration) -> TimeSpan {
    const TICKS_PER_SEC: u64 = 10_000_000;
    const NANOS_PER_TICK: u32 = 100;

    let secs_ticks = duration.as_secs().saturating_mul(TICKS_PER_SEC);
    let nanos_ticks = (duration.subsec_nanos() / NANOS_PER_TICK) as u64;
    let total_ticks = secs_ticks.saturating_add(nanos_ticks);
    let clamped = total_ticks.min(i64::MAX as u64);

    TimeSpan {
        Duration: clamped as i64,
    }
}
