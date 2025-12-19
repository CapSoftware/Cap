use crate::{AudioFrame, AudioMuxer, Muxer, TaskPool, VideoMuxer, fragmentation, screen_capture};
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

#[derive(Debug, Clone)]
pub struct SegmentInfo {
    pub path: PathBuf,
    pub index: u32,
    pub duration: Duration,
    pub file_size: Option<u64>,
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
    video_tx: SyncSender<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>,
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
                "Dropped {} screen frames due to encoder backpressure",
                self.count
            );
            self.count = 0;
            self.last_warning = std::time::Instant::now();
        }
    }

    fn reset(&mut self) {
        if self.count > 0 {
            trace!("Frame drop count at segment boundary: {}", self.count);
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

pub struct MacOSSegmentedMuxer {
    base_path: PathBuf,
    segment_duration: Duration,
    current_index: u32,
    segment_start_time: Option<Duration>,
    completed_segments: Vec<SegmentInfo>,
    pending_segments: Arc<Mutex<Vec<SegmentInfo>>>,

    current_state: Option<SegmentState>,

    video_config: VideoInfo,

    pause: PauseTracker,
    frame_drops: FrameDropTracker,
}

pub struct MacOSSegmentedMuxerConfig {
    pub segment_duration: Duration,
}

impl Default for MacOSSegmentedMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
        }
    }
}

impl Muxer for MacOSSegmentedMuxer {
    type Config = MacOSSegmentedMuxerConfig;

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
            pending_segments: Arc::new(Mutex::new(Vec::new())),
            current_state: None,
            video_config,
            pause: PauseTracker::new(pause_flag),
            frame_drops: FrameDropTracker::new(),
        })
    }

    fn stop(&mut self) {
        if let Some(state) = &self.current_state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("Screen encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        self.collect_pending_segments();

        let segment_path = self.current_segment_path();
        let segment_start = self.segment_start_time;
        let current_index = self.current_index;

        if let Some(mut state) = self.current_state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Screen encoder channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        if let Err(panic_payload) = handle.join() {
                            warn!(
                                "Screen encoder thread panicked during finish: {:?}",
                                panic_payload
                            );
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "Screen encoder thread did not finish within {:?}, abandoning",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            if let Ok(mut output) = state.output.lock() {
                if let Err(e) = output.write_trailer() {
                    warn!("Failed to write trailer for segment {current_index}: {e}");
                }
            }

            fragmentation::sync_file(&segment_path);

            if let Some(start) = segment_start {
                let final_duration = timestamp.saturating_sub(start);
                let file_size = std::fs::metadata(&segment_path).ok().map(|m| m.len());

                self.completed_segments.push(SegmentInfo {
                    path: segment_path,
                    index: current_index,
                    duration: final_duration,
                    file_size,
                });
            }
        }

        self.finalize_manifest();

        Ok(Ok(()))
    }
}

impl MacOSSegmentedMuxer {
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

    fn collect_pending_segments(&mut self) {
        if let Ok(mut pending) = self.pending_segments.lock() {
            for segment in pending.drain(..) {
                self.completed_segments.push(segment);
            }
            self.completed_segments.sort_by_key(|s| s.index);
        }
    }

    fn create_segment(&mut self) -> anyhow::Result<()> {
        let segment_path = self.current_segment_path();

        let (video_tx, video_rx) =
            sync_channel::<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>(8);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);
        let output = ffmpeg::format::output(&segment_path)?;
        let output = Arc::new(Mutex::new(output));

        let video_config = self.video_config;
        let output_clone = output.clone();

        let encoder_handle = std::thread::Builder::new()
            .name(format!("segment-encoder-{}", self.current_index))
            .spawn(move || {
                let encoder = (|| {
                    let mut output_guard = match output_clone.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => {
                            return Err(anyhow!(
                                "MacOSSegmentedEncoder: failed to lock output mutex: {}",
                                poisoned
                            ));
                        }
                    };

                    cap_enc_ffmpeg::h264::H264Encoder::builder(video_config)
                        .build(&mut output_guard)
                        .map_err(|e| anyhow!("MacOSSegmentedEncoder/{e}"))
                })();

                let mut encoder = match encoder {
                    Ok(encoder) => {
                        if ready_tx.send(Ok(())).is_err() {
                            error!("Failed to send ready signal - receiver dropped");
                            return Ok(());
                        }
                        encoder
                    }
                    Err(e) => {
                        error!("Encoder setup failed: {:#}", e);
                        if let Err(send_err) = ready_tx.send(Err(anyhow!("{e}"))) {
                            error!("failed to send ready_tx error: {send_err}");
                        }
                        return Err(anyhow!("{e}"));
                    }
                };

                let mut first_timestamp: Option<Duration> = None;

                while let Ok(Some((sample_buf, timestamp))) = video_rx.recv() {
                    let Ok(mut output) = output_clone.lock() else {
                        continue;
                    };

                    let relative = if let Some(first) = first_timestamp {
                        timestamp.checked_sub(first).unwrap_or(Duration::ZERO)
                    } else {
                        first_timestamp = Some(timestamp);
                        Duration::ZERO
                    };

                    let frame = sample_buf_to_ffmpeg_frame(&sample_buf);

                    match frame {
                        Ok(frame) => {
                            if let Err(e) = encoder.queue_frame(frame, relative, &mut output) {
                                warn!("Failed to encode frame: {e}");
                            }
                        }
                        Err(e) => {
                            warn!("Failed to convert frame: {e:?}");
                        }
                    }
                }

                if let Ok(mut output) = output_clone.lock() {
                    if let Err(e) = encoder.flush(&mut output) {
                        warn!("Failed to flush encoder: {e}");
                    }
                }

                drop(encoder);

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("Encoder thread ended unexpectedly"))??;

        output
            .lock()
            .map_err(|_| anyhow!("output mutex poisoned when writing header"))?
            .write_header()?;

        self.current_state = Some(SegmentState {
            video_tx,
            output,
            encoder_handle: Some(encoder_handle),
        });

        Ok(())
    }

    fn rotate_segment(&mut self, timestamp: Duration) -> anyhow::Result<()> {
        self.collect_pending_segments();

        let segment_start = self.segment_start_time.unwrap_or(Duration::ZERO);
        let segment_duration = timestamp.saturating_sub(segment_start);
        let completed_segment_path = self.current_segment_path();
        let current_index = self.current_index;

        if let Some(mut state) = self.current_state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("Screen encoder channel already closed during rotation: {e}");
            }

            let output = state.output.clone();
            let encoder_handle = state.encoder_handle.take();
            let path_for_sync = completed_segment_path.clone();
            let pending_segments = self.pending_segments.clone();

            std::thread::spawn(move || {
                if let Some(handle) = encoder_handle {
                    let timeout = Duration::from_secs(5);
                    let start = std::time::Instant::now();
                    loop {
                        if handle.is_finished() {
                            if let Err(panic_payload) = handle.join() {
                                warn!(
                                    "Screen encoder thread panicked during rotation: {:?}",
                                    panic_payload
                                );
                            }
                            break;
                        }
                        if start.elapsed() > timeout {
                            warn!(
                                "Screen encoder thread did not finish within {:?} during rotation, abandoning",
                                timeout
                            );
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }

                if let Ok(mut output) = output.lock() {
                    if let Err(e) = output.write_trailer() {
                        warn!("Failed to write trailer for segment {current_index}: {e}");
                    }
                }

                fragmentation::sync_file(&path_for_sync);

                let file_size = std::fs::metadata(&path_for_sync).ok().map(|m| m.len());

                if let Ok(mut pending) = pending_segments.lock() {
                    pending.push(SegmentInfo {
                        path: path_for_sync,
                        index: current_index,
                        duration: segment_duration,
                        file_size,
                    });
                }
            });

            self.write_manifest();
        }

        self.frame_drops.reset();
        self.current_index += 1;
        self.segment_start_time = Some(timestamp);

        self.create_segment()?;
        self.write_in_progress_manifest();

        info!(
            "Rotated to segment {} at {:?}",
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

impl VideoMuxer for MacOSSegmentedMuxer {
    type VideoFrame = screen_capture::VideoFrame;

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
            self.create_segment()?;
            self.write_in_progress_manifest();
        }

        if self.segment_start_time.is_none() {
            self.segment_start_time = Some(adjusted_timestamp);
        }

        let segment_elapsed =
            adjusted_timestamp.saturating_sub(self.segment_start_time.unwrap_or(Duration::ZERO));

        if segment_elapsed >= self.segment_duration {
            self.rotate_segment(adjusted_timestamp)?;
        }

        if let Some(state) = &self.current_state
            && let Err(e) = state
                .video_tx
                .try_send(Some((frame.sample_buf, adjusted_timestamp)))
        {
            match e {
                std::sync::mpsc::TrySendError::Full(_) => {
                    self.frame_drops.record_drop();
                }
                std::sync::mpsc::TrySendError::Disconnected(_) => {
                    trace!("Screen encoder channel disconnected");
                }
            }
        }

        Ok(())
    }
}

impl AudioMuxer for MacOSSegmentedMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}

fn sample_buf_to_ffmpeg_frame(
    sample_buf: &cidre::cm::SampleBuf,
) -> Result<ffmpeg::frame::Video, SampleBufConversionError> {
    use cidre::cv::{self, pixel_buffer::LockFlags};

    let Some(image_buf_ref) = sample_buf.image_buf() else {
        return Err(SampleBufConversionError::NoImageBuffer);
    };
    let mut image_buf = image_buf_ref.retained();

    let width = image_buf.width();
    let height = image_buf.height();
    let pixel_format = image_buf.pixel_format();
    let plane0_stride = image_buf.plane_bytes_per_row(0);
    let plane1_stride = image_buf.plane_bytes_per_row(1);

    let bytes_lock = BaseAddrLockGuard::lock(image_buf.as_mut(), LockFlags::READ_ONLY)
        .map_err(SampleBufConversionError::BaseAddrLock)?;

    Ok(match pixel_format {
        cv::PixelFormat::_420V => {
            let mut ff_frame =
                ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, width as u32, height as u32);

            let src_stride = plane0_stride;
            let dest_stride = ff_frame.stride(0);

            let src_bytes = bytes_lock.plane_data(0);
            let dest_bytes = &mut ff_frame.data_mut(0);

            for y in 0..height {
                let row_width = width;
                let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                dest_row.copy_from_slice(src_row);
            }

            let src_stride = plane1_stride;
            let dest_stride = ff_frame.stride(1);

            let src_bytes = bytes_lock.plane_data(1);
            let dest_bytes = &mut ff_frame.data_mut(1);

            for y in 0..height / 2 {
                let row_width = width;
                let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                dest_row.copy_from_slice(src_row);
            }

            ff_frame
        }
        cv::PixelFormat::_32_BGRA => {
            let mut ff_frame =
                ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, width as u32, height as u32);

            let src_stride = plane0_stride;
            let dest_stride = ff_frame.stride(0);

            let src_bytes = bytes_lock.plane_data(0);
            let dest_bytes = &mut ff_frame.data_mut(0);

            for y in 0..height {
                let row_width = width * 4;
                let src_row = &src_bytes[y * src_stride..y * src_stride + row_width];
                let dest_row = &mut dest_bytes[y * dest_stride..y * dest_stride + row_width];

                dest_row.copy_from_slice(src_row);
            }

            ff_frame
        }
        format => return Err(SampleBufConversionError::UnsupportedFormat(format)),
    })
}

#[derive(Debug)]
pub enum SampleBufConversionError {
    UnsupportedFormat(cidre::cv::PixelFormat),
    BaseAddrLock(cidre::os::Error),
    NoImageBuffer,
}

struct BaseAddrLockGuard<'a>(
    &'a mut cidre::cv::ImageBuf,
    cidre::cv::pixel_buffer::LockFlags,
);

impl<'a> BaseAddrLockGuard<'a> {
    fn lock(
        image_buf: &'a mut cidre::cv::ImageBuf,
        flags: cidre::cv::pixel_buffer::LockFlags,
    ) -> cidre::os::Result<Self> {
        unsafe { image_buf.lock_base_addr(flags) }.result()?;
        Ok(Self(image_buf, flags))
    }

    fn plane_data(&self, index: usize) -> &[u8] {
        let base_addr = self.0.plane_base_address(index);
        let plane_size = self.0.plane_bytes_per_row(index);
        unsafe { std::slice::from_raw_parts(base_addr, plane_size * self.0.plane_height(index)) }
    }
}

impl Drop for BaseAddrLockGuard<'_> {
    fn drop(&mut self) {
        let _ = unsafe { self.0.unlock_lock_base_addr(self.1) };
    }
}
