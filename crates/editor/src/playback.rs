use std::{ops::Mul, sync::Arc, time::Duration};

use cap_media::data::{AudioInfo, AudioInfoError, FromSampleBytes};
use cap_media::feeds::{AudioPlaybackBuffer, AudioTrack};
use cap_media::MediaError;
use cap_project::{ProjectConfiguration, XY};
use cap_rendering::{ProjectUniforms, RenderVideoConstants};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    BufferSize, SampleFormat,
};
use tokio::{sync::watch, time::Instant};

use crate::editor;
use crate::editor_instance::Segment;

pub struct Playback {
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    pub start_frame_number: u32,
    pub project: watch::Receiver<ProjectConfiguration>,
    pub segments: Arc<Vec<Segment>>,
}

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
    pub async fn start(self, fps: u32, resolution_base: XY<u32>) -> PlaybackHandle {
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

            let duration = if let Some(timeline) = &self.project.borrow().timeline {
                timeline.duration()
            } else {
                f64::MAX
            };

            AudioPlayback {
                segments: self
                    .segments
                    .iter()
                    .map(|s| {
                        [s.audio.clone(), s.system_audio.clone()]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>(),
                stop_rx: stop_rx.clone(),
                start_frame_number: self.start_frame_number,
                project: self.project.clone(),
                fps,
            }
            .spawn();

            loop {
                let time =
                    (self.start_frame_number as f64 / fps as f64) + start.elapsed().as_secs_f64();
                let frame_number = (time * fps as f64).floor() as u32;

                if frame_number as f64 >= fps as f64 * duration {
                    break;
                };

                let project = self.project.borrow().clone();

                if let Some((segment_time, segment_i)) = project.get_segment_time(time) {
                    let segment = &self.segments[segment_i as usize];

                    let data = tokio::select! {
                        _ = stop_rx.changed() => { break; },
                        data = segment.decoders.get_frames(segment_time as f32, !project.camera.hide) => { data }
                    };

                    if let Some(segment_frames) = data {
                        let uniforms = ProjectUniforms::new(
                            &self.render_constants,
                            &project,
                            frame_number,
                            fps,
                            resolution_base,
                        );

                        self.renderer
                            .render_frame(segment_frames, uniforms, segment.cursor.clone())
                            .await;
                    }
                }

                tokio::time::sleep_until(
                    start
                        + (frame_number - self.start_frame_number)
                            * Duration::from_secs_f32(1.0 / fps as f32),
                )
                .await;

                event_tx.send(PlaybackEvent::Frame(frame_number)).ok();
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
    segments: Vec<AudioTrack>,
    stop_rx: watch::Receiver<bool>,
    start_frame_number: u32,
    project: watch::Receiver<ProjectConfiguration>,
    fps: u32,
}

impl AudioPlayback {
    fn spawn(self) {
        let handle = tokio::runtime::Handle::current();

        if self.segments.is_empty() || self.segments[0].is_empty() {
            println!("No audio segments found, skipping audio playback thread.");
            return;
        }

        std::thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host.default_output_device() {
                Some(d) => d,
                None => {
                    eprintln!("No default output device found. Skipping audio playback.");
                    return;
                }
            };
            println!(
                "Output device: {}",
                device.name().unwrap_or_else(|_| "unknown".to_string())
            );
            let supported_config = match device.default_output_config() {
                Ok(sc) => sc,
                Err(e) => {
                    eprintln!(
                        "Failed to get default output config: {}. Skipping audio playback.",
                        e
                    );
                    return;
                }
            };

            let result = match supported_config.sample_format() {
                SampleFormat::I16 => self.create_stream::<i16>(device, supported_config),
                SampleFormat::I32 => self.create_stream::<i32>(device, supported_config),
                SampleFormat::F32 => self.create_stream::<f32>(device, supported_config),
                SampleFormat::I64 => self.create_stream::<i64>(device, supported_config),
                SampleFormat::U8 => self.create_stream::<u8>(device, supported_config),
                SampleFormat::F64 => self.create_stream::<f64>(device, supported_config),
                format => {
                    eprintln!(
                        "Unsupported sample format {:?} for simplified volume adjustment, skipping audio playback.",
                        format
                    );
                    return;
                }
            };

            let (mut stop_rx, stream) = match result {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "Failed to create audio stream: {}. Skipping audio playback.",
                        e
                    );
                    return;
                }
            };

            if let Err(e) = stream.play() {
                eprintln!(
                    "Failed to play audio stream: {}. Skipping audio playback.",
                    e
                );
                return;
            }

            let _ = handle.block_on(stop_rx.changed());
            println!("Audio playback thread finished.");
        });
    }

    fn create_stream<T>(
        self,
        device: cpal::Device,
        supported_config: cpal::SupportedStreamConfig,
    ) -> Result<(watch::Receiver<bool>, cpal::Stream), MediaError>
    where
        T: FromSampleBytes + cpal::Sample,
    {
        let AudioPlayback {
            stop_rx,
            start_frame_number,
            project,
            segments,
            fps,
            ..
        } = self;

        let mut output_info = AudioInfo::from_stream_config(&supported_config);
        output_info.sample_format = output_info.sample_format.packed();

        let mut audio_renderer = AudioPlaybackBuffer::new(segments, output_info);
        let playhead = f64::from(start_frame_number) / f64::from(fps);
        audio_renderer.set_playhead(playhead, &project.borrow());

        let mut config = supported_config.config();
        config.buffer_size = BufferSize::Fixed(AudioPlaybackBuffer::<T>::PLAYBACK_SAMPLES_COUNT);

        let stream_result = device.build_output_stream(
            &config,
            move |buffer: &mut [T], _info| {
                let project = project.borrow();
                audio_renderer.render(&project);
                audio_renderer.fill(buffer);

                if project.audio.mute {
                    for sample in buffer.iter_mut() {
                        *sample = T::EQUILIBRIUM;
                    }
                } else if project.audio.volume != 1.0 {
                    let volume = project.audio.volume as f32;

                    match supported_config.sample_format() {
                        SampleFormat::F32 => {
                            if T::FORMAT == SampleFormat::F32 {
                                let f32_buffer: &mut [f32] = unsafe { std::mem::transmute(buffer) };
                                for sample in f32_buffer.iter_mut() {
                                    *sample *= volume;
                                }
                            }
                        }
                        SampleFormat::F64 => {
                            if T::FORMAT == SampleFormat::F64 {
                                let f64_buffer: &mut [f64] = unsafe { std::mem::transmute(buffer) };
                                for sample in f64_buffer.iter_mut() {
                                    *sample *= volume as f64;
                                }
                            }
                        }
                        SampleFormat::I16 => {
                            if T::FORMAT == SampleFormat::I16 {
                                let i16_buffer: &mut [i16] = unsafe { std::mem::transmute(buffer) };
                                for sample in i16_buffer.iter_mut() {
                                    let val = *sample as f32 * volume;
                                    *sample = val.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                                }
                            }
                        }
                        SampleFormat::I32 => {
                            if T::FORMAT == SampleFormat::I32 {
                                let i32_buffer: &mut [i32] = unsafe { std::mem::transmute(buffer) };
                                for sample in i32_buffer.iter_mut() {
                                    let val = *sample as f32 * volume;
                                    *sample = val.clamp(i32::MIN as f32, i32::MAX as f32) as i32;
                                }
                            }
                        }
                        SampleFormat::I64 => {
                            if T::FORMAT == SampleFormat::I64 {
                                let i64_buffer: &mut [i64] = unsafe { std::mem::transmute(buffer) };
                                for sample in i64_buffer.iter_mut() {
                                    let val = *sample as f64 * volume as f64;
                                    *sample = val.clamp(i64::MIN as f64, i64::MAX as f64) as i64;
                                }
                            }
                        }
                        SampleFormat::U8 => {
                            if T::FORMAT == SampleFormat::U8 {
                                let u8_buffer: &mut [u8] = unsafe { std::mem::transmute(buffer) };
                                for sample in u8_buffer.iter_mut() {
                                    let val = *sample as f32 * volume;
                                    *sample = val.clamp(u8::MIN as f32, u8::MAX as f32) as u8;
                                }
                            }
                        }
                        _ => {}
                    }
                }
            },
            |_err| eprintln!("Audio stream error: {}", _err),
            None,
        );

        let stream = stream_result.map_err(|e| {
            MediaError::TaskLaunch(format!("Failed to build audio output stream: {}", e))
        })?;

        Ok((stop_rx, stream))
    }
}
