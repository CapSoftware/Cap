use cap_audio::{FromSampleBytes, OutputLatencyEstimator, default_output_latency_hint};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_project::{ProjectConfiguration, XY};
use cap_rendering::{ProjectUniforms, RenderVideoConstants};
use cpal::{
    BufferSize, SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use std::{sync::Arc, time::Duration};
use tokio::{sync::watch, time::Instant};
use tracing::{error, info};

use crate::{
    audio::{AudioPlaybackBuffer, AudioSegment},
    editor,
    editor_instance::Segment,
    segments::get_audio_segments,
};

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
                segments: get_audio_segments(&self.segments),
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
                    let clip_config = project.clips.iter().find(|v| v.index == segment_i);
                    let clip_offsets = clip_config.map(|v| v.offsets).unwrap_or_default();

                    let data = tokio::select! {
                        _ = stop_rx.changed() => { break; },
                        data = segment.decoders.get_frames(segment_time as f32, !project.camera.hide, clip_offsets) => { data }
                    };

                    if let Some(segment_frames) = data {
                        let uniforms = ProjectUniforms::new(
                            &self.render_constants,
                            &project,
                            frame_number,
                            fps,
                            resolution_base,
                            &segment.cursor,
                            &segment_frames,
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
    segments: Vec<AudioSegment>,
    stop_rx: watch::Receiver<bool>,
    start_frame_number: u32,
    project: watch::Receiver<ProjectConfiguration>,
    fps: u32,
}

impl AudioPlayback {
    fn spawn(self) {
        let handle = tokio::runtime::Handle::current();

        if self.segments.is_empty() || self.segments[0].tracks.is_empty() {
            info!("No audio segments found, skipping audio playback thread.");
            return;
        }

        std::thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host.default_output_device() {
                Some(d) => d,
                None => {
                    error!("No default output device found. Skipping audio playback.");
                    return;
                }
            };
            let supported_config = match device.default_output_config() {
                Ok(sc) => sc,
                Err(e) => {
                    error!(
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
                    error!(
                        "Unsupported sample format {:?} for simplified volume adjustment, skipping audio playback.",
                        format
                    );
                    return;
                }
            };

            let (mut stop_rx, stream) = match result {
                Ok(s) => s,
                Err(e) => {
                    error!(
                        "Failed to create audio stream: {}. Skipping audio playback.",
                        e
                    );
                    return;
                }
            };

            if let Err(e) = stream.play() {
                error!(
                    "Failed to play audio stream: {}. Skipping audio playback.",
                    e
                );
                return;
            }

            let _ = handle.block_on(stop_rx.changed());
            info!("Audio playback thread finished.");
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

        let mut elapsed = 0;

        let static_latency_hint =
            default_output_latency_hint(output_info.sample_rate, output_info.buffer_size);

        if let Some(hint) = static_latency_hint {
            if hint.latency_secs > 0.0 {
                match hint.transport {
                    cap_audio::OutputTransportKind::Airplay => info!(
                        "Applying AirPlay output latency hint: {:.1} ms",
                        hint.latency_secs * 1_000.0
                    ),
                    transport if transport.is_wireless() => info!(
                        "Applying wireless output latency hint: {:.1} ms",
                        hint.latency_secs * 1_000.0
                    ),
                    _ => info!(
                        "Applying output latency hint: {:.1} ms",
                        hint.latency_secs * 1_000.0
                    ),
                }
            }
        }

        let mut latency_estimator = static_latency_hint
            .map(OutputLatencyEstimator::from_hint)
            .unwrap_or_else(OutputLatencyEstimator::new);
        let mut last_latency_used = latency_estimator.current_secs();
        let mut last_logged_latency_ms: Option<i32> = None;
        let sample_rate_f64 = output_info.sample_rate as f64;
        const LATENCY_LOG_CHANGE_THRESHOLD_MS: i32 = 5;
        const MIN_LATENCY_APPLY_DELTA_SECS: f64 = 0.005;
        const MIN_UPDATES_FOR_DYNAMIC_LATENCY: u64 = 4;
        const MAX_LATENCY_CHANGE_PER_SEC: f64 = 0.15;
        const INITIAL_LATENCY_FREEZE_DURATION_SECS: f64 = 0.35;
        let mut last_latency_update_at = std::time::Instant::now();
        let latency_freeze_until = std::time::Instant::now()
            + std::time::Duration::from_secs_f64(INITIAL_LATENCY_FREEZE_DURATION_SECS);

        let stream_result = device.build_output_stream(
            &config,
            move |buffer: &mut [T], info| {
                let previous_update_count = latency_estimator.update_count();
                let estimated_latency_secs = latency_estimator
                    .observe_callback(info)
                    .or(last_latency_used)
                    .unwrap_or_default();

                let now = std::time::Instant::now();

                let latency_secs = if let Some(previous) = last_latency_used {
                    if now < latency_freeze_until {
                        previous
                    } else if latency_estimator.update_count() >= MIN_UPDATES_FOR_DYNAMIC_LATENCY {
                        let dt_secs = now
                            .checked_duration_since(last_latency_update_at)
                            .map(|d| d.as_secs_f64())
                            .unwrap_or(0.0);
                        let max_delta = (MAX_LATENCY_CHANGE_PER_SEC * dt_secs)
                            .max(MIN_LATENCY_APPLY_DELTA_SECS);
                        let delta = estimated_latency_secs - previous;

                        if delta.abs() <= max_delta {
                            last_latency_update_at = now;
                            estimated_latency_secs
                        } else {
                            last_latency_update_at = now;
                            previous + delta.signum() * max_delta
                        }
                    } else if (estimated_latency_secs - previous).abs()
                        < MIN_LATENCY_APPLY_DELTA_SECS
                    {
                        previous
                    } else {
                        last_latency_update_at = now;
                        estimated_latency_secs
                    }
                } else {
                    last_latency_update_at = now;
                    estimated_latency_secs
                };

                last_latency_used = Some(latency_secs);

                if latency_estimator.update_count() != previous_update_count {
                    let latency_ms = (latency_secs * 1_000.0).round() as i32;
                    let should_log = match last_logged_latency_ms {
                        Some(prev) => (prev - latency_ms).abs() >= LATENCY_LOG_CHANGE_THRESHOLD_MS,
                        None => latency_ms >= 0,
                    };

                    if should_log {
                        info!(
                            "Estimated audio output latency: {:.1} ms",
                            latency_secs * 1_000.0
                        );
                        last_logged_latency_ms = Some(latency_ms);
                    }
                }

                let project = project.borrow();

                audio_renderer.set_playhead(
                    playhead + latency_secs + elapsed as f64 / sample_rate_f64,
                    &project,
                );
                audio_renderer.render(&project);
                audio_renderer.fill(buffer);

                elapsed += buffer.len() / output_info.channels;
            },
            |_err| eprintln!("Audio stream error: {_err}"),
            None,
        );

        let stream = stream_result.map_err(|e| {
            MediaError::TaskLaunch(format!("Failed to build audio output stream: {e}"))
        })?;

        Ok((stop_rx, stream))
    }
}
