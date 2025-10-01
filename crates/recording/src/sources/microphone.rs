use crate::{
    feeds::microphone::{self, MicrophoneFeedLock},
    output_pipeline::{AudioFrame, AudioSource},
};
use anyhow::anyhow;
use cap_media_info::AudioInfo;
use futures::{SinkExt, channel::mpsc};
use std::sync::Arc;

pub struct Microphone(AudioInfo);

impl AudioSource for Microphone {
    type Config = Arc<MicrophoneFeedLock>;

    fn setup(
        config: Self::Config,
        mut audio_tx: mpsc::Sender<AudioFrame>,
        _: &mut crate::SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static
    where
        Self: Sized,
    {
        async move {
            let audio_info = config.audio_info();
            let (tx, rx) = flume::bounded(8);

            config
                .ask(microphone::AddSender(tx))
                .await
                .map_err(|e| anyhow!("Failed to add camera sender: {e}"))?;

            tokio::spawn(async move {
                while let Ok(frame) = rx.recv_async().await {
                    let _ = audio_tx
                        .send(AudioFrame::new(
                            audio_info.wrap_frame(&frame.data),
                            frame.timestamp,
                        ))
                        .await;
                }
            });

            Ok(Self(audio_info))
        }
    }

    fn audio_info(&self) -> AudioInfo {
        self.0
    }
}
