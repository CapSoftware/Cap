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

impl VideoSource for Camera {
    type Config = Arc<CameraFeedLock>;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        config: Self::Config,
        mut video_tx: mpsc::Sender<Self::Frame>,
        _: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        let (tx, rx) = flume::bounded(8);

        config
            .ask(camera::AddSender(tx))
            .await
            .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

        tokio::spawn(async move {
            while let Ok(frame) = rx.recv_async().await {
                let _ = video_tx.send(frame).await;
            }
        });

        Ok(Self(config))
    }

    fn video_info(&self) -> VideoInfo {
        *self.0.video_info()
    }
}
