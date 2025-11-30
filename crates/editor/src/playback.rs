use cap_audio::{
    FromSampleBytes, LatencyCorrectionConfig, LatencyCorrector, default_output_latency_hint,
};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_project::{ProjectConfiguration, XY};
use cap_rendering::{DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants};
use cpal::{
    BufferSize, SampleFormat, SupportedBufferSize,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use futures::stream::{FuturesUnordered, StreamExt};
use std::{collections::{HashSet, VecDeque}, sync::Arc, time::Duration};
use tokio::{sync::{mpsc as tokio_mpsc, watch}, time::Instant};
use tracing::{error, info, trace, warn};

use crate::{
    audio::{AudioPlaybackBuffer, AudioSegment},
    editor,
    editor_instance::SegmentMedia,
    segments::get_audio_segments,
};

const PREFETCH_BUFFER_SIZE: usize = 16;
const PARALLEL_DECODE_TASKS: usize = 4;

#[derive(Debug)]
pub enum PlaybackStartError {
    InvalidFps,
}

pub struct Playback {
    pub renderer: Arc<editor::RendererHandle>,
    pub render_constants: Arc<RenderVideoConstants>,
    pub start_frame_number: u32,
    pub project: watch::Receiver<ProjectConfiguration>,
    pub segment_medias: Arc<Vec<SegmentMedia>>,
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

struct PrefetchedFrame {
    frame_number: u32,
    segment_frames: DecodedSegmentFrames,
    segment_index: u32,
}

impl Playback {
    pub async fn start(
        self,
        fps: u32,
        resolution_base: XY<u32>,
    ) -> Result<PlaybackHandle, PlaybackStartError> {
        let fps_f64 = fps as f64;

        if !(fps_f64.is_finite() && fps_f64 > 0.0) {
            warn!(fps, "Invalid FPS provided for playback start");
            return Err(PlaybackStartError::InvalidFps);
        }

        let (stop_tx, mut stop_rx) = watch::channel(false);
        stop_rx.borrow_and_update();

        let (event_tx, mut event_rx) = watch::channel(PlaybackEvent::Start);
        event_rx.borrow_and_update();

        let handle = PlaybackHandle {
            stop_tx: stop_tx.clone(),
            event_rx,
        };

        let (prefetch_tx, mut prefetch_rx) = tokio_mpsc::channel::<PrefetchedFrame>(PREFETCH_BUFFER_SIZE * 2);
        let (frame_request_tx, mut frame_request_rx) = watch::channel(self.start_frame_number);

        let prefetch_stop_rx = stop_rx.clone();
        let prefetch_project = self.project.clone();
        let prefetch_segment_medias = self.segment_medias.clone();
        let prefetch_duration = if let Some(timeline) = &self.project.borrow().timeline {
            timeline.duration()
        } else {
            f64::MAX
        };

        tokio::spawn(async move {
            let mut next_prefetch_frame = *frame_request_rx.borrow();
            let mut in_flight: FuturesUnordered<_> = FuturesUnordered::new();
            let mut in_flight_frames: HashSet<u32> = HashSet::new();

            loop {
                if *prefetch_stop_rx.borrow() {
                    break;
                }

                if let Ok(true) = frame_request_rx.has_changed() {
                    let requested = *frame_request_rx.borrow_and_update();
                    if requested > next_prefetch_frame {
                        next_prefetch_frame = requested;
                        in_flight_frames.retain(|&f| f >= requested);
                    }
                }

                while in_flight.len() < PARALLEL_DECODE_TASKS {
                    let frame_num = next_prefetch_frame;
                    let prefetch_time = frame_num as f64 / fps_f64;
                    
                    if prefetch_time >= prefetch_duration {
                        break;
                    }
                    
                    if in_flight_frames.contains(&frame_num) {
                        next_prefetch_frame += 1;
                        continue;
                    }

                    let project = prefetch_project.borrow().clone();
                    
                    if let Some((segment_time, segment)) = project.get_segment_time(prefetch_time) {
                        if let Some(segment_media) = prefetch_segment_medias.get(segment.recording_clip as usize) {
                            let clip_offsets = project
                                .clips
                                .iter()
                                .find(|v| v.index == segment.recording_clip)
                                .map(|v| v.offsets)
                                .unwrap_or_default();

                            let decoders = segment_media.decoders.clone();
                            let hide_camera = project.camera.hide;
                            let segment_index = segment.recording_clip;
                            
                            in_flight_frames.insert(frame_num);
                            
                            in_flight.push(async move {
                                let result = decoders
                                    .get_frames(segment_time as f32, !hide_camera, clip_offsets)
                                    .await;
                                (frame_num, segment_index, result)
                            });
                        }
                    }
                    
                    next_prefetch_frame += 1;
                }

                tokio::select! {
                    biased;
                    
                    Some((frame_num, segment_index, result)) = in_flight.next() => {
                        in_flight_frames.remove(&frame_num);
                        if let Some(segment_frames) = result {
                            let _ = prefetch_tx.send(PrefetchedFrame {
                                frame_number: frame_num,
                                segment_frames,
                                segment_index,
                            }).await;
                        }
                    }
                    
                    _ = tokio::time::sleep(Duration::from_millis(1)), if in_flight.is_empty() => {}
                }
            }
        });

        tokio::spawn(async move {
            let start = Instant::now();

            let duration = if let Some(timeline) = &self.project.borrow().timeline {
                timeline.duration()
            } else {
                f64::MAX
            };

            AudioPlayback {
                segments: get_audio_segments(&self.segment_medias),
                stop_rx: stop_rx.clone(),
                start_frame_number: self.start_frame_number,
                project: self.project.clone(),
                fps,
            }
            .spawn();

            let frame_duration = Duration::from_secs_f64(1.0 / fps_f64);
            let mut frame_number = self.start_frame_number;
            let mut prefetch_buffer: VecDeque<PrefetchedFrame> = VecDeque::with_capacity(PREFETCH_BUFFER_SIZE);
            let max_frame_skip = 3u32;

            'playback: loop {
                while let Ok(prefetched) = prefetch_rx.try_recv() {
                    if prefetched.frame_number >= frame_number {
                        prefetch_buffer.push_back(prefetched);
                        if prefetch_buffer.len() > PREFETCH_BUFFER_SIZE {
                            prefetch_buffer.pop_front();
                        }
                    }
                }

                let frame_offset = frame_number.saturating_sub(self.start_frame_number) as f64;
                let next_deadline = start + frame_duration.mul_f64(frame_offset);

                tokio::select! {
                    _ = stop_rx.changed() => break 'playback,
                    _ = tokio::time::sleep_until(next_deadline) => {}
                }

                if *stop_rx.borrow() {
                    break;
                }

                let playback_time = frame_number as f64 / fps_f64;
                if playback_time >= duration {
                    break;
                }

                let project = self.project.borrow().clone();

                let prefetched_idx = prefetch_buffer.iter().position(|p| p.frame_number == frame_number);
                
                let segment_frames_opt = if let Some(idx) = prefetched_idx {
                    let prefetched = prefetch_buffer.remove(idx).unwrap();
                    Some((prefetched.segment_frames, prefetched.segment_index))
                } else {
                    let Some((segment_time, segment)) = project.get_segment_time(playback_time) else {
                        break;
                    };

                    let Some(segment_media) = self.segment_medias.get(segment.recording_clip as usize) else {
                        frame_number = frame_number.saturating_add(1);
                        continue;
                    };

                    let clip_offsets = project
                        .clips
                        .iter()
                        .find(|v| v.index == segment.recording_clip)
                        .map(|v| v.offsets)
                        .unwrap_or_default();

                    let data = tokio::select! {
                        _ = stop_rx.changed() => break 'playback,
                        data = segment_media
                            .decoders
                            .get_frames(segment_time as f32, !project.camera.hide, clip_offsets) => data,
                    };

                    data.map(|frames| (frames, segment.recording_clip))
                };

                if let Some((segment_frames, segment_index)) = segment_frames_opt {
                    let Some(segment_media) = self.segment_medias.get(segment_index as usize) else {
                        frame_number = frame_number.saturating_add(1);
                        continue;
                    };

                    let uniforms = ProjectUniforms::new(
                        &self.render_constants,
                        &project,
                        frame_number,
                        fps,
                        resolution_base,
                        &segment_media.cursor,
                        &segment_frames,
                    );

                    self.renderer
                        .render_frame(segment_frames, uniforms, segment_media.cursor.clone())
                        .await;
                }

                event_tx.send(PlaybackEvent::Frame(frame_number)).ok();

                frame_number = frame_number.saturating_add(1);

                let expected_frame = self.start_frame_number
                    + (start.elapsed().as_secs_f64() * fps_f64).floor() as u32;

                if frame_number < expected_frame {
                    let frames_behind = expected_frame - frame_number;
                    if frames_behind <= max_frame_skip {
                        frame_number = expected_frame;
                        trace!("Skipping {} frames to catch up", frames_behind);
                    } else {
                        frame_number = frame_number + max_frame_skip;
                        trace!("Limiting frame skip to {} (was {} behind)", max_frame_skip, frames_behind);
                    }

                    prefetch_buffer.retain(|p| p.frame_number >= frame_number);
                    let _ = frame_request_tx.send(frame_number);
                }
            }

            stop_tx.send(true).ok();

            event_tx.send(PlaybackEvent::Stop).ok();
        });

        Ok(handle)
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

        let mut base_output_info = AudioInfo::from_stream_config(&supported_config);
        base_output_info.sample_format = base_output_info.sample_format.packed();
        let default_output_info = base_output_info;

        let initial_latency_hint =
            default_output_latency_hint(base_output_info.sample_rate, base_output_info.buffer_size);
        let is_wireless = initial_latency_hint
            .as_ref()
            .map(|hint| hint.transport.is_wireless())
            .unwrap_or(false);

        let default_samples_count = AudioPlaybackBuffer::<T>::PLAYBACK_SAMPLES_COUNT;
        let wireless_samples_count = AudioPlaybackBuffer::<T>::WIRELESS_PLAYBACK_SAMPLES_COUNT;

        #[derive(Clone, Copy, PartialEq, Eq)]
        enum BufferSizeStrategy {
            Fixed(u32),
            DeviceDefault,
        }

        let candidate_order = if is_wireless {
            vec![
                BufferSizeStrategy::Fixed(wireless_samples_count),
                BufferSizeStrategy::Fixed(default_samples_count),
                BufferSizeStrategy::DeviceDefault,
            ]
        } else {
            vec![
                BufferSizeStrategy::Fixed(default_samples_count),
                BufferSizeStrategy::DeviceDefault,
            ]
        };

        let mut attempts = Vec::new();
        for strategy in candidate_order {
            if !attempts.contains(&strategy) {
                attempts.push(strategy);
            }
        }

        let playhead = f64::from(start_frame_number) / f64::from(fps);
        let mut last_error: Option<MediaError> = None;

        for (attempt_index, strategy) in attempts.into_iter().enumerate() {
            let mut config = supported_config.config();
            base_output_info = match strategy {
                BufferSizeStrategy::Fixed(desired) => {
                    let clamped = match supported_config.buffer_size() {
                        SupportedBufferSize::Range { min, max } => desired.clamp(*min, *max),
                        SupportedBufferSize::Unknown => desired,
                    };

                    if let SupportedBufferSize::Range { min, max } = supported_config.buffer_size()
                        && clamped != desired
                    {
                        info!(
                            requested_frames = desired,
                            clamped_frames = clamped,
                            range_min = *min,
                            range_max = *max,
                            "Adjusted requested audio buffer to fit device capabilities",
                        );
                    }

                    config.buffer_size = BufferSize::Fixed(clamped);

                    let mut info =
                        AudioInfo::from_stream_config_with_buffer(&supported_config, Some(clamped));
                    info.sample_format = info.sample_format.packed();
                    info
                }
                BufferSizeStrategy::DeviceDefault => {
                    config.buffer_size = BufferSize::Default;
                    default_output_info
                }
            };

            let sample_rate = base_output_info.sample_rate;
            let buffer_size = base_output_info.buffer_size;
            let channels = base_output_info.channels;

            let headroom_samples = (buffer_size as usize)
                .saturating_mul(channels)
                .saturating_mul(2)
                .max(channels * AudioPlaybackBuffer::<T>::PLAYBACK_SAMPLES_COUNT as usize);

            let mut audio_renderer = AudioPlaybackBuffer::new(segments.clone(), base_output_info);

            match strategy {
                BufferSizeStrategy::Fixed(desired) => {
                    let actual = match config.buffer_size {
                        BufferSize::Fixed(value) => value,
                        _ => desired,
                    };

                    if attempt_index == 0 {
                        if actual > default_samples_count {
                            info!("Using enlarged audio buffer: {} frames", actual);
                        } else if is_wireless {
                            info!(
                                "Using device-limited audio buffer for wireless output: {} frames",
                                actual
                            );
                        }
                    } else {
                        info!("Falling back to audio buffer size: {} frames", actual);
                    }
                }
                BufferSizeStrategy::DeviceDefault => {
                    if attempt_index == 0 {
                        info!("Using device default audio buffer size");
                    } else {
                        info!("Falling back to device default audio buffer size");
                    }
                }
            }

            let static_latency_hint =
                default_output_latency_hint(sample_rate, buffer_size).or(initial_latency_hint);
            let latency_config = LatencyCorrectionConfig::default();
            let mut latency_corrector = LatencyCorrector::new(static_latency_hint, latency_config);
            let initial_compensation_secs = latency_corrector.initial_compensation_secs();

            {
                let project_snapshot = project.borrow();
                audio_renderer
                    .set_playhead(playhead + initial_compensation_secs, &project_snapshot);
                audio_renderer.prefill(&project_snapshot, headroom_samples);
            }

            if let Some(hint) = static_latency_hint
                && hint.latency_secs > 0.0
            {
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

            let project_for_stream = project.clone();
            let headroom_for_stream = headroom_samples;

            let stream_result = device.build_output_stream(
                &config,
                move |buffer: &mut [T], info| {
                    let _latency_secs = latency_corrector.update_from_callback(info);

                    let project = project_for_stream.borrow();

                    let playback_samples = buffer.len();
                    let min_headroom = headroom_for_stream.max(playback_samples * 2);
                    audio_renderer.fill(buffer, &project, min_headroom);
                },
                |_err| eprintln!("Audio stream error: {_err}"),
                None,
            );

            match stream_result {
                Ok(stream) => {
                    return Ok((stop_rx, stream));
                }
                Err(err) => {
                    warn!(
                        error = %err,
                        "Audio stream creation failed, attempting fallback"
                    );
                    last_error = Some(MediaError::TaskLaunch(format!(
                        "Failed to build audio output stream: {err}"
                    )));
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            MediaError::TaskLaunch("Failed to build audio output stream".to_string())
        }))
    }
}
