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
//! the spring smooths through for continuous motion.
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
    Crop, CursorEvents, ProjectConfiguration, ScreenMovementSpring, TimelineConfiguration, XY,
    ZoomMode, ZoomSegment,
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

/// While the zoom amount is at (or within a hair of) identity the viewport
/// covers the whole frame regardless of the center, so the center channel is
/// free to track its target instantly — this pre-aims upcoming zooms so they
/// scale straight toward their focus. Any center jump while amount <= this
/// bound moves the viewport by at most (bound - 1) of the card: sub-pixel.
const CENTER_PREAIM_MAX_AMOUNT: f32 = 1.0005;

/// Greedy click-cluster bounding-box limits, as a fraction of the visible
/// zoomed viewport (50% width x 70% height).
const CLUSTER_WIDTH_RATIO: f64 = 0.5;
const CLUSTER_HEIGHT_RATIO: f64 = 0.7;

/// Fallback focus when a segment has no usable cursor data.
const FALLBACK_FOCUS: (f64, f64) = (0.5, 0.5);

/// Maps raw display-UV cursor coordinates into cropped-content UV space.
///
/// Cursor events are normalized to the FULL recorded display, but zoom
/// centers ([`SegmentBounds::from_amount_center`]) are proportions of the
/// rendered (cropped) content. Without this remap a cropped recording aims
/// its auto zoom at the wrong spot — and clustering dead-zone distances are
/// measured in the wrong scale. Identity when the recording is uncropped.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CursorCropMap {
    /// Crop top-left in raw display UV.
    offset: XY<f64>,
    /// Crop size in raw display UV.
    scale: XY<f64>,
}

impl CursorCropMap {
    /// `None` when the crop covers the whole screen (identity) or when the
    /// inputs are degenerate.
    pub fn from_crop(crop: &Crop, screen_size: XY<u32>) -> Option<Self> {
        if screen_size.x == 0 || screen_size.y == 0 || crop.size.x == 0 || crop.size.y == 0 {
            return None;
        }
        if crop.position.x == 0
            && crop.position.y == 0
            && crop.size.x >= screen_size.x
            && crop.size.y >= screen_size.y
        {
            return None;
        }
        let screen = XY::new(f64::from(screen_size.x), f64::from(screen_size.y));
        Some(Self {
            offset: XY::new(
                f64::from(crop.position.x) / screen.x,
                f64::from(crop.position.y) / screen.y,
            ),
            scale: XY::new(
                f64::from(crop.size.x) / screen.x,
                f64::from(crop.size.y) / screen.y,
            ),
        })
    }

    /// Raw display UV -> content UV. Positions outside the crop map outside
    /// [0, 1]; consumers clamp at the point of use so movement into a
    /// cropped-away strip still aims the camera at that content edge.
    fn map(&self, x: f64, y: f64) -> (f64, f64) {
        (
            (x - self.offset.x) / self.scale.x,
            (y - self.offset.y) / self.scale.y,
        )
    }
}

#[derive(PartialEq)]
struct TimedCursorCropMap {
    start: f64,
    end: f64,
    crop: Option<CursorCropMap>,
}

#[derive(PartialEq)]
struct CursorCropMaps {
    base: Option<CursorCropMap>,
    styles: Vec<TimedCursorCropMap>,
}

impl CursorCropMaps {
    fn from_project(project: &ProjectConfiguration, screen_size: XY<u32>) -> Self {
        let base = project
            .background
            .crop
            .as_ref()
            .and_then(|crop| CursorCropMap::from_crop(crop, screen_size));
        let mut maps = Self {
            base,
            styles: Vec::new(),
        };
        let Some(timeline) = &project.timeline else {
            return maps;
        };
        if timeline.style_segments.is_empty()
            || !timeline
                .zoom_segments
                .iter()
                .any(|segment| matches!(segment.mode, ZoomMode::Auto))
        {
            return maps;
        }

        let mut styles: Vec<_> = timeline
            .style_segments
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| {
                segment
                    .overrides
                    .background
                    .as_ref()
                    .filter(|_| segment.is_active_at(segment.start))
                    .map(|background| (index, segment, background))
            })
            .collect();
        styles.sort_unstable_by(|(left_index, left, _), (right_index, right, _)| {
            left.track
                .cmp(&right.track)
                .then_with(|| {
                    left.start
                        .partial_cmp(&right.start)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| left_index.cmp(right_index))
        });
        maps.styles = styles
            .into_iter()
            .map(|(_, segment, background)| TimedCursorCropMap {
                start: segment.start,
                end: segment.end,
                crop: background
                    .crop
                    .as_ref()
                    .and_then(|crop| CursorCropMap::from_crop(crop, screen_size)),
            })
            .collect();
        maps
    }
}

struct ClusterCenters {
    clusters: Vec<ClickCluster>,
    time_ordered: bool,
}

impl ClusterCenters {
    fn new(clusters: Vec<ClickCluster>) -> Self {
        let time_ordered =
            clusters.is_sorted_by(|left, right| left.start_time_ms <= right.start_time_ms);
        Self {
            clusters,
            time_ordered,
        }
    }

    fn center_at(&self, time_ms: f64) -> Option<(f64, f64)> {
        if self.time_ordered {
            let through_time = self
                .clusters
                .partition_point(|cluster| cluster.start_time_ms <= time_ms);
            self.clusters.get(through_time.saturating_sub(1))
        } else {
            self.clusters
                .iter()
                .rev()
                .find(|cluster| cluster.start_time_ms <= time_ms)
                .or_else(|| self.clusters.first())
        }
        .map(ClickCluster::center)
    }
}

struct CroppedClusters {
    crop: Option<CursorCropMap>,
    clusters: ClusterCenters,
}

struct TimedClusterVariant {
    start: f64,
    end: f64,
    variant: usize,
}

enum ZoomClusters {
    Static(ClusterCenters),
    Styled {
        variants: Vec<CroppedClusters>,
        styles: Vec<TimedClusterVariant>,
    },
}

impl ZoomClusters {
    fn new(
        cursor_events: &CursorEvents,
        moves_time_ordered: bool,
        recording_start: f64,
        recording_end: f64,
        segment: &ZoomSegment,
        crops: &CursorCropMaps,
    ) -> Self {
        let build = |crop| {
            ClusterCenters::new(build_clusters(
                cursor_events,
                moves_time_ordered,
                recording_start,
                recording_end,
                segment.amount,
                crop,
            ))
        };
        let base = build(crops.base);
        let overlaps =
            |style: &&TimedCursorCropMap| style.start <= segment.end && style.end > segment.start;
        if !crops
            .styles
            .iter()
            .filter(overlaps)
            .any(|style| style.crop != crops.base)
        {
            return Self::Static(base);
        }

        let mut variants = vec![CroppedClusters {
            crop: crops.base,
            clusters: base,
        }];
        let styles = crops
            .styles
            .iter()
            .filter(overlaps)
            .map(|style| {
                let variant = variants
                    .iter()
                    .position(|variant| variant.crop == style.crop)
                    .unwrap_or_else(|| {
                        let index = variants.len();
                        variants.push(CroppedClusters {
                            crop: style.crop,
                            clusters: build(style.crop),
                        });
                        index
                    });
                TimedClusterVariant {
                    start: style.start,
                    end: style.end,
                    variant,
                }
            })
            .collect();
        Self::Styled { variants, styles }
    }

    fn center_at(&self, timeline_secs: f64, recording_ms: f64) -> Option<(f64, f64)> {
        let clusters = match self {
            Self::Static(clusters) => clusters,
            Self::Styled { variants, styles } => {
                let variant = styles
                    .iter()
                    .rev()
                    .find(|style| timeline_secs >= style.start && timeline_secs < style.end)
                    .map_or(0, |style| style.variant);
                &variants[variant].clusters
            }
        };
        clusters.center_at(recording_ms)
    }
}

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

/// Greedily clusters ALL mouse movement inside a segment's RECORDING-time
/// range into bounding boxes limited to a fraction of the visible zoomed
/// viewport. Every move participates — not just clicks — so the camera
/// re-aims whenever the cursor travels outside the current cluster's
/// dead-zone box (hovering into a corner pans the view there even without a
/// click). Click positions are inherently part of the move stream, so they
/// need no separate pass.
pub(crate) fn build_clusters(
    cursor_events: &CursorEvents,
    moves_time_ordered: bool,
    segment_start_secs: f64,
    segment_end_secs: f64,
    zoom_amount: f64,
    crop: Option<CursorCropMap>,
) -> Vec<ClickCluster> {
    let start_ms = segment_start_secs * 1000.0;
    let end_ms = segment_end_secs * 1000.0;
    let cluster_w = CLUSTER_WIDTH_RATIO / zoom_amount.max(1.0);
    let cluster_h = CLUSTER_HEIGHT_RATIO / zoom_amount.max(1.0);
    // Clustering happens in CONTENT UV space: dead-zone box limits are
    // fractions of the visible (cropped) viewport, so raw display UVs must be
    // remapped before distances mean what the constants say they mean.
    let map_uv = |x: f64, y: f64| crop.map_or((x, y), |c| c.map(x, y));

    // Non-finite coordinates (corrupted files, synthetic event generators)
    // must never reach the cluster math: NaN propagates through min/max and
    // clamp, which would poison the spring targets for the whole timeline.
    let finite = |m: &&cap_project::CursorMoveEvent| {
        m.x.is_finite() && m.y.is_finite() && m.time_ms.is_finite()
    };

    // The narrowed slices only drop moves the filters below would reject, so
    // the filters stay and NaN bounds still match a full scan.
    let moves = cursor_events.moves.as_slice();
    let (range_moves, moves_until_start, moves_from_start) = if moves_time_ordered {
        let from_start = moves.partition_point(|m| m.time_ms < start_ms);
        let through_end = moves
            .partition_point(|m| m.time_ms <= end_ms)
            .max(from_start);
        let through_start = moves.partition_point(|m| m.time_ms <= start_ms);
        (
            &moves[from_start..through_end],
            &moves[..through_start],
            &moves[from_start..],
        )
    } else {
        (moves, moves, moves)
    };

    let events_in_range: Vec<&cap_project::CursorMoveEvent> = range_moves
        .iter()
        .filter(finite)
        .filter(|m| m.time_ms >= start_ms && m.time_ms <= end_ms)
        .collect();

    let previous = moves_until_start
        .iter()
        .filter(finite)
        .rev()
        .find(|m| m.time_ms <= start_ms);

    if events_in_range.is_empty() {
        let fallback = previous.or_else(|| {
            moves_from_start
                .iter()
                .filter(finite)
                .find(|m| m.time_ms >= start_ms)
        });

        if let Some(evt) = fallback {
            let (x, y) = map_uv(evt.x, evt.y);
            return vec![ClickCluster::new(x, y, evt.time_ms)];
        }
        return vec![];
    }

    let mut events = previous
        .filter(|_| events_in_range[0].time_ms > start_ms)
        .into_iter()
        .chain(events_in_range);
    let mut clusters = Vec::new();
    let first = events.next().unwrap();
    let (first_x, first_y) = map_uv(first.x, first.y);
    let mut current = ClickCluster::new(first_x, first_y, first.time_ms);

    for evt in events {
        let (x, y) = map_uv(evt.x, evt.y);
        if current.can_add(x, y, cluster_w, cluster_h) {
            current.add(x, y, evt.time_ms);
        } else {
            clusters.push(current);
            current = ClickCluster::new(x, y, evt.time_ms);
        }
    }
    clusters.push(current);

    clusters
}

/// One entry of the timeline-time -> recording-time mapping derived from
/// [`TimelineConfiguration::get_segment_time`]'s accumulation logic.
#[derive(Clone, Copy, PartialEq)]
struct TimeMapSegment {
    timeline_start: f64,
    timeline_end: f64,
    recording_start: f64,
    timescale: f64,
    recording_clip: u32,
}

fn build_time_map(timeline: Option<&TimelineConfiguration>) -> Vec<TimeMapSegment> {
    let Some(timeline) = timeline else {
        return Vec::new();
    };

    let mut map = Vec::with_capacity(timeline.segments.len());
    let mut accum = 0.0;
    for (segment_index, segment) in timeline.segments.iter().enumerate() {
        if !timeline.transitions.is_empty() {
            accum -= timeline
                .effective_transition(segment_index)
                .map_or(0.0, |transition| transition.duration);
        }
        let duration = segment.duration();
        if !duration.is_finite() || duration <= 0.0 {
            continue;
        }
        map.push(TimeMapSegment {
            timeline_start: accum,
            timeline_end: accum + duration,
            recording_start: segment.start,
            timescale: segment.timescale,
            recording_clip: segment.recording_clip,
        });
        accum += duration;
    }

    let holds = timeline.hold_windows();
    if holds.is_empty() {
        return map;
    }

    // Fullscreen text segments pause the recording clock: re-express the map
    // in held-output time, splitting entries at each hold and inserting a
    // timescale-0 (frozen) span so cursor-driven zoom aiming stays aligned
    // with what the display actually shows.
    let mut out = Vec::with_capacity(map.len() + holds.len());
    let mut hold_idx = 0usize;
    let mut shift = 0.0;
    for segment in map {
        let mut piece_start_out = segment.timeline_start + shift;
        let mut piece_start_rec = segment.recording_start;
        let mut remaining = segment.timeline_end - segment.timeline_start;
        while hold_idx < holds.len() {
            let (hold_start, hold_end) = holds[hold_idx];
            if hold_start >= piece_start_out + remaining {
                break;
            }
            if hold_start > piece_start_out {
                let len = hold_start - piece_start_out;
                out.push(TimeMapSegment {
                    timeline_start: piece_start_out,
                    timeline_end: hold_start,
                    recording_start: piece_start_rec,
                    timescale: segment.timescale,
                    recording_clip: segment.recording_clip,
                });
                piece_start_rec += len * segment.timescale;
                remaining -= len;
                piece_start_out = hold_start;
            }
            let hold_len = hold_end - hold_start;
            out.push(TimeMapSegment {
                timeline_start: piece_start_out,
                timeline_end: piece_start_out + hold_len,
                recording_start: piece_start_rec,
                timescale: 0.0,
                recording_clip: segment.recording_clip,
            });
            piece_start_out += hold_len;
            shift += hold_len;
            hold_idx += 1;
        }
        if remaining > 0.0 {
            out.push(TimeMapSegment {
                timeline_start: piece_start_out,
                timeline_end: piece_start_out + remaining,
                recording_start: piece_start_rec,
                timescale: segment.timescale,
                recording_clip: segment.recording_clip,
            });
        }
    }
    out
}

/// Maps a timeline timestamp to recording seconds. Identity when no timeline
/// is configured; clamps to the nearest edit boundary outside the timeline.
fn map_timeline_to_recording_secs(
    map: &[TimeMapSegment],
    timeline_secs: f64,
    recording_clip: Option<u32>,
    prefer_outgoing: bool,
) -> f64 {
    let Some(first) = map.first() else {
        return timeline_secs;
    };

    if timeline_secs <= first.timeline_start {
        return first.recording_start;
    }

    let contains = |segment: &&TimeMapSegment| {
        timeline_secs >= segment.timeline_start && timeline_secs < segment.timeline_end
    };
    let segment = recording_clip
        .and_then(|recording_clip| {
            if prefer_outgoing {
                map.iter()
                    .filter(contains)
                    .find(|segment| segment.recording_clip == recording_clip)
            } else {
                map.iter()
                    .rev()
                    .filter(contains)
                    .find(|segment| segment.recording_clip == recording_clip)
            }
        })
        .or_else(|| map.iter().rev().find(contains));
    if let Some(segment) = segment {
        return segment.recording_start
            + (timeline_secs - segment.timeline_start) * segment.timescale;
    }

    let last = map.last().expect("map is non-empty");
    last.recording_start + (last.timeline_end - last.timeline_start) * last.timescale
}

/// One precomputed step. Sample times are implicit: `samples[i]` is the state
/// at `i * STEP_MS`, so lookup is pure index math.
#[derive(Clone, Copy, Debug)]
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

/// Segments with a NaN bound can never be active, so they are left out of the
/// binary-searched index.
#[derive(Default)]
struct ZoomSegmentIndex {
    ordered: Vec<usize>,
    starts: Vec<f64>,
    /// Running maximum of `end`, so the first entry reaching `t` is also the
    /// first segment whose own end reaches `t`.
    max_ends: Vec<f64>,
    instant_windows: Vec<(f64, f64)>,
}

impl ZoomSegmentIndex {
    fn new(zoom_segments: &[ZoomSegment]) -> Self {
        let mut index = Self::default();
        let mut max_end = f64::NEG_INFINITY;
        for (i, segment) in zoom_segments.iter().enumerate() {
            if segment.instant_animation {
                index.instant_windows.push((
                    segment.start - INSTANT_SNAP_WINDOW_SECS,
                    segment.end + INSTANT_SNAP_WINDOW_SECS,
                ));
            }
            if segment.start.is_nan() || segment.end.is_nan() {
                continue;
            }
            max_end = max_end.max(segment.end);
            index.ordered.push(i);
            index.starts.push(segment.start);
            index.max_ends.push(max_end);
        }
        index
    }

    /// Same active predicate `SegmentsCursor` used: (start, end].
    fn active_at(&self, timeline_secs: f64) -> Option<usize> {
        let started = self.starts.partition_point(|&start| timeline_secs > start);
        let first_reaching = self
            .max_ends
            .partition_point(|&max_end| max_end < timeline_secs);
        (first_reaching < started).then(|| self.ordered[first_reaching])
    }

    fn snaps_at(&self, timeline_secs: f64) -> bool {
        self.instant_windows
            .iter()
            .any(|&(start, end)| timeline_secs >= start && timeline_secs <= end)
    }
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
    segment_index: ZoomSegmentIndex,
    /// Parallel to `zoom_segments`: prebuilt clusters (RECORDING-time ms) for
    /// Auto segments, `None` for Manual ones.
    clusters: Vec<Option<ZoomClusters>>,
    time_map: Vec<TimeMapSegment>,
    recording_clip: Option<u32>,
    prefer_outgoing: bool,
    /// Total number of samples covering [0, duration] plus one lerp partner.
    total_samples: usize,
}

struct RecordingClipSelection {
    recording_clip: Option<u32>,
    prefer_outgoing: bool,
}

impl ZoomTransformTimeline {
    pub fn new(
        zoom_segments: &[ZoomSegment],
        timeline: Option<&TimelineConfiguration>,
        cursor_events: &CursorEvents,
        spring: ScreenMovementSpring,
        duration_secs: f64,
        crop: Option<CursorCropMap>,
    ) -> Self {
        Self::new_for_recording_clip(
            zoom_segments,
            timeline,
            cursor_events,
            spring,
            duration_secs,
            CursorCropMaps {
                base: crop,
                styles: Vec::new(),
            },
            RecordingClipSelection {
                recording_clip: None,
                prefer_outgoing: false,
            },
        )
    }

    fn new_for_recording_clip(
        zoom_segments: &[ZoomSegment],
        timeline: Option<&TimelineConfiguration>,
        cursor_events: &CursorEvents,
        spring: ScreenMovementSpring,
        duration_secs: f64,
        crops: CursorCropMaps,
        selection: RecordingClipSelection,
    ) -> Self {
        let RecordingClipSelection {
            recording_clip,
            prefer_outgoing,
        } = selection;
        let mut zoom_segments = zoom_segments.to_vec();
        zoom_segments.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)));
        let segment_index = ZoomSegmentIndex::new(&zoom_segments);
        let moves_time_ordered = zoom_segments
            .iter()
            .any(|segment| matches!(segment.mode, ZoomMode::Auto))
            && cursor_events
                .moves
                .is_sorted_by(|a, b| a.time_ms <= b.time_ms);

        let time_map = if zoom_segments.is_empty() {
            Vec::new()
        } else {
            build_time_map(timeline)
        };
        let clusters = zoom_segments
            .iter()
            .map(|segment| match segment.mode {
                ZoomMode::Auto => {
                    let recording_start = map_timeline_to_recording_secs(
                        &time_map,
                        segment.start,
                        recording_clip,
                        prefer_outgoing,
                    );
                    let recording_end = map_timeline_to_recording_secs(
                        &time_map,
                        segment.end,
                        recording_clip,
                        prefer_outgoing,
                    )
                    .max(recording_start);
                    Some(ZoomClusters::new(
                        cursor_events,
                        moves_time_ordered,
                        recording_start,
                        recording_end,
                        segment,
                        &crops,
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
        let total_samples = ((duration_secs * 1000.0 / STEP_MS).ceil() as usize).saturating_add(2);
        if zoom_segments.is_empty() {
            return Self {
                samples: Vec::new(),
                state: None,
                zoom_segments,
                segment_index,
                clusters,
                time_map,
                recording_clip,
                prefer_outgoing,
                total_samples: 1,
            };
        }

        let spring_config = SpringMassDamperSimulationConfig {
            tension: spring.stiffness,
            mass: spring.mass,
            friction: spring.damping,
        };

        let mut timeline = Self {
            samples: Vec::new(),
            state: None,
            zoom_segments,
            segment_index,
            clusters,
            time_map,
            recording_clip,
            prefer_outgoing,
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

    /// Whether a project edit can keep zoom samples for unchanged recording
    /// data, screen dimensions, clip selection, and explicit duration.
    pub fn project_inputs_match(
        before: &ProjectConfiguration,
        after: &ProjectConfiguration,
        screen_size: XY<u32>,
    ) -> bool {
        let before_timeline = before.timeline.as_ref();
        let after_timeline = after.timeline.as_ref();
        let before_zooms = before_timeline
            .map(|timeline| timeline.zoom_segments.as_slice())
            .unwrap_or_default();
        let after_zooms = after_timeline
            .map(|timeline| timeline.zoom_segments.as_slice())
            .unwrap_or_default();
        let had_outgoing = before_timeline.is_some_and(|timeline| !timeline.transitions.is_empty());
        let needs_outgoing =
            after_timeline.is_some_and(|timeline| !timeline.transitions.is_empty());
        if before_zooms != after_zooms || had_outgoing != needs_outgoing {
            return false;
        }
        if before_zooms.is_empty() {
            return true;
        }

        before.screen_movement_spring == after.screen_movement_spring
            && before_timeline.map(TimelineConfiguration::duration)
                == after_timeline.map(TimelineConfiguration::duration)
            && build_time_map(before_timeline) == build_time_map(after_timeline)
            && CursorCropMaps::from_project(before, screen_size)
                == CursorCropMaps::from_project(after, screen_size)
    }

    /// Convenience constructor pulling zoom segments, edit mapping, spring
    /// config and crop mapping out of a [`ProjectConfiguration`].
    /// `screen_size` is the raw recorded display size in px
    /// (`RenderOptions::screen_size`), needed to normalize the project's
    /// pixel-space crop into cursor UV space.
    pub fn from_project(
        project: &ProjectConfiguration,
        cursor_events: &CursorEvents,
        duration_secs: f64,
        screen_size: XY<u32>,
    ) -> Self {
        Self::from_project_for_recording_clip(
            project,
            cursor_events,
            duration_secs,
            screen_size,
            None,
            false,
        )
    }

    pub fn from_project_for_clip(
        project: &ProjectConfiguration,
        cursor_events: &CursorEvents,
        duration_secs: f64,
        screen_size: XY<u32>,
        recording_clip: u32,
    ) -> Self {
        Self::from_project_for_recording_clip(
            project,
            cursor_events,
            duration_secs,
            screen_size,
            Some(recording_clip),
            false,
        )
    }

    pub fn from_project_for_outgoing_clip(
        project: &ProjectConfiguration,
        cursor_events: &CursorEvents,
        duration_secs: f64,
        screen_size: XY<u32>,
        recording_clip: u32,
    ) -> Self {
        Self::from_project_for_recording_clip(
            project,
            cursor_events,
            duration_secs,
            screen_size,
            Some(recording_clip),
            true,
        )
    }

    fn from_project_for_recording_clip(
        project: &ProjectConfiguration,
        cursor_events: &CursorEvents,
        duration_secs: f64,
        screen_size: XY<u32>,
        recording_clip: Option<u32>,
        prefer_outgoing: bool,
    ) -> Self {
        Self::new_for_recording_clip(
            project
                .timeline
                .as_ref()
                .map(|t| t.zoom_segments.as_slice())
                .unwrap_or(&[]),
            project.timeline.as_ref(),
            cursor_events,
            project.screen_movement_spring,
            duration_secs,
            CursorCropMaps::from_project(project, screen_size),
            RecordingClipSelection {
                recording_clip,
                prefer_outgoing,
            },
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
        let need_samples = ((need_ms / STEP_MS).ceil() as usize)
            .saturating_add(2)
            .min(self.total_samples);
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
            // While the amount spring sits at identity the viewport shows the
            // whole frame no matter where the center is — the center channel
            // is unobservable, so track its target instantly (free pre-aim).
            // An incoming zoom then launches already aimed at its focus and
            // scales straight toward it, instead of zooming about the stale
            // center and dragging over at high magnification (a huge late pan
            // that also detonated the motion blur). The epsilon bounds any
            // theoretical pop to sub-pixel: (amount - 1) * |center jump| of
            // the card, i.e. < 0.05% of the card size.
            if state.aux_sim.position.x <= CENTER_PREAIM_MAX_AMOUNT {
                state.center_sim.set_position(targets.center);
                state.center_sim.set_velocity(XY::new(0.0, 0.0));
            }
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
        let active = self.segment_index.active_at(timeline_secs);
        let snap = self.segment_index.snaps_at(timeline_secs);

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
                        let recording_ms = map_timeline_to_recording_secs(
                            &self.time_map,
                            timeline_secs,
                            self.recording_clip,
                            self.prefer_outgoing,
                        ) * 1000.0;
                        let focus = self.clusters[index]
                            .as_ref()
                            .and_then(|clusters| clusters.center_at(timeline_secs, recording_ms))
                            .unwrap_or(FALLBACK_FOCUS);
                        SegmentBounds::calculate_follow_center(
                            (focus.0.clamp(0.0, 1.0), focus.1.clamp(0.0, 1.0)),
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
        BackgroundConfiguration, ClipTransition, ClipTransitionType, CursorClickEvent,
        CursorMoveEvent, GlideDirection, StyleOverrides, StyleSegment, TimelineSegment, ZoomMode,
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
            None,
        )
    }

    fn project_with_crop_styles(
        zoom_segments: Vec<ZoomSegment>,
        style_segments: Vec<StyleSegment>,
    ) -> ProjectConfiguration {
        ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: Vec::new(),
                transitions: Vec::new(),
                zoom_segments,
                scene_segments: Vec::new(),
                style_segments,
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            ..Default::default()
        }
    }

    fn crop_style(start: f64, end: f64, track: u32, crop: Option<Crop>) -> StyleSegment {
        StyleSegment {
            start,
            end,
            track,
            overrides: StyleOverrides {
                background: Some(BackgroundConfiguration {
                    crop,
                    ..Default::default()
                }),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn assert_samples_identical(left: &ZoomTransformTimeline, right: &ZoomTransformTimeline) {
        assert_eq!(left.samples.len(), right.samples.len());
        for (index, (left, right)) in left.samples.iter().zip(&right.samples).enumerate() {
            assert_eq!(
                [left.amount, left.center.x, left.center.y, left.activity].map(f32::to_bits),
                [right.amount, right.center.x, right.center.y, right.activity].map(f32::to_bits),
                "sample {index}"
            );
            assert_eq!(left.snapped, right.snapped, "sample {index}");
        }
    }

    fn follow_center(focus: (f64, f64)) -> XY<f32> {
        let (x, y) = SegmentBounds::calculate_follow_center(focus, 0.25);
        XY::new(x as f32, y as f32)
    }

    fn project_for_zoom_reuse() -> ProjectConfiguration {
        let mut project = project_with_crop_styles(
            vec![auto_segment(0.5, 18.0, 2.0)],
            vec![crop_style(3.0, 8.0, 0, None)],
        );
        let timeline = project.timeline.as_mut().unwrap();
        timeline.segments = vec![
            TimelineSegment {
                end: 10.0,
                timescale: 1.0,
                ..Default::default()
            },
            TimelineSegment {
                recording_clip: 1,
                start: 5.0,
                end: 15.0,
                timescale: 1.0,
                ..Default::default()
            },
        ];
        timeline.transitions.push(ClipTransition {
            segment_index: 1,
            kind: ClipTransitionType::CrossFade,
            duration: 0.5,
        });
        timeline.text_segments.push(
            serde_json::from_value(serde_json::json!({
                "start": 4.0, "end": 5.0, "layout": "fullscreen"
            }))
            .unwrap(),
        );
        project
    }

    #[test]
    fn unrelated_project_edits_preserve_incoming_and_outgoing_zoom_samples() {
        let project = project_for_zoom_reuse();
        let mut edited = project.clone();
        edited.background.padding = 24.0;
        edited.camera.rounding = 0.75;
        edited.cursor.size = 150;
        let timeline = edited.timeline.as_mut().unwrap();
        timeline.segments[0].name = Some("Intro".to_string());
        timeline.segments[0].volume = Some(0.5);
        timeline.text_segments[0].content = "Edited title".to_string();
        timeline.style_segments[0]
            .overrides
            .background
            .as_mut()
            .unwrap()
            .rounding = 12.0;
        let screen = XY::new(1000, 1000);
        assert!(ZoomTransformTimeline::project_inputs_match(
            &project, &edited, screen
        ));

        let cursor = CursorEvents {
            moves: vec![
                move_event(0.0, 0.2, 0.8),
                move_event(4000.0, 0.4, 0.3),
                move_event(10000.0, 0.9, 0.7),
                move_event(18000.0, 0.3, 0.2),
            ],
            clicks: vec![click_event(1000.0), click_event(7000.0)],
        };
        let duration = project.timeline.as_ref().unwrap().duration();
        for recording_clip in [0, 1] {
            for outgoing in [false, true] {
                let build = |project| {
                    ZoomTransformTimeline::from_project_for_recording_clip(
                        project,
                        &cursor,
                        duration,
                        screen,
                        Some(recording_clip),
                        outgoing,
                    )
                };
                let mut retained = build(&project);
                retained.ensure_precomputed_until(5.0);
                let mut rebuilt = build(&edited);
                for time in [9.0, 4.0, 0.0, 17.0, duration as f32] {
                    retained.ensure_precomputed_until(time);
                    rebuilt.ensure_precomputed_until(time);
                    assert_samples_identical(&retained, &rebuilt);
                    assert_eq!(retained.sample(time).bounds, rebuilt.sample(time).bounds);
                }
            }
        }
    }

    #[test]
    fn zoom_inputs_invalidate_when_framing_or_timing_changes() {
        let project = project_for_zoom_reuse();
        let changes: [fn(&mut ProjectConfiguration); 9] = [
            |project| project.timeline.as_mut().unwrap().zoom_segments[0].amount = 3.0,
            |project| project.screen_movement_spring.stiffness += 1.0,
            |project| {
                project.background.crop = Some(Crop {
                    position: XY::new(100, 0),
                    size: XY::new(500, 1000),
                });
            },
            |project| {
                project.timeline.as_mut().unwrap().style_segments[0]
                    .overrides
                    .background
                    .as_mut()
                    .unwrap()
                    .crop = Some(Crop {
                    position: XY::new(0, 100),
                    size: XY::new(1000, 500),
                });
            },
            |project| {
                let segment = &mut project.timeline.as_mut().unwrap().segments[0];
                segment.start += 1.0;
                segment.end += 1.0;
            },
            |project| project.timeline.as_mut().unwrap().segments[0].timescale = 2.0,
            |project| project.timeline.as_mut().unwrap().segments[0].recording_clip = 1,
            |project| project.timeline.as_mut().unwrap().transitions[0].duration = 0.75,
            |project| {
                project.timeline.as_mut().unwrap().text_segments.push(
                    serde_json::from_value(serde_json::json!({
                        "start": 50.0, "end": 52.0, "layout": "fullscreen"
                    }))
                    .unwrap(),
                );
            },
        ];
        for (index, change) in changes.into_iter().enumerate() {
            let mut edited = project.clone();
            change(&mut edited);
            assert!(
                !ZoomTransformTimeline::project_inputs_match(
                    &project,
                    &edited,
                    XY::new(1000, 1000)
                ),
                "change {index} reused stale zoom samples"
            );
        }
    }

    #[test]
    fn empty_zoom_tracks_still_refresh_outgoing_timeline_availability() {
        let mut before = project_for_zoom_reuse();
        before.timeline.as_mut().unwrap().zoom_segments.clear();
        let mut after = before.clone();
        after.timeline.as_mut().unwrap().transitions.clear();
        let screen = XY::new(1000, 1000);

        assert!(!ZoomTransformTimeline::project_inputs_match(
            &before, &after, screen
        ));
        assert!(!ZoomTransformTimeline::project_inputs_match(
            &after, &before, screen
        ));
        let no_transitions = after.clone();
        after.background.padding = 24.0;
        assert!(ZoomTransformTimeline::project_inputs_match(
            &no_transitions,
            &after,
            screen
        ));
    }

    #[test]
    fn style_crop_retargets_auto_focus_at_start_and_restores_at_end() {
        let project = project_with_crop_styles(
            vec![auto_segment(0.5, 9.0, 2.0)],
            vec![crop_style(
                2.0,
                5.0,
                0,
                Some(Crop {
                    position: XY::new(0, 500),
                    size: XY::new(1000, 500),
                }),
            )],
        );
        let cursor = CursorEvents {
            moves: vec![move_event(0.0, 0.5, 0.75)],
            clicks: Vec::new(),
        };
        let mut timeline =
            ZoomTransformTimeline::from_project(&project, &cursor, 10.0, XY::new(1000, 1000));
        for (time, expected_y) in [(1.999, 0.75), (2.0, 0.5), (4.999, 0.5), (5.0, 0.75)] {
            assert_eq!(
                timeline.targets_at(time, XY::new(0.5, 0.5)).center,
                follow_center((0.5, expected_y)),
                "focus at {time}"
            );
        }
        timeline.precompute();
        let centered = SegmentBounds::from_amount_center(2.0, XY::new(0.5, 0.5));
        assert!((timeline.sample(4.5).bounds.top_left.y - centered.top_left.y).abs() < 1e-3);
        let bottom = SegmentBounds::from_amount_center(2.0, XY::new(0.5, 1.0));
        assert!((timeline.sample(7.5).bounds.top_left.y - bottom.top_left.y).abs() < 1e-3);
    }

    #[test]
    fn style_crop_focus_matches_model_precedence_and_explicit_crop_removal() {
        let bottom = Crop {
            position: XY::new(0, 500),
            size: XY::new(1000, 500),
        };
        let left = Crop {
            position: XY::new(0, 0),
            size: XY::new(500, 1000),
        };
        let mut disabled = crop_style(0.0, 10.0, 99, Some(left.clone()));
        disabled.enabled = false;
        let project = ProjectConfiguration {
            background: BackgroundConfiguration {
                crop: Some(left.clone()),
                ..Default::default()
            },
            ..project_with_crop_styles(
                vec![auto_segment(0.0, 9.0, 2.0)],
                vec![
                    crop_style(2.0, 6.0, 2, Some(bottom.clone())),
                    crop_style(3.0, 7.0, 0, None),
                    crop_style(1.0, 8.0, 2, Some(left.clone())),
                    crop_style(2.0, 4.0, 2, None),
                    crop_style(0.0, 9.0, 1, Some(left.clone())),
                    crop_style(-0.0, 9.0, 1, Some(bottom.clone())),
                    disabled,
                    crop_style(-1.0, 10.0, 99, None),
                    crop_style(0.0, f64::INFINITY, 99, None),
                    StyleSegment {
                        end: 10.0,
                        track: 99,
                        overrides: StyleOverrides {
                            camera_only_padding: Some(20.0),
                            ..Default::default()
                        },
                        ..Default::default()
                    },
                ],
            )
        };
        let cursor = CursorEvents {
            moves: vec![move_event(0.0, 0.4, 0.75)],
            clicks: Vec::new(),
        };
        let timeline =
            ZoomTransformTimeline::from_project(&project, &cursor, 10.0, XY::new(1000, 1000));
        for time in [0.5, 1.0, 1.999, 2.0, 3.0, 4.0, 6.0, 7.0, 8.0, 9.0] {
            let resolved = project.style_at(time);
            let crop = resolved
                .background
                .crop
                .as_ref()
                .and_then(|crop| CursorCropMap::from_crop(crop, XY::new(1000, 1000)));
            let reference = ZoomTransformTimeline::new(
                &project.timeline.as_ref().unwrap().zoom_segments,
                project.timeline.as_ref(),
                &cursor,
                project.screen_movement_spring,
                10.0,
                crop,
            );
            assert_eq!(
                timeline.targets_at(time, XY::new(0.5, 0.5)).center,
                reference.targets_at(time, XY::new(0.5, 0.5)).center,
                "style precedence at {time}"
            );
        }
        let Some(ZoomClusters::Styled { variants, .. }) = &timeline.clusters[0] else {
            panic!("Crop styles must produce timed cluster variants");
        };
        assert_eq!(variants.len(), 3);
    }

    #[test]
    fn style_crop_rebuilds_cluster_dead_zones_in_content_space() {
        let project = project_with_crop_styles(
            vec![auto_segment(0.5, 8.0, 2.0)],
            vec![crop_style(
                1.0,
                6.0,
                0,
                Some(Crop {
                    position: XY::new(250, 0),
                    size: XY::new(500, 1000),
                }),
            )],
        );
        let cursor = CursorEvents {
            moves: vec![move_event(1000.0, 0.4, 0.5), move_event(2000.0, 0.6, 0.5)],
            clicks: Vec::new(),
        };
        let timeline =
            ZoomTransformTimeline::from_project(&project, &cursor, 10.0, XY::new(1000, 1000));
        let expected = SegmentBounds::calculate_follow_center((0.3, 0.5), 0.25);
        assert!(
            (f64::from(timeline.targets_at(1.5, XY::new(0.5, 0.5)).center.x) - expected.0).abs()
                < 1e-6
        );
        let base = timeline_for(
            &project.timeline.as_ref().unwrap().zoom_segments,
            &cursor,
            10.0,
        );
        assert_eq!(
            base.targets_at(1.5, XY::new(0.5, 0.5)).center,
            follow_center((0.5, 0.5))
        );
    }

    #[test]
    fn style_crop_uses_output_time_with_trimmed_and_transitioning_recordings() {
        let mut project = project_with_crop_styles(
            vec![auto_segment(0.5, 5.0, 2.0)],
            vec![crop_style(
                1.0,
                4.0,
                0,
                Some(Crop {
                    position: XY::new(0, 500),
                    size: XY::new(1000, 500),
                }),
            )],
        );
        let config = project.timeline.as_mut().unwrap();
        config.segments = vec![
            TimelineSegment {
                recording_clip: 0,
                timescale: 2.0,
                start: 10.0,
                end: 14.0,
                name: None,
                speed_audio_mode: None,
                hide_cursor: None,
                volume: None,
            },
            TimelineSegment {
                recording_clip: 0,
                timescale: 1.0,
                start: 30.0,
                end: 34.0,
                name: None,
                speed_audio_mode: None,
                hide_cursor: None,
                volume: None,
            },
        ];
        config.transitions = vec![ClipTransition {
            segment_index: 1,
            kind: ClipTransitionType::CrossFade,
            duration: 0.5,
        }];
        let cursor = CursorEvents {
            moves: vec![
                move_event(11000.0, 0.5, 0.75),
                move_event(30000.0, 0.5, 0.1),
            ],
            clicks: Vec::new(),
        };
        let incoming = ZoomTransformTimeline::from_project_for_clip(
            &project,
            &cursor,
            6.0,
            XY::new(1000, 1000),
            0,
        );
        let outgoing = ZoomTransformTimeline::from_project_for_outgoing_clip(
            &project,
            &cursor,
            6.0,
            XY::new(1000, 1000),
            0,
        );
        assert_eq!(
            incoming.targets_at(0.999, XY::new(0.5, 0.5)).center,
            follow_center((0.5, 0.75))
        );
        assert_eq!(
            incoming.targets_at(1.0, XY::new(0.5, 0.5)).center,
            follow_center((0.5, 0.5))
        );
        assert_eq!(incoming.targets_at(1.75, XY::new(0.5, 0.5)).center.y, 0.0);
        assert_eq!(
            outgoing.targets_at(1.75, XY::new(0.5, 0.5)).center,
            follow_center((0.5, 0.5))
        );
    }

    #[test]
    fn crop_styles_preserve_manual_zoom_and_the_static_no_style_path() {
        let crop = Crop {
            position: XY::new(0, 500),
            size: XY::new(1000, 500),
        };
        let cursor = CursorEvents {
            moves: vec![move_event(1000.0, 0.3, 0.7), move_event(3000.0, 0.8, 0.9)],
            clicks: Vec::new(),
        };
        for (segments, styles) in [
            (vec![auto_segment(0.5, 8.0, 2.0)], Vec::new()),
            (
                vec![auto_segment(0.5, 8.0, 2.0)],
                vec![crop_style(1.0, 6.0, 0, Some(crop.clone()))],
            ),
            (
                vec![manual_segment(0.5, 8.0, 2.0, 0.2, 0.8)],
                vec![crop_style(1.0, 6.0, 0, None)],
            ),
            (Vec::new(), vec![crop_style(1.0, 6.0, 0, None)]),
        ] {
            let project = ProjectConfiguration {
                background: BackgroundConfiguration {
                    crop: Some(crop.clone()),
                    ..Default::default()
                },
                ..project_with_crop_styles(segments.clone(), styles)
            };
            let mut styled =
                ZoomTransformTimeline::from_project(&project, &cursor, 10.0, XY::new(1000, 1000));
            let mut reference = ZoomTransformTimeline::new(
                &segments,
                project.timeline.as_ref(),
                &cursor,
                project.screen_movement_spring,
                10.0,
                CursorCropMap::from_crop(&crop, XY::new(1000, 1000)),
            );
            assert!(
                styled
                    .clusters
                    .iter()
                    .all(|clusters| matches!(clusters, None | Some(ZoomClusters::Static(_))))
            );
            styled.precompute();
            reference.precompute();
            assert_samples_identical(&styled, &reference);
        }
    }

    #[test]
    fn style_crop_boundaries_are_identical_during_playback_and_seeking() {
        let project = project_with_crop_styles(
            vec![
                auto_segment(0.5, 7.0, 2.0),
                manual_segment(7.0, 9.0, 3.0, 0.2, 0.8),
            ],
            vec![
                crop_style(
                    2.0,
                    5.0,
                    0,
                    Some(Crop {
                        position: XY::new(0, 500),
                        size: XY::new(1000, 500),
                    }),
                ),
                crop_style(3.0, 4.0, 1, None),
            ],
        );
        let cursor = CursorEvents {
            moves: vec![
                move_event(0.0, 0.4, 0.75),
                move_event(2500.0, 0.9, 0.1),
                move_event(5500.0, 0.2, 0.65),
            ],
            clicks: Vec::new(),
        };
        let build =
            || ZoomTransformTimeline::from_project(&project, &cursor, 10.0, XY::new(1000, 1000));
        let mut sequential = build();
        for frame in 0..=600 {
            sequential.ensure_precomputed_until(frame as f32 / 60.0);
        }
        let mut seeked = build();
        for time in [7.75, 2.0, 1.999, 5.0, 3.0, 4.0, 9.0, 0.0, 10.0] {
            seeked.ensure_precomputed_until(time);
            let expected = sequential.sample(time);
            let actual = seeked.sample(time);
            assert_eq!(actual.bounds, expected.bounds, "seek to {time}");
            assert_eq!(actual.t.to_bits(), expected.t.to_bits(), "seek to {time}");
        }
        assert_samples_identical(&sequential, &seeked);
    }

    #[test]
    fn empty_zoom_timeline_stays_constant_without_precompute_work() {
        let mut timeline = timeline_for(&[], &CursorEvents::default(), 60.0 * 60.0);
        for seconds in [
            f32::NEG_INFINITY,
            -1.0,
            -0.0,
            0.0,
            0.5,
            60.0 * 60.0,
            f32::MAX,
            f32::INFINITY,
            f32::NAN,
        ] {
            timeline.ensure_precomputed_until(seconds);
            timeline.precompute();
            let sample = timeline.sample(seconds);
            assert_eq!(
                [
                    sample.t,
                    sample.bounds.top_left.x,
                    sample.bounds.top_left.y,
                    sample.bounds.bottom_right.x,
                    sample.bounds.bottom_right.y,
                ]
                .map(f64::to_bits),
                [0.0, 0.0, 0.0, 1.0, 1.0].map(f64::to_bits)
            );
            assert!(!timeline.snapped_within(seconds, 0.0));
        }

        assert!(timeline.state.is_none());
    }

    /// Max |value delta| and |slope delta| between adjacent 8ms sample
    /// intervals across the whole precomputed range, measured on the VISIBLE
    /// viewport rect (bounds corners + amount), not the latent channels: the
    /// center channel deliberately snaps to its target while the amount sits
    /// at identity (free pre-aim, geometrically invisible), and bounds are
    /// what the renderer — and the motion-blur velocity analysis — consume.
    fn max_step_discontinuities(timeline: &ZoomTransformTimeline) -> (f64, f64) {
        let step_secs = STEP_MS / 1000.0;
        let values: Vec<[f64; 5]> = timeline
            .samples
            .iter()
            .map(|s| {
                let bounds = SegmentBounds::from_amount_center(
                    f64::from(s.amount),
                    XY::new(f64::from(s.center.x), f64::from(s.center.y)),
                );
                [
                    f64::from(s.amount),
                    bounds.top_left.x,
                    bounds.top_left.y,
                    bounds.bottom_right.x,
                    bounds.bottom_right.y,
                ]
            })
            .collect();

        let mut max_value_jump = 0.0f64;
        let mut max_slope_jump = 0.0f64;
        for window in values.windows(3) {
            for ((v0, v1), v2) in window[0].iter().zip(&window[1]).zip(&window[2]) {
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

    /// Raw-UV viewport of a sampled zoom: (left, top, size).
    fn visible_viewport(zoom: &InterpolatedZoom) -> (f64, f64, f64) {
        let amount = zoom.display_amount();
        (
            -zoom.bounds.top_left.x / amount,
            -zoom.bounds.top_left.y / amount,
            1.0 / amount,
        )
    }

    #[test]
    fn auto_zoom_uses_position_at_segment_start_over_earlier_movement() {
        let cursor = CursorEvents {
            moves: vec![
                move_event(0.0, 0.9, 0.9),
                move_event(2000.0, 0.1, 0.1),
                move_event(6000.0, 0.9, 0.9),
            ],
            clicks: Vec::new(),
        };
        for ordered in [false, true] {
            let clusters = build_clusters(&cursor, ordered, 2.0, 10.0, 2.0, None);
            assert_eq!(
                ClusterCenters::new(clusters).center_at(2000.0),
                Some((0.1, 0.1))
            );
        }
    }

    #[test]
    fn auto_zoom_keeps_idle_cursor_visible_until_movement_resumes() {
        for (recording_start, timescale) in [(0.0, 1.0), (10.0, 2.0)] {
            let segment = auto_segment(2.0, 10.0, 2.0);
            let mut project = project_with_crop_styles(vec![segment], Vec::new());
            project.timeline.as_mut().unwrap().segments = vec![TimelineSegment {
                recording_clip: 0,
                start: recording_start,
                end: recording_start + 12.0 * timescale,
                timescale,
                name: None,
                speed_audio_mode: None,
                hide_cursor: None,
                volume: None,
            }];
            let cursor = CursorEvents {
                moves: vec![
                    move_event(recording_start * 1000.0, 0.1, 0.1),
                    move_event((recording_start + 6.0 * timescale) * 1000.0, 0.9, 0.9),
                ],
                clicks: Vec::new(),
            };
            let mut timeline = ZoomTransformTimeline::from_project_for_clip(
                &project,
                &cursor,
                12.0,
                XY::new(1920, 1080),
                0,
            );
            timeline.precompute();

            for (time, position) in [(4.0, 0.1), (8.0, 0.9)] {
                let zoom = timeline.sample(time);
                let (left, top, size) = visible_viewport(&zoom);
                assert!(
                    (left..=left + size).contains(&position)
                        && (top..=top + size).contains(&position),
                    "cursor {position} outside viewport at {time}s: {zoom:?}, source start={recording_start}, speed={timescale}"
                );
            }
        }
    }

    #[test]
    fn hovering_into_a_corner_re_aims_without_a_click() {
        // Regression for the real-recording report: clicks early near the
        // center, then the cursor HOVERS (no click) into the bottom-right
        // corner mid-segment. All movement participates in clustering, so
        // leaving the dead-zone box must re-aim the camera and bring the
        // hovered corner into the settled viewport.
        let corner = (0.95, 0.9);
        let mut moves = Vec::new();
        for i in 0..50 {
            moves.push(move_event(i as f64 * 100.0, 0.5, 0.5));
        }
        for i in 0..=20 {
            let t = i as f64 / 20.0;
            moves.push(move_event(
                5000.0 + t * 1000.0,
                0.5 + (corner.0 - 0.5) * t,
                0.5 + (corner.1 - 0.5) * t,
            ));
        }
        for i in 1..=30 {
            moves.push(move_event(6000.0 + i as f64 * 200.0, corner.0, corner.1));
        }
        let cursor = CursorEvents {
            moves,
            clicks: vec![click_event(1500.0), click_event(2000.0)],
        };
        let segments = vec![auto_segment(1.0, 15.1, 2.0)];
        let mut timeline = timeline_for(&segments, &cursor, 16.0);
        timeline.precompute();

        // Two seconds after arriving in the corner the spring has settled.
        let settled = timeline.sample(8.0);
        let (left, top, size) = visible_viewport(&settled);
        assert!(
            corner.0 >= left && corner.0 <= left + size,
            "hovered corner x {} outside viewport [{left}, {}]",
            corner.0,
            left + size
        );
        assert!(
            corner.1 >= top && corner.1 <= top + size,
            "hovered corner y {} outside viewport [{top}, {}]",
            corner.1,
            top + size
        );

        // And the framing genuinely moved from the early click-cluster view.
        let early = timeline.sample(4.0);
        let (early_left, early_top, _) = visible_viewport(&early);
        assert!(
            (left - early_left).abs() > 0.1 || (top - early_top).abs() > 0.1,
            "camera never re-aimed toward the hovered corner"
        );
        assert_viewport_in_bounds(&settled, "corner hover settle");
    }

    #[test]
    fn hostile_cursor_data_never_breaks_the_timeline() {
        // Simulated/corrupted input: NaN and infinite coordinates, positions
        // far outside the crop (cursor on another monitor), and full-screen
        // teleports between consecutive events (automation tools). The
        // timeline must stay finite, in bounds and smooth throughout.
        let moves = vec![
            move_event(0.0, 0.5, 0.5),
            move_event(500.0, f64::NAN, 0.5),
            move_event(600.0, 0.5, f64::INFINITY),
            move_event(1000.0, -3.0, 7.5),
            move_event(1500.0, 0.02, 0.98),
            move_event(1550.0, 0.98, 0.02),
            move_event(1600.0, 0.02, 0.02),
            move_event(1650.0, 0.98, 0.98),
            move_event(4000.0, 1.4, -0.4),
            move_event(8000.0, 0.5, 0.5),
        ];
        let cursor = CursorEvents {
            moves,
            clicks: vec![click_event(f64::NAN), click_event(1500.0)],
        };
        let segments = vec![auto_segment(0.5, 9.0, 2.0)];
        let mut timeline = timeline_for(&segments, &cursor, 10.0);
        timeline.precompute();

        for sample in &timeline.samples {
            assert!(
                sample.amount.is_finite()
                    && sample.center.x.is_finite()
                    && sample.center.y.is_finite()
                    && sample.activity.is_finite(),
                "non-finite sample: {sample:?}"
            );
        }
        let mut t = 0.0f32;
        while t <= 10.0 {
            let zoom = timeline.sample(t);
            assert!(
                zoom.bounds.top_left.x.is_finite() && zoom.bounds.bottom_right.y.is_finite(),
                "non-finite bounds at t={t}"
            );
            assert_viewport_in_bounds(&zoom, &format!("hostile input at t={t}"));
            t += 0.037;
        }
        let (max_value_jump, _) = max_step_discontinuities(&timeline);
        assert!(
            max_value_jump < 0.08,
            "teleporting input caused a visible jump: {max_value_jump}"
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
                SegmentBounds::calculate_follow_center(FALLBACK_FOCUS, 0.25).0,
                SegmentBounds::calculate_follow_center(FALLBACK_FOCUS, 0.25).1,
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
    fn manual_corner_zoom_launches_already_aimed() {
        // A manual zoom to the top-left corner must scale straight into the
        // corner from the first visible frame — not zoom about the stale
        // (centered) framing and pan over at high magnification. While the
        // amount is at identity the center is unobservable, so the timeline
        // pre-aims it; with a corner-flush target (0,0) the viewport's
        // top-left then stays pinned to the content's top-left for the whole
        // ramp.
        let cursor = CursorEvents::default();
        let segments = vec![manual_segment(1.0, 5.0, 2.862, 0.0, 0.0)];
        let mut timeline = timeline_for(&segments, &cursor, 6.0);
        timeline.precompute();

        for t in [1.05f32, 1.2, 1.5, 2.0, 3.0] {
            let z = timeline.sample(t);
            assert!(
                z.bounds.top_left.x.abs() < 5e-3 && z.bounds.top_left.y.abs() < 5e-3,
                "viewport must stay corner-anchored during the ramp at t={t}: {:?}",
                z.bounds
            );
        }

        // Guard against the assertion above passing trivially (identity
        // bounds also have top_left = 0): the zoom must actually engage and
        // settle on the full manual amount.
        let settled = timeline.sample(4.5);
        assert!(
            (settled.display_amount() - 2.862).abs() < 1e-2,
            "zoom failed to settle on the manual amount: {}",
            settled.display_amount()
        );

        // And the pre-aim must never cause a visible pop: the viewport stays
        // continuous across the segment start. Thresholds mirror the other
        // continuity tests — a 2.862x ramp legitimately sweeps ~0.054/step at
        // peak spring velocity, while a center pop at (say) amount 1.5 would
        // jump ~0.25 in one step.
        let (max_value_jump, max_slope_jump) = max_step_discontinuities(&timeline);
        assert!(
            max_value_jump < 0.1,
            "pre-aim introduced a step discontinuity: {max_value_jump}"
        );
        assert!(
            max_slope_jump < 4.0,
            "pre-aim introduced a velocity discontinuity: {max_slope_jump}/s"
        );
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

    fn benchmark_project(duration_secs: f64, zoom_count: usize) -> ProjectConfiguration {
        let spacing = duration_secs / zoom_count as f64;
        let zoom_segments = (0..zoom_count)
            .map(|i| {
                let start = i as f64 * spacing + spacing * 0.25;
                auto_segment(start, start + 4.0, 2.0)
            })
            .collect();
        let mut project = project_with_crop_styles(zoom_segments, Vec::new());
        if let Some(timeline) = project.timeline.as_mut() {
            timeline.segments.push(TimelineSegment {
                recording_clip: 0,
                timescale: 1.0,
                start: 0.0,
                end: duration_secs,
                name: None,
                speed_audio_mode: None,
                volume: None,
                hide_cursor: None,
            });
        }
        project
    }

    fn benchmark_cursor(duration_secs: f64) -> CursorEvents {
        let moves = (0..(duration_secs * 60.0) as usize)
            .map(|i| {
                move_event(
                    i as f64 * 1000.0 / 60.0,
                    ((i as f64 * 0.0011).sin() + 1.0) / 2.0,
                    ((i as f64 * 0.0007).cos() + 1.0) / 2.0,
                )
            })
            .collect();
        CursorEvents {
            moves,
            clicks: Vec::new(),
        }
    }

    fn samples_hash(timeline: &ZoomTransformTimeline) -> u64 {
        timeline
            .samples
            .iter()
            .fold(0xcbf2_9ce4_8422_2325, |hash, sample| {
                [
                    sample.amount.to_bits(),
                    sample.center.x.to_bits(),
                    sample.center.y.to_bits(),
                    sample.activity.to_bits(),
                    u32::from(sample.snapped),
                ]
                .into_iter()
                .fold(hash, |hash, word| {
                    (hash ^ u64::from(word)).wrapping_mul(0x0100_0000_01b3)
                })
            })
    }

    #[test]
    #[ignore = "benchmark; run with --release --ignored --nocapture"]
    fn benchmark_zoom_timeline_rebuild() {
        use std::time::{Duration, Instant};

        const RUNS: usize = 15;
        let screen_size = XY::new(1920, 1080);
        let percentile = |times: &mut Vec<Duration>, p: f64| {
            times.sort_unstable();
            let index = ((times.len() - 1) as f64 * p).round() as usize;
            times[index].as_secs_f64() * 1000.0
        };

        println!(
            "| recording | auto zooms | playhead | build p50 | precompute p50 | rebuild p50 | rebuild p95 | samples hash |"
        );
        println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
        for (minutes, zoom_count) in [(10.0, 20), (30.0, 60), (60.0, 120)] {
            let duration_secs = minutes * 60.0;
            let project = benchmark_project(duration_secs, zoom_count);
            let cursor = benchmark_cursor(duration_secs);
            for playhead_fraction in [0.5, 1.0] {
                let playhead = (duration_secs * playhead_fraction) as f32;
                let mut build_times = Vec::with_capacity(RUNS);
                let mut precompute_times = Vec::with_capacity(RUNS);
                let mut rebuild_times = Vec::with_capacity(RUNS);
                let mut checksum = 0.0f64;
                let mut hash = 0;
                for _ in 0..RUNS {
                    let build_start = Instant::now();
                    let mut timeline = ZoomTransformTimeline::from_project_for_clip(
                        &project,
                        &cursor,
                        duration_secs,
                        screen_size,
                        0,
                    );
                    let build_elapsed = build_start.elapsed();
                    let precompute_start = Instant::now();
                    timeline.ensure_precomputed_until(playhead);
                    let precompute_elapsed = precompute_start.elapsed();
                    checksum += timeline.sample(playhead).display_amount();
                    hash = samples_hash(&timeline);
                    build_times.push(build_elapsed);
                    precompute_times.push(precompute_elapsed);
                    rebuild_times.push(build_elapsed + precompute_elapsed);
                }
                std::hint::black_box(checksum);
                println!(
                    "| {minutes} min | {zoom_count} | {:.0}% | {:.3} ms | {:.3} ms | {:.3} ms | {:.3} ms | {hash:016x} |",
                    playhead_fraction * 100.0,
                    percentile(&mut build_times, 0.5),
                    percentile(&mut precompute_times, 0.5),
                    percentile(&mut rebuild_times, 0.5),
                    percentile(&mut rebuild_times, 0.95),
                );
            }
        }
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
                speed_audio_mode: None,
                hide_cursor: None,
                volume: None,
            }],
            transitions: vec![],
            zoom_segments: vec![],
            scene_segments: vec![],
            style_segments: vec![],
            image_segments: vec![],
            mask_segments: vec![],
            text_segments: vec![],
            caption_segments: vec![],
            keyboard_segments: vec![],
            audio_segments: vec![],
            camera3d_segments: Vec::new(),
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
            None,
        );
        timeline.precompute();

        // Settled framing aims at the in-edit click (0.9, 0.9), not (0.05, 0.05).
        let settled = timeline.sample(6.0);
        let toward_bottom_right = SegmentBounds::from_amount_center(
            2.0,
            XY::new(
                SegmentBounds::calculate_follow_center((0.9, 0.9), 0.25).0,
                SegmentBounds::calculate_follow_center((0.9, 0.9), 0.25).1,
            ),
        );
        assert!(
            (settled.bounds.top_left.x - toward_bottom_right.top_left.x).abs() < 1e-2,
            "expected framing near {:?}, got {:?}",
            toward_bottom_right,
            settled.bounds
        );
    }

    #[test]
    fn timeline_mapping_uses_incoming_source_during_transition() {
        let timeline = TimelineConfiguration {
            segments: vec![
                TimelineSegment {
                    recording_clip: 0,
                    timescale: 1.0,
                    start: 0.0,
                    end: 4.0,
                    name: None,
                    speed_audio_mode: None,
                    hide_cursor: None,
                    volume: None,
                },
                TimelineSegment {
                    recording_clip: 0,
                    timescale: 1.0,
                    start: 10.0,
                    end: 14.0,
                    name: None,
                    speed_audio_mode: None,
                    hide_cursor: None,
                    volume: None,
                },
            ],
            transitions: vec![ClipTransition {
                segment_index: 1,
                kind: ClipTransitionType::CrossFade,
                duration: 0.5,
            }],
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            style_segments: Vec::new(),
            image_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            camera3d_segments: Vec::new(),
        };
        let map = build_time_map(Some(&timeline));

        assert_eq!(
            map_timeline_to_recording_secs(&map, 3.25, None, false),
            3.25
        );
        assert_eq!(
            map_timeline_to_recording_secs(&map, 3.75, None, false),
            10.25
        );
        assert_eq!(
            map_timeline_to_recording_secs(&map, 3.75, Some(0), false),
            10.25
        );
        assert_eq!(
            map_timeline_to_recording_secs(&map, 3.75, Some(0), true),
            3.75
        );
    }

    #[test]
    fn crop_map_identity_cases() {
        let screen = XY::new(1000u32, 1000u32);
        // Full-screen crop is the identity: no map.
        let full = Crop {
            position: XY::new(0, 0),
            size: XY::new(1000, 1000),
        };
        assert!(CursorCropMap::from_crop(&full, screen).is_none());
        // Degenerate inputs never produce a map.
        let degenerate = Crop {
            position: XY::new(0, 0),
            size: XY::new(0, 500),
        };
        assert!(CursorCropMap::from_crop(&degenerate, screen).is_none());
        assert!(CursorCropMap::from_crop(&full, XY::new(0, 0)).is_none());
    }

    #[test]
    fn crop_remaps_auto_zoom_focus_into_content_space() {
        // Screen 1000x1000 cropped to the bottom half: content = y 500..1000.
        let crop = Crop {
            position: XY::new(0, 500),
            size: XY::new(1000, 500),
        };
        let map = CursorCropMap::from_crop(&crop, XY::new(1000, 1000)).unwrap();

        // Cursor parked at raw (0.5, 0.75) = the exact CENTER of the visible
        // content. Uncropped this raw y would edge-snap to a bottom-flush
        // framing; content-space it must settle centered.
        let cursor = CursorEvents {
            moves: vec![move_event(0.0, 0.5, 0.75), move_event(8_000.0, 0.5, 0.75)],
            clicks: vec![],
        };
        let segments = vec![auto_segment(0.5, 8.0, 2.0)];
        let mut with_crop = ZoomTransformTimeline::new(
            &segments,
            None,
            &cursor,
            ScreenMovementSpring::default(),
            10.0,
            Some(map),
        );
        with_crop.precompute();

        let settled = with_crop.sample(6.0);
        let centered = SegmentBounds::from_amount_center(2.0, XY::new(0.5, 0.5));
        assert!(
            (settled.bounds.top_left.y - centered.top_left.y).abs() < 1e-2,
            "expected centered framing {:?}, got {:?}",
            centered,
            settled.bounds
        );

        let mut without_crop = timeline_for(&segments, &cursor, 10.0);
        without_crop.precompute();
        let raw_settled = without_crop.sample(6.0);
        assert!(
            (raw_settled.bounds.top_left.y - centered.top_left.y).abs() > 0.2,
            "control: uncropped framing should NOT be centered, got {:?}",
            raw_settled.bounds
        );
    }

    #[test]
    fn cursor_in_cropped_away_region_aims_at_content_edge() {
        // Bottom-half crop; the cursor hovers in the removed TOP strip
        // (raw y = 0.05 -> content y < 0). The framing must clamp to a
        // top-flush viewport, not wander or blow up.
        let crop = Crop {
            position: XY::new(0, 500),
            size: XY::new(1000, 500),
        };
        let map = CursorCropMap::from_crop(&crop, XY::new(1000, 1000)).unwrap();

        let cursor = CursorEvents {
            moves: vec![move_event(0.0, 0.5, 0.05), move_event(8_000.0, 0.5, 0.05)],
            clicks: vec![],
        };
        let segments = vec![auto_segment(0.5, 8.0, 2.0)];
        let mut timeline = ZoomTransformTimeline::new(
            &segments,
            None,
            &cursor,
            ScreenMovementSpring::default(),
            10.0,
            Some(map),
        );
        timeline.precompute();

        let settled = timeline.sample(6.0);
        let top_flush = SegmentBounds::from_amount_center(2.0, XY::new(0.5, 0.0));
        assert!(
            (settled.bounds.top_left.y - top_flush.top_left.y).abs() < 1e-2,
            "expected top-flush framing {:?}, got {:?}",
            top_flush,
            settled.bounds
        );
    }

    #[test]
    fn segment_index_matches_linear_segment_scan() {
        let mut instant = manual_segment(4.0, 4.5, 2.0, 0.5, 0.5);
        instant.instant_animation = true;
        let mut instant_nan = manual_segment(f64::NAN, 9.0, 2.0, 0.5, 0.5);
        instant_nan.instant_animation = true;
        let cases = [
            vec![],
            vec![manual_segment(1.0, 2.0, 2.0, 0.5, 0.5)],
            vec![
                manual_segment(1.0, 6.0, 2.0, 0.5, 0.5),
                manual_segment(2.0, 3.0, 3.0, 0.5, 0.5),
                manual_segment(2.0, 3.0, 4.0, 0.5, 0.5),
                manual_segment(3.0, 3.0, 2.0, 0.5, 0.5),
                manual_segment(5.0, 4.0, 2.0, 0.5, 0.5),
                instant,
            ],
            vec![
                manual_segment(f64::NAN, 2.0, 2.0, 0.5, 0.5),
                manual_segment(-f64::NAN, 2.0, 2.0, 0.5, 0.5),
                manual_segment(1.0, f64::NAN, 2.0, 0.5, 0.5),
                manual_segment(-0.0, 0.0, 2.0, 0.5, 0.5),
                manual_segment(f64::NEG_INFINITY, 0.5, 2.0, 0.5, 0.5),
                manual_segment(7.0, f64::INFINITY, 2.0, 0.5, 0.5),
                instant_nan,
            ],
        ];
        for segments in cases {
            let timeline = timeline_for(&segments, &CursorEvents::default(), 10.0);
            let mut times: Vec<f64> = segments
                .iter()
                .flat_map(|s| [s.start, s.end, s.start - 0.1, s.end + 0.1])
                .flat_map(|t| [t, t.next_down(), t.next_up()])
                .collect();
            times.extend((0..=1300).map(|step| step as f64 * STEP_MS / 1000.0));
            for t in times {
                let linear_active = timeline
                    .zoom_segments
                    .iter()
                    .position(|s| t > s.start && t <= s.end);
                let linear_snap = timeline.zoom_segments.iter().any(|s| {
                    s.instant_animation
                        && t >= s.start - INSTANT_SNAP_WINDOW_SECS
                        && t <= s.end + INSTANT_SNAP_WINDOW_SECS
                });
                assert_eq!(timeline.segment_index.active_at(t), linear_active, "t={t}");
                assert_eq!(timeline.segment_index.snaps_at(t), linear_snap, "t={t}");
            }
        }
    }

    #[test]
    fn ordered_cluster_search_matches_full_scan() {
        let moves = vec![
            move_event(f64::NEG_INFINITY, 0.1, 0.1),
            move_event(0.0, 0.2, 0.2),
            move_event(500.0, f64::NAN, 0.5),
            move_event(500.0, 0.9, 0.9),
            move_event(500.0, 0.1, 0.9),
            move_event(1_000.0, 0.5, f64::INFINITY),
            move_event(2_000.0, 0.95, 0.05),
            move_event(2_000.0, 0.05, 0.95),
            move_event(3_500.0, 0.6, 0.4),
            move_event(9_000.0, 0.3, 0.7),
            move_event(f64::INFINITY, 0.8, 0.2),
        ];
        let cursor = CursorEvents {
            moves,
            clicks: vec![],
        };
        assert!(cursor.moves.is_sorted_by(|a, b| a.time_ms <= b.time_ms));
        let crop = CursorCropMap::from_crop(
            &Crop {
                position: XY::new(100, 50),
                size: XY::new(1600, 900),
            },
            XY::new(1920, 1080),
        );
        let bounds = [
            (0.0, 0.0),
            (0.0, 0.5),
            (0.5, 0.5),
            (0.5, 2.0),
            (0.6, 0.9),
            (2.5, 3.0),
            (4.0, 8.0),
            (10.0, 20.0),
            (-5.0, -1.0),
            (f64::NAN, 2.0),
            (0.5, f64::NAN),
            (f64::NEG_INFINITY, f64::INFINITY),
        ];
        for (start, end) in bounds {
            for amount in [1.0, 2.0, 4.0] {
                for crop in [None, crop] {
                    let ordered = build_clusters(&cursor, true, start, end, amount, crop);
                    let scanned = build_clusters(&cursor, false, start, end, amount, crop);
                    assert_eq!(
                        format!("{ordered:?}"),
                        format!("{scanned:?}"),
                        "range {start}..{end} amount {amount}"
                    );
                }
            }
        }
    }

    fn linear_cluster_center_at_time(
        clusters: &[ClickCluster],
        time_ms: f64,
    ) -> Option<(f64, f64)> {
        clusters
            .iter()
            .rev()
            .find(|cluster| cluster.start_time_ms <= time_ms)
            .or_else(|| clusters.first())
            .map(ClickCluster::center)
    }

    #[test]
    fn cluster_centers_match_linear_lookup_for_all_short_sequences() {
        let starts = [
            f64::NEG_INFINITY,
            -0.0,
            0.0,
            1.0,
            2.0,
            f64::INFINITY,
            f64::NAN,
        ];
        let queries = [
            f64::NEG_INFINITY,
            -1.0,
            -0.0,
            0.0,
            1.0_f64.next_down(),
            1.0,
            1.0_f64.next_up(),
            2.0,
            3.0,
            f64::INFINITY,
            f64::NAN,
        ];
        for length in 0..=4 {
            for mut sequence in 0..starts.len().pow(length) {
                let clusters = (0..length)
                    .map(|index| {
                        let start = starts[sequence % starts.len()];
                        sequence /= starts.len();
                        ClickCluster::new(f64::from(index), f64::from(index) * 0.5, start)
                    })
                    .collect();
                let centers = ClusterCenters::new(clusters);
                for time in queries {
                    assert_eq!(
                        centers.center_at(time),
                        linear_cluster_center_at_time(&centers.clusters, time),
                        "clusters {:?}, time {time}",
                        centers.clusters
                    );
                }
            }
        }
    }
}
