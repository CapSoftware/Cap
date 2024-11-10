use std::{sync::Arc, sync::Mutex as StdMutex, time::Duration};

use cap_media::data::{AudioInfo, FromSampleBytes};
use cap_media::feeds::{AudioData, AudioPlaybackBuffer};
use cap_project::ProjectConfiguration;
use cap_rendering::{ProjectUniforms, RecordingDecoders, RenderVideoConstants};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    BufferSize, SampleFormat,
};
use tokio::{sync::watch, time::Instant};

use crate::{editor, project_recordings::ProjectRecordings};

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
    fn spawn(self) {
        let handle = tokio::runtime::Handle::current();

        std::thread::spawn(move || {
            let host = cpal::default_host();
            let device = host.default_output_device().unwrap();
            println!("Output device: {}", device.name().unwrap());
            let supported_config = device
                .default_output_config()
                .expect("Failed to get default output format");

            let (mut stop_rx, stream) = match supported_config.sample_format() {
                // SampleFormat::I8 => create_stream::<i8>(shared_data),
                SampleFormat::I16 => self.create_stream::<i16>(device, supported_config),
                SampleFormat::I32 => self.create_stream::<i32>(device, supported_config),
                SampleFormat::I64 => self.create_stream::<i64>(device, supported_config),
                SampleFormat::U8 => self.create_stream::<u8>(device, supported_config),
                // SampleFormat::U16 => create_stream::<u16>(shared_data),
                // SampleFormat::U32 => create_stream::<u32>(shared_data),
                // SampleFormat::U64 => create_stream::<u64>(shared_data),
                SampleFormat::F32 => self.create_stream::<f32>(device, supported_config),
                SampleFormat::F64 => self.create_stream::<f64>(device, supported_config),
                _ => unimplemented!(),
            };

            stream.play().unwrap();

            handle.block_on(stop_rx.changed()).ok();

            stream.pause().ok();
            drop(stream);
        });
    }

    fn create_stream<T: FromSampleBytes>(
        self,
        device: cpal::Device,
        supported_config: cpal::SupportedStreamConfig,
    ) -> (watch::Receiver<bool>, cpal::Stream) {
        let AudioPlayback {
            audio,
            stop_rx,
            start_frame_number,
            project,
            ..
        } = self;

        let mut output_info = AudioInfo::from_stream_config(&supported_config);
        output_info.sample_format = output_info.sample_format.packed();

        // TODO: Get fps and duration from video (once we start supporting other frame rates)
        // Also, it's a bit weird that self.duration can ever be infinity to begin with, since
        // pre-recorded videos are obviously a fixed size
        let mut audio_renderer = AudioPlaybackBuffer::new(audio, output_info);
        let playhead = f64::from(start_frame_number) / f64::from(FPS);
        audio_renderer.set_playhead(playhead, project.borrow().timeline());

        // Prerender enough for smooth playback
        while !audio_renderer.buffer_reaching_limit() {
            audio_renderer.render(project.borrow().timeline());
        }

        let mut config = supported_config.config();
        // Low-latency playback
        config.buffer_size = BufferSize::Fixed(AudioPlaybackBuffer::<T>::PLAYBACK_SAMPLES_COUNT);

        let stream = device
            .build_output_stream(
                &config,
                move |buffer: &mut [T], _info| {
                    audio_renderer.render(project.borrow().timeline());
                    audio_renderer.fill(buffer);
                },
                |_| {},
                None,
            )
            .unwrap();

        (stop_rx, stream)
    }
}
