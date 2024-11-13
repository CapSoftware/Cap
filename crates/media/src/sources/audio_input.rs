use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Device, Stream, StreamConfig, StreamInstant, SupportedStreamConfig};
use flume::Sender;
use indexmap::IndexMap;

use crate::{
    data::{ffmpeg_sample_format_for, AudioInfo, FFAudio},
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
    device: Device,
    device_name: String,
    config: SupportedStreamConfig,
}

impl AudioInputSource {
    pub fn init(selected_audio_input: &str) -> Option<Self> {
        println!("Selected audio input: {selected_audio_input}",);

        Self::get_devices()
            .swap_remove_entry(selected_audio_input)
            .map(|(device_name, (device, config))| {
                println!("Using audio device: {}", device_name);

                Self {
                    device,
                    device_name,
                    config,
                }
            })
    }

    pub fn info(&self) -> AudioInfo {
        AudioInfo::from_stream_config(&self.config)
    }

    pub fn get_devices() -> AudioInputDeviceMap {
        let host = cpal::default_host();
        let mut device_map = IndexMap::new();

        let get_usable_device = |device: Device| {
            device
                .supported_input_configs()
                .map_err(|error| eprintln!("Error: {error}"))
                .ok()
                .and_then(|configs| {
                    let mut configs = configs.collect::<Vec<_>>();
                    configs.sort_by(|a, b| {
                        b.sample_format()
                            .sample_size()
                            .cmp(&a.sample_format().sample_size())
                    });
                    configs
                        .into_iter()
                        .find(|c| ffmpeg_sample_format_for(c.sample_format()).is_some())
                })
                .and_then(|config| {
                    device
                        .name()
                        .ok()
                        .map(|name| (name, device, config.with_max_sample_rate()))
                })
        };

        if let Some((name, device, config)) =
            host.default_input_device().and_then(get_usable_device)
        {
            device_map.insert(name, (device, config));
        }

        match host.input_devices() {
            Ok(devices) => {
                for (name, device, config) in devices.filter_map(get_usable_device) {
                    device_map.entry(name).or_insert((device, config));
                }
            }
            Err(error) => {
                eprintln!("Could not access audio input devices");
                eprintln!("{error}");
            }
        }

        device_map
    }

    pub fn build_stream(
        &self,
        mut clock: RealTimeClock<StreamInstant>,
        output: Arc<Mutex<Option<Sender<FFAudio>>>>,
    ) -> Result<Stream, MediaError> {
        let audio_info = self.info();
        let mut stream_config: StreamConfig = self.config.clone().into();
        stream_config.buffer_size = BufferSize::Fixed(audio_info.buffer_size);
        let sample_format = self.config.sample_format();

        let data_callback = move |data: &cpal::Data, info: &cpal::InputCallbackInfo| {
            println!("data_callback");
            let capture_time = info.timestamp().capture;

            let Ok(output) = output.try_lock() else {
                return;
            };
            let Some(output) = output.as_ref() else {
                return;
            };

            let Some(timestamp) = clock.timestamp_for(capture_time) else {
                eprintln!("Clock is currently stopped. Dropping samples.");
                return;
            };

            let buffer = audio_info.wrap_frame(data.bytes(), timestamp.try_into().unwrap());
            // TODO(PJ): Send error when I bring error infra back online
            output.send(buffer).unwrap();
            // if let Err(_) = output.send(buffer) {
            //     tracing::debug!("Pipeline is unreachable. Recording will shut down.");
            // }
        };

        let error_callback = |err| {
            // TODO: Handle errors such as device being disconnected. Some kind of fallback or pop-up?
            eprintln!("An error occurred on the audio stream: {}", err);
        };

        self.device
            .build_input_stream_raw(
                &stream_config,
                sample_format,
                data_callback,
                error_callback,
                None,
            )
            .map_err(|error| {
                eprintln!("Error while preparing audio capture: {error}");
                MediaError::TaskLaunch("Failed to start audio capture".into())
            })
    }
}

impl PipelineSourceTask for AudioInputSource {
    type Output = FFAudio;

    type Clock = RealTimeClock<StreamInstant>;

    // #[tracing::instrument(skip_all)]
    fn run(
        &mut self,
        clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        println!("Preparing audio input source thread...");

        let output = Arc::new(Mutex::new(Some(output)));

        match self.build_stream(clock.clone(), output.clone()) {
            Err(error) => ready_signal.send(Err(error)).unwrap(),
            Ok(stream) => {
                println!("Using audio input device {}", self.device_name);
                ready_signal.send(Ok(())).unwrap();

                loop {
                    // TODO: Handle these more gracefully than crashing (e.g. if user unplugged mic between pausing and resuming).
                    // Some kind of error stream?
                    match control_signal.blocking_last() {
                        Some(Control::Play) => {
                            stream
                                .play()
                                .expect("Failed to start audio input recording");
                            println!("Audio input recording started.");
                        }
                        Some(Control::Pause) => {
                            stream
                                .pause()
                                .expect("Failed to pause audio input recording");
                        }
                        Some(Control::Shutdown) | None => {
                            if let Err(error) = stream.pause() {
                                eprintln!("Error while stopping audio stream: {error}");
                            }
                            output.lock().unwrap().take();
                            drop(stream);
                            break;
                        }
                    }
                }

                println!("Shutting down audio input source thread.")
            }
        }
    }
}
