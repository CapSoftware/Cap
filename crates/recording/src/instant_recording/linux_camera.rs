use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::{
        self, SetupCtx, StallSendOutcome, VideoSource, send_with_stall_budget_futures,
    },
    sources::screen_capture,
};
use anyhow::{Context, anyhow};
use cap_media_info::VideoInfo;
use cap_timestamp::Timestamp;
use ffmpeg::format::Pixel;
use futures::{FutureExt, StreamExt, channel::mpsc};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const CAMERA_ATTACH_TIMEOUT: Duration = Duration::from_millis(1500);
const CAMERA_STALE_AFTER: Duration = Duration::from_secs(1);
const SCREEN_CHANNEL_CAPACITY: usize = 4;

pub(super) struct Config {
    pub(super) screen_capture: screen_capture::VideoSourceConfig,
    pub(super) camera_feed: Arc<CameraFeedLock>,
}

pub(super) struct CameraCompositeSource {
    inner: screen_capture::VideoSource,
    info: VideoInfo,
    _camera_feed: Arc<CameraFeedLock>,
}

impl VideoSource for CameraCompositeSource {
    type Config = Config;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (camera_tx, camera_rx) = flume::bounded(1);
        tokio::time::timeout(
            CAMERA_ATTACH_TIMEOUT,
            config.camera_feed.ask(camera::AddSender(camera_tx)),
        )
        .await
        .map_err(|_| {
            anyhow!("Camera compositor timed out attaching to feed after {CAMERA_ATTACH_TIMEOUT:?}")
        })?
        .map_err(|error| anyhow!("Camera compositor failed to attach to feed: {error}"))?;

        let (screen_tx, screen_rx) = mpsc::channel(SCREEN_CHANNEL_CAPACITY);
        let inner = screen_capture::VideoSource::setup(config.screen_capture, screen_tx, ctx)
            .await
            .context("screen source setup for camera compositor")?;
        let info = inner.video_info();
        let stop_token = ctx.stop_token();
        let health_tx = ctx.health_tx().clone();
        ctx.tasks()
            .spawn_thread("linux-instant-camera-compositor", move || {
                compositor_thread(
                    screen_rx,
                    Some(camera_rx),
                    video_tx,
                    stop_token,
                    health_tx,
                    info,
                )
            });

        Ok(Self {
            inner,
            info,
            _camera_feed: config.camera_feed,
        })
    }

    fn start(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        self.inner.start()
    }

    fn video_info(&self) -> VideoInfo {
        self.info
    }

    fn stop(&mut self) -> futures::future::BoxFuture<'_, anyhow::Result<()>> {
        self.inner.stop()
    }
}

fn compositor_thread(
    screen_rx: mpsc::Receiver<FFmpegVideoFrame>,
    camera_rx: Option<flume::Receiver<FFmpegVideoFrame>>,
    mut video_tx: mpsc::Sender<FFmpegVideoFrame>,
    stop_token: CancellationToken,
    health_tx: output_pipeline::HealthSender,
    info: VideoInfo,
) -> anyhow::Result<()> {
    futures::executor::block_on(async move {
        let mut screen_rx = screen_rx.fuse();
        let mut camera_closed = camera_rx.is_none();
        let camera_started_at = Instant::now();
        let mut camera_seen = camera_rx.is_none();
        let mut latest_camera: Option<(FFmpegVideoFrame, Instant)> = None;
        let mut compositor = Compositor::new(info);
        let mut logged_compose_failure = false;
        let mut logged_camera_disconnect = false;
        let mut logged_camera_stale = false;

        loop {
            let stop = stop_token.cancelled().fuse();
            let active_camera = camera_rx.as_ref().filter(|_| !camera_closed);
            let camera = async {
                match active_camera {
                    Some(receiver) => receiver.recv_async().await,
                    None => std::future::pending().await,
                }
            }
            .fuse();
            let screen = screen_rx.next().fuse();
            futures::pin_mut!(stop, camera, screen);

            futures::select! {
                _ = stop => break,
                camera_result = camera => match camera_result {
                    Ok(frame) => {
                        camera_seen = true;
                        let received_at = Instant::now();
                        let freshness_anchor = camera_freshness_anchor(&frame, received_at);
                        latest_camera = Some((frame, freshness_anchor));
                    }
                    Err(_) => {
                        camera_closed = true;
                        latest_camera = None;
                        if !logged_camera_disconnect {
                            tracing::warn!("Camera feed disconnected; continuing with screen-only output");
                            output_pipeline::emit_health(
                                &health_tx,
                                output_pipeline::PipelineHealthEvent::DeviceLost {
                                    subsystem: "camera".to_string(),
                                },
                            );
                            logged_camera_disconnect = true;
                        }
                    }
                },
                screen_result = screen => {
                    let Some(screen) = screen_result else { break };

                    if let Some(camera_rx) = camera_rx.as_ref() {
                        loop {
                            match camera_rx.try_recv() {
                                Ok(frame) => {
                                    camera_seen = true;
                                    let received_at = Instant::now();
                                    let freshness_anchor =
                                        camera_freshness_anchor(&frame, received_at);
                                    latest_camera = Some((frame, freshness_anchor));
                                }
                                Err(flume::TryRecvError::Empty) => break,
                                Err(flume::TryRecvError::Disconnected) => {
                                    camera_closed = true;
                                    latest_camera = None;
                                    if !logged_camera_disconnect {
                                        tracing::warn!("Camera feed disconnected; continuing with screen-only output");
                                        output_pipeline::emit_health(
                                            &health_tx,
                                            output_pipeline::PipelineHealthEvent::DeviceLost {
                                                subsystem: "camera".to_string(),
                                            },
                                        );
                                        logged_camera_disconnect = true;
                                    }
                                    break;
                                }
                            }
                        }
                    }

                    let mut clear_latest_camera = false;
                    let now = Instant::now();
                    let camera_is_stale = latest_camera
                        .as_ref()
                        .is_some_and(|(_, received_at)| !camera_is_fresh(*received_at, now));
                    let camera_waiting_for_first_frame = !camera_closed
                        && !camera_seen
                        && now.saturating_duration_since(camera_started_at) > CAMERA_STALE_AFTER;
                    if (camera_is_stale || camera_waiting_for_first_frame) && !logged_camera_stale {
                        tracing::warn!(
                            stale_after_ms = CAMERA_STALE_AFTER.as_millis(),
                            "Camera feed is stale; continuing with screen-only output"
                        );
                        output_pipeline::emit_health(
                            &health_tx,
                            output_pipeline::PipelineHealthEvent::Stalled {
                                source: "camera-compositor".to_string(),
                                waited_ms: CAMERA_STALE_AFTER.as_millis() as u64,
                            },
                        );
                        logged_camera_stale = true;
                    }
                    if !camera_is_stale && !camera_waiting_for_first_frame {
                        logged_camera_stale = false;
                    }
                    let output = match latest_camera
                        .as_ref()
                        .filter(|(_, received_at)| camera_is_fresh(*received_at, now))
                    {
                        Some((camera, _)) => match compositor.compose(&screen, camera) {
                            Ok(frame) => frame,
                            Err(error) => {
                                clear_latest_camera = true;
                                if !logged_compose_failure {
                                    tracing::warn!(error = %error, "Camera compositor degraded to screen-only output");
                                    logged_compose_failure = true;
                                }
                                screen
                            }
                        },
                        None => screen,
                    };
                    if clear_latest_camera {
                        latest_camera = None;
                    }

                    if matches!(
                        send_with_stall_budget_futures(
                            &mut video_tx,
                            output,
                            "linux-instant-camera-compositor",
                            &health_tx,
                        ),
                        StallSendOutcome::Disconnected
                    ) {
                        break;
                    }
                },
            }
        }

        Ok(())
    })
}

fn camera_is_fresh(received_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(received_at) <= CAMERA_STALE_AFTER
}

fn camera_freshness_anchor(frame: &FFmpegVideoFrame, received_at: Instant) -> Instant {
    match frame.timestamp {
        Timestamp::Instant(captured_at) => captured_at,
        _ => received_at,
    }
}

struct Compositor {
    info: VideoInfo,
    screen_to_rgba: Option<RgbaConverter>,
    camera_to_rgba: Option<RgbaConverter>,
    rgba_to_screen: Option<RgbaConverter>,
}

impl Compositor {
    fn new(info: VideoInfo) -> Self {
        Self {
            info,
            screen_to_rgba: None,
            camera_to_rgba: None,
            rgba_to_screen: None,
        }
    }

    fn compose(
        &mut self,
        screen: &FFmpegVideoFrame,
        camera: &FFmpegVideoFrame,
    ) -> anyhow::Result<FFmpegVideoFrame> {
        let screen_rgba = self.convert_screen(&screen.inner)?;
        let rect = overlay_rect(self.info.width, self.info.height);
        if rect.2 == 0 {
            return Err(anyhow!("screen dimensions are empty"));
        }
        let camera_rgba = self.convert_camera(&camera.inner, rect.2)?;
        let camera_overlay = center_crop_square(&camera_rgba, rect.2)?;
        let mut composed = screen_rgba;
        blend_rgba(&mut composed, &camera_overlay, rect.0, rect.1)?;
        let mut output = self.convert_to_screen(&composed)?;
        output.set_pts(screen.inner.pts());

        Ok(FFmpegVideoFrame {
            inner: output,
            timestamp: screen.timestamp,
        })
    }

    fn convert_screen(
        &mut self,
        input: &ffmpeg::frame::Video,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        let needs_converter = self.screen_to_rgba.as_ref().is_none_or(|converter| {
            converter.source_format != input.format()
                || converter.source_width != input.width()
                || converter.source_height != input.height()
        });
        if needs_converter {
            self.screen_to_rgba = Some(RgbaConverter::new(
                input.format(),
                input.width(),
                input.height(),
                Pixel::RGBA,
                self.info.width,
                self.info.height,
            )?);
        }
        self.screen_to_rgba
            .as_mut()
            .expect("screen converter initialized")
            .convert(input)
    }

    fn convert_camera(
        &mut self,
        input: &ffmpeg::frame::Video,
        size: u32,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        let (destination_width, destination_height) =
            aspect_fill_dimensions(input.width(), input.height(), size)?;
        let needs_converter = self.camera_to_rgba.as_ref().is_none_or(|converter| {
            converter.source_format != input.format()
                || converter.source_width != input.width()
                || converter.source_height != input.height()
                || converter.destination_width != destination_width
                || converter.destination_height != destination_height
        });
        if needs_converter {
            self.camera_to_rgba = Some(RgbaConverter::new(
                input.format(),
                input.width(),
                input.height(),
                Pixel::RGBA,
                destination_width,
                destination_height,
            )?);
        }
        self.camera_to_rgba
            .as_mut()
            .expect("camera converter initialized")
            .convert(input)
    }

    fn convert_to_screen(
        &mut self,
        input: &ffmpeg::frame::Video,
    ) -> anyhow::Result<ffmpeg::frame::Video> {
        if self.rgba_to_screen.is_none() {
            self.rgba_to_screen = Some(RgbaConverter::new(
                Pixel::RGBA,
                self.info.width,
                self.info.height,
                self.info.pixel_format,
                self.info.width,
                self.info.height,
            )?);
        }
        self.rgba_to_screen
            .as_mut()
            .expect("screen output converter initialized")
            .convert(input)
    }
}

struct RgbaConverter {
    context: ffmpeg::software::scaling::Context,
    source_format: ffmpeg::format::Pixel,
    source_width: u32,
    source_height: u32,
    destination_format: ffmpeg::format::Pixel,
    destination_width: u32,
    destination_height: u32,
}

impl RgbaConverter {
    fn new(
        source_format: ffmpeg::format::Pixel,
        source_width: u32,
        source_height: u32,
        destination_format: ffmpeg::format::Pixel,
        destination_width: u32,
        destination_height: u32,
    ) -> anyhow::Result<Self> {
        if source_width == 0
            || source_height == 0
            || destination_width == 0
            || destination_height == 0
        {
            return Err(anyhow!("invalid video dimensions for compositor"));
        }
        let context = ffmpeg::software::scaling::Context::get(
            source_format,
            source_width,
            source_height,
            destination_format,
            destination_width,
            destination_height,
            ffmpeg::software::scaling::Flags::BILINEAR,
        )?;
        Ok(Self {
            context,
            source_format,
            source_width,
            source_height,
            destination_format,
            destination_width,
            destination_height,
        })
    }

    fn convert(&mut self, input: &ffmpeg::frame::Video) -> anyhow::Result<ffmpeg::frame::Video> {
        if self.source_format != input.format()
            || self.source_width != input.width()
            || self.source_height != input.height()
        {
            let destination_format = self.destination_format;
            let destination_width = self.destination_width;
            let destination_height = self.destination_height;
            *self = Self::new(
                input.format(),
                input.width(),
                input.height(),
                destination_format,
                destination_width,
                destination_height,
            )?;
        }
        let mut output = ffmpeg::frame::Video::empty();
        self.context.run(input, &mut output)?;
        output.set_pts(input.pts());
        Ok(output)
    }
}

fn overlay_rect(width: u32, height: u32) -> (usize, usize, u32) {
    if width == 0 || height == 0 {
        return (0, 0, 0);
    }
    let short = width.min(height);
    let size = ((u64::from(short) * 30) / 100).clamp(1, u64::from(short)) as u32;
    let margin = (u64::from(short) * 2 / 100) as u32;
    let x = width.saturating_sub(size.saturating_add(margin));
    let y = height.saturating_sub(size.saturating_add(margin));
    (x as usize, y as usize, size)
}

fn aspect_fill_dimensions(width: u32, height: u32, size: u32) -> anyhow::Result<(u32, u32)> {
    if width == 0 || height == 0 || size == 0 {
        return Err(anyhow!("invalid dimensions for camera scaling"));
    }
    if width >= height {
        let scaled_width = (u64::from(size) * u64::from(width)).div_ceil(u64::from(height));
        Ok((scaled_width.min(u64::from(u32::MAX)) as u32, size))
    } else {
        let scaled_height = (u64::from(size) * u64::from(height)).div_ceil(u64::from(width));
        Ok((size, scaled_height.min(u64::from(u32::MAX)) as u32))
    }
}

fn center_crop_square(
    source: &ffmpeg::frame::Video,
    size: u32,
) -> anyhow::Result<ffmpeg::frame::Video> {
    if size == 0 || source.width() == 0 || source.height() == 0 {
        return Err(anyhow!("invalid camera dimensions for compositor"));
    }
    let source_width = source.width() as usize;
    let source_height = source.height() as usize;
    let crop_size = source_width.min(source_height);
    if crop_size < size as usize {
        return Err(anyhow!("scaled camera frame is smaller than overlay"));
    }
    let crop_x = (source_width - size as usize) / 2;
    let crop_y = (source_height - size as usize) / 2;
    let mut output = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, size, size);
    let source_stride = source.stride(0);
    let output_stride = output.stride(0);
    let source_data = source.data(0);
    let output_data = output.data_mut(0);
    for y in 0..size as usize {
        let source_y = crop_y + y;
        for x in 0..size as usize {
            let source_x = crop_x + x;
            let source_offset = source_y * source_stride + source_x * 4;
            let output_offset = y * output_stride + x * 4;
            if source_offset + 4 > source_data.len() || output_offset + 4 > output_data.len() {
                return Err(anyhow!(
                    "RGBA camera frame layout is smaller than dimensions"
                ));
            }
            output_data[output_offset..output_offset + 4]
                .copy_from_slice(&source_data[source_offset..source_offset + 4]);
        }
    }
    output.set_pts(source.pts());
    Ok(output)
}

fn blend_rgba(
    destination: &mut ffmpeg::frame::Video,
    source: &ffmpeg::frame::Video,
    x: usize,
    y: usize,
) -> anyhow::Result<()> {
    if destination.format() != ffmpeg::format::Pixel::RGBA
        || source.format() != ffmpeg::format::Pixel::RGBA
    {
        return Err(anyhow!("RGBA blend requires RGBA frames"));
    }
    let destination_stride = destination.stride(0);
    let source_stride = source.stride(0);
    let destination_width = destination.width() as usize;
    let destination_height = destination.height() as usize;
    let source_width = source.width() as usize;
    let source_height = source.height() as usize;
    if x.saturating_add(source_width) > destination_width
        || y.saturating_add(source_height) > destination_height
    {
        return Err(anyhow!("camera overlay exceeds screen frame"));
    }
    let source_data = source.data(0);
    let destination_data = destination.data_mut(0);
    for row in 0..source_height {
        for column in 0..source_width {
            let source_offset = row * source_stride + column * 4;
            let destination_offset = (y + row) * destination_stride + (x + column) * 4;
            let alpha = u16::from(source_data[source_offset + 3]);
            let inverse_alpha = 255 - alpha;
            for channel in 0..3 {
                destination_data[destination_offset + channel] =
                    ((u16::from(source_data[source_offset + channel]) * alpha
                        + u16::from(destination_data[destination_offset + channel])
                            * inverse_alpha
                        + 127)
                        / 255) as u8;
            }
            destination_data[destination_offset + 3] = 255;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::SinkExt;

    #[test]
    fn camera_freshness_expires_after_one_second() {
        let now = Instant::now();
        assert!(!camera_is_fresh(
            now,
            now + CAMERA_STALE_AFTER + Duration::from_millis(1)
        ));
        assert!(camera_is_fresh(now, now + CAMERA_STALE_AFTER));
    }

    #[test]
    fn camera_freshness_uses_capture_time_for_queued_frames() {
        ffmpeg::init().expect("FFmpeg initializes");
        let now = Instant::now();
        let captured_at = now
            .checked_sub(CAMERA_STALE_AFTER + Duration::from_millis(1))
            .expect("test instant has enough history");
        let frame = FFmpegVideoFrame {
            inner: ffmpeg::frame::Video::new(Pixel::RGBA, 1, 1),
            timestamp: Timestamp::Instant(captured_at),
        };
        assert!(!camera_is_fresh(camera_freshness_anchor(&frame, now), now));
        assert_eq!(camera_freshness_anchor(&frame, now), captured_at);
    }

    #[test]
    fn overlay_rect_is_bottom_right_and_safe_for_tiny_frames() {
        assert_eq!(overlay_rect(100, 50), (84, 34, 15));
        assert_eq!(overlay_rect(1, 1), (0, 0, 1));
        assert_eq!(overlay_rect(0, 50), (0, 0, 0));
        assert_eq!(overlay_rect(100, 0), (0, 0, 0));
    }

    #[test]
    fn center_crop_square_preserves_center_pixel() {
        ffmpeg::init().expect("FFmpeg initializes");
        let mut source = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 6, 4);
        source.data_mut(0).fill(0);
        let stride = source.stride(0);
        let center = 2 * stride + 2 * 4;
        source.data_mut(0)[center..center + 4].copy_from_slice(&[1, 2, 3, 255]);
        let cropped = center_crop_square(&source, 2).expect("crop succeeds");
        assert_eq!(
            &cropped.data(0)[cropped.stride(0)..cropped.stride(0) + 4],
            &[1, 2, 3, 255]
        );
    }

    #[test]
    fn compositor_converts_nv12_camera_without_mutating_screen_and_preserves_pts() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let info = VideoInfo::from_raw_ffmpeg(ffmpeg::format::Pixel::BGRA, 8, 8, 30);
        let mut screen = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 8, 8);
        for pixel in screen.data_mut(0).chunks_exact_mut(4) {
            pixel.copy_from_slice(&[0, 255, 0, 255]);
        }
        screen.set_pts(Some(1234));
        let original = screen.data(0).to_vec();
        let mut camera = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 4, 4);
        camera.data_mut(0).fill(235);
        camera.data_mut(1).fill(128);
        let camera_before = (camera.data(0).to_vec(), camera.data(1).to_vec());
        let screen_frame = FFmpegVideoFrame {
            inner: screen,
            timestamp,
        };
        let camera_frame = FFmpegVideoFrame {
            inner: camera,
            timestamp,
        };
        let mut compositor = Compositor::new(info);
        let output = compositor
            .compose(&screen_frame, &camera_frame)
            .expect("composition succeeds");
        assert_eq!(screen_frame.inner.data(0), original.as_slice());
        assert_eq!(camera_frame.inner.data(0), camera_before.0.as_slice());
        assert_eq!(camera_frame.inner.data(1), camera_before.1.as_slice());
        assert_eq!(output.inner.pts(), Some(1234));
        assert!(matches!(
            (output.timestamp, timestamp),
            (Timestamp::Instant(actual), Timestamp::Instant(expected)) if actual == expected
        ));
        assert_ne!(
            &output.inner.data(0)[output.inner.stride(0) * 7 + 7 * 4..][..3],
            &[0, 255, 0]
        );
    }

    #[test]
    fn compositor_converts_nv12_screen_and_preserves_input() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let info = VideoInfo::from_raw_ffmpeg(Pixel::NV12, 8, 8, 30);
        let mut screen = ffmpeg::frame::Video::new(Pixel::NV12, 8, 8);
        screen.data_mut(0).fill(16);
        screen.data_mut(1).fill(128);
        screen.set_pts(Some(4321));
        let original_y = screen.data(0).to_vec();
        let mut camera = ffmpeg::frame::Video::new(Pixel::BGRA, 4, 4);
        for pixel in camera.data_mut(0).chunks_exact_mut(4) {
            pixel.copy_from_slice(&[0, 0, 255, 255]);
        }
        let screen_frame = FFmpegVideoFrame {
            inner: screen,
            timestamp,
        };
        let camera_frame = FFmpegVideoFrame {
            inner: camera,
            timestamp,
        };
        let mut compositor = Compositor::new(info);
        let output = compositor
            .compose(&screen_frame, &camera_frame)
            .expect("composition succeeds");
        assert_eq!(screen_frame.inner.data(0), original_y.as_slice());
        assert_eq!(output.inner.format(), Pixel::NV12);
        assert_eq!(output.inner.pts(), Some(4321));
        assert_ne!(output.inner.data(0)[output.inner.stride(0) * 7 + 7], 16);
    }

    #[tokio::test]
    async fn compositor_passes_screen_without_camera_and_closes_on_cancel() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let info = VideoInfo::from_raw_ffmpeg(Pixel::BGRA, 4, 4, 30);
        let mut inner = ffmpeg::frame::Video::new(Pixel::BGRA, 4, 4);
        inner.data_mut(0).fill(17);
        inner.set_pts(Some(77));
        let expected = inner.data(0).to_vec();
        let frame = FFmpegVideoFrame { inner, timestamp };
        let (mut screen_tx, screen_rx) = mpsc::channel(1);
        let (video_tx, mut video_rx) = mpsc::channel(1);
        let (health_tx, _health_rx) = tokio::sync::mpsc::channel(1);
        let stop_token = CancellationToken::new();
        let _stop_guard = stop_token.clone().drop_guard();
        let worker_stop = stop_token.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = compositor_thread(screen_rx, None, video_tx, worker_stop, health_tx, info);
            let _ = done_tx.send(result);
        });

        screen_tx.send(frame).await.expect("screen frame sent");
        let output = tokio::time::timeout(Duration::from_secs(2), video_rx.next())
            .await
            .expect("screen-only output arrives promptly")
            .expect("screen-only frame emitted");
        assert_eq!(output.inner.data(0), expected.as_slice());
        assert_eq!(output.inner.pts(), Some(77));
        assert!(matches!(
            (output.timestamp, timestamp),
            (Timestamp::Instant(actual), Timestamp::Instant(expected)) if actual == expected
        ));

        stop_token.cancel();
        drop(screen_tx);
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("compositor exits promptly")
            .expect("compositor stopped");
        worker.join().expect("compositor thread joined");
        assert!(video_rx.next().await.is_none());
    }

    #[tokio::test]
    async fn compositor_reports_silent_attached_camera_and_keeps_screen_output() {
        ffmpeg::init().expect("FFmpeg initializes");
        let timestamp = Timestamp::Instant(Instant::now());
        let info = VideoInfo::from_raw_ffmpeg(Pixel::BGRA, 4, 4, 30);
        let mut first_inner = ffmpeg::frame::Video::new(Pixel::BGRA, 4, 4);
        first_inner.data_mut(0).fill(17);
        first_inner.set_pts(Some(77));
        let first_frame = FFmpegVideoFrame {
            inner: first_inner,
            timestamp,
        };
        let mut second_inner = ffmpeg::frame::Video::new(Pixel::BGRA, 4, 4);
        second_inner.data_mut(0).fill(23);
        second_inner.set_pts(Some(88));
        let second_frame = FFmpegVideoFrame {
            inner: second_inner,
            timestamp,
        };
        let (mut screen_tx, screen_rx) = mpsc::channel(1);
        let (camera_tx, camera_rx) = flume::bounded(1);
        let (video_tx, mut video_rx) = mpsc::channel(1);
        let (health_tx, mut health_rx) = tokio::sync::mpsc::channel(4);
        let stop_token = CancellationToken::new();
        let _stop_guard = stop_token.clone().drop_guard();
        let worker_stop = stop_token.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = compositor_thread(
                screen_rx,
                Some(camera_rx),
                video_tx,
                worker_stop,
                health_tx,
                info,
            );
            let _ = done_tx.send(result);
        });

        screen_tx
            .send(first_frame)
            .await
            .expect("first screen frame sent");
        let first_output = tokio::time::timeout(Duration::from_secs(2), video_rx.next())
            .await
            .expect("first screen-only output arrives promptly")
            .expect("first screen-only frame emitted");
        assert_eq!(first_output.inner.pts(), Some(77));

        tokio::time::sleep(CAMERA_STALE_AFTER + Duration::from_millis(20)).await;
        screen_tx
            .send(second_frame)
            .await
            .expect("second screen frame sent");
        let second_output = tokio::time::timeout(Duration::from_secs(2), video_rx.next())
            .await
            .expect("silent-camera screen output arrives promptly")
            .expect("silent-camera screen frame emitted");
        assert_eq!(second_output.inner.pts(), Some(88));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), health_rx.recv())
                .await
                .expect("silent camera reports its health promptly"),
            Some(output_pipeline::PipelineHealthEvent::Stalled { source, .. })
                if source == "camera-compositor"
        ));

        stop_token.cancel();
        drop(camera_tx);
        drop(screen_tx);
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("compositor exits promptly")
            .expect("compositor stopped");
        worker.join().expect("compositor thread joined");
        assert!(video_rx.next().await.is_none());
    }

    #[test]
    fn blend_rejects_overlay_outside_screen_bounds() {
        ffmpeg::init().expect("FFmpeg initializes");
        let mut destination = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 2, 2);
        let source = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, 2, 2);
        assert!(blend_rgba(&mut destination, &source, 1, 0).is_err());
    }
}
