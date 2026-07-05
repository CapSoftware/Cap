//! Deterministic spring-simulated zoom transform timeline.
//!
//! Replaces both the duration-based easing state machine that used to live in
//! `zoom.rs` (spring_ease / spring_ease_out / instant_ease over
//! `ZOOM_DURATION`) and the cursor-following `ZoomFocusInterpolator` layer.
//!
//! Three channels — `amount` (zoom scale), `center` (2D framing center in
//! `SegmentBounds::from_amount_center` travel space) and `activity` (the 0/1
//! "any zoom active" step that drives camera scale-during-zoom) — are each
//! integrated by an analytic [`SpringMassDamperSimulation`] chasing
//! step-function targets, retargeted every 8 ms step with velocity always
//! carried across retargets. There are no fixed animation durations and no
//! boundary special-cases: segment starts/ends/re-aims are just target changes
//! the spring smooths through, which is what makes the motion feel like
//! Screen Studio's.
//!
//! The timeline lives in TIMELINE time. Cursor events are in RECORDING time,
//! so click-cluster construction and the "active cluster at time t" lookup map
//! through the project's [`TimelineConfiguration`] (identity when absent).
//!
//! Precompute is lazy (`ensure_precomputed_until`) and must happen in the same
//! mutable phase render loops already used for the focus interpolator; the
//! render hot path only calls [`ZoomTransformTimeline::sample`], which is an
//! index + lerp over the cached samples with no allocation and no locking.
//! The result is a pure function of (segments, cursor events, spring config),
//! so sequential playback and seeking produce bit-identical transforms, and
//! export matches playback by construction.

use cap_project::{
    CursorEvents, ProjectConfiguration, ScreenMovementSpring, TimelineConfiguration, XY, ZoomMode,
    ZoomSegment,
};

use crate::{
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
    zoom::{InterpolatedZoom, SegmentBounds},
};

/// Fixed precompute step (125 Hz), matching the sampling density the old
/// focus interpolator used.
const STEP_MS: f64 = 8.0;

/// Instant-animation segments snap all channels (no spring) while inside the
/// segment and within this window of its boundaries.
const INSTANT_SNAP_WINDOW_SECS: f64 = 0.1;

/// Greedy click-cluster bounding-box limits, as a fraction of the visible
/// zoomed viewport (Screen Studio: 50% width x 70% height).
const CLUSTER_WIDTH_RATIO: f64 = 0.5;
const CLUSTER_HEIGHT_RATIO: f64 = 0.7;

/// Clicks separated by more than this gap start a new cluster.
const CLUSTER_MERGE_GAP_MS: f64 = 2_500.0;

/// Cursor samples further apart than this are treated as an idle gap rather
/// than interpolated across.
const CURSOR_IDLE_GAP_MS: f64 = 66.67;

/// Fallback focus when a segment has no usable cursor data.
const FALLBACK_FOCUS: (f64, f64) = (0.5, 0.5);

#[derive(Debug)]
pub(crate) struct ClickCluster {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
    start_time_ms: f64,
    last_time_ms: f64,
}

impl ClickCluster {
    fn new(x: f64, y: f64, time_ms: f64) -> Self {
        Self {
            min_x: x,
            max_x: x,
            min_y: y,
            max_y: y,
            start_time_ms: time_ms,
            last_time_ms: time_ms,
        }
    }

    fn can_add(&self, x: f64, y: f64, max_w: f64, max_h: f64) -> bool {
        let new_w = self.max_x.max(x) - self.min_x.min(x);
        let new_h = self.max_y.max(y) - self.min_y.min(y);
        new_w <= max_w && new_h <= max_h
    }

    fn add(&mut self, x: f64, y: f64, time_ms: f64) {
        self.min_x = self.min_x.min(x);
        self.max_x = self.max_x.max(x);
        self.min_y = self.min_y.min(y);
        self.max_y = self.max_y.max(y);
        self.last_time_ms = time_ms;
    }

    fn center(&self) -> (f64, f64) {
        (
            (self.min_x + self.max_x) / 2.0,
            (self.min_y + self.max_y) / 2.0,
        )
    }
}

fn cursor_position_at(moves: &[cap_project::CursorMoveEvent], time_ms: f64) -> Option<(f64, f64)> {
    if moves.is_empty() {
        return None;
    }

    if time_ms <= moves[0].time_ms {
        return Some((moves[0].x, moves[0].y));
    }

    if let Some(last) = moves.last()
        && time_ms >= last.time_ms
    {
        return Some((last.x, last.y));
    }

    let idx = moves.partition_point(|m| m.time_ms <= time_ms);
    if idx == 0 {
        return Some((moves[0].x, moves[0].y));
    }

    let prev = &moves[idx - 1];
    let next = &moves[idx.min(moves.len() - 1)];
    let dt = next.time_ms - prev.time_ms;

    if dt > CURSOR_IDLE_GAP_MS {
        return Some((prev.x, prev.y));
    }

    let t = if dt > 1e-9 {
        ((time_ms - prev.time_ms) / dt).clamp(0.0, 1.0)
    } else {
        0.0
    };

    Some((
        prev.x + (next.x - prev.x) * t,
        prev.y + (next.y - prev.y) * t,
    ))
}

/// Greedily clusters the mouse events inside a segment's RECORDING-time range
/// into bounding boxes limited to a fraction of the visible zoomed viewport.
/// Clicks are preferred; when a range has none, movement positions are
/// clustered instead so unclicked zoom ranges still aim somewhere sensible.
pub(crate) fn build_clusters(
    cursor_events: &CursorEvents,
    segment_start_secs: f64,
    segment_end_secs: f64,
    zoom_amount: f64,
) -> Vec<ClickCluster> {
    let start_ms = segment_start_secs * 1000.0;
    let end_ms = segment_end_secs * 1000.0;
    let cluster_w = CLUSTER_WIDTH_RATIO / zoom_amount.max(1.0);
    let cluster_h = CLUSTER_HEIGHT_RATIO / zoom_amount.max(1.0);

    let click_positions: Vec<(f64, f64, f64)> = cursor_events
        .clicks
        .iter()
        .filter(|click| click.down && click.time_ms >= start_ms && click.time_ms <= end_ms)
        .filter_map(|click| {
            cursor_position_at(&cursor_events.moves, click.time_ms)
                .map(|(x, y)| (click.time_ms, x, y))
        })
        .collect();

    if !click_positions.is_empty() {
        let mut clusters = Vec::new();
        let (first_time, first_x, first_y) = click_positions[0];
        let mut current = ClickCluster::new(first_x, first_y, first_time);

        for &(time_ms, x, y) in &click_positions[1..] {
            if time_ms - current.last_time_ms <= CLUSTER_MERGE_GAP_MS
                && current.can_add(x, y, cluster_w, cluster_h)
            {
                current.add(x, y, time_ms);
            } else {
                clusters.push(current);
                current = ClickCluster::new(x, y, time_ms);
            }
        }

        clusters.push(current);
        return clusters;
    }

    let events_in_range: Vec<&cap_project::CursorMoveEvent> = cursor_events
        .moves
        .iter()
        .filter(|m| m.time_ms >= start_ms && m.time_ms <= end_ms)
        .collect();

    if events_in_range.is_empty() {
        let fallback = cursor_events
            .moves
            .iter()
            .rev()
            .find(|m| m.time_ms <= start_ms)
            .or_else(|| cursor_events.moves.iter().find(|m| m.time_ms >= start_ms));

        if let Some(evt) = fallback {
            return vec![ClickCluster::new(evt.x, evt.y, evt.time_ms)];
        }
        return vec![];
    }

    let mut clusters = Vec::new();
    let first = events_in_range[0];
    let mut current = ClickCluster::new(first.x, first.y, first.time_ms);

    for evt in &events_in_range[1..] {
        if current.can_add(evt.x, evt.y, cluster_w, cluster_h) {
            current.add(evt.x, evt.y, evt.time_ms);
        } else {
            clusters.push(current);
            current = ClickCluster::new(evt.x, evt.y, evt.time_ms);
        }
    }
    clusters.push(current);

    clusters
}

/// The active cluster at `time_ms` (RECORDING time) is the last cluster whose
/// first event time is <= t; the spring smooths the discrete re-aims.
pub(crate) fn cluster_center_at_time(
    clusters: &[ClickCluster],
    time_ms: f64,
) -> Option<(f64, f64)> {
    clusters
        .iter()
        .rev()
        .find(|c| c.start_time_ms <= time_ms)
        .or_else(|| clusters.first())
        .map(|c| c.center())
}

/// One entry of the timeline-time -> recording-time mapping derived from
/// [`TimelineConfiguration::get_segment_time`]'s accumulation logic.
#[derive(Clone, Copy)]
struct TimeMapSegment {
    timeline_start: f64,
    timeline_end: f64,
    recording_start: f64,
    timescale: f64,
}

fn build_time_map(timeline: Option<&TimelineConfiguration>) -> Vec<TimeMapSegment> {
    let Some(timeline) = timeline else {
        return Vec::new();
    };

    let mut accum = 0.0;
    let mut map = Vec::with_capacity(timeline.segments.len());
    for segment in &timeline.segments {
        let duration = segment.duration();
        if !duration.is_finite() || duration <= 0.0 {
            continue;
        }
        map.push(TimeMapSegment {
            timeline_start: accum,
            timeline_end: accum + duration,
            recording_start: segment.start,
            timescale: segment.timescale,
        });
        accum += duration;
    }
    map
}

/// Maps a timeline timestamp to recording seconds. Identity when no timeline
/// is configured; clamps to the nearest edit boundary outside the timeline.
fn map_timeline_to_recording_secs(map: &[TimeMapSegment], timeline_secs: f64) -> f64 {
    let Some(first) = map.first() else {
        return timeline_secs;
    };

    if timeline_secs <= first.timeline_start {
        return first.recording_start;
    }

    for segment in map {
        if timeline_secs < segment.timeline_end {
            return segment.recording_start
                + (timeline_secs - segment.timeline_start) * segment.timescale;
        }
    }

    let last = map.last().expect("map is non-empty");
    last.recording_start + (last.timeline_end - last.timeline_start) * last.timescale
}

/// One precomputed step. Sample times are implicit: `samples[i]` is the state
/// at `i * STEP_MS`, so lookup is pure index math.
#[derive(Clone, Copy)]
struct TimelineSample {
    amount: f32,
    center: XY<f32>,
    activity: f32,
    snapped: bool,
}

struct PrecomputeState {
    /// 2D framing center in `from_amount_center` travel space.
    center_sim: SpringMassDamperSimulation,
    /// x = zoom amount, y = zoom activity (0/1 step -> smooth camera driver).
    aux_sim: SpringMassDamperSimulation,
    /// Last center target while a segment was active. Held during zoom-out so
    /// the outgoing framing stays anchored instead of re-aiming mid-flight.
    held_center_target: XY<f32>,
}

struct StepTargets {
    amount: f32,
    center: XY<f32>,
    activity: f32,
    segment_active: bool,
    snap: bool,
}

/// Deterministic, lazily precomputed zoom transform timeline.
///
/// Construction is cheap (clusters only); integration happens on demand via
/// [`Self::ensure_precomputed_until`] which must be called from a mutable
/// phase (exactly where the old focus interpolator's precompute ran) before
/// [`Self::sample`] is used for the corresponding frame times.
pub struct ZoomTransformTimeline {
    samples: Vec<TimelineSample>,
    state: Option<PrecomputeState>,
    zoom_segments: Vec<ZoomSegment>,
    /// Parallel to `zoom_segments`: prebuilt clusters (RECORDING-time ms) for
    /// Auto segments, `None` for Manual ones.
    clusters: Vec<Option<Vec<ClickCluster>>>,
    time_map: Vec<TimeMapSegment>,
    /// Total number of samples covering [0, duration] plus one lerp partner.
    total_samples: usize,
}

impl ZoomTransformTimeline {
    pub fn new(
        zoom_segments: &[ZoomSegment],
        timeline: Option<&TimelineConfiguration>,
        cursor_events: &CursorEvents,
        spring: ScreenMovementSpring,
        duration_secs: f64,
    ) -> Self {
        let mut zoom_segments = zoom_segments.to_vec();
        zoom_segments.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));

        let time_map = build_time_map(timeline);
        let clusters = zoom_segments
            .iter()
            .map(|segment| match segment.mode {
                ZoomMode::Auto => {
                    let recording_start = map_timeline_to_recording_secs(&time_map, segment.start);
                    let recording_end =
                        map_timeline_to_recording_secs(&time_map, segment.end).max(recording_start);
                    Some(build_clusters(
                        cursor_events,
                        recording_start,
                        recording_end,
                        segment.amount,
                    ))
                }
                ZoomMode::Manual { .. } => None,
            })
            .collect();

        let duration_secs = if duration_secs.is_finite() {
            duration_secs.max(0.0)
        } else {
            0.0
        };
        // One sample per step across the duration, plus one trailing sample so
        // a lookup right at the end always has a lerp partner.
        let total_samples = (duration_secs * 1000.0 / STEP_MS).ceil() as usize + 2;

        let spring_config = SpringMassDamperSimulationConfig {
            tension: spring.stiffness,
            mass: spring.mass,
            friction: spring.damping,
        };

        let mut timeline = Self {
            samples: Vec::new(),
            state: None,
            zoom_segments,
            clusters,
            time_map,
            total_samples,
        };

        // Seed the simulations at rest on the t=0 target so the very first
        // frame is already correct and `samples` is never empty.
        let initial = timeline.targets_at(0.0, XY::new(0.5, 0.5));
        let mut center_sim = SpringMassDamperSimulation::new(spring_config);
        center_sim.set_position(initial.center);
        center_sim.set_velocity(XY::new(0.0, 0.0));
        center_sim.set_target_position(initial.center);

        let mut aux_sim = SpringMassDamperSimulation::new(spring_config);
        aux_sim.set_position(XY::new(initial.amount, initial.activity));
        aux_sim.set_velocity(XY::new(0.0, 0.0));
        aux_sim.set_target_position(XY::new(initial.amount, initial.activity));

        timeline.samples.push(TimelineSample {
            amount: initial.amount.max(1.0),
            center: XY::new(
                initial.center.x.clamp(0.0, 1.0),
                initial.center.y.clamp(0.0, 1.0),
            ),
            activity: initial.activity.clamp(0.0, 1.0),
            snapped: false,
        });
        timeline.state = Some(PrecomputeState {
            center_sim,
            aux_sim,
            held_center_target: initial.center,
        });
        timeline
    }

    /// Convenience constructor pulling zoom segments, edit mapping and spring
    /// config out of a [`ProjectConfiguration`].
    pub fn from_project(
        project: &ProjectConfiguration,
        cursor_events: &CursorEvents,
        duration_secs: f64,
    ) -> Self {
        Self::new(
            project
                .timeline
                .as_ref()
                .map(|t| t.zoom_segments.as_slice())
                .unwrap_or(&[]),
            project.timeline.as_ref(),
            cursor_events,
            project.screen_movement_spring,
            duration_secs,
        )
    }

    /// Extends the precomputed cache to cover `timeline_secs`. Amortized and
    /// cheap (125 trivial steps per second of content); a no-op once the
    /// requested range — or the whole duration — is covered.
    pub fn ensure_precomputed_until(&mut self, timeline_secs: f32) {
        if self.state.is_none() {
            return;
        }
        let need_ms = (f64::from(timeline_secs).max(0.0)) * 1000.0;
        // +2: floor index plus its lerp partner.
        let need_samples = ((need_ms / STEP_MS).ceil() as usize + 2).min(self.total_samples);
        while self.samples.len() < need_samples && self.state.is_some() {
            self.advance_one_step();
        }
    }

    /// Precomputes the full duration.
    pub fn precompute(&mut self) {
        while self.state.is_some() {
            self.advance_one_step();
        }
    }

    /// Samples the transform at a TIMELINE timestamp: binary index + lerp over
    /// the precomputed steps. No allocation, no locks, no simulation work —
    /// safe for the render hot path. Times outside the precomputed range clamp
    /// to the nearest cached sample.
    pub fn sample(&self, timeline_secs: f32) -> InterpolatedZoom {
        let Some(last) = self.samples.len().checked_sub(1) else {
            return InterpolatedZoom {
                t: 0.0,
                bounds: SegmentBounds::default(),
            };
        };

        let pos = (f64::from(timeline_secs).max(0.0)) * 1000.0 / STEP_MS;
        let idx = (pos as usize).min(last);
        let next = (idx + 1).min(last);
        let frac = (pos - idx as f64).clamp(0.0, 1.0) as f32;

        let a = self.samples[idx];
        let b = self.samples[next];

        let amount = a.amount + (b.amount - a.amount) * frac;
        let center_x = a.center.x + (b.center.x - a.center.x) * frac;
        let center_y = a.center.y + (b.center.y - a.center.y) * frac;
        let activity = a.activity + (b.activity - a.activity) * frac;

        InterpolatedZoom {
            t: f64::from(activity).clamp(0.0, 1.0),
            bounds: SegmentBounds::from_amount_center(
                f64::from(amount),
                XY::new(f64::from(center_x), f64::from(center_y)),
            ),
        }
    }

    /// Whether any precomputed step in `[from_secs, to_secs]` was an instant
    /// snap (no spring). Motion-effect consumers can use this to suppress
    /// velocity-derived effects across intentional discontinuities.
    pub fn snapped_within(&self, from_secs: f32, to_secs: f32) -> bool {
        if self.samples.is_empty() {
            return false;
        }
        let last = self.samples.len() - 1;
        let lo_ms = f64::from(from_secs.min(to_secs)).max(0.0) * 1000.0;
        let hi_ms = f64::from(from_secs.max(to_secs)).max(0.0) * 1000.0;
        let lo = ((lo_ms / STEP_MS) as usize).min(last);
        let hi = ((hi_ms / STEP_MS).ceil() as usize).min(last);
        self.samples[lo..=hi].iter().any(|s| s.snapped)
    }

    fn advance_one_step(&mut self) {
        let Some(state) = self.state.as_ref() else {
            return;
        };
        let held_center = state.held_center_target;

        let step_index = self.samples.len();
        let step_secs = step_index as f64 * STEP_MS / 1000.0;
        let targets = self.targets_at(step_secs, held_center);

        let Some(state) = self.state.as_mut() else {
            return;
        };

        if targets.segment_active {
            state.held_center_target = targets.center;
        }

        state.center_sim.set_target_position(targets.center);
        state
            .aux_sim
            .set_target_position(XY::new(targets.amount, targets.activity));

        if targets.snap {
            // Instant animation: park the springs on the target with zero
            // velocity so no motion (or motion-derived effect) leaks through.
            state.center_sim.set_position(targets.center);
            state.center_sim.set_velocity(XY::new(0.0, 0.0));
            state
                .aux_sim
                .set_position(XY::new(targets.amount, targets.activity));
            state.aux_sim.set_velocity(XY::new(0.0, 0.0));
        } else {
            state.center_sim.run(STEP_MS as f32);
            state.aux_sim.run(STEP_MS as f32);
        }

        // Geometric safety: a sprung amount below 1 would show out-of-bounds
        // background ("bounce-out"), so clamp and kill velocity on that axis
        // only. Centers are clamped per-sample instead (the spring target is
        // always in-band, so overshoot is transient and tiny).
        if state.aux_sim.position.x < 1.0 {
            state.aux_sim.position.x = 1.0;
            state.aux_sim.velocity.x = 0.0;
        }

        self.samples.push(TimelineSample {
            amount: state.aux_sim.position.x,
            center: XY::new(
                state.center_sim.position.x.clamp(0.0, 1.0),
                state.center_sim.position.y.clamp(0.0, 1.0),
            ),
            activity: state.aux_sim.position.y.clamp(0.0, 1.0),
            snapped: targets.snap,
        });

        if self.samples.len() >= self.total_samples {
            self.state = None;
        }
    }

    fn targets_at(&self, timeline_secs: f64, held_center: XY<f32>) -> StepTargets {
        // Same active predicate `SegmentsCursor` used: (start, end].
        let active = self
            .zoom_segments
            .iter()
            .position(|s| timeline_secs > s.start && timeline_secs <= s.end);

        let snap = self.zoom_segments.iter().any(|s| {
            s.instant_animation
                && timeline_secs >= s.start - INSTANT_SNAP_WINDOW_SECS
                && timeline_secs <= s.end + INSTANT_SNAP_WINDOW_SECS
        });

        match active {
            Some(index) => {
                let segment = &self.zoom_segments[index];
                let amount = if segment.amount.is_finite() {
                    segment.amount.max(1.0)
                } else {
                    1.0
                };
                let center = match segment.mode {
                    ZoomMode::Manual { x, y } => {
                        (f64::from(x).clamp(0.0, 1.0), f64::from(y).clamp(0.0, 1.0))
                    }
                    ZoomMode::Auto => {
                        let recording_ms =
                            map_timeline_to_recording_secs(&self.time_map, timeline_secs) * 1000.0;
                        let focus = self.clusters[index]
                            .as_deref()
                            .and_then(|clusters| cluster_center_at_time(clusters, recording_ms))
                            .unwrap_or(FALLBACK_FOCUS);
                        SegmentBounds::calculate_follow_center(
                            (focus.0.clamp(0.0, 1.0), focus.1.clamp(0.0, 1.0)),
                            amount,
                            segment.edge_snap_ratio,
                        )
                    }
                };

                StepTargets {
                    amount: amount as f32,
                    center: XY::new(center.0 as f32, center.1 as f32),
                    activity: 1.0,
                    segment_active: true,
                    snap,
                }
            }
            None => StepTargets {
                amount: 1.0,
                // Hold the last active framing while zooming out so the
                // outgoing shot stays anchored (irrelevant once amount = 1).
                center: held_center,
                activity: 0.0,
                segment_active: false,
                snap,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use cap_project::{
        CursorClickEvent, CursorMoveEvent, GlideDirection, TimelineSegment, ZoomMode,
    };

    use super::*;

    fn manual_segment(start: f64, end: f64, amount: f64, x: f64, y: f64) -> ZoomSegment {
        ZoomSegment {
            start,
            end,
            amount,
            mode: ZoomMode::Manual {
                x: x as f32,
                y: y as f32,
            },
            glide_direction: GlideDirection::default(),
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
        }
    }

    fn auto_segment(start: f64, end: f64, amount: f64) -> ZoomSegment {
        ZoomSegment {
            mode: ZoomMode::Auto,
            ..manual_segment(start, end, amount, 0.5, 0.5)
        }
    }

    fn move_event(time_ms: f64, x: f64, y: f64) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "default".to_string(),
            time_ms,
            x,
            y,
        }
    }

    fn click_event(time_ms: f64) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: vec![],
            cursor_num: 0,
            cursor_id: "default".to_string(),
            time_ms,
            down: true,
        }
    }

    fn timeline_for(
        segments: &[ZoomSegment],
        cursor: &CursorEvents,
        duration: f64,
    ) -> ZoomTransformTimeline {
        ZoomTransformTimeline::new(
            segments,
            None,
            cursor,
            ScreenMovementSpring::default(),
            duration,
        )
    }

    /// Max |value delta| and |slope delta| between adjacent 8ms sample
    /// intervals across the whole precomputed range, per channel scalar.
    fn max_step_discontinuities(timeline: &ZoomTransformTimeline) -> (f64, f64) {
        let step_secs = STEP_MS / 1000.0;
        let values: Vec<[f64; 3]> = timeline
            .samples
            .iter()
            .map(|s| {
                [
                    f64::from(s.amount),
                    f64::from(s.center.x),
                    f64::from(s.center.y),
                ]
            })
            .collect();

        let mut max_value_jump = 0.0f64;
        let mut max_slope_jump = 0.0f64;
        for window in values.windows(3) {
            for channel in 0..3 {
                let v0 = window[0][channel];
                let v1 = window[1][channel];
                let v2 = window[2][channel];
                let slope_a = (v1 - v0) / step_secs;
                let slope_b = (v2 - v1) / step_secs;
                max_value_jump = max_value_jump.max((v1 - v0).abs()).max((v2 - v1).abs());
                max_slope_jump = max_slope_jump.max((slope_b - slope_a).abs());
            }
        }
        (max_value_jump, max_slope_jump)
    }

    fn assert_viewport_in_bounds(zoom: &InterpolatedZoom, context: &str) {
        // The display rect must cover the full output on both axes; anything
        // less shows out-of-bounds background.
        assert!(
            zoom.bounds.top_left.x <= 1e-6 && zoom.bounds.top_left.y <= 1e-6,
            "{context}: top_left out of bounds: {:?}",
            zoom.bounds
        );
        assert!(
            zoom.bounds.bottom_right.x >= 1.0 - 1e-6 && zoom.bounds.bottom_right.y >= 1.0 - 1e-6,
            "{context}: bottom_right out of bounds: {:?}",
            zoom.bounds
        );
        assert!(
            zoom.display_amount() >= 1.0 - 1e-6,
            "{context}: amount below 1: {}",
            zoom.display_amount()
        );
        assert!(
            (0.0..=1.0).contains(&zoom.t),
            "{context}: t out of [0,1]: {}",
            zoom.t
        );
    }

    #[test]
    fn sequential_and_seek_precompute_are_identical() {
        let cursor = CursorEvents {
            moves: vec![
                move_event(0.0, 0.2, 0.3),
                move_event(1500.0, 0.8, 0.7),
                move_event(4000.0, 0.4, 0.9),
            ],
            clicks: vec![click_event(1200.0), click_event(3600.0)],
        };
        let segments = vec![
            auto_segment(1.0, 4.0, 2.0),
            manual_segment(6.0, 8.0, 3.0, 0.2, 0.8),
        ];

        let mut sequential = timeline_for(&segments, &cursor, 10.0);
        let mut chunk_time = 0.0f32;
        while chunk_time < 10.5 {
            sequential.ensure_precomputed_until(chunk_time);
            chunk_time += 0.037; // deliberately not a multiple of the step
        }
        sequential.precompute();

        let mut seeked = timeline_for(&segments, &cursor, 10.0);
        seeked.precompute();

        assert_eq!(sequential.samples.len(), seeked.samples.len());
        for (index, (a, b)) in sequential
            .samples
            .iter()
            .zip(seeked.samples.iter())
            .enumerate()
        {
            assert_eq!(a.amount.to_bits(), b.amount.to_bits(), "amount @ {index}");
            assert_eq!(
                a.center.x.to_bits(),
                b.center.x.to_bits(),
                "center.x @ {index}"
            );
            assert_eq!(
                a.center.y.to_bits(),
                b.center.y.to_bits(),
                "center.y @ {index}"
            );
            assert_eq!(
                a.activity.to_bits(),
                b.activity.to_bits(),
                "activity @ {index}"
            );
        }

        // Sampling backwards after a forward precompute is pure cache lookup
        // and must equal a fresh sample of the same time.
        let early = sequential.sample(1.5);
        let late = sequential.sample(9.0);
        let early_again = sequential.sample(1.5);
        assert_eq!(early.bounds, early_again.bounds);
        assert!(late.display_amount().is_finite());
    }

    #[test]
    fn velocity_is_continuous_across_segment_boundaries() {
        // The old easing scheme had C1 breaks at segment start/end that
        // required `segment_end_focus` patches; the spring must not. Bounds
        // derived from the default spring: |accel| <= (k*disp + c*v)/m with
        // disp <= 2, v <= ~7/s => ~300/s^2, i.e. slope deltas of at most
        // ~2.4/s between adjacent 8ms intervals. A duration-eased jump would
        // show up as a slope delta of tens per second.
        let cursor = CursorEvents {
            moves: vec![move_event(0.0, 0.7, 0.4)],
            clicks: vec![],
        };
        let segments = vec![
            auto_segment(1.0, 3.0, 3.0),
            manual_segment(3.5, 5.0, 2.0, 0.1, 0.9), // retarget mid-flight of the zoom-out
        ];
        let mut timeline = timeline_for(&segments, &cursor, 7.0);
        timeline.precompute();

        let (max_value_jump, max_slope_jump) = max_step_discontinuities(&timeline);
        assert!(
            max_value_jump < 0.1,
            "C0 violated: sample-to-sample jump {max_value_jump}"
        );
        assert!(
            max_slope_jump < 4.0,
            "velocity discontinuity across retargets: slope jump {max_slope_jump}/s"
        );
    }

    #[test]
    fn viewport_stays_in_bounds_for_all_t() {
        let cursor = CursorEvents {
            moves: vec![
                move_event(0.0, 0.02, 0.02),
                move_event(1000.0, 0.98, 0.03),
                move_event(2500.0, 0.97, 0.96),
                move_event(4000.0, 0.01, 0.99),
            ],
            clicks: vec![click_event(900.0), click_event(2400.0), click_event(3900.0)],
        };
        // Edge-hugging focus + manual corners + amounts up to 4x.
        let segments = vec![
            auto_segment(0.5, 4.5, 4.0),
            manual_segment(5.0, 6.0, 2.0, 0.0, 0.0),
            manual_segment(6.0, 7.0, 3.0, 1.0, 1.0),
        ];
        let mut timeline = timeline_for(&segments, &cursor, 9.0);
        timeline.precompute();

        let mut t = 0.0f32;
        while t <= 9.0 {
            let zoom = timeline.sample(t);
            assert_viewport_in_bounds(&zoom, &format!("t={t}"));
            t += 0.003; // off-grid sampling exercises the lerp too
        }
    }

    #[test]
    fn instant_segments_snap_without_spring() {
        let cursor = CursorEvents::default();
        let mut segment = manual_segment(1.0, 2.0, 2.5, 0.5, 0.5);
        segment.instant_animation = true;
        let mut timeline = timeline_for(&[segment], &cursor, 4.0);
        timeline.precompute();

        // One step into the segment the amount is already at target.
        let inside = timeline.sample(1.016);
        assert!(
            (inside.display_amount() - 2.5).abs() < 1e-4,
            "instant zoom-in did not snap: {}",
            inside.display_amount()
        );

        // One step past the end (still inside the +-100ms snap window) it is
        // already back at identity.
        let after = timeline.sample(2.016);
        assert!(
            (after.display_amount() - 1.0).abs() < 1e-4,
            "instant zoom-out did not snap: {}",
            after.display_amount()
        );

        assert!(timeline.snapped_within(0.95, 1.05));
        assert!(timeline.snapped_within(1.95, 2.05));
        assert!(!timeline.snapped_within(3.0, 4.0));
    }

    #[test]
    fn cluster_re_aim_is_smooth() {
        // Two click clusters far apart inside one long auto segment: the
        // target re-aims discretely, the sprung center must move smoothly.
        let cursor = CursorEvents {
            moves: vec![
                move_event(0.0, 0.1, 0.1),
                move_event(2000.0, 0.12, 0.12),
                move_event(5000.0, 0.9, 0.9),
                move_event(8000.0, 0.88, 0.88),
            ],
            clicks: vec![click_event(1000.0), click_event(6000.0)],
        };
        let segments = vec![auto_segment(0.5, 9.0, 2.0)];
        let mut timeline = timeline_for(&segments, &cursor, 10.0);
        timeline.precompute();

        let (max_value_jump, max_slope_jump) = max_step_discontinuities(&timeline);
        assert!(max_value_jump < 0.06, "re-aim value jump {max_value_jump}");
        assert!(max_slope_jump < 4.0, "re-aim slope jump {max_slope_jump}");

        // And it actually re-aims: early framing differs from late framing.
        let early = timeline.sample(3.0);
        let late = timeline.sample(8.9);
        assert!(
            (early.bounds.top_left.x - late.bounds.top_left.x).abs() > 0.05,
            "cluster re-aim never moved the framing"
        );
    }

    #[test]
    fn empty_cursor_events_fall_back_to_centered_focus() {
        let cursor = CursorEvents::default();
        let segments = vec![auto_segment(0.5, 5.0, 2.0)];
        let mut timeline = timeline_for(&segments, &cursor, 6.0);
        timeline.precompute();

        // Well after the spring has settled (~1s), framing is centered.
        let settled = timeline.sample(4.5);
        let expected = SegmentBounds::from_amount_center(
            2.0,
            XY::new(
                SegmentBounds::calculate_follow_center(FALLBACK_FOCUS, 2.0, 0.25).0,
                SegmentBounds::calculate_follow_center(FALLBACK_FOCUS, 2.0, 0.25).1,
            ),
        );
        assert!((settled.bounds.top_left.x - expected.top_left.x).abs() < 1e-3);
        assert!((settled.bounds.bottom_right.y - expected.bottom_right.y).abs() < 1e-3);
        assert!((settled.t - 1.0).abs() < 1e-3);
    }

    #[test]
    fn steady_state_matches_manual_target_framing() {
        // Parity anchor with the retired easing implementation: a settled
        // manual zoom must land on exactly the same framing formula.
        let cursor = CursorEvents::default();
        let segments = vec![manual_segment(0.5, 6.0, 2.0, 0.3, 0.7)];
        let mut timeline = timeline_for(&segments, &cursor, 7.0);
        timeline.precompute();

        let settled = timeline.sample(5.5);
        let expected = SegmentBounds::from_amount_center(2.0, XY::new(0.3, 0.7));
        assert!((settled.bounds.top_left.x - expected.top_left.x).abs() < 1e-3);
        assert!((settled.bounds.top_left.y - expected.top_left.y).abs() < 1e-3);
        assert!((settled.bounds.bottom_right.x - expected.bottom_right.x).abs() < 1e-3);
        assert!((settled.bounds.bottom_right.y - expected.bottom_right.y).abs() < 1e-3);
    }

    #[test]
    fn zoom_out_returns_to_identity_and_zero_activity() {
        let cursor = CursorEvents::default();
        let segments = vec![manual_segment(0.5, 2.0, 2.0, 0.5, 0.5)];
        let mut timeline = timeline_for(&segments, &cursor, 6.0);
        timeline.precompute();

        let rest = timeline.sample(5.5);
        assert!((rest.display_amount() - 1.0).abs() < 1e-4);
        assert!(rest.t < 1e-3);
        assert!((rest.bounds.top_left.x).abs() < 1e-4);
        assert!((rest.bounds.bottom_right.x - 1.0).abs() < 1e-4);
    }

    #[test]
    fn degenerate_segments_do_not_break_the_timeline() {
        let cursor = CursorEvents {
            moves: vec![move_event(0.0, 0.5, 0.5)],
            clicks: vec![],
        };
        let segments = vec![
            manual_segment(1.0, 1.0, 2.0, 0.5, 0.5), // zero duration
            manual_segment(3.0, 2.5, 2.0, 0.5, 0.5), // reversed
            auto_segment(100.0, 105.0, 2.0),         // beyond duration
        ];
        let mut timeline = timeline_for(&segments, &cursor, 5.0);
        timeline.precompute();

        let mut t = 0.0f32;
        while t <= 5.0 {
            let zoom = timeline.sample(t);
            assert_viewport_in_bounds(&zoom, &format!("degenerate t={t}"));
            // None of these segments can activate, so the timeline is identity.
            assert!(
                (zoom.display_amount() - 1.0).abs() < 1e-6,
                "degenerate segment activated at t={t}"
            );
            t += 0.05;
        }

        // Zero-duration timelines (screenshot paths) still sample safely.
        let mut zero = timeline_for(&[], &CursorEvents::default(), 0.0);
        zero.ensure_precomputed_until(1.0);
        let frame0 = zero.sample(0.0);
        assert!((frame0.display_amount() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn sampling_before_precompute_clamps_to_seed_instead_of_diverging() {
        // The old focus interpolator silently fell back to a *different*
        // interpolation when precompute had not run (the scrub-path bug).
        // The timeline instead clamps to what is cached — callers must ensure
        // first, but an unensured sample can never disagree with an ensured
        // one at t=0.
        let cursor = CursorEvents::default();
        let segments = vec![manual_segment(0.5, 2.0, 2.0, 0.5, 0.5)];
        let unensured = timeline_for(&segments, &cursor, 6.0);
        let frame0 = unensured.sample(0.0);
        assert!((frame0.display_amount() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn precompute_cost_is_bounded_for_long_projects() {
        use std::time::{Duration, Instant};

        // Synthetic 30-minute project: 10 auto zoom segments and 50k cursor
        // move events with a click every 3 seconds.
        let duration_secs = 1800.0;
        let moves: Vec<CursorMoveEvent> = (0..50_000)
            .map(|i| {
                let t_ms = i as f64 * (duration_secs * 1000.0 / 50_000.0);
                move_event(
                    t_ms,
                    ((i as f64 * 0.0011).sin() + 1.0) / 2.0,
                    ((i as f64 * 0.0007).cos() + 1.0) / 2.0,
                )
            })
            .collect();
        let clicks: Vec<CursorClickEvent> =
            (0..600).map(|i| click_event(i as f64 * 3_000.0)).collect();
        let cursor = CursorEvents { moves, clicks };
        let segments: Vec<ZoomSegment> = (0..10)
            .map(|i| auto_segment(i as f64 * 170.0 + 10.0, i as f64 * 170.0 + 40.0, 2.0))
            .collect();

        // Amortization: ensuring an early time must NOT precompute the whole
        // 30-minute timeline. 1s of content is ~127 samples at the 8ms step;
        // the full timeline would be ~225k.
        let construct_start = Instant::now();
        let mut lazy = timeline_for(&segments, &cursor, duration_secs);
        let construct_elapsed = construct_start.elapsed();
        let ensure_start = Instant::now();
        lazy.ensure_precomputed_until(1.0);
        let ensure_elapsed = ensure_start.elapsed();
        let lazy_samples = lazy.samples.len();
        println!(
            "construct: {construct_elapsed:?}, ensure(1s): {ensure_elapsed:?}, samples after early ensure: {lazy_samples}"
        );
        assert!(
            lazy_samples < 1_000,
            "early ensure_precomputed_until precomputed {lazy_samples} samples; amortization is broken"
        );

        // Full precompute of the 30-minute timeline.
        let mut timeline = timeline_for(&segments, &cursor, duration_secs);
        let precompute_start = Instant::now();
        timeline.precompute();
        let precompute_elapsed = precompute_start.elapsed();
        let total_samples = timeline.samples.len();
        println!("precompute({total_samples} samples): {precompute_elapsed:?}");

        // 10k hot-path samples spread across the whole duration.
        let sample_start = Instant::now();
        let mut checksum = 0.0f64;
        for i in 0..10_000u32 {
            let t = (i as f32 * 0.18) % duration_secs as f32;
            checksum += timeline.sample(t).display_amount();
        }
        let sample_elapsed = sample_start.elapsed();
        println!("10k samples: {sample_elapsed:?} (checksum {checksum})");

        // Generous debug-mode bounds; release is far faster.
        assert!(
            precompute_elapsed < Duration::from_millis(500),
            "full precompute took {precompute_elapsed:?} (>500ms) for a 30-minute project"
        );
        assert!(
            sample_elapsed < Duration::from_millis(50),
            "10k samples took {sample_elapsed:?} (>50ms)"
        );
    }

    #[test]
    fn timeline_mapping_filters_clusters_in_recording_time() {
        // Timeline: single segment showing recording range [10s, 20s] at 1x,
        // so timeline t=1s corresponds to recording t=11s. A click at
        // recording 11s must aim the zoom; a click at recording 1s must not.
        let timeline_config = TimelineConfiguration {
            segments: vec![TimelineSegment {
                recording_clip: 0,
                timescale: 1.0,
                start: 10.0,
                end: 20.0,
                name: None,
            }],
            zoom_segments: vec![],
            scene_segments: vec![],
            mask_segments: vec![],
            text_segments: vec![],
            caption_segments: vec![],
            keyboard_segments: vec![],
            audio_segments: vec![],
        };
        let cursor = CursorEvents {
            moves: vec![
                move_event(1_000.0, 0.05, 0.05), // recording 1s: outside edit
                move_event(11_000.0, 0.9, 0.9),  // recording 11s: inside edit
            ],
            clicks: vec![click_event(1_000.0), click_event(11_000.0)],
        };
        let segments = vec![auto_segment(0.5, 8.0, 2.0)];
        let mut timeline = ZoomTransformTimeline::new(
            &segments,
            Some(&timeline_config),
            &cursor,
            ScreenMovementSpring::default(),
            10.0,
        );
        timeline.precompute();

        // Settled framing aims at the in-edit click (0.9, 0.9), not (0.05, 0.05).
        let settled = timeline.sample(6.0);
        let toward_bottom_right = SegmentBounds::from_amount_center(
            2.0,
            XY::new(
                SegmentBounds::calculate_follow_center((0.9, 0.9), 2.0, 0.25).0,
                SegmentBounds::calculate_follow_center((0.9, 0.9), 2.0, 0.25).1,
            ),
        );
        assert!(
            (settled.bounds.top_left.x - toward_bottom_right.top_left.x).abs() < 1e-2,
            "expected framing near {:?}, got {:?}",
            toward_bottom_right,
            settled.bounds
        );
    }
}
