use super::*;
use crate::{
    ChannelAudioSourceConfig,
    output_pipeline::{
        self, AudioFrame, ChannelAudioSource, ChannelVideoSource, ChannelVideoSourceConfig,
        SetupCtx,
    },
};
use anyhow::{Context, anyhow};
use cap_timestamp::Timestamp;
use cidre::*;
use futures::{FutureExt as _, channel::mpsc, future::BoxFuture};
use std::{
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{self, AtomicBool, AtomicU32, AtomicU64},
    },
    time::{Duration, Instant},
};
use tokio::{select, sync::broadcast};
use tokio_util::{
    future::FutureExt as _,
    sync::{CancellationToken, DropGuard},
};
use tracing::{debug, info, warn};

struct FrameScaler {
    session: arc::R<cidre::vt::PixelTransferSession>,
    pool: arc::R<cv::PixelBufPool>,
}

unsafe impl Send for FrameScaler {}

impl FrameScaler {
    fn new(expected_width: usize, expected_height: usize) -> Option<Self> {
        let mut session = cidre::vt::PixelTransferSession::new().ok()?;
        session.set_scaling_letter_box().ok()?;
        session.set_realtime(true).ok()?;
        let pool = create_pixel_buffer_pool(expected_width, expected_height)?;

        Some(Self { session, pool })
    }

    fn scale_frame(&self, src_sample_buf: &cm::SampleBuf) -> Option<arc::R<cm::SampleBuf>> {
        let src_image_buf = src_sample_buf.image_buf()?;
        let dst_buf = self.pool.pixel_buf().ok()?;

        self.session.transfer(src_image_buf, &dst_buf).ok()?;

        let format_desc = cm::VideoFormatDesc::with_image_buf(&dst_buf).ok()?;
        let timing = src_sample_buf.timing_info(0).ok()?;

        cm::SampleBuf::with_image_buf(&dst_buf, true, None, ptr::null(), &format_desc, &timing).ok()
    }
}

fn get_pixel_buffer_pool_size() -> usize {
    std::env::var("CAP_PIXEL_BUFFER_POOL_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)
}

fn create_pixel_buffer_pool(width: usize, height: usize) -> Option<arc::R<cv::PixelBufPool>> {
    let min_count = get_pixel_buffer_pool_size();

    let min_count_num = cf::Number::from_usize(min_count);
    let width_num = cf::Number::from_usize(width);
    let height_num = cf::Number::from_usize(height);
    let io_props = cf::Dictionary::new();

    let pool_attr_keys: [&cf::Type; 1] =
        [cv::pixel_buffer_pool::keys::minimum_buffer_count().as_ref()];
    let pool_attr_values: [&cf::Type; 1] = [min_count_num.as_ref()];
    let pool_attrs = cf::Dictionary::with_keys_values(&pool_attr_keys, &pool_attr_values)?;

    let pixel_buf_attr_keys: [&cf::Type; 5] = [
        cv::pixel_buffer::keys::pixel_format().as_ref(),
        cv::pixel_buffer::keys::width().as_ref(),
        cv::pixel_buffer::keys::height().as_ref(),
        cv::pixel_buffer::keys::io_surf_props().as_ref(),
        cv::pixel_buffer::keys::metal_compatibility().as_ref(),
    ];
    let pixel_buf_attr_values: [&cf::Type; 5] = [
        cv::PixelFormat::_420V.to_cf_number().as_ref(),
        width_num.as_ref(),
        height_num.as_ref(),
        io_props.as_ref(),
        cf::Boolean::value_true().as_ref(),
    ];
    let pixel_buf_attrs =
        cf::Dictionary::with_keys_values(&pixel_buf_attr_keys, &pixel_buf_attr_values)?;

    debug!(min_count, width, height, "Pixel buffer pool initialized");
    cv::PixelBufPool::new(Some(pool_attrs.as_ref()), Some(pixel_buf_attrs.as_ref())).ok()
}

struct PixelBufferCopier {
    session: arc::R<cidre::vt::PixelTransferSession>,
    pool: arc::R<cv::PixelBufPool>,
}

unsafe impl Send for PixelBufferCopier {}

impl PixelBufferCopier {
    fn new(width: usize, height: usize) -> Option<Self> {
        let mut session = cidre::vt::PixelTransferSession::new().ok()?;
        session.set_realtime(true).ok()?;
        let pool = create_pixel_buffer_pool(width, height)?;
        Some(Self { session, pool })
    }

    fn copy_frame(&self, src_sample_buf: &cm::SampleBuf) -> Option<arc::R<cm::SampleBuf>> {
        let src_image_buf = src_sample_buf.image_buf()?;
        let dst_buf = self.pool.pixel_buf().ok()?;

        self.session.transfer(src_image_buf, &dst_buf).ok()?;

        let format_desc = cm::VideoFormatDesc::with_image_buf(&dst_buf).ok()?;
        let timing = src_sample_buf.timing_info(0).ok()?;

        cm::SampleBuf::with_image_buf(&dst_buf, true, None, ptr::null(), &format_desc, &timing).ok()
    }
}

fn get_screen_buffer_size() -> usize {
    std::env::var("CAP_SCREEN_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15)
}

fn get_max_queue_depth() -> isize {
    std::env::var("CAP_MAX_QUEUE_DEPTH")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8)
}

#[derive(Debug)]
pub struct CMSampleBufferCapture;

impl ScreenCaptureFormat for CMSampleBufferCapture {
    type VideoFormat = cidre::arc::R<cidre::cm::SampleBuf>;

    fn pixel_format() -> ffmpeg::format::Pixel {
        ffmpeg::format::Pixel::NV12
    }

    fn audio_info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
            48_000,
            2,
        )
        .expect("static F32/48kHz/stereo audio config")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("NoDisplay: Id '{0}'")]
    NoDisplay(DisplayId),
    #[error("AsContentFilter")]
    AsContentFilter,
}

pub struct VideoFrame {
    pub sample_buf: arc::R<cm::SampleBuf>,
    pub timestamp: Timestamp,
}

impl output_pipeline::VideoFrame for VideoFrame {
    fn timestamp(&self) -> Timestamp {
        self.timestamp
    }
}

impl ScreenCaptureConfig<CMSampleBufferCapture> {
    pub async fn to_sources(
        &self,
    ) -> anyhow::Result<(VideoSourceConfig, Option<SystemAudioSourceConfig>)> {
        let (error_tx, error_rx) = broadcast::channel(1);
        let buffer_size = get_screen_buffer_size();
        debug!(buffer_size = buffer_size, "Screen capture buffer size");
        let (video_tx, video_rx) = flume::bounded(buffer_size);
        let drop_counter: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let (mut audio_tx, audio_rx) = if self.system_audio {
            let (tx, rx) = mpsc::channel(128);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let system_audio_drop_counter: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let system_audio_frame_counter: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

        let display = Display::from_id(&self.config.display)
            .ok_or_else(|| SourceError::NoDisplay(self.config.display.clone()))?;

        let excluded_sc_windows = if self.excluded_windows.is_empty() {
            Vec::new()
        } else {
            let mut collected = Vec::new();

            for window_id in &self.excluded_windows {
                let Some(window) = Window::from_id(window_id) else {
                    continue;
                };

                if let Some(sc_window) = window.raw_handle().as_sc(self.shareable_content.clone()) {
                    collected.push(sc_window);
                }
            }

            collected
        };

        let content_filter = display
            .raw_handle()
            .as_content_filter_excluding_windows(
                self.shareable_content.clone(),
                excluded_sc_windows,
            )
            .ok_or(SourceError::AsContentFilter)?;

        debug!("SCK content filter: {:?}", content_filter);

        let size = {
            let logical_size = self
                .config
                .crop_bounds
                .map(|bounds| bounds.size())
                .or_else(|| display.logical_size())
                .ok_or_else(|| anyhow!("Display has no logical size"))?;

            let physical_size = display
                .physical_size()
                .ok_or_else(|| anyhow!("Display has no physical size"))?;
            let display_logical_size = display
                .logical_size()
                .ok_or_else(|| anyhow!("Display has no logical size for scale computation"))?;

            let scale = physical_size.width() / display_logical_size.width();

            let width = ensure_even((logical_size.width() * scale) as u32) as f64;
            let height = ensure_even((logical_size.height() * scale) as u32) as f64;
            PhysicalSize::new(width, height)
        };

        debug!("size: {:?}", size);

        let max_queue_depth = get_max_queue_depth();
        let queue_depth =
            ((self.config.fps as f32 / 30.0 * 5.0).ceil() as isize).clamp(3, max_queue_depth);
        debug!(
            queue_depth = queue_depth,
            max_queue_depth = max_queue_depth,
            "Screen capture queue depth"
        );

        let mut settings = scap_screencapturekit::StreamCfgBuilder::default()
            .with_width(size.width() as usize)
            .with_height(size.height() as usize)
            .with_fps(self.config.fps as f32)
            .with_shows_cursor(self.config.show_cursor)
            .with_captures_audio(self.system_audio)
            .with_queue_depth(queue_depth)
            .build();

        settings.set_pixel_format(cv::PixelFormat::_420V);
        settings.set_color_space_name(cg::color_space::names::srgb());

        if let Some(crop_bounds) = self.config.crop_bounds {
            debug!("crop bounds: {:?}", crop_bounds);
            settings.set_src_rect(cg::Rect::new(
                crop_bounds.position().x(),
                crop_bounds.position().y(),
                crop_bounds.size().width(),
                crop_bounds.size().height(),
            ));
        }
        cap_fail::fail_err!(
            "macos::ScreenCaptureActor::new",
            ns::Error::with_domain(ns::ErrorDomain::os_status(), 69420, None)
        );

        let video_frame_counter: Arc<AtomicU32> = Arc::new(AtomicU32::new(0));

        let expected_width = self.video_info.width as usize;
        let expected_height = self.video_info.height as usize;
        let frame_scaler: Arc<Mutex<Option<FrameScaler>>> = Arc::new(Mutex::new(None));
        let scaling_logged = Arc::new(AtomicBool::new(false));
        let scaled_frame_count = Arc::new(AtomicU64::new(0));

        let pixel_buffer_copier: Arc<Mutex<Option<PixelBufferCopier>>> = Arc::new(Mutex::new(
            PixelBufferCopier::new(expected_width, expected_height),
        ));

        let builder = scap_screencapturekit::Capturer::builder(content_filter, settings)
            .with_output_sample_buf_cb({
                let video_frame_count = video_frame_counter.clone();
                let drop_counter = drop_counter.clone();
                let frame_scaler = frame_scaler.clone();
                let scaling_logged = scaling_logged.clone();
                let scaled_frame_count = scaled_frame_count.clone();
                let pixel_buffer_copier = pixel_buffer_copier.clone();
                let sys_audio_drop_counter = system_audio_drop_counter.clone();
                let sys_audio_frame_counter = system_audio_frame_counter.clone();
                move |frame| {
                    let sample_buffer = frame.sample_buf();

                    let mach_timestamp =
                        cm::Clock::convert_host_time_to_sys_units(sample_buffer.pts());
                    let timestamp = Timestamp::MachAbsoluteTime(
                        cap_timestamp::MachAbsoluteTimestamp::new(mach_timestamp),
                    );

                    match &frame {
                        scap_screencapturekit::Frame::Screen(frame) => {
                            let Some(image_buf) = frame.image_buf() else {
                                return;
                            };
                            if image_buf.height() == 0 || image_buf.width() == 0 {
                                return;
                            }

                            let frame_width = image_buf.width();
                            let frame_height = image_buf.height();

                            let final_sample_buf =
                                if frame_width != expected_width || frame_height != expected_height
                                {
                                    let Ok(mut scaler_guard) = frame_scaler.lock() else {
                                        drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                        return;
                                    };

                                    if scaler_guard.is_none() {
                                        *scaler_guard =
                                            FrameScaler::new(expected_width, expected_height);

                                        if scaler_guard.is_some() {
                                            info!(
                                                expected_width,
                                                expected_height,
                                                frame_width,
                                                frame_height,
                                                "Display configuration changed, scaling frames to match original dimensions"
                                            );
                                        } else {
                                            warn!(
                                                "Failed to create frame scaler, dropping mismatched frames"
                                            );
                                        }
                                        scaling_logged.store(true, atomic::Ordering::Relaxed);
                                    }

                                    let Some(scaler) = scaler_guard.as_ref() else {
                                        drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                        return;
                                    };

                                    let Some(scaled) = scaler.scale_frame(sample_buffer) else {
                                        drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                        return;
                                    };

                                    let count =
                                        scaled_frame_count.fetch_add(1, atomic::Ordering::Relaxed)
                                            + 1;
                                    if count.is_multiple_of(300) {
                                        debug!(scaled_frames = count, "Scaling frames");
                                    }

                                    scaled
                                } else {
                                    if scaling_logged.swap(false, atomic::Ordering::Relaxed) {
                                        let count =
                                            scaled_frame_count.swap(0, atomic::Ordering::Relaxed);
                                        info!(
                                            scaled_frames = count,
                                            "Display dimensions restored, resuming direct capture"
                                        );
                                        if let Ok(mut guard) = frame_scaler.lock() {
                                            *guard = None;
                                        }
                                    }

                                    let copied = if let Ok(copier_guard) = pixel_buffer_copier.lock() {
                                        if let Some(copier) = copier_guard.as_ref() {
                                            copier.copy_frame(sample_buffer)
                                        } else {
                                            None
                                        }
                                    } else {
                                        None
                                    };

                                    match copied {
                                        Some(buf) => buf,
                                        None => {
                                            drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                                            return;
                                        }
                                    }
                                };

                            cap_fail::fail_ret!("screen_capture video frame skip");

                            video_frame_count.fetch_add(1, atomic::Ordering::Relaxed);

                            if video_tx
                                .try_send(VideoFrame {
                                    sample_buf: final_sample_buf,
                                    timestamp,
                                })
                                .is_err()
                            {
                                drop_counter.fetch_add(1, atomic::Ordering::Relaxed);
                            }
                        }
                        scap_screencapturekit::Frame::Audio(_) => {
                            use ffmpeg::ChannelLayout;

                            cap_fail::fail_ret!("screen_capture audio frame skip");

                            let Some(audio_tx) = &mut audio_tx else {
                                return;
                            };

                            let Ok(buf_list) = sample_buffer.audio_buf_list::<2>() else {
                                warn!("Failed to extract audio buffer list from sample, dropping audio chunk");
                                return;
                            };
                            let Ok(slice) = buf_list.block().as_slice() else {
                                warn!("Failed to get audio buffer slice, dropping audio chunk");
                                return;
                            };

                            let mut frame = ffmpeg::frame::Audio::new(
                                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                                sample_buffer.num_samples() as usize,
                                ChannelLayout::STEREO,
                            );
                            frame.set_rate(48_000);
                            let data_bytes_size = buf_list.list().buffers[0].data_bytes_size;
                            for i in 0..frame.planes() {
                                frame.data_mut(i).copy_from_slice(
                                    &slice[i * data_bytes_size as usize
                                        ..(i + 1) * data_bytes_size as usize],
                                );
                            }

                            match audio_tx.try_send(AudioFrame::new(frame, timestamp)) {
                                Ok(()) => {
                                    sys_audio_frame_counter
                                        .fetch_add(1, atomic::Ordering::Relaxed);
                                }
                                Err(_) => {
                                    sys_audio_drop_counter
                                        .fetch_add(1, atomic::Ordering::Relaxed);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            })
            .with_stop_with_err_cb({
                let video_frame_count = video_frame_counter.clone();
                move |_, err| {
                    debug!(
                        "Capturer stopping after creating {} video frames",
                        video_frame_count.load(atomic::Ordering::Relaxed)
                    );

                    let _ = error_tx.send(err.retained());
                }
            });

        let cancel_token = CancellationToken::new();
        let capturer = Capturer::new(Arc::new(builder.build()?));

        Ok((
            VideoSourceConfig {
                inner: ChannelVideoSourceConfig::new(self.video_info, video_rx),
                capturer: capturer.clone(),
                error_rx: error_rx.resubscribe(),
                video_frame_counter: video_frame_counter.clone(),
                drop_counter,
                cancel_token: cancel_token.clone(),
                drop_guard: cancel_token.drop_guard(),
            },
            audio_rx.map(|rx| {
                SystemAudioSourceConfig(
                    ChannelAudioSourceConfig::new(self.audio_info(), rx),
                    capturer,
                    error_rx,
                    system_audio_frame_counter,
                    system_audio_drop_counter,
                )
            }),
        ))
    }
}

// Public

pub struct StartCapturing;

// External

pub struct NewFrame(pub scap_screencapturekit::Frame);

// Internal

pub struct CaptureError(pub arc::R<ns::Error>);

struct Capturer {
    started: Arc<AtomicBool>,
    capturer: Arc<scap_screencapturekit::Capturer>,
}

impl Clone for Capturer {
    fn clone(&self) -> Self {
        Self {
            started: self.started.clone(),
            capturer: self.capturer.clone(),
            // error_rx: self.error_rx.resubscribe(),
        }
    }
}

impl Capturer {
    fn new(capturer: Arc<scap_screencapturekit::Capturer>) -> Self {
        Self {
            started: Arc::new(AtomicBool::new(false)),
            capturer,
        }
    }

    async fn start(&self) -> anyhow::Result<()> {
        if self
            .started
            .compare_exchange(
                false,
                true,
                atomic::Ordering::Relaxed,
                atomic::Ordering::Relaxed,
            )
            .is_ok()
        {
            self.capturer
                .start()
                .await
                .map_err(|err| anyhow!(format!("{err}")))?;
        }

        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        if self
            .started
            .compare_exchange(
                true,
                false,
                atomic::Ordering::Relaxed,
                atomic::Ordering::Relaxed,
            )
            .is_ok()
        {
            self.capturer.stop().await.context("capturer_stop")?;
        }

        Ok(())
    }

    fn mark_stopped(&self) {
        self.started.store(false, atomic::Ordering::Relaxed);
    }
}

pub struct VideoSourceConfig {
    inner: ChannelVideoSourceConfig<VideoFrame>,
    capturer: Capturer,
    error_rx: broadcast::Receiver<arc::R<ns::Error>>,
    cancel_token: CancellationToken,
    drop_guard: DropGuard,
    video_frame_counter: Arc<AtomicU32>,
    drop_counter: Arc<AtomicU64>,
}
pub struct VideoSource {
    inner: ChannelVideoSource<VideoFrame>,
    capturer: Capturer,
    cancel_token: CancellationToken,
    video_frame_counter: Arc<AtomicU32>,
    drop_counter: Arc<AtomicU64>,
    _drop_guard: DropGuard,
    health_tx: output_pipeline::HealthSender,
}

impl output_pipeline::VideoSource for VideoSource {
    type Config = VideoSourceConfig;
    type Frame = VideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let VideoSourceConfig {
            inner,
            capturer,
            mut error_rx,
            cancel_token,
            drop_guard,
            video_frame_counter,
            drop_counter,
        } = config;

        let monitor_capturer = capturer.clone();
        let monitor_cancel = cancel_token.clone();
        let health_tx = ctx.health_tx().clone();
        ctx.tasks().spawn("screen-capture-monitor", async move {
            loop {
                select! {
                    _ = monitor_cancel.cancelled() => break Ok(()),
                    recv = error_rx.recv() => {
                        let err = match recv {
                            Ok(err) => err,
                            Err(broadcast::error::RecvError::Closed) => break Ok(()),
                            Err(broadcast::error::RecvError::Lagged(_)) => {
                                warn!("Screen capture error channel lagged; continuing");
                                continue;
                            }
                        };

                        if is_system_stop_error(err.as_ref()) {
                            warn!("Screen capture stream stopped by the system; attempting restart");
                            output_pipeline::emit_health(
                                &health_tx,
                                output_pipeline::PipelineHealthEvent::SourceRestarting,
                            );
                            if monitor_cancel.is_cancelled() {
                                break Ok(());
                            }
                            monitor_capturer.mark_stopped();
                            if let Err(restart_err) = monitor_capturer.start().await {
                                return Err(anyhow!(format!(
                                    "Failed to restart ScreenCaptureKit stream: {restart_err:#}"
                                )));
                            }
                            output_pipeline::emit_health(
                                &health_tx,
                                output_pipeline::PipelineHealthEvent::SourceRestarted,
                            );
                            continue;
                        }

                        return Err(anyhow!(format!("{err}")));
                    }
                }
            }
        });

        let stats_health_tx = ctx.health_tx().clone();
        ChannelVideoSource::setup(inner, video_tx, ctx)
            .await
            .map(|source| Self {
                inner: source,
                capturer,
                cancel_token,
                _drop_guard: drop_guard,
                video_frame_counter,
                drop_counter,
                health_tx: stats_health_tx,
            })
    }

    fn start(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            self.capturer.start().await?;

            tokio::spawn({
                let video_frame_count = self.video_frame_counter.clone();
                let drop_counter = self.drop_counter.clone();
                let health_tx = self.health_tx.clone();
                async move {
                    let mut prev_frames = 0u32;
                    let mut prev_drops = 0u64;
                    loop {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        let current_frames = video_frame_count.load(atomic::Ordering::Relaxed);
                        let current_drops = drop_counter.load(atomic::Ordering::Relaxed);

                        let frame_delta = current_frames.saturating_sub(prev_frames);
                        let drop_delta = current_drops.saturating_sub(prev_drops);

                        if frame_delta > 0 {
                            let drop_rate = 100.0 * drop_delta as f64
                                / (frame_delta as f64 + drop_delta as f64);
                            if drop_rate > 5.0 {
                                warn!(
                                    frames = frame_delta,
                                    drops = drop_delta,
                                    drop_rate_pct = format!("{:.1}%", drop_rate),
                                    total_frames = current_frames,
                                    total_drops = current_drops,
                                    "Screen capture frame drop rate exceeds 5% threshold"
                                );
                                output_pipeline::emit_health(
                                    &health_tx,
                                    output_pipeline::PipelineHealthEvent::FrameDropRateHigh {
                                        rate_pct: drop_rate,
                                    },
                                );
                            } else {
                                debug!(
                                    frames = frame_delta,
                                    drops = drop_delta,
                                    drop_rate_pct = format!("{:.1}%", drop_rate),
                                    total_frames = current_frames,
                                    "Screen capture stats"
                                );
                            }
                        }

                        prev_frames = current_frames;
                        prev_drops = current_drops;
                    }
                }
                .with_cancellation_token_owned(self.cancel_token.clone())
                .in_current_span()
            });

            Ok(())
        }
        .boxed()
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            debug!(
                "Capturer stopping after creating {} video frames",
                self.video_frame_counter.load(atomic::Ordering::Relaxed)
            );
            self.capturer.stop().await?;

            self.cancel_token.cancel();

            Ok(())
        }
        .boxed()
    }

    fn video_info(&self) -> VideoInfo {
        self.inner.video_info()
    }
}

fn is_system_stop_error(err: &ns::Error) -> bool {
    err.code() == sc::error::code::SYSTEM_STOPPED_STREAM as ns::Integer
        && err.domain().to_string() == sc::error::domain().to_string()
}

pub struct SystemAudioSourceConfig(
    ChannelAudioSourceConfig,
    Capturer,
    broadcast::Receiver<arc::R<ns::Error>>,
    Arc<AtomicU64>,
    Arc<AtomicU64>,
);

pub struct SystemAudioSource {
    inner: ChannelAudioSource,
    capturer: Capturer,
    cancel_token: CancellationToken,
}

impl output_pipeline::AudioSource for SystemAudioSource {
    type Config = SystemAudioSourceConfig;

    fn setup(
        config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        let SystemAudioSourceConfig(
            channel_config,
            capturer,
            mut error_rx,
            frame_counter,
            drop_counter,
        ) = config;

        ctx.tasks().spawn("system-audio", async move {
            loop {
                match error_rx.recv().await {
                    Ok(err) => {
                        if is_system_stop_error(err.as_ref()) {
                            warn!("Screen capture audio stream stopped by the system; awaiting restart");
                            continue;
                        }

                        return Err(anyhow!("{err}"));
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }

            Ok(())
        });

        let cancel_token = CancellationToken::new();

        let stats_cancel = cancel_token.clone();
        tokio::spawn(
            async move {
                let mut last_log = Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    let captured = frame_counter.load(atomic::Ordering::Relaxed);
                    let dropped = drop_counter.load(atomic::Ordering::Relaxed);

                    if dropped > 0 {
                        let total = captured + dropped;
                        let drop_pct = if total > 0 {
                            100.0 * dropped as f64 / total as f64
                        } else {
                            0.0
                        };

                        if last_log.elapsed() >= Duration::from_secs(5) {
                            warn!(
                                captured = captured,
                                dropped = dropped,
                                drop_pct = format!("{:.1}%", drop_pct),
                                "System audio dropping frames due to full channel"
                            );
                            last_log = Instant::now();
                        }
                    } else if captured > 0 {
                        debug!(captured = captured, "System audio frames captured");
                    }
                }
            }
            .with_cancellation_token_owned(stats_cancel)
            .in_current_span(),
        );

        ChannelAudioSource::setup(channel_config, tx, ctx).map({
            let cancel_token = cancel_token.clone();
            move |v| {
                v.map(|source| Self {
                    inner: source,
                    capturer,
                    cancel_token,
                })
            }
        })
    }

    async fn start(&mut self) -> anyhow::Result<()> {
        self.capturer.start().await?;

        Ok(())
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        self.cancel_token.cancel();
        self.capturer.stop().await?;

        Ok(())
    }

    fn audio_info(&self) -> AudioInfo {
        self.inner.audio_info()
    }
}
