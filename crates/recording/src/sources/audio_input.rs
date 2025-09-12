use crate::{
    feeds::microphone::{self, MicrophoneFeedLock, MicrophoneSamples},
    pipeline::{control::Control, task::PipelineSourceTask},
};
use cap_fail::fail;
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_timestamp::Timestamp;
use cpal::{Device, SupportedStreamConfig};
use ffmpeg::frame::Audio as FFAudio;
use flume::{Receiver, Sender};
use indexmap::IndexMap;
use std::sync::Arc;
use tracing::{error, info};

pub type AudioInputDeviceMap = IndexMap<String, (Device, SupportedStreamConfig)>;

pub struct AudioInputSource {
    feed: Arc<MicrophoneFeedLock>,
    audio_info: AudioInfo,
    tx: Sender<(FFAudio, Timestamp)>,
}

impl AudioInputSource {
    pub fn init(feed: Arc<MicrophoneFeedLock>, tx: Sender<(FFAudio, Timestamp)>) -> Self {
        Self {
            audio_info: *feed.audio_info(),
            feed,
            tx,
        }
    }

    pub fn info(&self) -> AudioInfo {
        self.audio_info
    }

    fn process_frame(&mut self, samples: MicrophoneSamples) -> Result<(), MediaError> {
        let timestamp = Timestamp::from_cpal(samples.info.timestamp().capture);

        let frame = self.audio_info.wrap_frame(&samples.data);
        if self.tx.send((frame, timestamp)).is_err() {
            return Err(MediaError::Any(
                "Pipeline is unreachable! Stopping capture".into(),
            ));
        }

        Ok(())
    }

    fn pause_and_drain_frames(&mut self, frames_rx: Receiver<MicrophoneSamples>) {
        let frames: Vec<MicrophoneSamples> = frames_rx.drain().collect();

        for frame in frames {
            if let Err(error) = self.process_frame(frame) {
                eprintln!("{error}");
                break;
            }
        }
    }
}

impl PipelineSourceTask for AudioInputSource {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        info!("Preparing audio input source thread...");

        let mut samples_rx: Option<Receiver<MicrophoneSamples>> = None;
        ready_signal.send(Ok(())).unwrap();

        fail!("media::sources::audio_input::run");

        let res = loop {
            match control_signal.last() {
                Some(Control::Play) => {
                    let samples = samples_rx.get_or_insert_with(|| {
                        let (tx, rx) = flume::bounded(5);
                        let _ = self.feed.ask(microphone::AddSender(tx)).blocking_send();
                        rx
                    });

                    match samples.recv() {
                        Ok(samples) => {
                            if let Err(error) = self.process_frame(samples) {
                                error!("{error}");
                                break Err(error.to_string());
                            }
                        }
                        Err(_) => {
                            error!("Lost connection with the camera feed");
                            break Err("Lost connection with the camera feed".to_string());
                        }
                    }
                }
                Some(Control::Shutdown) | None => {
                    if let Some(rx) = samples_rx.take() {
                        self.pause_and_drain_frames(rx);
                    }
                    break Ok(());
                }
            }
        };

        info!("Shut down audio input source thread.");
        res
    }
}
