use cap_audio::{
    FromSampleBytes, LatencyCorrectionConfig, LatencyCorrector, default_output_latency_hint,
};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_project::{ClipOffsets, ProjectConfiguration, XY};
use cap_rendering::{
    DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, ZoomFocusInterpolator,
    spring_mass_damper::SpringMassDamperSimulationConfig,
};
use cpal::{BufferSize, SupportedBufferSize};
use cpal::{
    SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use futures::stream::{FuturesUnordered, StreamExt};
use lru::LruCache;
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    num::NonZeroUsize,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc as tokio_mpsc, watch},
    time::Instant,
};
use tracing::{error, info, warn};

use crate::audio::AudioPlaybackBuffer;
use crate::{
    audio::AudioSegment, editor, editor_instance::SegmentMedia, segments::get_audio_segments,
};

const PREFETCH_BUFFER_SIZE: usize = 60;
const PARALLEL_DECODE_TASKS: usize = 4;
const FRAME_CACHE_SIZE: usize = 60;

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
    seek_tx: watch::Sender<u32>,
}

struct PrefetchedFrame {
    frame_number: u32,
    segment_frames: DecodedSegmentFrames,
    segment_index: u32,
    generation: u64,
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

    fn clear(&mut self) {
        self.cache.clear();
    }
}

fn trim_prefetch_buffer(buffer: &mut BTreeMap<u32, PrefetchedFrame>, current_frame: u32) -> bool {
    let mut changed = false;
    while buffer.len() > PREFETCH_BUFFER_SIZE {
        let far_ahead_frame = buffer
            .iter()
            .rev()
            .find(|(frame, _)| **frame > current_frame.saturating_add(PREFETCH_BUFFER_SIZE as u32))
            .map(|(frame, _)| *frame);

        if let Some(frame) = far_ahead_frame {
            buffer.remove(&frame);
            changed = true;
            continue;
        }

        let Some(oldest_frame) = buffer.keys().next().copied() else {
            break;
        };
        buffer.remove(&oldest_frame);
        changed = true;
    }
    changed
}

fn insert_prefetched_frame(
    buffer: &mut BTreeMap<u32, PrefetchedFrame>,
    prefetched: PrefetchedFrame,
    current_frame: u32,
) -> bool {
    let inserted_new = insert_prefetched_frame_untrimmed(buffer, prefetched, current_frame);
    let trimmed = trim_prefetch_buffer(buffer, current_frame);
    inserted_new || trimmed
}

fn insert_prefetched_frame_untrimmed(
    buffer: &mut BTreeMap<u32, PrefetchedFrame>,
    prefetched: PrefetchedFrame,
    current_frame: u32,
) -> bool {
    if prefetched.frame_number < current_frame {
        return false;
    }

    let frame_number = prefetched.frame_number;
    let inserted_new = match buffer.entry(frame_number) {
        std::collections::btree_map::Entry::Vacant(entry) => {
            entry.insert(prefetched);
            true
        }
        std::collections::btree_map::Entry::Occupied(_) => false,
    };
    inserted_new
}

fn prune_prefetch_buffer_before_frame(
    buffer: &mut BTreeMap<u32, PrefetchedFrame>,
    current_frame: u32,
) {
    while let Some((frame, _)) = buffer.first_key_value() {
        if *frame >= current_frame {
            break;
        }
        buffer.pop_first();
    }
}

fn count_contiguous_prefetched_frames(
    buffer: &BTreeMap<u32, PrefetchedFrame>,
    start_frame: u32,
    limit: usize,
) -> usize {
    let mut contiguous = 0usize;
    let mut expected_frame = start_frame;
    for (frame, _) in buffer.range(start_frame..) {
        if *frame != expected_frame {
            break;
        }
        contiguous += 1;
        if contiguous >= limit {
            break;
        }
        expected_frame = expected_frame.saturating_add(1);
    }
    contiguous
}

fn build_clip_offsets_lookup(project: &ProjectConfiguration) -> HashMap<u32, ClipOffsets> {
    project
        .clips
        .iter()
        .map(|clip| (clip.index, clip.offsets))
        .collect()
}

fn send_watch_u32_if_changed(tx: &watch::Sender<u32>, value: u32) {
    let _ = tx.send_if_modified(|current| {
        if *current == value {
            false
        } else {
            *current = value;
            true
        }
    });
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
        let (seek_tx, mut seek_rx) = watch::channel(self.start_frame_number);
        seek_rx.borrow_and_update();

        let handle = PlaybackHandle {
            stop_tx: stop_tx.clone(),
            event_rx,
            seek_tx,
        };

        let (prefetch_tx, mut prefetch_rx) =
            tokio_mpsc::channel::<PrefetchedFrame>(PREFETCH_BUFFER_SIZE * 2);
        let (frame_request_tx, mut frame_request_rx) = watch::channel(self.start_frame_number);
        let (playback_position_tx, playback_position_rx) = watch::channel(self.start_frame_number);
        let (seek_generation_tx, mut seek_generation_rx) = watch::channel(0u64);
        seek_generation_rx.borrow_and_update();

        let prefetch_in_flight_frames: Arc<RwLock<HashSet<(u64, u32)>>> =
            Arc::new(RwLock::new(HashSet::new()));
        let prefetch_in_flight = prefetch_in_flight_frames.clone();
        let playback_prefetch_in_flight = prefetch_in_flight_frames;
        let playback_decode_in_flight: Arc<RwLock<HashSet<(u64, u32)>>> =
            Arc::new(RwLock::new(HashSet::new()));

        let prefetch_stop_rx = stop_rx.clone();
        let mut prefetch_project = self.project.clone();
        let mut prefetch_seek_generation = seek_generation_rx.clone();
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
                    dyn std::future::Future<Output = (u32, u32, u64, Option<DecodedSegmentFrames>)>
                        + Send,
                >,
            >;
            let mut next_prefetch_frame = *frame_request_rx.borrow();
            let mut in_flight: FuturesUnordered<PrefetchFuture> = FuturesUnordered::new();
            let mut frames_decoded: u32 = 0;
            let mut prefetched_behind: HashSet<u32> = HashSet::new();
            let mut prefetched_behind_order: VecDeque<u32> = VecDeque::new();
            let mut scheduled_in_flight_frames: HashSet<u32> = HashSet::new();
            let mut last_behind_scan_frame: Option<u32> = None;
            const RAMP_UP_AFTER_FRAMES: u32 = 5;
            let dynamic_prefetch_ahead = fps.clamp(30, 90).min(PREFETCH_BUFFER_SIZE as u32);
            let dynamic_prefetch_behind = (fps / 4).clamp(8, 24);
            let dynamic_parallel_tasks = if fps >= 60 {
                6
            } else if fps >= 45 {
                5
            } else {
                PARALLEL_DECODE_TASKS
            };
            let initial_parallel_tasks = dynamic_parallel_tasks.min(4);
            let prefetch_idle_poll_interval = Duration::from_secs_f64(1.0 / fps_f64)
                .mul_f64(0.25)
                .max(Duration::from_millis(2))
                .min(Duration::from_millis(8));
            let prefetched_behind_capacity = (dynamic_prefetch_behind as usize).saturating_mul(8);
            let mut active_generation = *prefetch_seek_generation.borrow();

            let mut cached_project = prefetch_project.borrow().clone();
            let mut prefetch_clip_offsets = build_clip_offsets_lookup(&cached_project);
            info!(
                dynamic_prefetch_ahead,
                dynamic_prefetch_behind,
                dynamic_parallel_tasks,
                prefetch_idle_poll_interval_ms = prefetch_idle_poll_interval.as_secs_f64() * 1000.0,
                "Prefetch window configuration"
            );

            loop {
                if *prefetch_stop_rx.borrow() {
                    break;
                }

                if prefetch_project.has_changed().unwrap_or(false) {
                    cached_project = prefetch_project.borrow_and_update().clone();
                    prefetch_clip_offsets = build_clip_offsets_lookup(&cached_project);
                }

                if prefetch_seek_generation.has_changed().unwrap_or(false) {
                    let generation = *prefetch_seek_generation.borrow_and_update();
                    if generation != active_generation {
                        active_generation = generation;
                        next_prefetch_frame = *frame_request_rx.borrow();
                        frames_decoded = 0;
                        prefetched_behind.clear();
                        prefetched_behind_order.clear();
                        last_behind_scan_frame = None;

                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.clear();
                        }
                        scheduled_in_flight_frames.clear();

                        in_flight = FuturesUnordered::new();
                    }
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

                        if is_backward_seek || seek_distance > dynamic_prefetch_ahead / 2 {
                            frames_decoded = 0;
                            prefetched_behind.clear();
                            prefetched_behind_order.clear();
                            last_behind_scan_frame = None;
                            if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                                in_flight_guard.clear();
                            }
                            scheduled_in_flight_frames.clear();
                            in_flight = FuturesUnordered::new();
                        }
                    }
                }

                let current_playback_frame = *playback_position_rx.borrow();
                let max_prefetch_frame = current_playback_frame + dynamic_prefetch_ahead;

                let effective_parallel = if frames_decoded < RAMP_UP_AFTER_FRAMES {
                    initial_parallel_tasks
                } else {
                    dynamic_parallel_tasks
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

                    if scheduled_in_flight_frames.contains(&frame_num) {
                        next_prefetch_frame += 1;
                        continue;
                    }

                    if let Some((segment_time, segment)) =
                        cached_project.get_segment_time(prefetch_time)
                        && let Some(segment_media) =
                            prefetch_segment_medias.get(segment.recording_clip as usize)
                    {
                        let clip_offsets = prefetch_clip_offsets
                            .get(&segment.recording_clip)
                            .copied()
                            .unwrap_or_default();

                        let decoders = segment_media.decoders.clone();
                        let hide_camera = cached_project.camera.hide;
                        let segment_index = segment.recording_clip;
                        let is_initial = frames_decoded < 10;
                        let generation = active_generation;

                        scheduled_in_flight_frames.insert(frame_num);
                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.insert((generation, frame_num));
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
                            (frame_num, segment_index, generation, result)
                        }));
                    }

                    next_prefetch_frame += 1;
                }

                if in_flight.len() < effective_parallel
                    && last_behind_scan_frame != Some(current_playback_frame)
                {
                    last_behind_scan_frame = Some(current_playback_frame);
                    for behind_offset in 1..=dynamic_prefetch_behind {
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

                        if scheduled_in_flight_frames.contains(&behind_frame) {
                            continue;
                        }

                        if let Some((segment_time, segment)) =
                            cached_project.get_segment_time(prefetch_time)
                            && let Some(segment_media) =
                                prefetch_segment_medias.get(segment.recording_clip as usize)
                        {
                            let clip_offsets = prefetch_clip_offsets
                                .get(&segment.recording_clip)
                                .copied()
                                .unwrap_or_default();

                            let decoders = segment_media.decoders.clone();
                            let hide_camera = cached_project.camera.hide;
                            let segment_index = segment.recording_clip;
                            let generation = active_generation;

                            scheduled_in_flight_frames.insert(behind_frame);
                            if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                                in_flight_guard.insert((generation, behind_frame));
                            }

                            if prefetched_behind.insert(behind_frame) {
                                prefetched_behind_order.push_back(behind_frame);
                                while prefetched_behind_order.len() > prefetched_behind_capacity {
                                    if let Some(evicted) = prefetched_behind_order.pop_front() {
                                        prefetched_behind.remove(&evicted);
                                    }
                                }
                            }
                            in_flight.push(Box::pin(async move {
                                let result = decoders
                                    .get_frames(segment_time as f32, !hide_camera, clip_offsets)
                                    .await;
                                (behind_frame, segment_index, generation, result)
                            }));
                        }
                    }
                }

                tokio::select! {
                    biased;

                    Some((frame_num, segment_index, generation, result)) = in_flight.next() => {
                        scheduled_in_flight_frames.remove(&frame_num);
                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.remove(&(generation, frame_num));
                        }

                        if generation != active_generation {
                            continue;
                        }

                        frames_decoded = frames_decoded.saturating_add(1);

                        if let Some(segment_frames) = result {
                            let _ = prefetch_tx.send(PrefetchedFrame {
                                frame_number: frame_num,
                                segment_frames,
                                segment_index,
                                generation,
                            }).await;
                        } else if frames_decoded <= 5 {
                            warn!(
                                frame = frame_num,
                                segment = segment_index,
                                "Prefetch: decoder returned no frames"
                            );
                        }
                    }

                    _ = tokio::time::sleep(prefetch_idle_poll_interval), if in_flight.is_empty() => {}
                }
            }
        });

        tokio::spawn(async move {
            let playback_task_start = Instant::now();
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
            let frame_fetch_timeout = frame_duration
                .mul_f64(4.0)
                .max(Duration::from_millis(20))
                .min(Duration::from_millis(80));
            let in_flight_poll_interval = frame_duration
                .mul_f64(0.25)
                .max(Duration::from_millis(1))
                .min(Duration::from_millis(4));
            let mut frame_number = self.start_frame_number;
            let mut prefetch_buffer: BTreeMap<u32, PrefetchedFrame> = BTreeMap::new();
            let mut frame_cache = FrameCache::new(FRAME_CACHE_SIZE);
            let mut seek_generation = 0u64;
            let base_skip_threshold = (fps / 6).clamp(6, 16);
            let mut late_streak = 0u32;
            let mut skip_events = 0u64;

            let mut total_frames_rendered = 0u64;
            let mut total_frames_skipped = 0u64;
            let mut first_render_logged = false;
            let mut pending_seek_observation: Option<(u32, Instant)> = None;

            let warmup_target_frames = (fps.saturating_div(4)).clamp(8, 16) as usize;
            let warmup_after_first_timeout = frame_duration
                .mul_f64((warmup_target_frames as f64) * 2.0)
                .max(Duration::from_millis(200))
                .min(Duration::from_millis(700));
            let warmup_no_frames_timeout = Duration::from_secs(5);
            let warmup_idle_poll_interval = frame_duration
                .mul_f64(0.5)
                .max(Duration::from_millis(8))
                .min(Duration::from_millis(25));
            let mut warmup_start = Instant::now();
            let mut first_frame_time: Option<Instant> = None;
            let mut warmup_contiguous_prefetched = 0usize;
            let mut warmup_buffer_changed = false;
            info!(
                warmup_target_frames,
                warmup_after_first_timeout_ms = warmup_after_first_timeout.as_secs_f64() * 1000.0,
                warmup_idle_poll_interval_ms = warmup_idle_poll_interval.as_secs_f64() * 1000.0,
                "Playback warmup configuration"
            );

            while !*stop_rx.borrow() {
                if first_frame_time.is_some() && warmup_buffer_changed {
                    warmup_contiguous_prefetched = count_contiguous_prefetched_frames(
                        &prefetch_buffer,
                        frame_number,
                        warmup_target_frames,
                    );
                    warmup_buffer_changed = false;
                }
                let contiguous_prefetched = if first_frame_time.is_some() {
                    warmup_contiguous_prefetched
                } else {
                    0
                };
                let should_start = if let Some(first_time) = first_frame_time {
                    contiguous_prefetched >= warmup_target_frames
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
                        let mut next_prefetched = Some(prefetched);
                        let mut prefetched_batch_changed = false;

                        loop {
                            let Some(prefetched) = next_prefetched.take() else {
                                break;
                            };

                            if prefetched.generation == seek_generation
                                && insert_prefetched_frame_untrimmed(
                                    &mut prefetch_buffer,
                                    prefetched,
                                    frame_number,
                                )
                            {
                                prefetched_batch_changed = true;
                            }

                            next_prefetched = prefetch_rx.try_recv().ok();
                        }

                        if trim_prefetch_buffer(&mut prefetch_buffer, frame_number) {
                            prefetched_batch_changed = true;
                        }

                        if prefetched_batch_changed {
                            warmup_buffer_changed = true;
                        }

                        if first_frame_time.is_none() && !prefetch_buffer.is_empty() {
                            first_frame_time = Some(Instant::now());
                        }
                    }
                    _ = seek_rx.changed() => {
                        let seek_frame = *seek_rx.borrow_and_update();
                        seek_generation = seek_generation.saturating_add(1);
                        frame_number = seek_frame;
                        prefetch_buffer.clear();
                        frame_cache.clear();
                        warmup_contiguous_prefetched = 0;
                        warmup_buffer_changed = false;
                        first_frame_time = None;
                        warmup_start = Instant::now();
                        let _ = seek_generation_tx.send(seek_generation);
                        send_watch_u32_if_changed(&frame_request_tx, frame_number);
                        send_watch_u32_if_changed(&playback_position_tx, frame_number);
                        if has_audio
                            && audio_playhead_tx
                                .send(frame_number as f64 / fps_f64)
                                .is_err()
                        {
                            break;
                        }
                    }
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(warmup_idle_poll_interval) => {
                    }
                }
            }

            let mut playback_anchor_start = Instant::now();
            let mut playback_anchor_frame = frame_number;
            let mut cached_project = self.project.borrow().clone();
            let mut playback_clip_offsets = build_clip_offsets_lookup(&cached_project);

            'playback: loop {
                if seek_rx.has_changed().unwrap_or(false) {
                    let seek_frame = *seek_rx.borrow_and_update();
                    seek_generation = seek_generation.saturating_add(1);
                    frame_number = seek_frame;
                    playback_anchor_start = Instant::now();
                    playback_anchor_frame = seek_frame;
                    pending_seek_observation = Some((seek_frame, Instant::now()));
                    prefetch_buffer.clear();
                    frame_cache.clear();
                    let _ = seek_generation_tx.send(seek_generation);
                    send_watch_u32_if_changed(&frame_request_tx, frame_number);
                    send_watch_u32_if_changed(&playback_position_tx, frame_number);
                    if has_audio
                        && audio_playhead_tx
                            .send(frame_number as f64 / fps_f64)
                            .is_err()
                    {
                        break 'playback;
                    }
                }

                if self.project.has_changed().unwrap_or(false) {
                    cached_project = self.project.borrow_and_update().clone();
                    playback_clip_offsets = build_clip_offsets_lookup(&cached_project);
                }
                let mut drained_prefetch_changed = false;
                while let Ok(prefetched) = prefetch_rx.try_recv() {
                    if prefetched.generation == seek_generation {
                        if insert_prefetched_frame_untrimmed(
                            &mut prefetch_buffer,
                            prefetched,
                            frame_number,
                        ) {
                            drained_prefetch_changed = true;
                        }
                    }
                }
                if drained_prefetch_changed {
                    let _ = trim_prefetch_buffer(&mut prefetch_buffer, frame_number);
                }
                prune_prefetch_buffer_before_frame(&mut prefetch_buffer, frame_number);

                let frame_offset = frame_number.saturating_sub(playback_anchor_frame) as f64;
                let next_deadline = playback_anchor_start + frame_duration.mul_f64(frame_offset);

                tokio::select! {
                    _ = stop_rx.changed() => break 'playback,
                    _ = seek_rx.changed() => {
                        let seek_frame = *seek_rx.borrow_and_update();
                        seek_generation = seek_generation.saturating_add(1);
                        frame_number = seek_frame;
                        playback_anchor_start = Instant::now();
                        playback_anchor_frame = seek_frame;
                        pending_seek_observation = Some((seek_frame, Instant::now()));
                        prefetch_buffer.clear();
                        frame_cache.clear();
                        let _ = seek_generation_tx.send(seek_generation);
                        send_watch_u32_if_changed(&frame_request_tx, frame_number);
                        send_watch_u32_if_changed(&playback_position_tx, frame_number);
                        if has_audio
                            && audio_playhead_tx
                                .send(frame_number as f64 / fps_f64)
                                .is_err()
                        {
                            break 'playback;
                        }
                        continue;
                    }
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
                    Some(cached)
                } else {
                    if let Some(prefetched) = prefetch_buffer.remove(&frame_number) {
                        Some((
                            Arc::new(prefetched.segment_frames),
                            prefetched.segment_index,
                        ))
                    } else {
                        let in_flight_key = (seek_generation, frame_number);
                        let is_in_flight = playback_prefetch_in_flight
                            .read()
                            .map(|guard| guard.contains(&in_flight_key))
                            .unwrap_or(false)
                            || playback_decode_in_flight
                                .read()
                                .map(|guard| guard.contains(&in_flight_key))
                                .unwrap_or(false);

                        if is_in_flight {
                            let wait_start = Instant::now();
                            let max_wait = frame_fetch_timeout;
                            let mut found_frame = None;

                            while wait_start.elapsed() < max_wait {
                                tokio::select! {
                                    _ = stop_rx.changed() => break 'playback,
                                    Some(prefetched) = prefetch_rx.recv() => {
                                        if prefetched.generation != seek_generation {
                                            continue;
                                        }
                                        if prefetched.frame_number == frame_number {
                                            found_frame = Some(prefetched);
                                            break;
                                        } else if prefetched.frame_number >= frame_number {
                                            let _ = insert_prefetched_frame(
                                                &mut prefetch_buffer,
                                                prefetched,
                                                frame_number,
                                            );
                                        }
                                    }
                                    _ = tokio::time::sleep(in_flight_poll_interval) => {
                                        if seek_rx.has_changed().unwrap_or(false) {
                                            break;
                                        }
                                        let still_in_flight = playback_prefetch_in_flight
                                            .read()
                                            .map(|guard| guard.contains(&in_flight_key))
                                            .unwrap_or(false)
                                            || playback_decode_in_flight
                                                .read()
                                                .map(|guard| guard.contains(&in_flight_key))
                                                .unwrap_or(false);
                                        if !still_in_flight {
                                            break;
                                        }
                                    }
                                }
                            }

                            if seek_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

                            if let Some(prefetched) = found_frame {
                                Some((
                                    Arc::new(prefetched.segment_frames),
                                    prefetched.segment_index,
                                ))
                            } else {
                                if let Some(prefetched) = prefetch_buffer.remove(&frame_number) {
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
                            if seek_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

                            send_watch_u32_if_changed(&frame_request_tx, frame_number);

                            let wait_result =
                                tokio::time::timeout(frame_fetch_timeout, prefetch_rx.recv()).await;

                            if seek_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

                            if let Ok(Some(prefetched)) = wait_result {
                                if prefetched.generation != seek_generation {
                                    frame_number = frame_number.saturating_add(1);
                                    total_frames_skipped += 1;
                                    continue;
                                }
                                if prefetched.frame_number == frame_number {
                                    Some((
                                        Arc::new(prefetched.segment_frames),
                                        prefetched.segment_index,
                                    ))
                                } else {
                                    let _ = insert_prefetched_frame(
                                        &mut prefetch_buffer,
                                        prefetched,
                                        frame_number,
                                    );
                                    frame_number = frame_number.saturating_add(1);
                                    total_frames_skipped += 1;
                                    continue;
                                }
                            } else {
                                if seek_rx.has_changed().unwrap_or(false) {
                                    continue;
                                }
                                frame_number = frame_number.saturating_add(1);
                                total_frames_skipped += 1;
                                continue;
                            }
                        } else {
                            if seek_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

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

                            let clip_offsets = playback_clip_offsets
                                .get(&segment.recording_clip)
                                .copied()
                                .unwrap_or_default();

                            if let Ok(mut guard) = playback_decode_in_flight.write() {
                                guard.insert(in_flight_key);
                            }

                            let max_wait = frame_fetch_timeout;
                            let data = tokio::select! {
                                _ = stop_rx.changed() => {
                                    if let Ok(mut guard) = playback_decode_in_flight.write() {
                                        guard.remove(&in_flight_key);
                                    }
                                    break 'playback
                                },
                                _ = tokio::time::sleep(max_wait) => {
                                    if let Ok(mut guard) = playback_decode_in_flight.write() {
                                        guard.remove(&in_flight_key);
                                    }
                                    frame_number = frame_number.saturating_add(1);
                                    total_frames_skipped += 1;
                                    continue;
                                },
                                data = segment_media
                                    .decoders
                                    .get_frames(segment_time as f32, !cached_project.camera.hide, clip_offsets) => {
                                    if let Ok(mut guard) = playback_decode_in_flight.write() {
                                        guard.remove(&in_flight_key);
                                    }
                                    data
                                },
                            };

                            if seek_rx.has_changed().unwrap_or(false) {
                                continue;
                            }

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

                    let zoom_focus_interpolator = ZoomFocusInterpolator::new(
                        &segment_media.cursor,
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
                    if !first_render_logged {
                        first_render_logged = true;
                        info!(
                            first_render_latency_ms =
                                playback_task_start.elapsed().as_secs_f64() * 1000.0,
                            "Playback rendered first frame"
                        );
                    }
                    if let Some((seek_target_frame, seek_started_at)) = pending_seek_observation
                        && frame_number >= seek_target_frame
                    {
                        info!(
                            seek_target_frame,
                            rendered_frame = frame_number,
                            seek_settle_ms = seek_started_at.elapsed().as_secs_f64() * 1000.0,
                            "Playback seek settled"
                        );
                        pending_seek_observation = None;
                    }
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

                let expected_frame = playback_anchor_frame
                    + (playback_anchor_start.elapsed().as_secs_f64() * fps_f64).floor() as u32;

                if frame_number < expected_frame {
                    let frames_behind = expected_frame - frame_number;
                    late_streak = late_streak.saturating_add(1);
                    let threshold_reduction = (late_streak / 12).min(base_skip_threshold);
                    let dynamic_skip_threshold =
                        base_skip_threshold.saturating_sub(threshold_reduction);

                    if frames_behind <= dynamic_skip_threshold {
                        continue;
                    }

                    let skipped = frames_behind.saturating_sub(1);
                    if skipped > 0 {
                        frame_number += skipped;
                        total_frames_skipped += skipped as u64;
                        skip_events = skip_events.saturating_add(1);

                        prune_prefetch_buffer_before_frame(&mut prefetch_buffer, frame_number);
                        send_watch_u32_if_changed(&frame_request_tx, frame_number);
                        let _ = playback_position_tx.send(frame_number);
                        if has_audio
                            && audio_playhead_tx
                                .send(frame_number as f64 / fps_f64)
                                .is_err()
                        {
                            break 'playback;
                        }

                        if skipped >= fps.saturating_div(2) || skip_events % 120 == 0 {
                            info!(
                                skipped_frames = skipped,
                                frames_behind,
                                dynamic_skip_threshold,
                                late_streak,
                                total_frames_skipped,
                                skip_events,
                                "Playback applied frame skip catch-up"
                            );
                        }
                    }
                } else {
                    late_streak = 0;
                }
            }

            info!(
                total_frames_rendered,
                total_frames_skipped, skip_events, "Playback loop completed"
            );

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

    pub fn seek(&self, frame_number: u32) {
        let _ = self.seek_tx.send_if_modified(|current_frame| {
            if *current_frame == frame_number {
                false
            } else {
                *current_frame = frame_number;
                true
            }
        });
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
    fn use_prerendered_audio() -> bool {
        std::env::var("CAP_AUDIO_PRERENDER_PLAYBACK")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    fn spawn(self) -> bool {
        let handle = tokio::runtime::Handle::current();

        if self.segments.is_empty() || self.segments[0].tracks.is_empty() {
            info!("No audio segments found, skipping audio playback thread.");
            return false;
        }

        std::thread::spawn(move || {
            let audio_thread_start = Instant::now();
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

            let use_prerendered_audio = Self::use_prerendered_audio();
            let duration_secs = self.duration_secs;
            if use_prerendered_audio {
                info!("Using pre-rendered audio playback mode");
            } else {
                info!("Using low-latency streaming audio playback mode");
            }

            let result = match supported_config.sample_format() {
                SampleFormat::I16 => {
                    if use_prerendered_audio {
                        self.create_stream_prerendered::<i16>(
                            device,
                            supported_config,
                            duration_secs,
                        )
                    } else {
                        self.create_stream::<i16>(device, supported_config)
                    }
                }
                SampleFormat::I32 => {
                    if use_prerendered_audio {
                        self.create_stream_prerendered::<i32>(
                            device,
                            supported_config,
                            duration_secs,
                        )
                    } else {
                        self.create_stream::<i32>(device, supported_config)
                    }
                }
                SampleFormat::F32 => {
                    if use_prerendered_audio {
                        self.create_stream_prerendered::<f32>(
                            device,
                            supported_config,
                            duration_secs,
                        )
                    } else {
                        self.create_stream::<f32>(device, supported_config)
                    }
                }
                SampleFormat::I64 => {
                    if use_prerendered_audio {
                        self.create_stream_prerendered::<i64>(
                            device,
                            supported_config,
                            duration_secs,
                        )
                    } else {
                        self.create_stream::<i64>(device, supported_config)
                    }
                }
                SampleFormat::U8 => {
                    if use_prerendered_audio {
                        self.create_stream_prerendered::<u8>(
                            device,
                            supported_config,
                            duration_secs,
                        )
                    } else {
                        self.create_stream::<u8>(device, supported_config)
                    }
                }
                SampleFormat::F64 => {
                    if use_prerendered_audio {
                        self.create_stream_prerendered::<f64>(
                            device,
                            supported_config,
                            duration_secs,
                        )
                    } else {
                        self.create_stream::<f64>(device, supported_config)
                    }
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

            info!(
                startup_prepare_ms = audio_thread_start.elapsed().as_secs_f64() * 1000.0,
                "Audio stream prepared, starting playback stream"
            );
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
            let stream_build_start = Instant::now();
            let callback_started = Arc::new(AtomicBool::new(false));

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
            let callback_started_for_stream = callback_started.clone();

            #[cfg(target_os = "windows")]
            const FIXED_LATENCY_SECS: f64 = 0.08;
            #[cfg(target_os = "windows")]
            const SYNC_THRESHOLD_SECS: f64 = 0.20;
            #[cfg(target_os = "windows")]
            const HARD_SEEK_THRESHOLD_SECS: f64 = 0.5;
            #[cfg(target_os = "windows")]
            const MIN_SYNC_INTERVAL_CALLBACKS: u32 = 50;

            #[cfg(not(target_os = "windows"))]
            const SYNC_THRESHOLD_SECS: f64 = 0.12;

            #[cfg(target_os = "windows")]
            let mut callbacks_since_last_sync: u32 = MIN_SYNC_INTERVAL_CALLBACKS;

            let stream_result = device.build_output_stream(
                &config,
                move |buffer: &mut [T], info| {
                    if !callback_started_for_stream.swap(true, Ordering::Relaxed) {
                        info!(
                            startup_to_callback_ms =
                                stream_build_start.elapsed().as_secs_f64() * 1000.0,
                            "Audio output callback started"
                        );
                    }
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

                        if jump > 0.1 {
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
