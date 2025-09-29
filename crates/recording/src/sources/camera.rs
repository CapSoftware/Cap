use std::sync::Arc;

use anyhow::anyhow;
use futures::SinkExt;

use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmepg::FFmpegVideoFrame,
    output_pipeline::VideoSource,
};

pub struct Camera(Arc<CameraFeedLock>);

impl VideoSource for Camera {
    type Config = Arc<CameraFeedLock>;
    type Frame = FFmpegVideoFrame;

    async fn setup(
        config: Self::Config,
        mut video_tx: futures::channel::mpsc::Sender<Self::Frame>,
        ctx: &mut crate::output_pipeline::SetupCtx,
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
                video_tx.send(frame).await;
            }
        });

        Ok(Self(config))
    }

    fn video_info(&self) -> cap_media_info::VideoInfo {
        *self.0.video_info()
    }
}
