use cap_fail::fail;
use cap_media_info::AudioInfo;
use cpal::{Device, StreamInstant, SupportedStreamConfig};
use ffmpeg_sys_next::AV_TIME_BASE_Q;
use flume::{Receiver, Sender};
use indexmap::IndexMap;
use std::time::SystemTime;
use tracing::{error, info};

use crate::{
    MediaError,
    data::FFAudio,
    feeds::{AudioInputConnection, AudioInputFeed, AudioInputSamples},
    pipeline::{
        clock::{LocalTimestamp, RealTimeClock},
        control::Control,
        task::PipelineSourceTask,
    },
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
    tx: Sender<(FFAudio, f64)>,
    start_timestamp: Option<(StreamInstant, SystemTime)>,
    start_time: f64,
}

impl AudioInputSource {
    pub fn init(feed: &AudioInputFeed, tx: Sender<(FFAudio, f64)>, start_time: SystemTime) -> Self {
        Self {
            feed_connection: feed.create_connection(),
            audio_info: feed.audio_info(),
            tx,
            start_timestamp: None,
            start_time: start_time
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_secs_f64(),
        }
    }

    pub fn info(&self) -> AudioInfo {
        self.audio_info
    }

    fn process_frame(&mut self, samples: AudioInputSamples) -> Result<(), MediaError> {
        let start_timestamp = match self.start_timestamp {
            None => *self
                .start_timestamp
                .insert((samples.info.timestamp().capture, SystemTime::now())),
            Some(v) => v,
        };

        let elapsed = samples
            .info
            .timestamp()
            .capture
            .duration_since(&start_timestamp.0)
            .unwrap();

        let timestamp = start_timestamp
            .1
            .checked_add(elapsed)
            .unwrap()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            - self.start_time;

        let frame = self.audio_info.wrap_frame(
            &samples.data,
            (elapsed.as_secs_f64() * AV_TIME_BASE_Q.den as f64) as i64,
        );
        if self.tx.send((frame, timestamp)).is_err() {
            return Err(MediaError::Any(
                "Pipeline is unreachable! Stopping capture".into(),
            ));
        }

        Ok(())
    }

    fn pause_and_drain_frames(&mut self, frames_rx: Receiver<AudioInputSamples>) {
        let frames: Vec<AudioInputSamples> = frames_rx.drain().collect();

        for frame in frames {
            if let Err(error) = self.process_frame(frame) {
                eprintln!("{error}");
                break;
            }
        }
    }
}

impl PipelineSourceTask for AudioInputSource {
    type Clock = RealTimeClock<StreamInstant>;

    fn run(
        &mut self,
        _: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        info!("Preparing audio input source thread...");

        let mut samples_rx: Option<Receiver<AudioInputSamples>> = None;
        ready_signal.send(Ok(())).unwrap();

        fail!("media::sources::audio_input::run");

        let res = loop {
            match control_signal.last() {
                Some(Control::Play) => {
                    let samples = samples_rx.get_or_insert_with(|| self.feed_connection.attach());

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
