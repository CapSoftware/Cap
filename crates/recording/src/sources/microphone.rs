use crate::{
    feeds::microphone::{self, MicrophoneFeedLock},
    output_pipeline::{AudioFrame, AudioSource},
};
use anyhow::anyhow;
use cap_media_info::AudioInfo;
use futures::{SinkExt, channel::mpsc};
use std::sync::Arc;

pub struct Microphone(pub Arc<MicrophoneFeedLock>);

impl AudioSource for Microphone {
    async fn setup(self, mut audio_tx: mpsc::Sender<AudioFrame>) -> anyhow::Result<AudioInfo> {
        let audio_info = self.0.audio_info();
        let (tx, rx) = flume::bounded(8);

        self.0
            .ask(microphone::AddSender(tx))
            .blocking_send()
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

        Ok(audio_info)
    }
}
