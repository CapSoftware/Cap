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
use std::time::Duration;
use tokio::sync::oneshot;

const CAMERA_SENDER_ATTACH_TIMEOUT: Duration = Duration::from_millis(1500);

struct CameraFrameScaler {
    context: ffmpeg::software::scaling::Context,
}

unsafe impl Send for CameraFrameScaler {}

impl CameraFrameScaler {
    fn new(
        src_width: u32,
        src_height: u32,
        src_format: ffmpeg::format::Pixel,
        dst_width: u32,
        dst_height: u32,
        dst_format: ffmpeg::format::Pixel,
    ) -> anyhow::Result<Self> {
        let context = ffmpeg::software::scaling::Context::get(
            src_format,
            src_width,
            src_height,
            dst_format,
            dst_width,
            dst_height,
            ffmpeg::software::scaling::Flags::BILINEAR,
        )?;

        Ok(Self { context })
    }

    fn matches_source(&self, frame: &ffmpeg::frame::Video) -> bool {
        let source = self.context.input();
        source.width == frame.width()
            && source.height == frame.height()
            && source.format == frame.format()
    }

    fn scale(&mut self, input: &ffmpeg::frame::Video) -> anyhow::Result<ffmpeg::frame::Video> {
        let mut output = ffmpeg::frame::Video::empty();
        self.context.run(input, &mut output)?;
        output.set_pts(input.pts());
        Ok(output)
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
        let (tx, rx) = flume::bounded(256);
        let stall_health_tx = ctx.health_tx().clone();
        let full_res = feed_lock.hold_full_resolution();

        let original_video_info = *feed_lock.video_info();
        let original_width = original_video_info.width;
        let original_height = original_video_info.height;
        let original_format = original_video_info.pixel_format;

        tokio::time::timeout(
            CAMERA_SENDER_ATTACH_TIMEOUT,
            feed_lock.ask(camera::AddSender(tx)),
        )
        .await
        .map_err(|_| anyhow!("Timed out adding camera sender"))?
        .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

        let (stop_tx, stop_rx) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_clone = stopped.clone();
        let scaled_frame_count = Arc::new(AtomicU64::new(0));
        let scaled_count_clone = scaled_frame_count.clone();

        crate::output_pipeline::spawn_capture_task(async move {
            tracing::debug!(
                original_width,
                original_height,
                "Camera source task started"
            );
            let mut frame_count: u64 = 0;
            let mut sent_count: u64 = 0;
            let mut dropped_count: u64 = 0;
            let start = std::time::Instant::now();
            let mut video_tx = video_tx;
            let mut stop_rx = stop_rx.fuse();
            let mut scaler: Option<CameraFrameScaler> = None;

            loop {
                if stopped_clone.load(Ordering::Relaxed) {
                    tracing::debug!("Camera source: stop flag set, exiting");
                    break;
                }

                tokio::select! {
                    biased;
                    _ = &mut stop_rx => {
                        tracing::debug!("Camera source: received stop signal");
                        break;
                    }
                    result = rx.recv_async() => {
                        match result {
                            Ok(mut frame) => {
                                frame_count += 1;

                                let frame_width = frame.inner.width();
                                let frame_height = frame.inner.height();
                                let frame_format = frame.inner.format();

                                if frame_width != original_width
                                    || frame_height != original_height
                                    || frame_format != original_format
                                {
                                    let needs_new_scaler = scaler
                                        .as_ref()
                                        .is_none_or(|s| !s.matches_source(&frame.inner));

                                    if needs_new_scaler {
                                        match CameraFrameScaler::new(
                                            frame_width,
                                            frame_height,
                                            frame_format,
                                            original_width,
                                            original_height,
                                            original_format,
                                        ) {
                                            Ok(new_scaler) => {
                                                tracing::info!(
                                                    src_width = frame_width,
                                                    src_height = frame_height,
                                                    src_format = ?frame_format,
                                                    dst_width = original_width,
                                                    dst_height = original_height,
                                                    dst_format = ?original_format,
                                                    "Camera source: created scaler for format change"
                                                );
                                                scaler = Some(new_scaler);
                                            }
                                            Err(e) => {
                                                tracing::warn!(
                                                    src_width = frame_width,
                                                    src_height = frame_height,
                                                    error = %e,
                                                    "Camera source: failed to create scaler, dropping frame"
                                                );
                                                dropped_count += 1;
                                                continue;
                                            }
                                        }
                                    }

                                    if let Some(s) = &mut scaler {
                                        match s.scale(&frame.inner) {
                                            Ok(scaled) => {
                                                frame.inner = scaled;
                                                scaled_count_clone.fetch_add(1, Ordering::Relaxed);
                                            }
                                            Err(e) => {
                                                if dropped_count.is_multiple_of(30) {
                                                    tracing::warn!(
                                                        error = %e,
                                                        "Camera source: scale failed, dropping frame"
                                                    );
                                                }
                                                dropped_count += 1;
                                                continue;
                                            }
                                        }
                                    }
                                } else if scaler.is_some() {
                                    let total_scaled = scaled_count_clone.load(Ordering::Relaxed);
                                    tracing::info!(
                                        total_scaled,
                                        "Camera source: format restored to original, removing scaler"
                                    );
                                    scaler = None;
                                }

                                match send_with_stall_budget_futures(
                                    &mut video_tx,
                                    frame,
                                    "camera-video",
                                    &stall_health_tx,
                                ) {
                                    StallSendOutcome::Sent => {
                                        sent_count += 1;
                                        if sent_count.is_multiple_of(300) {
                                            let total_scaled = scaled_count_clone.load(Ordering::Relaxed);
                                            tracing::debug!(
                                                sent_count,
                                                dropped_count,
                                                total_scaled,
                                                elapsed = ?start.elapsed(),
                                                "Camera source stats"
                                            );
                                        }
                                    }
                                    StallSendOutcome::StalledAndDropped { .. } => {
                                        dropped_count += 1;
                                        if dropped_count.is_multiple_of(30) {
                                            tracing::warn!(
                                                dropped_count,
                                                "Camera source: encoder can't keep up"
                                            );
                                        }
                                    }
                                    StallSendOutcome::Disconnected => {
                                        tracing::debug!(
                                            sent_count,
                                            dropped_count,
                                            "Camera source: pipeline closed"
                                        );
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::debug!(
                                    frame_count,
                                    elapsed = ?start.elapsed(),
                                    error = %e,
                                    "Camera feed disconnected (rx closed)"
                                );
                                break;
                            }
                        }
                    }
                }
            }

            drop(video_tx);

            let total_scaled = scaled_count_clone.load(Ordering::Relaxed);
            tracing::info!(
                frame_count,
                sent_count,
                dropped_count,
                total_scaled,
                elapsed = ?start.elapsed(),
                "Camera source finished"
            );
        });

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
    use crate::{
        TaskPool,
        feeds::camera::synthetic::SyntheticCamera,
        output_pipeline::{AudioFrame, AudioMuxer, Muxer, OutputPipeline, VideoMuxer},
    };
    use cap_media_info::{AudioInfo, Pixel};
    use cap_timestamp::Timestamp;
    use std::path::PathBuf;

    struct ObservedCamera(flume::Sender<ffmpeg::frame::Video>);

    impl Muxer for ObservedCamera {
        type Config = flume::Sender<ffmpeg::frame::Video>;

        async fn setup(
            tx: Self::Config,
            _: PathBuf,
            _: Option<VideoInfo>,
            _: Option<AudioInfo>,
            _: Arc<AtomicBool>,
            _: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            Ok(Self(tx))
        }

        fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
            Ok(Ok(()))
        }
    }

    impl AudioMuxer for ObservedCamera {
        fn send_audio_frame(&mut self, _: AudioFrame, _: Duration) -> anyhow::Result<()> {
            unreachable!()
        }
    }

    impl VideoMuxer for ObservedCamera {
        type VideoFrame = FFmpegVideoFrame;

        fn send_video_frame(&mut self, frame: Self::VideoFrame, _: Duration) -> anyhow::Result<()> {
            self.0.send(frame.inner)?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn camera_keeps_frames_when_pixel_format_changes() {
        ffmpeg::init().unwrap();
        let info = VideoInfo::from_raw_ffmpeg(Pixel::YUVJ422P, 64, 48, 30);
        let camera = SyntheticCamera::spawn("format-changing-camera", info);
        let (tx, rx) = flume::unbounded();
        let dir = tempfile::tempdir().unwrap();
        let pipeline = OutputPipeline::builder(dir.path().join("camera.mp4"))
            .with_video::<Camera>(Arc::new(camera.lock().await.unwrap()))
            .build::<ObservedCamera>(tx)
            .await
            .unwrap();

        let result = async {
            for (index, (format, width, height)) in [
                (Pixel::YUVJ422P, 64, 48),
                (Pixel::YUVJ422P, 32, 24),
                (Pixel::YUVJ420P, 32, 24),
                (Pixel::YUVJ420P, 32, 24),
                (Pixel::YUVJ420P, 64, 48),
                (Pixel::YUVJ422P, 64, 48),
                (Pixel::YUVJ444P, 96, 72),
                (Pixel::YUVJ422P, 64, 48),
            ]
            .into_iter()
            .enumerate()
            {
                let mut frame = ffmpeg::frame::Video::new(format, width, height);
                for plane in 0..frame.planes() {
                    frame.data_mut(plane).fill(128);
                }
                frame.set_pts(Some(index as i64));
                camera
                    .push(FFmpegVideoFrame {
                        inner: frame,
                        timestamp: Timestamp::Instant(std::time::Instant::now()),
                    })
                    .await;
                let output = tokio::time::timeout(Duration::from_secs(2), rx.recv_async())
                    .await
                    .map_err(|_| {
                        anyhow!("Camera dropped frame {index}: {format:?} {width}x{height}")
                    })??;
                anyhow::ensure!(
                    (output.width(), output.height(), output.format())
                        == (info.width, info.height, info.pixel_format),
                    "Camera changed output format on frame {index}: {:?} {}x{}",
                    output.format(),
                    output.width(),
                    output.height()
                );
                anyhow::ensure!(output.pts() == Some(index as i64), "Camera lost frame PTS");
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;

        pipeline.stop().await.unwrap();
        result.unwrap();
    }
}
