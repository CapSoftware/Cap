use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::{SetupCtx, VideoSource},
};
use anyhow::anyhow;
use cap_media_info::VideoInfo;
use futures::{SinkExt, channel::mpsc};
use std::sync::Arc;
use tracing::{error, warn};

pub struct Camera(Arc<CameraFeedLock>);

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
        let (tx, rx) = flume::bounded(8);

        feed_lock
            .ask(camera::AddSender(tx))
            .await
            .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

        tokio::spawn({
            let feed_lock = feed_lock.clone();
            async move {
                let mut receiver = rx;

                loop {
                    match receiver.recv_async().await {
                        Ok(frame) => {
                            if let Err(err) = video_tx.send(frame).await {
                                error!(
                                    ?err,
                                    "Camera pipeline receiver dropped; stopping camera forwarding"
                                );
                                break;
                            }
                        }
                        Err(_) => {
                            let (tx, new_rx) = flume::bounded(8);

                            if let Err(err) = feed_lock.ask(camera::AddSender(tx)).await {
                                warn!(
                                    ?err,
                                    "Camera sender disconnected and could not be reattached"
                                );
                                break;
                            }

                            receiver = new_rx;
                        }
                    }
                }
            }
        });

        Ok(Self(feed_lock))
    }

    fn video_info(&self) -> VideoInfo {
        *self.0.video_info()
    }
}
