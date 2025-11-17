use crate::{
    feeds::camera::{self, CameraFeedLock},
    ffmpeg::FFmpegVideoFrame,
    output_pipeline::{SetupCtx, VideoSource},
};
use anyhow::anyhow;
use cap_media_info::VideoInfo;
use futures::{SinkExt, channel::mpsc};
use std::sync::Arc;
use tracing::{error, info, warn};

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
            .ask(camera::AddSender(tx.clone()))
            .await
            .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

        tokio::spawn({
            let feed_lock = feed_lock.clone();
            async move {
                let mut receiver = rx;
                let mut frame_count = 0u64;

                let result = loop {
                    match receiver.recv_async().await {
                        Ok(frame) => {
                            frame_count += 1;
                            if let Err(err) = video_tx.send(frame).await {
                                error!(
                                    ?err,
                                    frame_count,
                                    "Camera pipeline receiver dropped; stopping camera forwarding"
                                );
                                break Ok(());
                            }
                        }
                        Err(_) => {
                            let (new_tx, new_rx) = flume::bounded(8);

                            if let Err(err) = feed_lock.ask(camera::AddSender(new_tx)).await {
                                warn!(
                                    ?err,
                                    "Camera sender disconnected and could not be reattached"
                                );
                                break Err(err);
                            }

                            receiver = new_rx;
                        }
                    }
                };

                // Explicitly drop the sender to disconnect from the feed
                drop(tx);
                drop(receiver);

                info!(
                    frame_count,
                    ?result,
                    "Camera forwarding stopped after processing frames"
                );
            }
        });

        Ok(Self(feed_lock))
    }

    fn video_info(&self) -> VideoInfo {
        *self.0.video_info()
    }
}
