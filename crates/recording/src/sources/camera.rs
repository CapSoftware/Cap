use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::{SetupCtx, VideoSource},
};
use anyhow::anyhow;
use cap_media_info::VideoInfo;
use futures::{FutureExt, channel::mpsc, future::BoxFuture};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::sync::oneshot;

struct CameraFrameScaler {
    context: ffmpeg::software::scaling::Context,
    source_width: u32,
    source_height: u32,
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

        Ok(Self {
            context,
            source_width: src_width,
            source_height: src_height,
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

pub struct Camera {
    #[allow(dead_code)]
    feed_lock: Arc<CameraFeedLock>,
    stop_tx: Option<oneshot::Sender<()>>,
    stopped: Arc<AtomicBool>,
    original_video_info: VideoInfo,
}

impl VideoSource for Camera {
    type Config = Arc<CameraFeedLock>;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        feed_lock: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        _: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (tx, rx) = flume::bounded(256);

        let original_video_info = *feed_lock.video_info();
        let original_width = original_video_info.width;
        let original_height = original_video_info.height;
        let original_format = original_video_info.pixel_format;

        feed_lock
            .ask(camera::AddSender(tx))
            .await
            .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

        let (stop_tx, stop_rx) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_clone = stopped.clone();
        let scaled_frame_count = Arc::new(AtomicU64::new(0));
        let scaled_count_clone = scaled_frame_count.clone();

        tokio::spawn(async move {
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

                                if frame_width != original_width || frame_height != original_height {
                                    let needs_new_scaler = scaler
                                        .as_ref()
                                        .is_none_or(|s| !s.matches_source(frame_width, frame_height));

                                    if needs_new_scaler {
                                        let frame_format = frame.inner.format();
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
                                                    dst_width = original_width,
                                                    dst_height = original_height,
                                                    "Camera source: created scaler for dimension change"
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
                                        "Camera source: dimensions restored to original, removing scaler"
                                    );
                                    scaler = None;
                                }

                                match video_tx.try_send(frame) {
                                    Ok(()) => {
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
                                    Err(e) => {
                                        if e.is_full() {
                                            dropped_count += 1;
                                            if dropped_count.is_multiple_of(30) {
                                                tracing::warn!(
                                                    dropped_count,
                                                    "Camera source: encoder can't keep up"
                                                );
                                            }
                                        } else if e.is_disconnected() {
                                            tracing::debug!(
                                                sent_count,
                                                dropped_count,
                                                "Camera source: pipeline closed"
                                            );
                                            break;
                                        }
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
