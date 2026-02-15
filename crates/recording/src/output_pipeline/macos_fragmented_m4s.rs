use crate::{
    AudioFrame, AudioMuxer, Muxer, SharedPauseState, TaskPool, VideoMuxer,
    output_pipeline::NativeCameraFrame, screen_capture,
};
use anyhow::{Context, anyhow};
use cap_enc_ffmpeg::h264::{H264EncoderBuilder, H264Preset};
use cap_enc_ffmpeg::segmented_stream::{
    DiskSpaceCallback, SegmentedVideoEncoder, SegmentedVideoEncoderConfig,
};
use cap_media_info::{AudioInfo, VideoInfo};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::AtomicBool,
        mpsc::{SyncSender, sync_channel},
    },
    thread::JoinHandle,
    time::Duration,
};
use tracing::*;

fn get_muxer_buffer_size() -> usize {
    std::env::var("CAP_MUXER_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(120)
}

struct FrameDropTracker {
    drops_in_window: u32,
    frames_in_window: u32,
    total_drops: u64,
    total_frames: u64,
    last_check: std::time::Instant,
}

impl FrameDropTracker {
    fn new() -> Self {
        Self {
            drops_in_window: 0,
            frames_in_window: 0,
            total_drops: 0,
            total_frames: 0,
            last_check: std::time::Instant::now(),
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
                        "M4S muxer frame drop rate exceeds 5% threshold"
                    );
                } else if self.drops_in_window > 0 {
                    debug!(
                        frames = self.frames_in_window,
                        drops = self.drops_in_window,
                        drop_rate_pct = format!("{:.1}%", drop_rate),
                        "M4S muxer frame stats"
                    );
                }
            }
            self.drops_in_window = 0;
            self.frames_in_window = 0;
            self.last_check = std::time::Instant::now();
        }
    }
}

struct EncoderState {
    video_tx: SyncSender<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>,
    encoder: Arc<Mutex<SegmentedVideoEncoder>>,
    encoder_handle: Option<JoinHandle<anyhow::Result<()>>>,
}

pub struct MacOSFragmentedM4SMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    output_size: Option<(u32, u32)>,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    disk_space_callback: Option<DiskSpaceCallback>,
}

pub struct MacOSFragmentedM4SMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
}

impl Default for MacOSFragmentedM4SMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            preset: H264Preset::Ultrafast,
            output_size: None,
            shared_pause_state: None,
            disk_space_callback: None,
        }
    }
}

impl Muxer for MacOSFragmentedM4SMuxer {
    type Config = MacOSFragmentedM4SMuxerConfig;

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

        let pause = config
            .shared_pause_state
            .unwrap_or_else(|| SharedPauseState::new(pause_flag));

        let mut muxer = Self {
            base_path: output_path,
            video_config,
            segment_duration: config.segment_duration,
            preset: config.preset,
            output_size: config.output_size,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(),
            started: false,
            disk_space_callback: config.disk_space_callback,
        };

        muxer.start_encoder()?;

        Ok(muxer)
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("M4S encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("M4S encoder channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        match handle.join() {
                            Err(panic_payload) => {
                                warn!(
                                    "M4S encoder thread panicked during finish: {:?}",
                                    panic_payload
                                );
                            }
                            Ok(Err(e)) => {
                                warn!("M4S encoder thread returned error: {e}");
                            }
                            Ok(Ok(())) => {}
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "M4S encoder thread did not finish within {:?}, abandoning",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            match state.encoder.lock() {
                Ok(mut encoder) => {
                    if let Err(e) = encoder.finish_with_timestamp(timestamp) {
                        warn!("Failed to finish segmented encoder: {e}");
                    }
                }
                Err(_) => {
                    error!("Encoder mutex poisoned during finish - encoder thread likely panicked");
                    return Ok(Err(anyhow!(
                        "Encoder mutex poisoned - recording may be corrupt or incomplete"
                    )));
                }
            }
        }

        Ok(Ok(()))
    }
}

impl MacOSFragmentedM4SMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "M4S muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            sync_channel::<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: self.output_size,
        };

        let mut encoder =
            SegmentedVideoEncoder::init(self.base_path.clone(), self.video_config, encoder_config)?;
        if let Some(callback) = &self.disk_space_callback {
            encoder.set_disk_space_callback(callback.clone());
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();
        let video_config = self.video_config;

        let encoder_handle = std::thread::Builder::new()
            .name("m4s-segment-encoder".to_string())
            .spawn(move || {
                let pixel_format = match video_config.pixel_format {
                    cap_media_info::Pixel::NV12 => ffmpeg::format::Pixel::NV12,
                    cap_media_info::Pixel::BGRA => ffmpeg::format::Pixel::BGRA,
                    cap_media_info::Pixel::UYVY422 => ffmpeg::format::Pixel::UYVY422,
                    _ => ffmpeg::format::Pixel::NV12,
                };

                let mut frame_pool =
                    FramePool::new(pixel_format, video_config.width, video_config.height);

                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!("Failed to send ready signal - receiver dropped"));
                }

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                const SLOW_THRESHOLD_MS: u128 = 5;

                while let Ok(Some((sample_buf, timestamp))) = video_rx.recv() {
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
                                "fill_frame_from_sample_buf exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    match fill_result {
                        Ok(()) => {
                            let encode_start = std::time::Instant::now();
                            let owned_frame = frame_pool.take_frame();

                            match encoder_clone.lock() {
                                Ok(mut encoder) => {
                                    if let Err(e) = encoder.queue_frame(owned_frame, timestamp) {
                                        warn!("Failed to encode frame: {e}");
                                    }
                                }
                                Err(_) => {
                                    error!("Encoder mutex poisoned - encoder thread likely panicked, stopping");
                                    return Err(anyhow!("Encoder mutex poisoned - all subsequent frames would be lost"));
                                }
                            }

                            let encode_elapsed_ms = encode_start.elapsed().as_millis();

                            if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                                slow_encode_count += 1;
                                if slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                                    debug!(
                                        elapsed_ms = encode_elapsed_ms,
                                        count = slow_encode_count,
                                        "encoder.queue_frame exceeded {}ms threshold",
                                        SLOW_THRESHOLD_MS
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Failed to convert frame: {e:?}");
                        }
                    }

                    total_frames += 1;
                }

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
                        "M4S encoder timing summary (using SegmentedVideoEncoder)"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("M4S encoder thread ended unexpectedly"))??;

        self.state = Some(EncoderState {
            video_tx,
            encoder,
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started M4S fragmented video encoder"
        );

        Ok(())
    }
}

impl VideoMuxer for MacOSFragmentedM4SMuxer {
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
                        trace!("M4S encoder channel disconnected");
                    }
                },
            }
        }

        Ok(())
    }
}

impl AudioMuxer for MacOSFragmentedM4SMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}

fn copy_plane_data(
    src: &[u8],
    dest: &mut [u8],
    height: usize,
    row_width: usize,
    src_stride: usize,
    dest_stride: usize,
) {
    if src_stride == row_width && dest_stride == row_width {
        let total_bytes = height * row_width;
        dest[..total_bytes].copy_from_slice(&src[..total_bytes]);
    } else if src_stride == dest_stride {
        let total_bytes = height * src_stride;
        dest[..total_bytes].copy_from_slice(&src[..total_bytes]);
    } else {
        for y in 0..height {
            let src_row = &src[y * src_stride..y * src_stride + row_width];
            let dest_row = &mut dest[y * dest_stride..y * dest_stride + row_width];
            dest_row.copy_from_slice(src_row);
        }
    }
}

struct FramePool {
    frame: Option<ffmpeg::frame::Video>,
    pixel_format: ffmpeg::format::Pixel,
    width: u32,
    height: u32,
}

impl FramePool {
    fn new(pixel_format: ffmpeg::format::Pixel, width: u32, height: u32) -> Self {
        Self {
            frame: Some(ffmpeg::frame::Video::new(pixel_format, width, height)),
            pixel_format,
            width,
            height,
        }
    }

    fn get_frame(&mut self) -> &mut ffmpeg::frame::Video {
        if self.frame.is_none() {
            self.frame = Some(ffmpeg::frame::Video::new(
                self.pixel_format,
                self.width,
                self.height,
            ));
        }
        self.frame.as_mut().expect("frame initialized above")
    }

    fn take_frame(&mut self) -> ffmpeg::frame::Video {
        self.frame.take().unwrap_or_else(|| {
            ffmpeg::frame::Video::new(self.pixel_format, self.width, self.height)
        })
    }
}

fn fill_frame_from_sample_buf(
    sample_buf: &cidre::cm::SampleBuf,
    frame: &mut ffmpeg::frame::Video,
) -> Result<(), SampleBufConversionError> {
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

    match pixel_format {
        cv::PixelFormat::_420V => {
            let dest_stride0 = frame.stride(0);
            let dest_stride1 = frame.stride(1);

            copy_plane_data(
                bytes_lock.plane_data(0),
                frame.data_mut(0),
                height,
                width,
                plane0_stride,
                dest_stride0,
            );

            copy_plane_data(
                bytes_lock.plane_data(1),
                frame.data_mut(1),
                height / 2,
                width,
                plane1_stride,
                dest_stride1,
            );
        }
        cv::PixelFormat::_32_BGRA => {
            let row_width = width * 4;
            let dest_stride = frame.stride(0);
            copy_plane_data(
                bytes_lock.plane_data(0),
                frame.data_mut(0),
                height,
                row_width,
                plane0_stride,
                dest_stride,
            );
        }
        cv::PixelFormat::_2VUY => {
            let row_width = width * 2;
            let dest_stride = frame.stride(0);
            copy_plane_data(
                bytes_lock.plane_data(0),
                frame.data_mut(0),
                height,
                row_width,
                plane0_stride,
                dest_stride,
            );
        }
        format => return Err(SampleBufConversionError::UnsupportedFormat(format)),
    }

    Ok(())
}

#[derive(Debug)]
#[allow(dead_code)]
enum SampleBufConversionError {
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
        unsafe { self.0.unlock_lock_base_addr(self.1) };
    }
}

pub struct MacOSFragmentedM4SCameraMuxer {
    base_path: PathBuf,
    video_config: VideoInfo,
    segment_duration: Duration,
    preset: H264Preset,
    output_size: Option<(u32, u32)>,
    state: Option<EncoderState>,
    pause: SharedPauseState,
    frame_drops: FrameDropTracker,
    started: bool,
    disk_space_callback: Option<DiskSpaceCallback>,
}

pub struct MacOSFragmentedM4SCameraMuxerConfig {
    pub segment_duration: Duration,
    pub preset: H264Preset,
    pub output_size: Option<(u32, u32)>,
    pub shared_pause_state: Option<SharedPauseState>,
    pub disk_space_callback: Option<DiskSpaceCallback>,
}

impl Default for MacOSFragmentedM4SCameraMuxerConfig {
    fn default() -> Self {
        Self {
            segment_duration: Duration::from_secs(3),
            preset: H264Preset::Ultrafast,
            output_size: None,
            shared_pause_state: None,
            disk_space_callback: None,
        }
    }
}

impl Muxer for MacOSFragmentedM4SCameraMuxer {
    type Config = MacOSFragmentedM4SCameraMuxerConfig;

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
            video_config.ok_or_else(|| anyhow!("invariant: video config expected for camera"))?;

        std::fs::create_dir_all(&output_path).with_context(|| {
            format!("Failed to create camera segments directory: {output_path:?}")
        })?;

        let pause = config
            .shared_pause_state
            .unwrap_or_else(|| SharedPauseState::new(pause_flag));

        let mut muxer = Self {
            base_path: output_path,
            video_config,
            segment_duration: config.segment_duration,
            preset: config.preset,
            output_size: config.output_size,
            state: None,
            pause,
            frame_drops: FrameDropTracker::new(),
            started: false,
            disk_space_callback: config.disk_space_callback,
        };

        muxer.start_encoder()?;

        Ok(muxer)
    }

    fn stop(&mut self) {
        if let Some(state) = &self.state
            && let Err(e) = state.video_tx.send(None)
        {
            trace!("M4S camera encoder channel already closed during stop: {e}");
        }
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        if let Some(mut state) = self.state.take() {
            if let Err(e) = state.video_tx.send(None) {
                trace!("M4S camera encoder channel already closed during finish: {e}");
            }

            if let Some(handle) = state.encoder_handle.take() {
                let timeout = Duration::from_secs(5);
                let start = std::time::Instant::now();
                loop {
                    if handle.is_finished() {
                        match handle.join() {
                            Err(panic_payload) => {
                                warn!(
                                    "M4S camera encoder thread panicked during finish: {:?}",
                                    panic_payload
                                );
                            }
                            Ok(Err(e)) => {
                                warn!("M4S camera encoder thread returned error: {e}");
                            }
                            Ok(Ok(())) => {}
                        }
                        break;
                    }
                    if start.elapsed() > timeout {
                        warn!(
                            "M4S camera encoder thread did not finish within {:?}, abandoning",
                            timeout
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }

            match state.encoder.lock() {
                Ok(mut encoder) => {
                    if let Err(e) = encoder.finish_with_timestamp(timestamp) {
                        warn!("Failed to finish camera segmented encoder: {e}");
                    }
                }
                Err(_) => {
                    error!(
                        "Camera encoder mutex poisoned during finish - encoder thread likely panicked"
                    );
                    return Ok(Err(anyhow!(
                        "Camera encoder mutex poisoned - recording may be corrupt or incomplete"
                    )));
                }
            }
        }

        Ok(Ok(()))
    }
}

impl MacOSFragmentedM4SCameraMuxer {
    fn start_encoder(&mut self) -> anyhow::Result<()> {
        let buffer_size = get_muxer_buffer_size();
        debug!(
            buffer_size = buffer_size,
            "M4S camera muxer encoder channel buffer size"
        );

        let (video_tx, video_rx) =
            sync_channel::<Option<(cidre::arc::R<cidre::cm::SampleBuf>, Duration)>>(buffer_size);
        let (ready_tx, ready_rx) = sync_channel::<anyhow::Result<()>>(1);

        let encoder_config = SegmentedVideoEncoderConfig {
            segment_duration: self.segment_duration,
            preset: self.preset,
            bpp: H264EncoderBuilder::QUALITY_BPP,
            output_size: self.output_size,
        };

        let mut encoder =
            SegmentedVideoEncoder::init(self.base_path.clone(), self.video_config, encoder_config)?;
        if let Some(callback) = &self.disk_space_callback {
            encoder.set_disk_space_callback(callback.clone());
        }
        let encoder = Arc::new(Mutex::new(encoder));
        let encoder_clone = encoder.clone();
        let video_config = self.video_config;

        let encoder_handle = std::thread::Builder::new()
            .name("m4s-camera-segment-encoder".to_string())
            .spawn(move || {
                let pixel_format = match video_config.pixel_format {
                    cap_media_info::Pixel::NV12 => ffmpeg::format::Pixel::NV12,
                    cap_media_info::Pixel::BGRA => ffmpeg::format::Pixel::BGRA,
                    cap_media_info::Pixel::UYVY422 => ffmpeg::format::Pixel::UYVY422,
                    _ => ffmpeg::format::Pixel::NV12,
                };

                let mut frame_pool =
                    FramePool::new(pixel_format, video_config.width, video_config.height);

                if ready_tx.send(Ok(())).is_err() {
                    return Err(anyhow!(
                        "Failed to send ready signal - camera receiver dropped"
                    ));
                }

                let mut slow_convert_count = 0u32;
                let mut slow_encode_count = 0u32;
                let mut total_frames = 0u64;
                const SLOW_THRESHOLD_MS: u128 = 5;

                while let Ok(Some((sample_buf, timestamp))) = video_rx.recv() {
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
                                "Camera fill_frame_from_sample_buf exceeded {}ms threshold",
                                SLOW_THRESHOLD_MS
                            );
                        }
                    }

                    match fill_result {
                        Ok(()) => {
                            let encode_start = std::time::Instant::now();
                            let owned_frame = frame_pool.take_frame();

                            match encoder_clone.lock() {
                                Ok(mut encoder) => {
                                    if let Err(e) = encoder.queue_frame(owned_frame, timestamp) {
                                        warn!("Failed to encode camera frame: {e}");
                                    }
                                }
                                Err(_) => {
                                    error!("Camera encoder mutex poisoned - encoder thread likely panicked, stopping");
                                    return Err(anyhow!("Camera encoder mutex poisoned - all subsequent frames would be lost"));
                                }
                            }

                            let encode_elapsed_ms = encode_start.elapsed().as_millis();

                            if encode_elapsed_ms > SLOW_THRESHOLD_MS {
                                slow_encode_count += 1;
                                if slow_encode_count <= 5 || slow_encode_count.is_multiple_of(100) {
                                    debug!(
                                        elapsed_ms = encode_elapsed_ms,
                                        count = slow_encode_count,
                                        "Camera encoder.queue_frame exceeded {}ms threshold",
                                        SLOW_THRESHOLD_MS
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            warn!("Failed to convert camera frame: {e:?}");
                        }
                    }

                    total_frames += 1;
                }

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
                        "M4S camera encoder timing summary"
                    );
                }

                Ok(())
            })?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("M4S camera encoder thread ended unexpectedly"))??;

        self.state = Some(EncoderState {
            video_tx,
            encoder,
            encoder_handle: Some(encoder_handle),
        });

        self.started = true;

        info!(
            path = %self.base_path.display(),
            "Started M4S fragmented camera encoder"
        );

        Ok(())
    }
}

impl VideoMuxer for MacOSFragmentedM4SCameraMuxer {
    type VideoFrame = NativeCameraFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        let Some(adjusted_timestamp) = self.pause.adjust(timestamp)? else {
            return Ok(());
        };

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
                        trace!("M4S camera encoder channel disconnected");
                    }
                },
            }
        }

        Ok(())
    }
}

impl AudioMuxer for MacOSFragmentedM4SCameraMuxer {
    fn send_audio_frame(&mut self, _frame: AudioFrame, _timestamp: Duration) -> anyhow::Result<()> {
        Ok(())
    }
}
