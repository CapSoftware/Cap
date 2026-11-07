use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::{SetupCtx, StallSendOutcome, VideoSource, send_with_stall_budget_futures},
};
use anyhow::anyhow;
use cap_media_info::VideoInfo;
use futures::{FutureExt, channel::mpsc, future::BoxFuture};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const CAMERA_SENDER_ATTACH_TIMEOUT: Duration = Duration::from_millis(1500);

// Cap the decoded-frame channel to 64 MiB so 4K/1080p BGRA frames cannot accumulate
// gigabytes of uncompressed pixel buffers when downstream encoding is throttled.
const CAMERA_CHANNEL_BYTE_BUDGET: usize = 64 * 1024 * 1024;
const MIN_CAMERA_CHANNEL_FRAMES: usize = 8;
const MAX_CAMERA_CHANNEL_FRAMES: usize = 64;

// Estimate uncompressed byte footprint per decoded frame to size bounded channels by memory budget.
pub(crate) fn estimate_video_frame_bytes(info: &VideoInfo) -> usize {
    let pixels = (info.width as usize).saturating_mul(info.height as usize);
    let bpp_num_den: (usize, usize) = match info.pixel_format {
        ffmpeg::format::Pixel::NV12
        | ffmpeg::format::Pixel::YUV420P
        | ffmpeg::format::Pixel::YUVJ420P => (3, 2),
        ffmpeg::format::Pixel::YUYV422
        | ffmpeg::format::Pixel::UYVY422
        | ffmpeg::format::Pixel::YUV422P => (2, 1),
        ffmpeg::format::Pixel::RGB24 | ffmpeg::format::Pixel::BGR24 => (3, 1),
        _ => (4, 1),
    };
    pixels
        .saturating_mul(bpp_num_den.0)
        .checked_div(bpp_num_den.1)
        .unwrap_or(0)
        .max(1)
}

// Compute bounded frame capacity from resolution and pixel format to prevent multi-GB queues.
pub(crate) fn bounded_camera_channel_capacity(info: &VideoInfo) -> usize {
    let frame_bytes = estimate_video_frame_bytes(info);
    (CAMERA_CHANNEL_BYTE_BUDGET / frame_bytes)
        .clamp(MIN_CAMERA_CHANNEL_FRAMES, MAX_CAMERA_CHANNEL_FRAMES)
}

#[derive(Clone, Copy)]
struct ScalingSpec {
    src_width: u32,
    src_height: u32,
    src_format: ffmpeg::format::Pixel,
    dst_width: u32,
    dst_height: u32,
    dst_format: ffmpeg::format::Pixel,
}

struct CameraFrameScaler {
    context: ffmpeg::software::scaling::Context,
    source_width: u32,
    source_height: u32,
}

unsafe impl Send for CameraFrameScaler {}

impl CameraFrameScaler {
    fn new(spec: ScalingSpec) -> anyhow::Result<Self> {
        let context = ffmpeg::software::scaling::Context::get(
            spec.src_format,
            spec.src_width,
            spec.src_height,
            spec.dst_format,
            spec.dst_width,
            spec.dst_height,
            ffmpeg::software::scaling::Flags::BILINEAR,
        )?;

        Ok(Self {
            context,
            source_width: spec.src_width,
            source_height: spec.src_height,
        })
    }

    fn matches_source(&self, width: u32, height: u32) -> bool {
        self.source_width == width && self.source_height == height
    }

    fn scale(&mut self, input: &ffmpeg::frame::Video) -> anyhow::Result<ffmpeg::frame::Video> {
        let mut output = ffmpeg::frame::Video::empty();
        self.context.run(input, &mut output)?;
        output.set_pts(input.pts());
        Ok(output)
    }
}

struct CameraLoopRuntime {
    original_info: VideoInfo,
    video_tx: mpsc::Sender<FFmpegVideoFrame>,
    stall_health_tx: crate::output_pipeline::PipelineHealthSender,
    stopped: Arc<AtomicBool>,
    scaled_frame_count: Arc<AtomicU64>,
    scaler: Option<CameraFrameScaler>,
    frame_count: u64,
    sent_count: u64,
    dropped_count: u64,
    start: Instant,
}

impl CameraLoopRuntime {
    fn ensure_scaler(&mut self, frame: &ffmpeg::frame::Video) -> bool {
        let frame_width = frame.width();
        let frame_height = frame.height();
        let needs_new_scaler = self
            .scaler
            .as_ref()
            .is_none_or(|s| !s.matches_source(frame_width, frame_height));

        if !needs_new_scaler {
            return true;
        }

        let spec = ScalingSpec {
            src_width: frame_width,
            src_height: frame_height,
            src_format: frame.format(),
            dst_width: self.original_info.width,
            dst_height: self.original_info.height,
            dst_format: self.original_info.pixel_format,
        };

        match CameraFrameScaler::new(spec) {
            Ok(new_scaler) => {
                tracing::info!(
                    src_width = frame_width,
                    src_height = frame_height,
                    dst_width = self.original_info.width,
                    dst_height = self.original_info.height,
                    "Camera source: created scaler for dimension change"
                );
                self.scaler = Some(new_scaler);
                true
            }
            Err(e) => {
                tracing::warn!(
                    src_width = frame_width,
                    src_height = frame_height,
                    error = %e,
                    "Camera source: failed to create scaler, dropping frame"
                );
                self.dropped_count += 1;
                false
            }
        }
    }

    fn normalize_frame_dimensions(&mut self, frame: &mut FFmpegVideoFrame) -> bool {
        let width_matches = frame.inner.width() == self.original_info.width;
        let height_matches = frame.inner.height() == self.original_info.height;

        if width_matches && height_matches {
            if self.scaler.take().is_some() {
                let total_scaled = self.scaled_frame_count.load(Ordering::Relaxed);
                tracing::info!(
                    total_scaled,
                    "Camera source: dimensions restored to original, removing scaler"
                );
            }
            return true;
        }

        if !self.ensure_scaler(&frame.inner) {
            return false;
        }

        let Some(scaler) = self.scaler.as_mut() else {
            return true;
        };

        match scaler.scale(&frame.inner) {
            Ok(scaled) => {
                frame.inner = scaled;
                self.scaled_frame_count.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(e) => {
                if self.dropped_count.is_multiple_of(30) {
                    tracing::warn!(error = %e, "Camera source: scale failed, dropping frame");
                }
                self.dropped_count += 1;
                false
            }
        }
    }

    fn forward_frame(&mut self, mut frame: FFmpegVideoFrame) -> bool {
        self.frame_count += 1;
        if !self.normalize_frame_dimensions(&mut frame) {
            return true;
        }

        let outcome = send_with_stall_budget_futures(
            &mut self.video_tx,
            frame,
            "camera-video",
            &self.stall_health_tx,
        );
        self.record_send_outcome(outcome)
    }

    fn record_send_outcome(&mut self, outcome: StallSendOutcome) -> bool {
        match outcome {
            StallSendOutcome::Sent => {
                self.sent_count += 1;
                if self.sent_count.is_multiple_of(300) {
                    let total_scaled = self.scaled_frame_count.load(Ordering::Relaxed);
                    tracing::debug!(
                        sent_count = self.sent_count,
                        dropped_count = self.dropped_count,
                        total_scaled,
                        elapsed = ?self.start.elapsed(),
                        "Camera source stats"
                    );
                }
                true
            }
            StallSendOutcome::StalledAndDropped { .. } => {
                self.dropped_count += 1;
                if self.dropped_count.is_multiple_of(30) {
                    tracing::warn!(
                        dropped_count = self.dropped_count,
                        "Camera source: encoder can't keep up"
                    );
                }
                true
            }
            StallSendOutcome::Disconnected => {
                tracing::debug!(
                    sent_count = self.sent_count,
                    dropped_count = self.dropped_count,
                    "Camera source: pipeline closed"
                );
                false
            }
        }
    }

    async fn run(mut self, rx: flume::Receiver<FFmpegVideoFrame>, stop_rx: oneshot::Receiver<()>) {
        tracing::debug!(
            original_width = self.original_info.width,
            original_height = self.original_info.height,
            "Camera source task started"
        );
        let mut stop_rx = stop_rx.fuse();

        loop {
            if self.stopped.load(Ordering::Relaxed) {
                tracing::debug!("Camera source: stop flag set, exiting");
                break;
            }

            let keep_running = tokio::select! {
                biased;
                _ = &mut stop_rx => {
                    tracing::debug!("Camera source: received stop signal");
                    false
                }
                result = rx.recv_async() => match result {
                    Ok(frame) => self.forward_frame(frame),
                    Err(e) => {
                        tracing::debug!(
                            frame_count = self.frame_count,
                            elapsed = ?self.start.elapsed(),
                            error = %e,
                            "Camera feed disconnected (rx closed)"
                        );
                        false
                    }
                }
            };

            if !keep_running {
                break;
            }
        }

        drop(self.video_tx);
        let total_scaled = self.scaled_frame_count.load(Ordering::Relaxed);
        tracing::info!(
            frame_count = self.frame_count,
            sent_count = self.sent_count,
            dropped_count = self.dropped_count,
            total_scaled,
            elapsed = ?self.start.elapsed(),
            "Camera source finished"
        );
    }
}

pub struct Camera {
    #[allow(dead_code)]
    feed_lock: Arc<CameraFeedLock>,
    stop_tx: Option<oneshot::Sender<()>>,
    stopped: Arc<AtomicBool>,
    original_video_info: VideoInfo,
    _full_res: camera::MjpegFullResHold,
}

impl VideoSource for Camera {
    type Config = Arc<CameraFeedLock>;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        feed_lock: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let stall_health_tx = ctx.health_tx().clone();
        let full_res = feed_lock.hold_full_resolution();
        let original_video_info = *feed_lock.video_info();
        let channel_capacity = bounded_camera_channel_capacity(&original_video_info);
        let (tx, rx) = flume::bounded(channel_capacity);

        tokio::time::timeout(
            CAMERA_SENDER_ATTACH_TIMEOUT,
            feed_lock.ask(camera::AddSender(tx)),
        )
        .await
        .map_err(|_| anyhow!("Timed out adding camera sender"))?
        .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

        let (stop_tx, stop_rx) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let runtime = CameraLoopRuntime {
            original_info: original_video_info,
            video_tx,
            stall_health_tx,
            stopped: stopped.clone(),
            scaled_frame_count: Arc::new(AtomicU64::new(0)),
            scaler: None,
            frame_count: 0,
            sent_count: 0,
            dropped_count: 0,
            start: Instant::now(),
        };

        crate::output_pipeline::spawn_capture_task(runtime.run(rx, stop_rx));

        Ok(Self {
            feed_lock,
            stop_tx: Some(stop_tx),
            stopped,
            original_video_info,
            _full_res: full_res,
        })
    }

    fn video_info(&self) -> VideoInfo {
        self.original_video_info
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        async move {
            tracing::debug!("Camera source: stopping");
            self.stopped.store(true, Ordering::SeqCst);
            if let Some(stop_tx) = self.stop_tx.take() {
                let _ = stop_tx.send(());
            }
            Ok(())
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::Pixel;

    #[test]
    fn bounds_4k_bgra_camera_channel_within_memory_budget() {
        let info = VideoInfo {
            pixel_format: Pixel::BGRA,
            width: 3840,
            height: 2160,
            time_base: ffmpeg::Rational(1, 30),
            frame_rate: ffmpeg::Rational(30, 1),
        };
        let capacity = bounded_camera_channel_capacity(&info);
        assert_eq!(capacity, MIN_CAMERA_CHANNEL_FRAMES);
    }

    #[test]
    fn bounds_1080p_nv12_camera_channel_by_byte_budget() {
        let info = VideoInfo {
            pixel_format: Pixel::NV12,
            width: 1920,
            height: 1080,
            time_base: ffmpeg::Rational(1, 30),
            frame_rate: ffmpeg::Rational(30, 1),
        };
        let capacity = bounded_camera_channel_capacity(&info);
        assert!(capacity >= MIN_CAMERA_CHANNEL_FRAMES);
        assert!(capacity <= MAX_CAMERA_CHANNEL_FRAMES);
    }
}
