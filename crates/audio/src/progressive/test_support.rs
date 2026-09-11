use super::{
    AudioLoadProgress, AudioStorage, DecodedAudio, LoadResult, LoadState, PendingBlocks,
    ProgressiveAudio,
};
use crate::AudioChunk;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

pub struct ProgressiveAudioTestProducer {
    pending: Arc<Mutex<PendingBlocks>>,
    progress: watch::Sender<LoadState>,
    complete: watch::Sender<Option<LoadResult>>,
}

impl ProgressiveAudioTestProducer {
    pub fn new() -> (ProgressiveAudio, Self) {
        let (progress, rx) = watch::channel(LoadState::default());
        let (complete, complete_rx) = watch::channel(None);
        let pending = Arc::new(Mutex::new(PendingBlocks::default()));
        (
            ProgressiveAudio {
                rx,
                complete: complete_rx,
                pending: pending.clone(),
            },
            Self {
                pending,
                progress,
                complete,
            },
        )
    }

    pub fn append(&self, chunk: AudioChunk) -> Result<(), String> {
        let progress = {
            let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
            pending.append(chunk)?;
            AudioLoadProgress {
                ready_frames: pending.frames,
                channels: pending.channels,
                complete: false,
                error: None,
            }
        };
        self.progress.send_replace(LoadState {
            progress,
            result: None,
        });
        Ok(())
    }

    pub fn finish(self) -> Result<(), String> {
        let audio = {
            let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
            Arc::new(DecodedAudio {
                channels: pending.channels.ok_or("No published audio channels")?,
                frames: pending.frames,
                storage: AudioStorage::Blocks(std::mem::take(&mut pending.blocks)),
            })
        };
        let result = Ok(Some(audio.clone()));
        self.progress.send_replace(LoadState {
            progress: AudioLoadProgress {
                ready_frames: audio.frames,
                channels: Some(audio.channels),
                complete: true,
                error: None,
            },
            result: Some(result.clone()),
        });
        self.complete.send_replace(Some(result));
        Ok(())
    }

    pub fn fail(self, error: String) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .blocks
            .clear();
        let mut progress = self.progress.borrow().progress.clone();
        progress.complete = false;
        progress.error = Some(error.clone());
        let result = Err(error);
        self.progress.send_replace(LoadState {
            progress,
            result: Some(result.clone()),
        });
        self.complete.send_replace(Some(result));
    }
}
