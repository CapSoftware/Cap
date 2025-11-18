use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::{SetupCtx, VideoSource},
};
use anyhow::anyhow;
use cap_media_info::VideoInfo;
use futures::{SinkExt, channel::mpsc};
use std::sync::Arc;

pub struct Camera(Arc<CameraFeedLock>);

struct LogDrop<T>(T, &'static str);
impl<T> Drop for LogDrop<T> {
    fn drop(&mut self) {
        tracing::debug!("Dropping {}", self.1);
    }
}
impl<T> std::ops::Deref for LogDrop<T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl<T> std::ops::DerefMut for LogDrop<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl VideoSource for Camera {
    type Config = Arc<CameraFeedLock>;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        feed_lock: Self::Config,
        mut video_tx: mpsc::Sender<Self::Frame>,
        _: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (tx, rx) = flume::bounded(32);

        feed_lock
            .ask(camera::AddSender(tx))
            .await
            .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

        let mut video_tx = LogDrop(video_tx, "camera_video_tx");

        tokio::spawn(async move {
            tracing::debug!("Camera source task started");
            loop {
                match rx.recv_async().await {
                    Ok(frame) => {
                        // tracing::trace!("Sending camera frame");
                        if let Err(e) = video_tx.send(frame).await {
                            tracing::warn!("Failed to send to video pipeline: {e}");
                            // If pipeline is closed, we should stop?
                            // But lets continue to keep rx alive for now to see if it helps,
                            // or maybe break?
                            // If we break, we disconnect from CameraFeed.
                            // If pipeline is closed, we SHOULD disconnect.
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::debug!("Camera feed disconnected (rx closed): {e}");
                        break;
                    }
                }
            }
            tracing::debug!("Camera source task finished");
        });

        Ok(Self(feed_lock))
    }

    fn video_info(&self) -> VideoInfo {
        *self.0.video_info()
    }
}
