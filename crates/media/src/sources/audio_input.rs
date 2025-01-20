use cpal::{Device, StreamInstant, SupportedStreamConfig};
use flume::{Receiver, Sender};
use indexmap::IndexMap;
use tracing::{error, info};

use crate::feeds::{AudioInputConnection, AudioInputFeed, AudioInputSamples};
use crate::{
    data::{AudioInfo, FFAudio},
    pipeline::{
        clock::{LocalTimestamp, RealTimeClock},
        control::Control,
        task::PipelineSourceTask,
    },
    MediaError,
};

pub type AudioInputDeviceMap = IndexMap<String, (Device, SupportedStreamConfig)>;

impl LocalTimestamp for StreamInstant {
    fn elapsed_since(&self, other: &Self) -> std::time::Duration {
        self.duration_since(other).unwrap()
    }
}

pub struct AudioInputSource {
    feed_connection: AudioInputConnection,
    audio_info: AudioInfo,
}

impl AudioInputSource {
    pub fn init(feed: &AudioInputFeed) -> Self {
        Self {
            feed_connection: feed.create_connection(),
            audio_info: feed.audio_info(),
        }
    }

    pub fn info(&self) -> AudioInfo {
        self.audio_info
    }

    fn process_frame(
        &self,
        clock: &mut RealTimeClock<StreamInstant>,
        output: &Sender<FFAudio>,
        samples: AudioInputSamples,
    ) -> Result<(), MediaError> {
        match clock.timestamp_for(samples.info.timestamp().capture) {
            None => {
                eprintln!("Clock is currently stopped. Dropping frames.");
            }
            Some(timestamp) => {
                let frame = self.audio_info.wrap_frame(&samples.data, timestamp);
                if let Err(_) = output.send(frame) {
                    return Err(MediaError::Any("Pipeline is unreachable! Stopping capture"));
                }
            }
        }

        Ok(())
    }

    fn pause_and_drain_frames(
        &self,
        clock: &mut RealTimeClock<StreamInstant>,
        output: &Sender<FFAudio>,
        frames_rx: Receiver<AudioInputSamples>,
    ) {
        let frames: Vec<AudioInputSamples> = frames_rx.drain().collect();
        drop(frames_rx);

        for frame in frames {
            if let Err(error) = self.process_frame(clock, output, frame) {
                eprintln!("{error}");
                break;
            }
        }
    }
}

impl PipelineSourceTask for AudioInputSource {
    type Output = FFAudio;

    type Clock = RealTimeClock<StreamInstant>;

    fn run(
        &mut self,
        mut clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        info!("Preparing audio input source thread...");

        let mut samples_rx: Option<Receiver<AudioInputSamples>> = None;
        ready_signal.send(Ok(())).unwrap();

        loop {
            match control_signal.last() {
                Some(Control::Play) => {
                    let samples = samples_rx.get_or_insert_with(|| self.feed_connection.attach());

                    match samples.recv() {
                        Ok(samples) => {
                            if let Err(error) = self.process_frame(&mut clock, &output, samples) {
                                error!("{error}");
                                break;
                            }
                        }
                        Err(_) => {
                            error!("Lost connection with the camera feed");
                            break;
                        }
                    }
                }
                Some(Control::Pause) => {
                    // TODO: This blocks to process frames in the queue, which may delay resumption
                    // Some way to prevent this from delaying the listen loop?
                    if let Some(rx) = samples_rx.take() {
                        self.pause_and_drain_frames(&mut clock, &output, rx);
                    }
                }
                Some(Control::Shutdown) | None => {
                    if let Some(rx) = samples_rx.take() {
                        self.pause_and_drain_frames(&mut clock, &output, rx);
                    }
                    break;
                }
            }
        }

        info!("Shut down audio input source thread.");
    }
}
