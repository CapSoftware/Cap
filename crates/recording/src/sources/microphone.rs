use crate::{
    feeds::microphone::{self, MicrophoneFeedLock},
    output_pipeline::{AudioFrame, AudioSource},
};
use anyhow::anyhow;
use cap_media_info::AudioInfo;
use futures::{SinkExt, channel::mpsc};
use std::sync::Arc;

pub struct Microphone {
    info: AudioInfo,
    _lock: Arc<MicrophoneFeedLock>,
}

impl AudioSource for Microphone {
    type Config = Arc<MicrophoneFeedLock>;

    #[allow(clippy::manual_async_fn)]
    fn setup(
        feed_lock: Self::Config,
        mut audio_tx: mpsc::Sender<AudioFrame>,
        _: &mut crate::SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        async move {
            let audio_info = feed_lock.audio_info();
            let (tx, rx) = flume::bounded(8);

            feed_lock
                .ask(microphone::AddSender(tx))
                .await
                .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

            tokio::spawn(async move {
                while let Ok(frame) = rx.recv_async().await {
                    let _ = audio_tx
                        .send(AudioFrame::new(
                            audio_info.wrap_frame_with_max_channels(&frame.data, 2),
                            frame.timestamp,
                        ))
                        .await;
                }
            });

            Ok(Self {
                info: audio_info.with_max_channels(2),
                _lock: feed_lock,
            })
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }
}
