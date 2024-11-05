use std::{sync::Arc, sync::Mutex as StdMutex, time::Duration};

use cap_project::ProjectConfiguration;
use cap_rendering::{ProjectUniforms, RecordingDecoders, RenderVideoConstants};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat, SizedSample,
};
use tokio::{sync::watch, time::Instant};

use crate::{audio::AudioData, editor, project_recordings::ProjectRecordings};

pub struct Playback {
    pub audio: Arc<StdMutex<Option<AudioData>>>,
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    pub decoders: RecordingDecoders,
    pub start_frame_number: u32,
    pub project: watch::Receiver<ProjectConfiguration>,
    pub recordings: ProjectRecordings,
}

const FPS: u32 = 30;

#[derive(Clone, Copy)]
pub enum PlaybackEvent {
    Start,
    Frame(u32),
    Stop,
}

#[derive(Clone)]
pub struct PlaybackHandle {
    stop_tx: watch::Sender<bool>,
    event_rx: watch::Receiver<PlaybackEvent>,
}

impl Playback {
    pub async fn start(self) -> PlaybackHandle {
        let (stop_tx, mut stop_rx) = watch::channel(false);
        stop_rx.borrow_and_update();

        let (event_tx, mut event_rx) = watch::channel(PlaybackEvent::Start);
        event_rx.borrow_and_update();

        let handle = PlaybackHandle {
            stop_tx: stop_tx.clone(),
            event_rx,
        };

        tokio::spawn(async move {
            let start = Instant::now();

            let mut frame_number = self.start_frame_number + 1;

            let duration = self
                .project
                .borrow()
                .timeline()
                .map(|t| t.duration())
                .unwrap_or(f64::MAX);

            // Lock the mutex and check if audio data is available
            if let Some(audio_data) = self.audio.lock().unwrap().as_ref() {
                AudioPlayback {
                    audio: audio_data.clone(),
                    stop_rx: stop_rx.clone(),
                    start_frame_number: self.start_frame_number,
                    duration,
                    project: self.project.clone(),
                }
                .spawn();
            };

            loop {
                if frame_number as f64 > FPS as f64 * duration {
                    break;
                };

                let project = self.project.borrow().clone();

                let time = if let Some(timeline) = project.timeline() {
                    match timeline.get_recording_time(frame_number as f64 / FPS as f64) {
                        Some(time) => time,
                        None => break,
                    }
                } else {
                    frame_number as f64 / FPS as f64
                };

                tokio::select! {
                    _ = stop_rx.changed() => {
                       break;
                    },
                    Some((screen_frame, camera_frame)) = self.decoders.get_frames((time * FPS as f64) as u32) => {
                        // println!("decoded frame in {:?}", debug.elapsed());
                        let uniforms = ProjectUniforms::new(&self.render_constants, &project, time as f32);

                        self
                            .renderer
                            .render_frame(
                                screen_frame,
                                camera_frame,
                                project.background.source.clone(),
                                uniforms.clone(),
                                time as f32  // Add the time parameter
                            )
                            .await;

                        tokio::time::sleep_until(start + (frame_number - self.start_frame_number) * Duration::from_secs_f32(1.0 / FPS as f32)).await;

                        event_tx.send(PlaybackEvent::Frame(frame_number)).ok();

                        frame_number += 1;
                    }
                    else => {
                        break;
                    }
                }
            }

            stop_tx.send(true).ok();

            event_tx.send(PlaybackEvent::Stop).ok();
        });

        handle
    }
}

impl PlaybackHandle {
    pub fn stop(&self) {
        self.stop_tx.send(true).ok();
    }

    pub async fn receive_event(&mut self) -> watch::Ref<'_, PlaybackEvent> {
        self.event_rx.changed().await.ok();
        self.event_rx.borrow_and_update()
    }
}

struct AudioPlayback {
    audio: AudioData,
    stop_rx: watch::Receiver<bool>,
    start_frame_number: u32,
    duration: f64,
    project: watch::Receiver<ProjectConfiguration>,
}

impl AudioPlayback {
    fn spawn(mut self) {
        let handle = tokio::runtime::Handle::current();

        std::thread::spawn(move || {
            let audio = self.audio;

            let host = cpal::default_host();
            let device = host.default_output_device().unwrap();
            let supported_config = device
                .default_output_config()
                .expect("Failed to get default output format");
            let mut config = supported_config.config();
            config.channels = 1;

            let data = audio.buffer.clone();
            let duration = data.len() as f64 / audio.sample_rate as f64;
            let mut time = self.start_frame_number as f64 / FPS as f64;

            let time_inc = 1.0 / config.sample_rate.0 as f64;

            let mut clock =
                data.len() as f64 * self.start_frame_number as f64 / (FPS as f64 * self.duration);

            let resample_ratio = audio.sample_rate as f64 / config.sample_rate.0 as f64;

            let next_sample = move || {
                time += time_inc;
                let time = self.project.borrow().timeline()?.get_recording_time(time)?;

                let index = time / duration * data.len() as f64;

                clock += resample_ratio;

                if clock >= data.len() as f64 {
                    return None;
                }

                // Add a check to prevent index_int from going out of bounds
                let index_int = index as usize;
                if index_int >= data.len() - 1 {
                    return None;
                }

                let frac = index.fract();
                let current = data[index_int];
                let next = data[(index_int + 1) % data.len()];
                Some(current * (1.0 - frac) + next * frac)
            };

            let shared_data = (&device, &config, next_sample);
            let stream = match supported_config.sample_format() {
                SampleFormat::I8 => create_stream::<i8>(shared_data),
                SampleFormat::I16 => create_stream::<i16>(shared_data),
                SampleFormat::I32 => create_stream::<i32>(shared_data),
                SampleFormat::I64 => create_stream::<i64>(shared_data),
                SampleFormat::U8 => create_stream::<u8>(shared_data),
                SampleFormat::U16 => create_stream::<u16>(shared_data),
                SampleFormat::U32 => create_stream::<u32>(shared_data),
                SampleFormat::U64 => create_stream::<u64>(shared_data),
                SampleFormat::F32 => create_stream::<f32>(shared_data),
                SampleFormat::F64 => create_stream::<f64>(shared_data),
                _ => unimplemented!(),
            };

            fn create_stream<T: SizedSample + cpal::FromSample<f64> + 'static>(
                (device, config, mut next_sample): (
                    &cpal::Device,
                    &cpal::StreamConfig,
                    impl FnMut() -> Option<f64> + Send + 'static,
                ),
            ) -> cpal::Stream {
                device
                    .build_output_stream(
                        config,
                        move |buffer: &mut [T], _info| {
                            for sample in buffer.iter_mut() {
                                let Some(s) = next_sample() else {
                                    *sample = T::EQUILIBRIUM;
                                    continue;
                                };
                                let value = cpal::Sample::from_sample::<f64>(s);
                                *sample = value;
                            }
                        },
                        |_| {},
                        None,
                    )
                    .unwrap()
            }

            stream.play().unwrap();

            handle.block_on(self.stop_rx.changed()).ok();

            stream.pause().ok();
            drop(stream);
        });
    }
}
