use cap_project::{
    ClipOffsets, ClipTransitionType, ProjectConfiguration, TimelineFrameMapping, XY,
};
use cap_rendering::{
    DecodedSegmentFrames, PrecomputedCursorTimeline, ProjectUniforms, RecordingSegmentDecoders,
    RenderVideoConstants, ZoomTransformTimeline,
    spring_mass_damper::SpringMassDamperSimulationConfig,
};
use futures::stream::{FuturesUnordered, StreamExt};
use lru::LruCache;
use std::{
    collections::{HashSet, VecDeque},
    num::NonZeroUsize,
    sync::{Arc, RwLock, mpsc as std_mpsc},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tracing::{info, warn};

use crate::{
    audio_output::{AudioOutput, PlaySpec},
    editor,
    editor_instance::SegmentMedia,
    segments::get_audio_segments,
    telemetry::{
        PlaybackFrameSource, PlaybackSkipReason, PlaybackTelemetry, PlaybackTelemetryEvent,
    },
};

const PREFETCH_BUFFER_SIZE: usize = 90;
const PARALLEL_DECODE_TASKS: usize = 4;
const INITIAL_PARALLEL_DECODE_TASKS: usize = 4;
const MAX_PREFETCH_AHEAD: u32 = 90;
const FRAME_CACHE_SIZE: usize = 90;
const RAMP_UP_FRAME_COUNT: u32 = 15;

#[cfg(target_os = "windows")]
struct WindowsTimerResolution;

#[cfg(target_os = "windows")]
impl WindowsTimerResolution {
    fn set_high_precision() -> Self {
        unsafe {
            windows::Win32::Media::timeBeginPeriod(1);
        }
        Self
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsTimerResolution {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::Media::timeEndPeriod(1);
        }
    }
}

fn precision_sleep_sync(deadline: Instant) {
    let now = Instant::now();
    if now >= deadline {
        return;
    }

    let remaining = deadline.saturating_duration_since(now);

    #[cfg(target_os = "windows")]
    {
        let spin_threshold = Duration::from_millis(2);
        if remaining > spin_threshold {
            std::thread::sleep(remaining.saturating_sub(spin_threshold));
        }
        while Instant::now() < deadline {
            std::hint::spin_loop();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::thread::sleep(remaining);
    }
}

fn valid_playback_duration(duration: f64) -> Option<f64> {
    (duration.is_finite() && duration > 0.0).then_some(duration)
}

fn has_playback_audio(audio_segments: &[crate::audio::AudioSegment], has_music: bool) -> bool {
    has_music
        || audio_segments
            .iter()
            .any(|segment| !segment.tracks.is_empty())
}

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
    pub music: crate::audio::MusicTracks,
    pub audio_output: Arc<AudioOutput>,
    pub telemetry: Option<PlaybackTelemetry>,
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
    transition: Option<PrefetchedTransition>,
}

struct PrefetchedTransition {
    segment_frames: DecodedSegmentFrames,
    segment_index: u32,
    kind: ClipTransitionType,
    progress: f32,
}

impl PrefetchedFrame {
    fn into_cached(self) -> CachedFrame {
        (
            Arc::new(self.segment_frames),
            self.segment_index,
            self.transition.map(|transition| {
                (
                    Arc::new(transition.segment_frames),
                    transition.segment_index,
                    transition.kind,
                    transition.progress,
                )
            }),
        )
    }
}

type CachedTransition = (Arc<DecodedSegmentFrames>, u32, ClipTransitionType, f32);
type CachedFrame = (Arc<DecodedSegmentFrames>, u32, Option<CachedTransition>);

struct FrameCache {
    cache: LruCache<u32, CachedFrame>,
}

impl FrameCache {
    fn new(capacity: usize) -> Self {
        Self {
            cache: LruCache::new(NonZeroUsize::new(capacity).unwrap()),
        }
    }

    fn get(&mut self, frame_number: u32) -> Option<CachedFrame> {
        self.cache
            .get(&frame_number)
            .map(|(frames, segment_index, transition)| {
                (
                    Arc::clone(frames),
                    *segment_index,
                    transition.as_ref().map(
                        |(transition_frames, transition_index, kind, progress)| {
                            (
                                Arc::clone(transition_frames),
                                *transition_index,
                                *kind,
                                *progress,
                            )
                        },
                    ),
                )
            })
    }

    fn insert(
        &mut self,
        frame_number: u32,
        segment_frames: Arc<DecodedSegmentFrames>,
        segment_index: u32,
        transition: Option<CachedTransition>,
    ) {
        self.cache
            .put(frame_number, (segment_frames, segment_index, transition));
    }

    fn evict_far_from(&mut self, current_frame: u32, max_distance: u32) {
        let keys_to_remove: Vec<u32> = self
            .cache
            .iter()
            .filter_map(|(k, _)| {
                if (*k).abs_diff(current_frame) > max_distance {
                    Some(*k)
                } else {
                    None
                }
            })
            .collect();

        for key in keys_to_remove {
            self.cache.pop(&key);
        }
    }
}

struct TransitionDecodeRequest {
    decoders: RecordingSegmentDecoders,
    segment_time: f64,
    segment_index: u32,
    offsets: ClipOffsets,
    kind: ClipTransitionType,
    progress: f32,
}

struct PrefetchDecodeRequest {
    frame_number: u32,
    decoders: RecordingSegmentDecoders,
    segment_time: f64,
    segment_index: u32,
    offsets: ClipOffsets,
    hide_camera: bool,
    is_initial: bool,
    transition: Option<TransitionDecodeRequest>,
}

type PrefetchDecodeResult = (
    u32,
    u32,
    Option<DecodedSegmentFrames>,
    Option<PrefetchedTransition>,
);

async fn decode_prefetched_frame(request: PrefetchDecodeRequest) -> PrefetchDecodeResult {
    let PrefetchDecodeRequest {
        frame_number,
        decoders,
        segment_time,
        segment_index,
        offsets,
        hide_camera,
        is_initial,
        transition,
    } = request;
    let primary = async {
        if is_initial {
            decoders
                .get_frames_initial(segment_time as f32, !hide_camera, true, offsets)
                .await
        } else {
            decoders
                .get_frames(segment_time as f32, !hide_camera, true, offsets)
                .await
        }
    };
    let transition = async {
        let transition = transition?;
        let segment_frames = if is_initial {
            transition
                .decoders
                .get_frames_initial(
                    transition.segment_time as f32,
                    !hide_camera,
                    true,
                    transition.offsets,
                )
                .await
        } else {
            transition
                .decoders
                .get_frames(
                    transition.segment_time as f32,
                    !hide_camera,
                    true,
                    transition.offsets,
                )
                .await
        }?;
        Some(PrefetchedTransition {
            segment_frames,
            segment_index: transition.segment_index,
            kind: transition.kind,
            progress: transition.progress,
        })
    };
    let (segment_frames, transition) = tokio::join!(primary, transition);

    (frame_number, segment_index, segment_frames, transition)
}

fn transition_decode_request(
    project: &ProjectConfiguration,
    segment_medias: &[SegmentMedia],
    frame_time: f64,
) -> Option<TransitionDecodeRequest> {
    let timeline = project.timeline.as_ref()?;
    if timeline.transitions.is_empty() {
        return None;
    }
    let TimelineFrameMapping::Transition {
        outgoing,
        kind,
        progress,
        ..
    } = timeline.get_frame_mapping(frame_time)?
    else {
        return None;
    };
    let segment_media = segment_medias.get(outgoing.segment.recording_clip as usize)?;
    let offsets = project
        .clips
        .iter()
        .find(|clip| clip.index == outgoing.segment.recording_clip)
        .map(|clip| clip.offsets)
        .unwrap_or_default();

    Some(TransitionDecodeRequest {
        decoders: segment_media.decoders.clone(),
        segment_time: outgoing.source_time,
        segment_index: outgoing.segment.recording_clip,
        offsets,
        kind,
        progress: progress as f32,
    })
}

impl Playback {
    pub async fn start(
        mut self,
        fps: u32,
        resolution_base: XY<u32>,
    ) -> Result<PlaybackHandle, PlaybackStartError> {
        let start_call = Instant::now();
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

        let (prefetch_tx, prefetch_rx) = std_mpsc::channel::<PrefetchedFrame>();
        let (frame_request_tx, mut frame_request_rx) = watch::channel(self.start_frame_number);
        let (playback_position_tx, playback_position_rx) = watch::channel(self.start_frame_number);

        let output_size = ProjectUniforms::get_output_size(
            &self.render_constants.options,
            &self.project.borrow(),
            resolution_base,
        );
        self.renderer
            .prepare_output_size(output_size.0, output_size.1);

        let in_flight_frames: Arc<RwLock<HashSet<u32>>> = Arc::new(RwLock::new(HashSet::new()));
        let prefetch_in_flight = in_flight_frames.clone();
        let _main_in_flight = in_flight_frames;

        let prefetch_stop_rx = stop_rx.clone();
        let mut prefetch_project = self.project.clone();
        let prefetch_segment_medias = self.segment_medias.clone();
        let (prefetch_duration, has_timeline) = self
            .project
            .borrow()
            .timeline
            .as_ref()
            .and_then(|timeline| valid_playback_duration(timeline.duration()))
            .map(|duration| (duration, true))
            .unwrap_or((0.0, false));
        let segment_media_count = self.segment_medias.len();

        tokio::spawn(async move {
            if !has_timeline {
                warn!("Prefetch: No valid timeline duration found");
            }
            if segment_media_count == 0 {
                warn!("Prefetch: No segment media available");
            }
            type PrefetchFuture =
                std::pin::Pin<Box<dyn std::future::Future<Output = PrefetchDecodeResult> + Send>>;
            let mut next_prefetch_frame = *frame_request_rx.borrow();
            let mut in_flight: FuturesUnordered<PrefetchFuture> = FuturesUnordered::new();
            let mut frames_decoded: u32 = 0;
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

                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.clear();
                        }

                        if is_backward_seek || seek_distance > MAX_PREFETCH_AHEAD / 2 {
                            in_flight = FuturesUnordered::new();
                        }
                    }
                }

                let current_playback_frame = *playback_position_rx.borrow();
                let max_prefetch_ahead = MAX_PREFETCH_AHEAD;
                let max_prefetch_frame = current_playback_frame + max_prefetch_ahead;

                let initial_parallel_decode_tasks = INITIAL_PARALLEL_DECODE_TASKS;
                let parallel_decode_tasks = PARALLEL_DECODE_TASKS;

                let effective_parallel = if frames_decoded < RAMP_UP_FRAME_COUNT {
                    initial_parallel_decode_tasks
                } else {
                    parallel_decode_tasks
                };

                while in_flight.len() < effective_parallel {
                    let frame_num = next_prefetch_frame;

                    if frame_num > max_prefetch_frame {
                        break;
                    }

                    let prefetch_time = frame_num as f64 / fps_f64;

                    if prefetch_time >= prefetch_duration {
                        next_prefetch_frame = next_prefetch_frame.saturating_add(1);
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
                        let transition = transition_decode_request(
                            &cached_project,
                            &prefetch_segment_medias,
                            prefetch_time,
                        );

                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.insert(frame_num);
                        }

                        in_flight.push(Box::pin(decode_prefetched_frame(PrefetchDecodeRequest {
                            frame_number: frame_num,
                            decoders,
                            segment_time,
                            segment_index,
                            offsets: clip_offsets,
                            hide_camera,
                            is_initial,
                            transition,
                        })));
                    }

                    next_prefetch_frame += 1;
                }

                tokio::select! {
                    biased;

                    Some((frame_num, segment_index, result, transition)) = in_flight.next() => {
                        if let Ok(mut in_flight_guard) = prefetch_in_flight.write() {
                            in_flight_guard.remove(&frame_num);
                        }
                        frames_decoded = frames_decoded.saturating_add(1);

                        if let Some(segment_frames) = result {
                            let _ = prefetch_tx.send(PrefetchedFrame {
                                frame_number: frame_num,
                                segment_frames,
                                segment_index,
                                transition,
                            });
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

        // Resolve the background audio decodes before entering the sync
        // playback thread. This only waits when playback starts before the
        // decode kicked off at editor open has finished.
        let audio_wait_start = Instant::now();
        let audio_segments = get_audio_segments(&self.segment_medias).await;
        if let Some(telemetry) = &self.telemetry {
            telemetry.emit(PlaybackTelemetryEvent::AudioSegmentsResolved {
                elapsed: audio_wait_start.elapsed(),
            });
        }

        let playback_body = move || {
            let duration = self
                .project
                .borrow()
                .timeline
                .as_ref()
                .and_then(|timeline| valid_playback_duration(timeline.duration()));
            let Some(duration) = duration else {
                warn!("Playback: No valid timeline duration found");
                stop_tx.send(true).ok();
                event_tx.send(PlaybackEvent::Stop).ok();
                return;
            };

            let (audio_playhead_tx, audio_playhead_rx) =
                watch::channel(self.start_frame_number as f64 / fps as f64);

            let frame_duration = Duration::from_secs_f64(1.0 / fps_f64);
            let mut frame_number = self.start_frame_number;
            let mut prefetch_buffer: VecDeque<PrefetchedFrame> =
                VecDeque::with_capacity(PREFETCH_BUFFER_SIZE);
            let mut frame_cache = FrameCache::new(FRAME_CACHE_SIZE);

            let mut total_frames_rendered = 0u64;
            let mut total_frames_skipped = 0u64;
            let mut cache_hits = 0u64;
            let mut prefetch_hits = 0u64;
            let sync_decodes = 0u64;
            let mut last_stats_time = Instant::now();
            let stats_interval = Duration::from_secs(2);

            let is_mid_start = self.start_frame_number > 0;
            let warmup_target_frames = if is_mid_start { 30 } else { 10 };
            let warmup_after_first_timeout = if is_mid_start {
                Duration::from_millis(800)
            } else {
                Duration::from_millis(500)
            };
            let warmup_no_frames_timeout = Duration::from_secs(5);
            let warmup_start = Instant::now();
            let mut first_frame_time: Option<Instant> = None;

            while !*stop_rx.borrow() {
                let should_start = if let Some(first_time) = first_frame_time {
                    prefetch_buffer
                        .iter()
                        .any(|p| p.frame_number == frame_number)
                        || prefetch_buffer.len() >= warmup_target_frames
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

                match prefetch_rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(prefetched) => {
                        if prefetched.frame_number >= frame_number {
                            prefetch_buffer.push_back(prefetched);
                            if first_frame_time.is_none() {
                                first_frame_time = Some(Instant::now());
                            }
                        }
                        while prefetch_buffer.len() < warmup_target_frames {
                            match prefetch_rx.try_recv() {
                                Ok(p) => {
                                    if p.frame_number >= frame_number {
                                        prefetch_buffer.push_back(p);
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                    }
                    Err(std_mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }

            prefetch_buffer
                .make_contiguous()
                .sort_by_key(|p| p.frame_number);

            let mut cached_project = self.project.borrow().clone();

            let build_cursor_timelines =
                |project: &ProjectConfiguration| -> Vec<Arc<PrecomputedCursorTimeline>> {
                    let cursor_smoothing =
                        (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
                            tension: project.cursor.tension,
                            mass: project.cursor.mass,
                            friction: project.cursor.friction,
                        });
                    let click_spring = project.cursor.click_spring_config();
                    self.segment_medias
                        .iter()
                        .map(|seg| {
                            Arc::new(PrecomputedCursorTimeline::new(
                                &seg.cursor,
                                cursor_smoothing,
                                Some(click_spring),
                            ))
                        })
                        .collect()
                };

            let build_zoom_timelines =
                |project: &ProjectConfiguration| -> Vec<ZoomTransformTimeline> {
                    self.segment_medias
                        .iter()
                        .enumerate()
                        .map(|(recording_clip, seg)| {
                            ZoomTransformTimeline::from_project_for_clip(
                                project,
                                &seg.cursor,
                                duration,
                                self.render_constants.options.screen_size,
                                recording_clip as u32,
                            )
                        })
                        .collect()
                };
            let build_outgoing_zoom_timelines =
                |project: &ProjectConfiguration| -> Vec<ZoomTransformTimeline> {
                    if project
                        .timeline
                        .as_ref()
                        .is_none_or(|timeline| timeline.transitions.is_empty())
                    {
                        return Vec::new();
                    }
                    self.segment_medias
                        .iter()
                        .enumerate()
                        .map(|(recording_clip, segment)| {
                            ZoomTransformTimeline::from_project_for_outgoing_clip(
                                project,
                                &segment.cursor,
                                duration,
                                self.render_constants.options.screen_size,
                                recording_clip as u32,
                            )
                        })
                        .collect()
                };

            let mut cursor_timelines = build_cursor_timelines(&cached_project);
            let mut zoom_timelines = build_zoom_timelines(&cached_project);
            let mut outgoing_zoom_timelines = build_outgoing_zoom_timelines(&cached_project);

            if !*stop_rx.borrow()
                && let Some(prefetched_idx) = prefetch_buffer
                    .iter()
                    .position(|p| p.frame_number == frame_number)
            {
                let frame_acquire_start = Instant::now();
                let prefetched = prefetch_buffer.remove(prefetched_idx).unwrap();
                let frame_acquire_duration = frame_acquire_start.elapsed();
                let (segment_frames, segment_index, transition) = prefetched.into_cached();

                if let Some(segment_media) = self.segment_medias.get(segment_index as usize) {
                    let zoom_until = (frame_number as f32 + 1.0) / fps as f32;
                    if let Some(timeline) = zoom_timelines.get_mut(segment_index as usize) {
                        timeline.ensure_precomputed_until(zoom_until);
                    }
                    if let Some(timeline) = outgoing_zoom_timelines.get_mut(segment_index as usize)
                    {
                        timeline.ensure_precomputed_until(zoom_until);
                    }
                    let zoom_timeline = zoom_timelines.get(segment_index as usize);

                    let empty_timeline;
                    let zoom_ref = match zoom_timeline {
                        Some(timeline) => timeline,
                        None => {
                            empty_timeline = ZoomTransformTimeline::new(
                                &[],
                                None,
                                &segment_media.cursor,
                                cached_project.screen_movement_spring,
                                duration,
                                None,
                            );
                            &empty_timeline
                        }
                    };

                    let precomputed_cursor = &cursor_timelines[segment_index as usize];
                    let uniforms_start = Instant::now();
                    let uniforms = ProjectUniforms::new_with_precomputed_cursor(
                        &self.render_constants,
                        &cached_project,
                        frame_number,
                        fps,
                        resolution_base,
                        &segment_media.cursor,
                        &segment_frames,
                        duration,
                        zoom_ref,
                        precomputed_cursor,
                    );
                    let uniforms_duration = uniforms_start.elapsed();
                    let submit_start = Instant::now();
                    let submitted_frame_number = frame_number;
                    let rendered = if let Some((outgoing_frames, outgoing_index, kind, progress)) =
                        transition
                    {
                        let outgoing_media = &self.segment_medias[outgoing_index as usize];
                        if let Some(timeline) =
                            outgoing_zoom_timelines.get_mut(outgoing_index as usize)
                        {
                            timeline.ensure_precomputed_until(zoom_until);
                        }
                        let outgoing_zoom = &outgoing_zoom_timelines[outgoing_index as usize];
                        let outgoing_uniforms = ProjectUniforms::new_with_precomputed_cursor(
                            &self.render_constants,
                            &cached_project,
                            frame_number,
                            fps,
                            resolution_base,
                            &outgoing_media.cursor,
                            &outgoing_frames,
                            duration,
                            outgoing_zoom,
                            &cursor_timelines[outgoing_index as usize],
                        );
                        self.renderer.render_transition_frame_wait(
                            editor::RendererTransitionInput {
                                segment_frames: Arc::unwrap_or_clone(outgoing_frames),
                                uniforms: outgoing_uniforms,
                                cursor: outgoing_media.cursor.clone(),
                            },
                            editor::RendererTransitionInput {
                                segment_frames: Arc::unwrap_or_clone(segment_frames),
                                uniforms,
                                cursor: segment_media.cursor.clone(),
                            },
                            kind,
                            progress,
                        )
                    } else {
                        self.renderer.render_frame_wait(
                            Arc::unwrap_or_clone(segment_frames),
                            uniforms,
                            segment_media.cursor.clone(),
                        )
                    };
                    let submit_duration = submit_start.elapsed();

                    if rendered {
                        if let Some(telemetry) = &self.telemetry {
                            telemetry.emit(PlaybackTelemetryEvent::FrameSubmitted {
                                frame_number: submitted_frame_number,
                                source: PlaybackFrameSource::InitialPrerender,
                                schedule_overshoot: Duration::ZERO,
                                frame_acquire_duration,
                                uniforms_duration,
                                submit_duration,
                                prefetch_buffer_len: prefetch_buffer.len(),
                                total_frames_skipped,
                            });
                        }

                        total_frames_rendered += 1;
                        event_tx.send(PlaybackEvent::Frame(frame_number)).ok();
                        frame_number = frame_number.saturating_add(1);
                        let _ = playback_position_tx.send(frame_number);
                    }
                }
            }

            while prefetch_buffer.len() < warmup_target_frames {
                match prefetch_rx.try_recv() {
                    Ok(prefetched) => {
                        if prefetched.frame_number >= frame_number {
                            prefetch_buffer.push_back(prefetched);
                        }
                    }
                    Err(_) => break,
                }
            }
            prefetch_buffer
                .make_contiguous()
                .sort_by_key(|p| p.frame_number);

            if let Some(telemetry) = &self.telemetry {
                telemetry.emit(PlaybackTelemetryEvent::WarmupComplete {
                    elapsed: warmup_start.elapsed(),
                    buffered_frames: prefetch_buffer.len(),
                    target_frames: warmup_target_frames,
                    start_frame_number: self.start_frame_number,
                });
            }

            #[cfg(target_os = "windows")]
            let _timer_guard = WindowsTimerResolution::set_high_precision();

            // Attach this playback's audio to the session's persistent output
            // stream. Blocks until the live callback is consuming the source,
            // so the clock below never runs ahead of audible audio.
            let audio_spawn_start = Instant::now();
            let audio_generation = if !has_playback_audio(&audio_segments, !self.music.is_empty()) {
                info!("No audio segments found, skipping audio playback.");
                None
            } else {
                self.audio_output.play(PlaySpec {
                    segments: audio_segments,
                    music: self.music.clone(),
                    project: self.project.borrow().clone(),
                    duration_secs: duration,
                    start_playhead_secs: self.start_frame_number as f64 / fps_f64,
                    playhead_rx: audio_playhead_rx,
                })
            };
            let has_audio = audio_generation.is_some();
            if let Some(telemetry) = &self.telemetry {
                telemetry.emit(PlaybackTelemetryEvent::AudioPipelineReady {
                    elapsed: audio_spawn_start.elapsed(),
                    has_audio,
                });
                telemetry.emit(PlaybackTelemetryEvent::ClockStarted {
                    elapsed: start_call.elapsed(),
                });
            }
            let start = Instant::now();

            'playback: loop {
                if self.project.has_changed().unwrap_or(false) {
                    cached_project = self.project.borrow_and_update().clone();
                    cursor_timelines = build_cursor_timelines(&cached_project);
                    zoom_timelines = build_zoom_timelines(&cached_project);
                    outgoing_zoom_timelines = build_outgoing_zoom_timelines(&cached_project);
                }

                let frame_offset = frame_number.saturating_sub(self.start_frame_number) as f64;
                let next_deadline = start + frame_duration.mul_f64(frame_offset);

                precision_sleep_sync(next_deadline);

                if *stop_rx.borrow() {
                    break;
                }

                let overshoot = Instant::now().saturating_duration_since(next_deadline);
                if overshoot > frame_duration + frame_duration / 2 {
                    let frames_behind = (overshoot.as_secs_f64() * fps_f64).floor() as u32;
                    let skip = frames_behind.max(1);
                    let skipped_from = frame_number;
                    frame_number += skip;
                    total_frames_skipped += skip as u64;
                    while prefetch_buffer
                        .front()
                        .is_some_and(|f| f.frame_number < frame_number)
                    {
                        prefetch_buffer.pop_front();
                    }
                    frame_cache.evict_far_from(frame_number, MAX_PREFETCH_AHEAD);
                    let _ = frame_request_tx.send(frame_number);
                    let _ = playback_position_tx.send(frame_number);
                    if let Some(telemetry) = &self.telemetry {
                        telemetry.emit(PlaybackTelemetryEvent::FrameSkipped {
                            frame_number: skipped_from,
                            skipped: skip,
                            reason: PlaybackSkipReason::ScheduleOvershoot,
                            prefetch_buffer_len: prefetch_buffer.len(),
                        });
                    }
                    if has_audio
                        && audio_playhead_tx
                            .send(frame_number as f64 / fps_f64)
                            .is_err()
                    {
                        break 'playback;
                    }
                    continue;
                }

                prefetch_buffer.retain(|p| p.frame_number >= frame_number);
                let drain_budget = 16usize;
                let mut drained = 0usize;
                while prefetch_buffer.len() < PREFETCH_BUFFER_SIZE && drained < drain_budget {
                    match prefetch_rx.try_recv() {
                        Ok(prefetched) => {
                            drained += 1;
                            if prefetched.frame_number >= frame_number {
                                prefetch_buffer.push_back(prefetched);
                            }
                        }
                        Err(_) => break,
                    }
                }

                let playback_time = frame_number as f64 / fps_f64;
                if playback_time >= duration {
                    break;
                }

                let mut was_cached = false;
                let frame_acquire_start = Instant::now();
                let mut frame_source = PlaybackFrameSource::Cache;

                let segment_frames_opt = if let Some(cached) = frame_cache.get(frame_number) {
                    was_cached = true;
                    cache_hits += 1;
                    Some(cached)
                } else if prefetch_buffer
                    .front()
                    .is_some_and(|f| f.frame_number == frame_number)
                {
                    frame_source = PlaybackFrameSource::PrefetchFront;
                    let prefetched = prefetch_buffer.pop_front().unwrap();
                    prefetch_hits += 1;
                    Some(prefetched.into_cached())
                } else {
                    let prefetched_idx = prefetch_buffer
                        .iter()
                        .position(|p| p.frame_number == frame_number);

                    if let Some(idx) = prefetched_idx {
                        frame_source = PlaybackFrameSource::PrefetchSearch;
                        let prefetched = prefetch_buffer.remove(idx).unwrap();
                        prefetch_hits += 1;
                        Some(prefetched.into_cached())
                    } else if prefetch_buffer.is_empty() {
                        let _ = frame_request_tx.send(frame_number);

                        let wait_ms = if total_frames_rendered < 15 { 20 } else { 8 };
                        let prefetched_opt = match prefetch_rx
                            .recv_timeout(Duration::from_millis(wait_ms))
                        {
                            Ok(p) => Some(p),
                            Err(std_mpsc::RecvTimeoutError::Timeout) => prefetch_rx.try_recv().ok(),
                            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                                break 'playback;
                            }
                        };

                        match prefetched_opt {
                            Some(prefetched) => {
                                if prefetched.frame_number == frame_number {
                                    frame_source = PlaybackFrameSource::PrefetchWaitExact;
                                    Some(prefetched.into_cached())
                                } else if prefetched.frame_number > frame_number {
                                    frame_source = PlaybackFrameSource::PrefetchWaitFuture;
                                    let skipped_from = frame_number;
                                    frame_number = prefetched.frame_number;
                                    total_frames_skipped += 1;
                                    if let Some(telemetry) = &self.telemetry {
                                        telemetry.emit(PlaybackTelemetryEvent::FrameSkipped {
                                            frame_number: skipped_from,
                                            skipped: 1,
                                            reason: PlaybackSkipReason::PrefetchGap,
                                            prefetch_buffer_len: prefetch_buffer.len(),
                                        });
                                    }
                                    Some(prefetched.into_cached())
                                } else {
                                    prefetch_buffer.push_back(prefetched);
                                    let skipped_from = frame_number;
                                    frame_number = frame_number.saturating_add(1);
                                    total_frames_skipped += 1;
                                    if let Some(telemetry) = &self.telemetry {
                                        telemetry.emit(PlaybackTelemetryEvent::FrameSkipped {
                                            frame_number: skipped_from,
                                            skipped: 1,
                                            reason: PlaybackSkipReason::PrefetchBehind,
                                            prefetch_buffer_len: prefetch_buffer.len(),
                                        });
                                    }
                                    continue;
                                }
                            }
                            None => {
                                let skipped_from = frame_number;
                                frame_number = frame_number.saturating_add(1);
                                total_frames_skipped += 1;
                                let _ = frame_request_tx.send(frame_number);
                                let _ = playback_position_tx.send(frame_number);
                                if let Some(telemetry) = &self.telemetry {
                                    telemetry.emit(PlaybackTelemetryEvent::FrameSkipped {
                                        frame_number: skipped_from,
                                        skipped: 1,
                                        reason: PlaybackSkipReason::PrefetchTimeout,
                                        prefetch_buffer_len: prefetch_buffer.len(),
                                    });
                                }
                                if has_audio
                                    && audio_playhead_tx
                                        .send(frame_number as f64 / fps_f64)
                                        .is_err()
                                {
                                    break 'playback;
                                }
                                continue;
                            }
                        }
                    } else {
                        // IMPORTANT: Do NOT send frame_request_tx from these skip paths.
                        // frame_request_tx resets the prefetch pipeline's next_prefetch_frame
                        // via a watch channel. Since the prefetch is already decoding well ahead
                        // (e.g. next_prefetch_frame=119), sending a lower frame number here
                        // (e.g. 63) is interpreted as a backward seek, which clears ALL in-flight
                        // decode tasks via `in_flight = FuturesUnordered::new()`. This creates a
                        // cascading failure: dropped decode tasks create more gaps → more skips
                        // → more resets → progressively worse playback. The prefetch already
                        // tracks playback position via playback_position_tx/rx.
                        //
                        // Note: the overshoot skip (above) and clock-drift skip (below) DO still
                        // send frame_request_tx because those advance frame_number forward from
                        // the playback clock, which the prefetch correctly treats as demand for
                        // higher frames. These buffer-gap skips are different — the frame_number
                        // we'd send is always BEHIND the prefetch's next_prefetch_frame.
                        //
                        // Before jumping, drain all available frames from the rx channel. The
                        // regular drain budget of 16 per iteration can miss frames that arrived
                        // between the drain and the buffer check. This protects both the
                        // jump-to-min path and the +1 fallback path below.
                        while prefetch_buffer.len() < PREFETCH_BUFFER_SIZE {
                            match prefetch_rx.try_recv() {
                                Ok(p) => {
                                    if p.frame_number >= frame_number {
                                        prefetch_buffer.push_back(p);
                                    }
                                }
                                Err(_) => break,
                            }
                        }

                        if let Some(late_idx) = prefetch_buffer
                            .iter()
                            .position(|p| p.frame_number == frame_number)
                        {
                            frame_source = PlaybackFrameSource::LateDrain;
                            let prefetched = prefetch_buffer.remove(late_idx).unwrap();
                            prefetch_hits += 1;
                            Some(prefetched.into_cached())
                        } else {
                            let min_buffered = prefetch_buffer.iter().map(|p| p.frame_number).min();
                            if let Some(next_available_frame) = min_buffered
                                && next_available_frame > frame_number
                            {
                                let jumped = next_available_frame - frame_number;
                                let skipped_from = frame_number;
                                frame_number = next_available_frame;
                                total_frames_skipped += jumped as u64;
                                let _ = playback_position_tx.send(frame_number);
                                if let Some(telemetry) = &self.telemetry {
                                    telemetry.emit(PlaybackTelemetryEvent::FrameSkipped {
                                        frame_number: skipped_from,
                                        skipped: jumped,
                                        reason: PlaybackSkipReason::PrefetchGap,
                                        prefetch_buffer_len: prefetch_buffer.len(),
                                    });
                                }
                                if has_audio
                                    && audio_playhead_tx
                                        .send(frame_number as f64 / fps_f64)
                                        .is_err()
                                {
                                    break 'playback;
                                }
                                continue;
                            }
                            let skipped_from = frame_number;
                            frame_number = frame_number.saturating_add(1);
                            total_frames_skipped += 1;
                            let _ = playback_position_tx.send(frame_number);
                            if let Some(telemetry) = &self.telemetry {
                                telemetry.emit(PlaybackTelemetryEvent::FrameSkipped {
                                    frame_number: skipped_from,
                                    skipped: 1,
                                    reason: PlaybackSkipReason::PrefetchGap,
                                    prefetch_buffer_len: prefetch_buffer.len(),
                                });
                            }
                            if has_audio
                                && audio_playhead_tx
                                    .send(frame_number as f64 / fps_f64)
                                    .is_err()
                            {
                                break 'playback;
                            }
                            continue;
                        }
                    }
                };
                let frame_acquire_duration = frame_acquire_start.elapsed();

                if let Some((segment_frames, segment_index, transition)) = segment_frames_opt {
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
                            transition.as_ref().map(
                                |(frames, transition_index, kind, progress)| {
                                    (Arc::clone(frames), *transition_index, *kind, *progress)
                                },
                            ),
                        );
                    }

                    let zoom_until = (frame_number as f32 + 1.0) / fps as f32;
                    if let Some(timeline) = zoom_timelines.get_mut(segment_index as usize) {
                        timeline.ensure_precomputed_until(zoom_until);
                    }
                    if let Some(timeline) = outgoing_zoom_timelines.get_mut(segment_index as usize)
                    {
                        timeline.ensure_precomputed_until(zoom_until);
                    }
                    let zoom_timeline = zoom_timelines.get(segment_index as usize);

                    let empty_timeline;
                    let zoom_ref = match zoom_timeline {
                        Some(timeline) => timeline,
                        None => {
                            empty_timeline = ZoomTransformTimeline::new(
                                &[],
                                None,
                                &segment_media.cursor,
                                cached_project.screen_movement_spring,
                                duration,
                                None,
                            );
                            &empty_timeline
                        }
                    };

                    let precomputed_cursor = &cursor_timelines[segment_index as usize];

                    let uniforms_start = Instant::now();
                    let uniforms = ProjectUniforms::new_with_precomputed_cursor(
                        &self.render_constants,
                        &cached_project,
                        frame_number,
                        fps,
                        resolution_base,
                        &segment_media.cursor,
                        &segment_frames,
                        duration,
                        zoom_ref,
                        precomputed_cursor,
                    );
                    let uniforms_duration = uniforms_start.elapsed();
                    let submit_start = Instant::now();
                    let submitted_frame_number = frame_number;
                    if let Some((outgoing_frames, outgoing_index, kind, progress)) = transition {
                        let outgoing_media = &self.segment_medias[outgoing_index as usize];
                        if let Some(timeline) =
                            outgoing_zoom_timelines.get_mut(outgoing_index as usize)
                        {
                            timeline.ensure_precomputed_until(zoom_until);
                        }
                        let outgoing_uniforms = ProjectUniforms::new_with_precomputed_cursor(
                            &self.render_constants,
                            &cached_project,
                            frame_number,
                            fps,
                            resolution_base,
                            &outgoing_media.cursor,
                            &outgoing_frames,
                            duration,
                            &outgoing_zoom_timelines[outgoing_index as usize],
                            &cursor_timelines[outgoing_index as usize],
                        );
                        self.renderer.render_transition_frame(
                            editor::RendererTransitionInput {
                                segment_frames: Arc::unwrap_or_clone(outgoing_frames),
                                uniforms: outgoing_uniforms,
                                cursor: outgoing_media.cursor.clone(),
                            },
                            editor::RendererTransitionInput {
                                segment_frames: Arc::unwrap_or_clone(segment_frames),
                                uniforms,
                                cursor: segment_media.cursor.clone(),
                            },
                            kind,
                            progress,
                        );
                    } else {
                        self.renderer.render_frame(
                            Arc::unwrap_or_clone(segment_frames),
                            uniforms,
                            segment_media.cursor.clone(),
                        );
                    }
                    let submit_duration = submit_start.elapsed();

                    if let Some(telemetry) = &self.telemetry {
                        telemetry.emit(PlaybackTelemetryEvent::FrameSubmitted {
                            frame_number: submitted_frame_number,
                            source: frame_source,
                            schedule_overshoot: overshoot,
                            frame_acquire_duration,
                            uniforms_duration,
                            submit_duration,
                            prefetch_buffer_len: prefetch_buffer.len(),
                            total_frames_skipped,
                        });
                    }

                    total_frames_rendered += 1;
                }

                if last_stats_time.elapsed() >= stats_interval {
                    let effective_fps =
                        total_frames_rendered as f64 / start.elapsed().as_secs_f64().max(0.001);
                    let buffer_len = prefetch_buffer.len();
                    info!(
                        effective_fps = format!("{:.1}", effective_fps),
                        total_rendered = total_frames_rendered,
                        total_skipped = total_frames_skipped,
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

                    if frames_behind <= 2 {
                        continue;
                    }

                    let skipped = frames_behind;
                    let skipped_from = frame_number;
                    frame_number += skipped;
                    total_frames_skipped += skipped as u64;

                    while prefetch_buffer
                        .front()
                        .is_some_and(|f| f.frame_number < frame_number)
                    {
                        prefetch_buffer.pop_front();
                    }
                    frame_cache.evict_far_from(frame_number, MAX_PREFETCH_AHEAD);
                    let _ = frame_request_tx.send(frame_number);
                    let _ = playback_position_tx.send(frame_number);
                    if let Some(telemetry) = &self.telemetry {
                        telemetry.emit(PlaybackTelemetryEvent::FrameSkipped {
                            frame_number: skipped_from,
                            skipped,
                            reason: PlaybackSkipReason::ClockDrift,
                            prefetch_buffer_len: prefetch_buffer.len(),
                        });
                    }
                    if has_audio
                        && audio_playhead_tx
                            .send(frame_number as f64 / fps_f64)
                            .is_err()
                    {
                        break 'playback;
                    }
                }
            }

            if let Some(generation) = audio_generation {
                self.audio_output.stop_playback(generation);
            }

            stop_tx.send(true).ok();

            event_tx.send(PlaybackEvent::Stop).ok();
        };

        std::thread::Builder::new()
            .name("cap-playback".into())
            .spawn(playback_body)
            .expect("failed to spawn playback thread");

        Ok(handle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_music_enables_audio_playback_without_recorded_audio() {
        assert!(has_playback_audio(&[], true));
        assert!(!has_playback_audio(&[], false));
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
