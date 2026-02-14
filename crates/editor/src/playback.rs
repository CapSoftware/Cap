use cap_audio::FromSampleBytes;
#[cfg(not(target_os = "windows"))]
use cap_audio::{LatencyCorrectionConfig, LatencyCorrector, default_output_latency_hint};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_project::{ProjectConfiguration, XY};
use cap_rendering::{
    DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, ZoomFocusInterpolator,
    spring_mass_damper::SpringMassDamperSimulationConfig,
};
#[cfg(not(target_os = "windows"))]
use cpal::{BufferSize, SupportedBufferSize};
use cpal::{
    SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use futures::stream::{FuturesUnordered, StreamExt};
use lru::LruCache;
use std::{
    collections::{HashSet, VecDeque},
    num::NonZeroUsize,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::{
    sync::{mpsc as tokio_mpsc, watch},
    time::Instant,
};
use tracing::{error, info, warn};

#[cfg(not(target_os = "windows"))]
use crate::audio::AudioPlaybackBuffer;
use crate::{
    audio::AudioSegment, editor, editor_instance::SegmentMedia, segments::get_audio_segments,
};

const PREFETCH_BUFFER_SIZE: usize = 90;
const PARALLEL_DECODE_TASKS: usize = 6;
const INITIAL_PARALLEL_DECODE_TASKS: usize = 8;
const MAX_PREFETCH_AHEAD: u32 = 90;
const PREFETCH_BEHIND: u32 = 10;
const FRAME_CACHE_SIZE: usize = 90;
const RAMP_UP_FRAME_COUNT: u32 = 15;

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

struct FrameCache {
    cache: LruCache<u32, (Arc<DecodedSegmentFrames>, u32)>,
}

impl FrameCache {
    fn new(capacity: usize) -> Self {
        Self {
            cache: LruCache::new(NonZeroUsize::new(capacity).unwrap()),
        }
    }

    fn get(&mut self, frame_number: u32) -> Option<(Arc<DecodedSegmentFrames>, u32)> {
        self.cache
            .get(&frame_number)
            .map(|(frames, idx)| (Arc::clone(frames), *idx))
    }

    fn insert(
        &mut self,
        frame_number: u32,
        segment_frames: Arc<DecodedSegmentFrames>,
        segment_index: u32,
    ) {
        self.cache
            .put(frame_number, (segment_frames, segment_index));
    }
}

impl Playback {
    pub async fn start(
        mut self,
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

        let (prefetch_tx, mut prefetch_rx) =
            tokio_mpsc::channel::<PrefetchedFrame>(PREFETCH_BUFFER_SIZE * 2);
        let (frame_request_tx, mut frame_request_rx) = watch::channel(self.start_frame_number);
        let (playback_position_tx, playback_position_rx) = watch::channel(self.start_frame_number);

        let in_flight_frames: Arc<RwLock<HashSet<u32>>> = Arc::new(RwLock::new(HashSet::new()));
        let prefetch_in_flight = in_flight_frames.clone();
        let main_in_flight = in_flight_frames;

        let prefetch_stop_rx = stop_rx.clone();
        let mut prefetch_project = self.project.clone();
        let prefetch_segment_medias = self.segment_medias.clone();
        let (prefetch_duration, has_timeline) =
            if let Some(timeline) = &self.project.borrow().timeline {
                (timeline.duration(), true)
            } else {
                (f64::MAX, false)
            };
        let segment_media_count = self.segment_medias.len();

        tokio::spawn(async move {
            if !has_timeline {
                warn!("Prefetch: No timeline configuration found");
            }
            if segment_media_count == 0 {
                warn!("Prefetch: No segment media available");
            }
            type PrefetchFuture = std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = (u32, u32, Option<DecodedSegmentFrames>)>
                        + Send,
                >,
            >;
            let mut next_prefetch_frame = *frame_request_rx.borrow();
            let mut in_flight: FuturesUnordered<PrefetchFuture> = FuturesUnordered::new();
            let mut frames_decoded: u32 = 0;
            let mut prefetched_behind: HashSet<u32> = HashSet::new();

            let mut cached_project = prefetch_project.borrow().clone();

            loop {
                if *prefetch_stop_rx.borrow() {
                    break;
                }

                if prefetch_project.has_changed().unwrap_or(false) {
                    cached_project = prefetch_project.borrow_and_update().clone();
                }

                if let Ok(true) = frame_request_rx.has_changed() {
                    let requested = *frame_request_rx.borrow_and_update();
                    if requested != next_prefetch_frame {
                        let old_frame = next_prefetch_frame;
                        let is_backward_seek = requested < old_frame;
                        let seek_distance = if is_backward_seek {
                            old_frame - requested
                        } else {
                            requested - old_frame
                        };

                        next_prefetch_frame = requested;
                        frames_decoded = 0;
                        prefetched_behind.clear();

                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.clear();
                        }

                        if is_backward_seek || seek_distance > MAX_PREFETCH_AHEAD / 2 {
                            in_flight = FuturesUnordered::new();
                        }
                    }
                }

                let current_playback_frame = *playback_position_rx.borrow();
                let max_prefetch_frame = current_playback_frame + MAX_PREFETCH_AHEAD;

                let effective_parallel = if frames_decoded < RAMP_UP_FRAME_COUNT {
                    INITIAL_PARALLEL_DECODE_TASKS
                } else {
                    PARALLEL_DECODE_TASKS
                };

                while in_flight.len() < effective_parallel {
                    let frame_num = next_prefetch_frame;

                    if frame_num > max_prefetch_frame {
                        break;
                    }

                    let prefetch_time = frame_num as f64 / fps_f64;

                    if prefetch_time >= prefetch_duration {
                        break;
                    }

                    let already_in_flight = prefetch_in_flight
                        .read()
                        .map(|guard| guard.contains(&frame_num))
                        .unwrap_or(false);
                    if already_in_flight {
                        next_prefetch_frame += 1;
                        continue;
                    }

                    if let Some((segment_time, segment)) =
                        cached_project.get_segment_time(prefetch_time)
                        && let Some(segment_media) =
                            prefetch_segment_medias.get(segment.recording_clip as usize)
                    {
                        let clip_offsets = cached_project
                            .clips
                            .iter()
                            .find(|v| v.index == segment.recording_clip)
                            .map(|v| v.offsets)
                            .unwrap_or_default();

                        let decoders = segment_media.decoders.clone();
                        let hide_camera = cached_project.camera.hide;
                        let segment_index = segment.recording_clip;
                        let is_initial = frames_decoded < 10;

                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.insert(frame_num);
                        }

                        in_flight.push(Box::pin(async move {
                            let result = if is_initial {
                                decoders
                                    .get_frames_initial(
                                        segment_time as f32,
                                        !hide_camera,
                                        clip_offsets,
                                    )
                                    .await
                            } else {
                                decoders
                                    .get_frames(segment_time as f32, !hide_camera, clip_offsets)
                                    .await
                            };
                            (frame_num, segment_index, result)
                        }));
                    }

                    next_prefetch_frame += 1;
                }

                if in_flight.len() < effective_parallel {
                    for behind_offset in 1..=PREFETCH_BEHIND {
                        if in_flight.len() >= effective_parallel {
                            break;
                        }
                        let behind_frame = current_playback_frame.saturating_sub(behind_offset);
                        if behind_frame == 0 || prefetched_behind.contains(&behind_frame) {
                            continue;
                        }

                        let prefetch_time = behind_frame as f64 / fps_f64;
                        if prefetch_time >= prefetch_duration || prefetch_time < 0.0 {
                            continue;
                        }

                        let already_in_flight = prefetch_in_flight
                            .read()
                            .map(|guard| guard.contains(&behind_frame))
                            .unwrap_or(false);
                        if already_in_flight {
                            continue;
                        }

                        if let Some((segment_time, segment)) =
                            cached_project.get_segment_time(prefetch_time)
                            && let Some(segment_media) =
                                prefetch_segment_medias.get(segment.recording_clip as usize)
                        {
                            let clip_offsets = cached_project
                                .clips
                                .iter()
                                .find(|v| v.index == segment.recording_clip)
                                .map(|v| v.offsets)
                                .unwrap_or_default();

                            let decoders = segment_media.decoders.clone();
                            let hide_camera = cached_project.camera.hide;
                            let segment_index = segment.recording_clip;

                            if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                                in_flight_guard.insert(behind_frame);
                            }

                            prefetched_behind.insert(behind_frame);
                            in_flight.push(Box::pin(async move {
                                let result = decoders
                                    .get_frames(segment_time as f32, !hide_camera, clip_offsets)
                                    .await;
                                (behind_frame, segment_index, result)
                            }));
                        }
                    }
                }

                tokio::select! {
                    biased;

                    Some((frame_num, segment_index, result)) = in_flight.next() => {
                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.remove(&frame_num);
                        }
                        frames_decoded = frames_decoded.saturating_add(1);

                        if let Some(segment_frames) = result {
                            let _ = prefetch_tx.send(PrefetchedFrame {
                                frame_number: frame_num,
                                segment_frames,
                                segment_index,
                            }).await;
                        } else if frames_decoded <= 5 {
                            warn!(
                                frame = frame_num,
                                segment = segment_index,
                                "Prefetch: decoder returned no frames"
                            );
                        }
                    }

                    _ = tokio::time::sleep(Duration::from_millis(1)), if in_flight.is_empty() => {}
                }
            }
        });

        tokio::spawn(async move {
            let duration = if let Some(timeline) = &self.project.borrow().timeline {
                timeline.duration()
            } else {
                f64::MAX
            };

            let (audio_playhead_tx, audio_playhead_rx) =
                watch::channel(self.start_frame_number as f64 / fps as f64);

            let has_audio = AudioPlayback {
                segments: get_audio_segments(&self.segment_medias),
                stop_rx: stop_rx.clone(),
                start_frame_number: self.start_frame_number,
                project: self.project.clone(),
                fps,
                playhead_rx: audio_playhead_rx,
                duration_secs: duration,
            }
            .spawn();

            let frame_duration = Duration::from_secs_f64(1.0 / fps_f64);
            let mut frame_number = self.start_frame_number;
            let mut prefetch_buffer: VecDeque<PrefetchedFrame> =
                VecDeque::with_capacity(PREFETCH_BUFFER_SIZE);
            let mut frame_cache = FrameCache::new(FRAME_CACHE_SIZE);
            let aggressive_skip_threshold = 6u32;

            let mut total_frames_rendered = 0u64;
            let mut total_frames_skipped = 0u64;
            let mut cache_hits = 0u64;
            let mut prefetch_hits = 0u64;
            let mut sync_decodes = 0u64;
            let mut last_stats_time = Instant::now();
            let stats_interval = Duration::from_secs(2);

            let warmup_target_frames = 10usize;
            let warmup_after_first_timeout = Duration::from_millis(500);
            let warmup_no_frames_timeout = Duration::from_secs(5);
            let warmup_start = Instant::now();
            let mut first_frame_time: Option<Instant> = None;

            while !*stop_rx.borrow() {
                let should_start = if let Some(first_time) = first_frame_time {
                    prefetch_buffer.len() >= warmup_target_frames
                        || first_time.elapsed() > warmup_after_first_timeout
                } else {
                    false
                };

                if should_start {
                    break;
                }

                if first_frame_time.is_none() && warmup_start.elapsed() > warmup_no_frames_timeout {
                    warn!(
                        "Playback warmup timed out waiting for first frame after {:?}",
                        warmup_start.elapsed()
                    );
                    let _ = event_tx.send(PlaybackEvent::Stop);
                    return;
                }

                tokio::select! {
                    Some(prefetched) = prefetch_rx.recv() => {
                        if prefetched.frame_number >= frame_number {
                            prefetch_buffer.push_back(prefetched);
                            if first_frame_time.is_none() {
                                first_frame_time = Some(Instant::now());
                            }
                        }
                    }
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    }
                }
            }

            prefetch_buffer
                .make_contiguous()
                .sort_by_key(|p| p.frame_number);

            let start = Instant::now();
            let mut cached_project = self.project.borrow().clone();

            'playback: loop {
                if self.project.has_changed().unwrap_or(false) {
                    cached_project = self.project.borrow_and_update().clone();
                }
                while let Ok(prefetched) = prefetch_rx.try_recv() {
                    if prefetched.frame_number >= frame_number {
                        prefetch_buffer.push_back(prefetched);
                        while prefetch_buffer.len() > PREFETCH_BUFFER_SIZE {
                            if let Some(idx) = prefetch_buffer
                                .iter()
                                .enumerate()
                                .filter(|(_, p)| {
                                    p.frame_number > frame_number + PREFETCH_BUFFER_SIZE as u32
                                })
                                .max_by_key(|(_, p)| p.frame_number)
                                .map(|(i, _)| i)
                            {
                                prefetch_buffer.remove(idx);
                            } else {
                                prefetch_buffer.pop_front();
                            }
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

                let mut was_cached = false;

                let segment_frames_opt = if let Some(cached) = frame_cache.get(frame_number) {
                    was_cached = true;
                    cache_hits += 1;
                    Some(cached)
                } else {
                    let prefetched_idx = prefetch_buffer
                        .iter()
                        .position(|p| p.frame_number == frame_number);

                    if let Some(idx) = prefetched_idx {
                        let prefetched = prefetch_buffer.remove(idx).unwrap();
                        prefetch_hits += 1;
                        Some((
                            Arc::new(prefetched.segment_frames),
                            prefetched.segment_index,
                        ))
                    } else {
                        let is_in_flight = main_in_flight
                            .read()
                            .map(|guard| guard.contains(&frame_number))
                            .unwrap_or(false);

                        if is_in_flight {
                            let wait_start = Instant::now();
                            let max_wait = Duration::from_millis(100);
                            let mut found_frame = None;

                            while wait_start.elapsed() < max_wait {
                                tokio::select! {
                                    _ = stop_rx.changed() => break 'playback,
                                    Some(prefetched) = prefetch_rx.recv() => {
                                        if prefetched.frame_number == frame_number {
                                            found_frame = Some(prefetched);
                                            break;
                                        } else if prefetched.frame_number >= self.start_frame_number {
                                            prefetch_buffer.push_back(prefetched);
                                        }
                                    }
                                    _ = tokio::time::sleep(Duration::from_millis(5)) => {
                                        let still_in_flight = main_in_flight
                                            .read()
                                            .map(|guard| guard.contains(&frame_number))
                                            .unwrap_or(false);
                                        if !still_in_flight {
                                            break;
                                        }
                                    }
                                }
                            }

                            if let Some(prefetched) = found_frame {
                                Some((
                                    Arc::new(prefetched.segment_frames),
                                    prefetched.segment_index,
                                ))
                            } else {
                                let prefetched_idx = prefetch_buffer
                                    .iter()
                                    .position(|p| p.frame_number == frame_number);
                                if let Some(idx) = prefetched_idx {
                                    let prefetched = prefetch_buffer.remove(idx).unwrap();
                                    Some((
                                        Arc::new(prefetched.segment_frames),
                                        prefetched.segment_index,
                                    ))
                                } else {
                                    frame_number = frame_number.saturating_add(1);
                                    total_frames_skipped += 1;
                                    continue;
                                }
                            }
                        } else if prefetch_buffer.is_empty() && total_frames_rendered < 15 {
                            let _ = frame_request_tx.send(frame_number);

                            let wait_result = tokio::time::timeout(
                                Duration::from_millis(100),
                                prefetch_rx.recv(),
                            )
                            .await;

                            if let Ok(Some(prefetched)) = wait_result {
                                if prefetched.frame_number == frame_number {
                                    Some((
                                        Arc::new(prefetched.segment_frames),
                                        prefetched.segment_index,
                                    ))
                                } else {
                                    prefetch_buffer.push_back(prefetched);
                                    frame_number = frame_number.saturating_add(1);
                                    total_frames_skipped += 1;
                                    continue;
                                }
                            } else {
                                frame_number = frame_number.saturating_add(1);
                                total_frames_skipped += 1;
                                continue;
                            }
                        } else {
                            let Some((segment_time, segment)) =
                                cached_project.get_segment_time(playback_time)
                            else {
                                break;
                            };

                            let Some(segment_media) =
                                self.segment_medias.get(segment.recording_clip as usize)
                            else {
                                frame_number = frame_number.saturating_add(1);
                                continue;
                            };

                            let clip_offsets = cached_project
                                .clips
                                .iter()
                                .find(|v| v.index == segment.recording_clip)
                                .map(|v| v.offsets)
                                .unwrap_or_default();

                            if let Ok(mut guard) = main_in_flight.write() {
                                guard.insert(frame_number);
                            }

                            let max_wait = Duration::from_millis(100);
                            let data = tokio::select! {
                                _ = stop_rx.changed() => {
                                    if let Ok(mut guard) = main_in_flight.write() {
                                        guard.remove(&frame_number);
                                    }
                                    break 'playback
                                },
                                _ = tokio::time::sleep(max_wait) => {
                                    if let Ok(mut guard) = main_in_flight.write() {
                                        guard.remove(&frame_number);
                                    }
                                    frame_number = frame_number.saturating_add(1);
                                    total_frames_skipped += 1;
                                    continue;
                                },
                                data = segment_media
                                    .decoders
                                    .get_frames(segment_time as f32, !cached_project.camera.hide, clip_offsets) => {
                                    if let Ok(mut guard) = main_in_flight.write() {
                                        guard.remove(&frame_number);
                                    }
                                    data
                                },
                            };

                            sync_decodes += 1;
                            data.map(|frames| (Arc::new(frames), segment.recording_clip))
                        }
                    }
                };

                if let Some((segment_frames, segment_index)) = segment_frames_opt {
                    let Some(segment_media) = self.segment_medias.get(segment_index as usize)
                    else {
                        frame_number = frame_number.saturating_add(1);
                        continue;
                    };

                    if !was_cached {
                        frame_cache.insert(
                            frame_number,
                            Arc::clone(&segment_frames),
                            segment_index,
                        );
                    }

                    let cursor_smoothing =
                        (!cached_project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
                            tension: cached_project.cursor.tension,
                            mass: cached_project.cursor.mass,
                            friction: cached_project.cursor.friction,
                        });

                    let zoom_focus_interpolator = ZoomFocusInterpolator::new_arc(
                        segment_media.cursor.clone(),
                        cursor_smoothing,
                        cached_project.screen_movement_spring,
                        duration,
                    );

                    let uniforms = ProjectUniforms::new(
                        &self.render_constants,
                        &cached_project,
                        frame_number,
                        fps,
                        resolution_base,
                        &segment_media.cursor,
                        &segment_frames,
                        duration,
                        &zoom_focus_interpolator,
                    );

                    self.renderer
                        .render_frame(
                            Arc::unwrap_or_clone(segment_frames),
                            uniforms,
                            segment_media.cursor.clone(),
                        )
                        .await;

                    total_frames_rendered += 1;
                }

                if last_stats_time.elapsed() >= stats_interval {
                    let effective_fps = total_frames_rendered as f64
                        / start.elapsed().as_secs_f64().max(0.001);
                    let recent_rendered = total_frames_rendered;
                    let buffer_len = prefetch_buffer.len();
                    info!(
                        effective_fps = format!("{:.1}", effective_fps),
                        rendered = recent_rendered,
                        skipped = total_frames_skipped,
                        cache_hits = cache_hits,
                        prefetch_hits = prefetch_hits,
                        sync_decodes = sync_decodes,
                        prefetch_buffer = buffer_len,
                        "Playback stats"
                    );
                    last_stats_time = Instant::now();
                }

                event_tx.send(PlaybackEvent::Frame(frame_number)).ok();

                frame_number = frame_number.saturating_add(1);
                let _ = playback_position_tx.send(frame_number);
                if has_audio
                    && audio_playhead_tx
                        .send(frame_number as f64 / fps_f64)
                        .is_err()
                {
                    break 'playback;
                }

                let expected_frame = self.start_frame_number
                    + (start.elapsed().as_secs_f64() * fps_f64).floor() as u32;

                if frame_number < expected_frame {
                    let frames_behind = expected_frame - frame_number;

                    if frames_behind <= aggressive_skip_threshold {
                        continue;
                    }

                    let skipped = frames_behind.saturating_sub(1);
                    if skipped > 0 {
                        frame_number += skipped;
                        total_frames_skipped += skipped as u64;

                        prefetch_buffer.retain(|p| p.frame_number >= frame_number);
                        let _ = frame_request_tx.send(frame_number);
                        let _ = playback_position_tx.send(frame_number);
                        if has_audio
                            && audio_playhead_tx
                                .send(frame_number as f64 / fps_f64)
                                .is_err()
                        {
                            break 'playback;
                        }
                    }
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
    playhead_rx: watch::Receiver<f64>,
    duration_secs: f64,
}

impl AudioPlayback {
    fn spawn(self) -> bool {
        let handle = tokio::runtime::Handle::current();

        if self.segments.is_empty() || self.segments[0].tracks.is_empty() {
            info!("No audio segments found, skipping audio playback thread.");
            return false;
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

            let duration_secs = self.duration_secs;

            let result = match supported_config.sample_format() {
                SampleFormat::I16 => {
                    self.create_stream_prerendered::<i16>(device, supported_config, duration_secs)
                }
                SampleFormat::I32 => {
                    self.create_stream_prerendered::<i32>(device, supported_config, duration_secs)
                }
                SampleFormat::F32 => {
                    self.create_stream_prerendered::<f32>(device, supported_config, duration_secs)
                }
                SampleFormat::I64 => {
                    self.create_stream_prerendered::<i64>(device, supported_config, duration_secs)
                }
                SampleFormat::U8 => {
                    self.create_stream_prerendered::<u8>(device, supported_config, duration_secs)
                }
                SampleFormat::F64 => {
                    self.create_stream_prerendered::<f64>(device, supported_config, duration_secs)
                }
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

        true
    }

    #[cfg(not(target_os = "windows"))]
    #[allow(dead_code)]
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
            playhead_rx,
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
                BufferSizeStrategy::DeviceDefault,
                BufferSizeStrategy::Fixed(wireless_samples_count),
                BufferSizeStrategy::Fixed(default_samples_count),
            ]
        } else {
            vec![
                BufferSizeStrategy::DeviceDefault,
                BufferSizeStrategy::Fixed(default_samples_count),
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

            // Clamp output info for FFmpeg compatibility (max 8 channels)
            // This must match what AudioPlaybackBuffer will use internally
            base_output_info = base_output_info.for_ffmpeg_output();

            // Also update the stream config to match the clamped channels
            config.channels = base_output_info.channels as u16;

            let sample_rate = base_output_info.sample_rate;
            let buffer_size = base_output_info.buffer_size;
            let channels = base_output_info.channels;

            #[cfg(target_os = "windows")]
            let headroom_multiplier = 4usize;
            #[cfg(not(target_os = "windows"))]
            let headroom_multiplier = 2usize;

            let headroom_samples = (buffer_size as usize)
                .saturating_mul(channels)
                .saturating_mul(headroom_multiplier)
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
            #[allow(unused_mut)]
            let mut latency_corrector = LatencyCorrector::new(static_latency_hint, latency_config);
            let initial_compensation_secs = latency_corrector.initial_compensation_secs();
            let device_sample_rate = sample_rate;

            {
                let project_snapshot = project.borrow();
                audio_renderer
                    .set_playhead(playhead + initial_compensation_secs, &project_snapshot);

                #[cfg(target_os = "windows")]
                let initial_prefill = headroom_samples * 4;
                #[cfg(not(target_os = "windows"))]
                let initial_prefill = headroom_samples;

                audio_renderer.prefill(&project_snapshot, initial_prefill);
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
            let mut playhead_rx_for_stream = playhead_rx.clone();
            let mut last_video_playhead = playhead;

            #[cfg(target_os = "windows")]
            const FIXED_LATENCY_SECS: f64 = 0.08;
            #[cfg(target_os = "windows")]
            const SYNC_THRESHOLD_SECS: f64 = 0.10;
            #[cfg(target_os = "windows")]
            const HARD_SEEK_THRESHOLD_SECS: f64 = 0.3;
            #[cfg(target_os = "windows")]
            const MIN_SYNC_INTERVAL_CALLBACKS: u32 = 30;

            #[cfg(not(target_os = "windows"))]
            const SYNC_THRESHOLD_SECS: f64 = 0.08;

            #[cfg(target_os = "windows")]
            let mut callbacks_since_last_sync: u32 = MIN_SYNC_INTERVAL_CALLBACKS;

            let stream_result = device.build_output_stream(
                &config,
                move |buffer: &mut [T], info| {
                    #[cfg(not(target_os = "windows"))]
                    let latency_secs = latency_corrector.update_from_callback(info);
                    #[cfg(target_os = "windows")]
                    let _ = (info, &latency_corrector);

                    let project = project_for_stream.borrow();

                    #[cfg(target_os = "windows")]
                    {
                        callbacks_since_last_sync = callbacks_since_last_sync.saturating_add(1);
                    }

                    if playhead_rx_for_stream.has_changed().unwrap_or(false) {
                        let video_playhead = *playhead_rx_for_stream.borrow_and_update();

                        #[cfg(target_os = "windows")]
                        {
                            let jump = (video_playhead - last_video_playhead).abs();
                            let audio_playhead = audio_renderer
                                .current_audible_playhead(device_sample_rate, FIXED_LATENCY_SECS);
                            let drift = (video_playhead - audio_playhead).abs();

                            if jump > HARD_SEEK_THRESHOLD_SECS {
                                audio_renderer.set_playhead(
                                    video_playhead + initial_compensation_secs,
                                    &project,
                                );
                                callbacks_since_last_sync = 0;
                            } else if drift > SYNC_THRESHOLD_SECS
                                && callbacks_since_last_sync >= MIN_SYNC_INTERVAL_CALLBACKS
                            {
                                audio_renderer.set_playhead_smooth(
                                    video_playhead + initial_compensation_secs,
                                    &project,
                                );
                                callbacks_since_last_sync = 0;
                            }
                        }

                        #[cfg(not(target_os = "windows"))]
                        {
                            let audio_playhead = audio_renderer
                                .current_audible_playhead(device_sample_rate, latency_secs);
                            let drift = (video_playhead - audio_playhead).abs();

                            if drift > SYNC_THRESHOLD_SECS
                                || (video_playhead - last_video_playhead).abs()
                                    > SYNC_THRESHOLD_SECS
                            {
                                audio_renderer.set_playhead(
                                    video_playhead + initial_compensation_secs,
                                    &project,
                                );
                            }
                        }

                        last_video_playhead = video_playhead;
                    }

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

    fn create_stream_prerendered<T>(
        self,
        device: cpal::Device,
        supported_config: cpal::SupportedStreamConfig,
        duration_secs: f64,
    ) -> Result<(watch::Receiver<bool>, cpal::Stream), MediaError>
    where
        T: FromSampleBytes + cpal::Sample,
    {
        use crate::audio::PrerenderedAudioBuffer;

        let AudioPlayback {
            stop_rx,
            start_frame_number,
            project,
            segments,
            fps,
            playhead_rx,
            ..
        } = self;

        let mut output_info = AudioInfo::from_stream_config(&supported_config);
        output_info.sample_format = output_info.sample_format.packed();
        // Clamp output info for FFmpeg compatibility (max 8 channels)
        output_info = output_info.for_ffmpeg_output();

        let mut config = supported_config.config();
        // Match stream config channels to clamped output info
        config.channels = output_info.channels as u16;

        let sample_rate = output_info.sample_rate;

        let playhead = f64::from(start_frame_number) / f64::from(fps);

        info!(
            duration_secs = duration_secs,
            start_playhead = playhead,
            sample_rate = sample_rate,
            "Creating pre-rendered audio stream"
        );

        let project_snapshot = project.borrow().clone();
        let mut audio_buffer = PrerenderedAudioBuffer::<T>::new(
            segments,
            &project_snapshot,
            output_info,
            duration_secs,
        );

        audio_buffer.set_playhead(playhead);

        let mut playhead_rx_for_stream = playhead_rx.clone();
        let mut last_video_playhead = playhead;

        let stream = device
            .build_output_stream(
                &config,
                move |buffer: &mut [T], _info| {
                    if playhead_rx_for_stream.has_changed().unwrap_or(false) {
                        let video_playhead = *playhead_rx_for_stream.borrow_and_update();
                        let jump = (video_playhead - last_video_playhead).abs();

                        if jump > 0.05 {
                            audio_buffer.set_playhead(video_playhead);
                        }

                        last_video_playhead = video_playhead;
                    }

                    audio_buffer.fill(buffer);
                },
                |err| eprintln!("Audio stream error: {err}"),
                None,
            )
            .map_err(|e| MediaError::TaskLaunch(format!("Failed to build audio stream: {e}")))?;

        info!("Pre-rendered audio stream created successfully");

        Ok((stop_rx, stream))
    }
}
