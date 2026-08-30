//! Timeline **editing** -- everything E3 deliberately left out: selection,
//! trim, drag, split, create, delete and undo/redo, plus the pure geometry the
//! window's pointer handlers run on.
//!
//! Nothing here touches gpui. It is the model half of E4: given a
//! [`ProjectConfiguration`] and a pointer position it answers "what was hit",
//! "where may this edge go" and "what does the config look like afterwards",
//! which is what makes the maths testable without a window.
//!
//! Three facts about the source shape everything below:
//!
//! * **Every track's segment drag is the same 60 lines.** `createMouseDownDrag`
//!   appears once per track file (`TL/ZoomTrack.tsx:401-513`,
//!   `TL/MaskTrack.tsx:212-303`, and six near-identical siblings) with the same
//!   2px promotion threshold, the same shift/meta selection rules and the same
//!   `projectHistory.pause()` bracket. It is written once here.
//! * **The clip track is not one of them.** Its handles trim in the *recording*
//!   domain scaled by `timescale`, with no promotion threshold and a floor that
//!   grows with the neighbouring transitions (`TL/ClipTrack.tsx:1134-1230,
//!   1283-1372`), and its body drag is a crossfade-duration drag rather than a
//!   move.
//! * **History is snapshots, not diffs.** `createStoreHistory`
//!   (`ED/context.ts:1913-1961`) hands `createUndoHistory` a memo that
//!   `structuredClone`s the whole project store, so an entry is a whole
//!   `ProjectConfiguration` and a drag is coalesced by *pausing* the recorder
//!   for its duration.

use cap_project::{
    AudioTrackSegment, Camera3DProperties, Camera3DSegment, CaptionTrackSegment,
    ClipSpeedAudioMode, CursorClickEvent, GlideDirection, KeyboardTrackSegment, MaskKind,
    MaskSegment, ProjectConfiguration, SceneMode, SceneSegment, TextSegment, TimelineConfiguration,
    TimelineSegment, XY, ZoomMode, ZoomSegment, mask_effect_contract,
};

use crate::editor_timeline::{self, Segment, TrackKind};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/// `editorState.timeline.selection` (`ED/context.ts:1441-1452`).
///
/// The source's union has ten arms; nine are `{ type, indices: number[] }` --
/// one per track -- and the tenth is `{ type: "transition", index }`. Only the
/// nine are modelled: a clip transition has no drawn affordance in this rev
/// (see the README's deviation), so nothing can select one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub track: TrackKind,
    /// Config indices, in the order the source builds them -- **not** sorted.
    /// `Cmd+click` appends, and shift-range anchors on `indices.at(-1)`.
    pub indices: Vec<usize>,
}

impl Selection {
    pub fn single(track: TrackKind, index: usize) -> Self {
        Self {
            track,
            indices: vec![index],
        }
    }

    pub fn contains(&self, track: TrackKind, index: usize) -> bool {
        self.track == track && self.indices.contains(&index)
    }
}

/// The selection half of every track's `finish()` -- `selectClip`
/// (`TL/ClipTrack.tsx:570-600`) and the eight copies of it inside
/// `createMouseDownDrag` (`TL/ZoomTrack.tsx:426-477`).
///
/// * **shift** extends from the *last* index in the current selection to the
///   clicked one, inclusive, but only when the current selection is already on
///   this track.
/// * **cmd/ctrl** toggles the clicked index in and out; emptying the list
///   clears the selection entirely. Against a *different* track's selection it
///   starts a fresh single selection.
/// * anything else selects just the clicked segment.
///
/// The multi-select modifier is `metaKey` on macOS and `ctrlKey` elsewhere in
/// the clip track (`:572-573`) and `e.ctrlKey || e.metaKey` in the other eight
/// (`ZoomTrack.tsx:428`); on macOS the two agree, so one rule serves both.
pub fn click_selection(
    current: Option<&Selection>,
    track: TrackKind,
    index: usize,
    shift: bool,
    multi: bool,
) -> Option<Selection> {
    let same_track = current.filter(|selection| selection.track == track);

    if shift && let Some(selection) = same_track {
        let last = selection.indices.last().copied().unwrap_or(index);
        let (start, end) = (last.min(index), last.max(index));
        return Some(Selection {
            track,
            indices: (start..=end).collect(),
        });
    }

    if multi {
        let Some(selection) = same_track else {
            return Some(Selection::single(track, index));
        };
        let mut indices = selection.indices.clone();
        if let Some(position) = indices.iter().position(|value| *value == index) {
            indices.remove(position);
        } else {
            indices.push(index);
        }
        return (!indices.is_empty()).then_some(Selection { track, indices });
    }

    Some(Selection::single(track, index))
}

/// `Cmd/Ctrl+A` (`TL/index.tsx:1019-1045`): expand the current selection to
/// every segment on the same track. Does nothing without a selection, and
/// nothing when that track has no segments.
pub fn select_all_on_track(current: Option<&Selection>, count: usize) -> Option<Selection> {
    let selection = current?;
    if count == 0 {
        return None;
    }
    Some(Selection {
        track: selection.track,
        indices: (0..count).collect(),
    })
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

/// `options.limit ?? 100` inside `createUndoHistory`
/// (`@solid-primitives/history/dist/index.js`).
const HISTORY_LIMIT: usize = 100;

/// `createStoreHistory` (`ED/context.ts:1913-1961`) over `createUndoHistory`.
///
/// The source's history is a list of *whole store snapshots*: the tracked memo
/// `structuredClone`s `unwrap(state)` on every change and returns a closure
/// that reconciles it back. `count` is how far back the cursor has walked, so
/// `canUndo` is "more than one entry behind the cursor" and a fresh change
/// truncates the redo tail. All of that is transcribed literally; the entries
/// are `ProjectConfiguration`s rather than closures because there is only one
/// store here.
#[derive(Debug, Clone)]
pub struct ProjectHistory {
    entries: Vec<ProjectConfiguration>,
    /// `history().count` -- steps walked back from the newest entry.
    count: usize,
    /// `pauseCount` (`:1917`). A drag brackets itself with `pause`/`resume` so
    /// its sixty intermediate states become one entry.
    paused: u32,
    /// Whether anything was actually written while paused. The source pushes an
    /// entry on *every* resume because the memo re-runs when `pauseCount`
    /// changes -- so a click that never moved leaves a duplicate snapshot on
    /// the stack, and the first undo after one appears to do nothing. That is a
    /// wart, not a contract; see the README deviation.
    dirty: bool,
}

impl ProjectHistory {
    pub fn new(initial: ProjectConfiguration) -> Self {
        Self {
            entries: vec![initial],
            count: 0,
            paused: 0,
            dirty: false,
        }
    }

    /// One store change. Truncates the redo tail (`newLength = list.length -
    /// count`), pushes, and keeps at most [`HISTORY_LIMIT`] entries.
    pub fn record(&mut self, config: &ProjectConfiguration) {
        if self.paused > 0 {
            self.dirty = true;
            return;
        }
        let new_length = self.entries.len() - self.count;
        self.entries.truncate(new_length);
        if self.entries.len() >= HISTORY_LIMIT {
            let excess = self.entries.len() - HISTORY_LIMIT + 1;
            self.entries.drain(0..excess);
        }
        self.entries.push(config.clone());
        self.count = 0;
    }

    /// `projectHistory.pause()`.
    pub fn pause(&mut self) {
        self.paused += 1;
    }

    /// The closure `pause()` returns. Records the state the drag ended on, as
    /// one entry.
    pub fn resume(&mut self, config: &ProjectConfiguration) {
        self.paused = self.paused.saturating_sub(1);
        if self.paused == 0 && std::mem::take(&mut self.dirty) {
            self.record(config);
        }
    }

    /// `canUndo = list.length - count > 1`.
    pub fn can_undo(&self) -> bool {
        self.entries.len() - self.count > 1
    }

    /// `canRedo = count > 0`.
    pub fn can_redo(&self) -> bool {
        self.count > 0
    }

    /// `move(1)`: step the cursor back one and hand back the state there.
    pub fn undo(&mut self) -> Option<&ProjectConfiguration> {
        if !self.can_undo() {
            return None;
        }
        self.count += 1;
        self.entries.get(self.entries.len() - self.count - 1)
    }

    /// `move(-1)`.
    pub fn redo(&mut self) -> Option<&ProjectConfiguration> {
        if !self.can_redo() {
            return None;
        }
        self.count -= 1;
        self.entries.get(self.entries.len() - self.count - 1)
    }

    #[cfg(test)]
    fn depth(&self) -> usize {
        self.entries.len()
    }
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/// `SegmentHandle`'s hit box: `w-5` with `-translate-x-1/2` (start) or
/// `translate-x-1/2` (end), i.e. 20px straddling the edge, 10 each side
/// (`TL/Track.tsx:236-258`).
pub const HANDLE_HIT_PX: f64 = 10.;

/// What the pointer landed on in a track row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hit {
    /// A trim handle. `start` distinguishes the two.
    Handle { index: usize, start: bool },
    /// The segment's own body -- a move on most tracks, a selection everywhere.
    Body { index: usize },
    /// Bare track. The zoom track creates a segment here; every other track
    /// lets the press fall through to the timeline container.
    Empty,
}

/// Which segment (and which part of it) is under `x`, where `x` is pixels from
/// the **content column's** left edge.
///
/// The source resolves this by DOM stacking, where a later sibling's handle
/// covers the whole 20px zone at a shared boundary -- which means the right
/// clip's *start* handle owns even the pixels inside the left clip's box, and
/// grabbing "the left clip's end" actually trims the right clip. Deliberate
/// deviation: a press *inside* a segment's own box belongs to that segment's
/// nearest handle; a neighbour's handle only reaches across empty space.
pub fn hit_test(
    segments: &[Segment],
    lane: u32,
    x: f64,
    position: f64,
    secs_per_pixel: f64,
) -> Hit {
    let edges = |segment: &Segment| {
        (
            (segment.start - position) / secs_per_pixel,
            (segment.end - position) / secs_per_pixel,
        )
    };

    // Pass 1: handles clipped to their own box. Later segments win ties at a
    // shared edge, matching the paint order.
    for (index, segment) in segments.iter().enumerate().rev() {
        if segment.lane != lane {
            continue;
        }
        let (left, right) = edges(segment);
        if x < left || x > right {
            continue;
        }
        let from_start = x - left;
        let from_end = right - x;
        let start_hit = from_start <= HANDLE_HIT_PX;
        let end_hit = from_end <= HANDLE_HIT_PX;
        if start_hit && (!end_hit || from_start <= from_end) {
            return Hit::Handle { index, start: true };
        }
        if end_hit {
            return Hit::Handle {
                index,
                start: false,
            };
        }
        break;
    }

    // Pass 2: the overhanging halves, for grabs from just outside the box.
    for (index, segment) in segments.iter().enumerate().rev() {
        if segment.lane != lane {
            continue;
        }
        let (left, right) = edges(segment);
        if (x - left).abs() <= HANDLE_HIT_PX {
            return Hit::Handle { index, start: true };
        }
        if (x - right).abs() <= HANDLE_HIT_PX {
            return Hit::Handle {
                index,
                start: false,
            };
        }
    }

    for (index, segment) in segments.iter().enumerate().rev() {
        if segment.lane != lane {
            continue;
        }
        let (left, right) = edges(segment);
        if x >= left && x <= right {
            return Hit::Body { index };
        }
    }
    Hit::Empty
}

// ---------------------------------------------------------------------------
// Minimum durations
// ---------------------------------------------------------------------------

/// The per-track trim floor, `max(secondsFloor, secsPerPixel * pixelFloor)`.
///
/// | track | seconds | pixels | source |
/// |---|---|---|---|
/// | clip | 1 | 100 | `TL/ClipTrack.tsx:55, 1141-1152` (× `timescale`, plus the transition term) |
/// | zoom | 1 | 40 | `TL/ZoomTrack.tsx:35, 606-609` |
/// | scene | 1 | 80 | `TL/SceneTrack.tsx:33, 454-457` |
/// | 3d | 1 | 40 | `TL/ThreeDTrack.tsx:38, 568-571` |
/// | text | 1 | 80 | `TL/TextTrack.tsx:25-26, 49` |
/// | mask | 1 | 80 | `TL/MaskTrack.tsx:24-25, 47` |
/// | audio | 0.5 | 60 | `TL/AudioTrack.tsx:24, 230` + `ED/audio.ts:24` |
/// | caption | 0.5 | 40 | `TL/CaptionsTrack.tsx:20-21, 41` |
/// | keyboard | 0.3 | 30 | `TL/KeyboardTrack.tsx:20-21, 39` |
pub fn min_segment_duration(kind: TrackKind, secs_per_pixel: f64) -> f64 {
    let (seconds, pixels): (f64, f64) = match kind {
        TrackKind::Clip => (1., 100.),
        TrackKind::Zoom => (1., 40.),
        TrackKind::Scene => (1., 80.),
        TrackKind::ThreeD => (1., 40.),
        TrackKind::Text => (1., 80.),
        TrackKind::Mask => (1., 80.),
        TrackKind::Audio => (0.5, 60.),
        TrackKind::Caption => (0.5, 40.),
        TrackKind::Keyboard => (0.3, 30.),
    };
    seconds.max(secs_per_pixel * pixels)
}

/// The split floor for a non-clip track: `if (time < N || remaining < N)
/// return;` in each `split*Segment` action (`ED/context.ts:601-1072`).
pub fn min_split_duration(kind: TrackKind) -> f64 {
    match kind {
        TrackKind::Audio | TrackKind::Caption => 0.5,
        TrackKind::Keyboard => 0.3,
        _ => 1.,
    }
}

// ---------------------------------------------------------------------------
// Drag bounds
// ---------------------------------------------------------------------------

/// The clamp a live drag runs each pointer move through.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragBounds {
    pub min: f64,
    pub max: f64,
}

impl DragBounds {
    pub fn clamp(&self, value: f64) -> f64 {
        value.max(self.min).min(self.max.max(self.min))
    }
}

/// The lane neighbours of a segment: the end of the one before it and the start
/// of the one after it, in *time* order within its own lane
/// (`neighborBounds`, `TL/MaskTrack.tsx:75-84`).
///
/// The single-lane tracks express this as array-index neighbours instead
/// (`zoomSegments[i - 1]` / `[i + 1]`, `TL/ZoomTrack.tsx:660-664`) or as a
/// backwards search for the nearest segment ending at or before this one's
/// start (`:615-622`). Every one of those agrees with this while the array is
/// sorted by start, which every mutation here keeps it.
fn neighbours(segments: &[Segment], lane: u32, index: usize, total: f64) -> (f64, f64) {
    let target = &segments[index];
    let mut previous_end: f64 = 0.;
    let mut next_start: f64 = total;
    for (other_index, other) in segments.iter().enumerate() {
        if other_index == index || other.lane != lane {
            continue;
        }
        if other.end <= target.start {
            previous_end = previous_end.max(other.end);
        } else if other.start >= target.end {
            next_start = next_start.min(other.start);
        }
    }
    (previous_end, next_start)
}

/// `SegmentHandle position="start"`'s setup (`TL/MaskTrack.tsx:404-419`):
/// `minValue = prevEnd`, `maxValue = max(minValue, min(end - minDuration,
/// nextStart - minDuration))`.
pub fn trim_start_bounds(
    segments: &[Segment],
    lane: u32,
    index: usize,
    min_duration: f64,
    total: f64,
) -> DragBounds {
    let (previous_end, next_start) = neighbours(segments, lane, index, total);
    let min = previous_end;
    let max = min.max((segments[index].end - min_duration).min(next_start - min_duration));
    DragBounds { min, max }
}

/// `SegmentHandle position="end"`'s setup (`TL/MaskTrack.tsx:499-508`):
/// `minValue = start + minDuration`, `maxValue = max(minValue, nextStart)`.
pub fn trim_end_bounds(
    segments: &[Segment],
    lane: u32,
    index: usize,
    min_duration: f64,
    total: f64,
) -> DragBounds {
    let (_, next_start) = neighbours(segments, lane, index, total);
    let min = segments[index].start + min_duration;
    DragBounds {
        min,
        max: min.max(next_start),
    }
}

/// `SegmentContent`'s setup (`TL/MaskTrack.tsx:449-458`): the whole segment
/// slides, clamped so it cannot pass either neighbour. Expressed as bounds on
/// the *delta* rather than on the start, which is how the source clamps it.
pub fn move_bounds(segments: &[Segment], lane: u32, index: usize, total: f64) -> DragBounds {
    let (previous_end, next_start) = neighbours(segments, lane, index, total);
    let segment = &segments[index];
    DragBounds {
        min: previous_end - segment.start,
        max: next_start - segment.end,
    }
}

// ---------------------------------------------------------------------------
// The generic track segment
// ---------------------------------------------------------------------------

/// The three fields every non-clip track segment has, plus how it splits.
///
/// Eight structs implement it and the generic mutators below are written once
/// against it, which is the Rust spelling of the eight near-identical track
/// components.
pub trait TrackSegmentOps: Clone {
    fn start(&self) -> f64;
    fn end(&self) -> f64;
    fn set_start(&mut self, value: f64);
    fn set_end(&mut self, value: f64);
    fn lane(&self) -> u32 {
        0
    }

    /// The right-hand half of a split: `{...segment, start: segment.start +
    /// time, end: segment.end}`.
    fn split_tail(&self, at: f64) -> Self {
        let mut tail = self.clone();
        tail.set_start(self.start() + at);
        tail
    }

    /// Anything the left-hand half needs beyond its new `end`.
    fn split_head(&mut self) {}
}

macro_rules! impl_track_segment {
    ($type:ty $(, lane: $lane:ident)?) => {
        impl TrackSegmentOps for $type {
            fn start(&self) -> f64 { self.start }
            fn end(&self) -> f64 { self.end }
            fn set_start(&mut self, value: f64) { self.start = value; }
            fn set_end(&mut self, value: f64) { self.end = value; }
            $(fn lane(&self) -> u32 { self.$lane })?
        }
    };
}

impl_track_segment!(ZoomSegment);
impl_track_segment!(SceneSegment);
impl_track_segment!(Camera3DSegment);
impl_track_segment!(MaskSegment, lane: track);
impl_track_segment!(TextSegment, lane: track);

impl TrackSegmentOps for CaptionTrackSegment {
    fn start(&self) -> f64 {
        self.start
    }
    fn end(&self) -> f64 {
        self.end
    }
    fn set_start(&mut self, value: f64) {
        self.start = value;
    }
    fn set_end(&mut self, value: f64) {
        self.end = value;
    }
    /// `id: \`cap-split-${Date.now()}-${random}\`` (`ED/context.ts:1023`).
    fn split_tail(&self, at: f64) -> Self {
        let mut tail = self.clone();
        tail.start = self.start + at;
        tail.id = split_id("cap");
        tail
    }
}

impl TrackSegmentOps for KeyboardTrackSegment {
    fn start(&self) -> f64 {
        self.start
    }
    fn end(&self) -> f64 {
        self.end
    }
    fn set_start(&mut self, value: f64) {
        self.start = value;
    }
    fn set_end(&mut self, value: f64) {
        self.end = value;
    }
    /// `id: \`kb-split-${Date.now()}-${random}\`` (`ED/context.ts:983`).
    fn split_tail(&self, at: f64) -> Self {
        let mut tail = self.clone();
        tail.start = self.start + at;
        tail.id = split_id("kb");
        tail
    }
}

impl TrackSegmentOps for AudioTrackSegment {
    fn start(&self) -> f64 {
        self.start
    }
    fn end(&self) -> f64 {
        self.end
    }
    fn set_start(&mut self, value: f64) {
        self.start = value;
    }
    fn set_end(&mut self, value: f64) {
        self.end = value;
    }
    fn lane(&self) -> u32 {
        self.track
    }
    /// The split moves the source offset with the cut and hard-cuts the new
    /// boundary: "fades belong to the outer edges of the original clip"
    /// (`ED/context.ts:855-862`).
    fn split_tail(&self, at: f64) -> Self {
        let mut tail = self.clone();
        tail.start = self.start + at;
        tail.trim_start = self.trim_start + at;
        tail.fade_in = 0.;
        tail
    }
    fn split_head(&mut self) {
        self.fade_out = 0.;
    }
}

/// `${prefix}-split-${Date.now()}-${Math.random().toString(36).slice(2)}`.
fn split_id(prefix: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    format!("{prefix}-split-{millis}-{:x}", uuid_like())
}

/// A short random tail. `Math.random().toString(36).slice(2)` has no exact
/// equivalent and none is needed -- the value only has to be unique.
fn uuid_like() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish()
}

/// `sortTrackSegments` (`ED/timelineTracks.ts:13-21`): by lane, then start,
/// then end. Run after every mutation that can move a segment, exactly where
/// the source runs it.
fn sort_track<T: TrackSegmentOps>(segments: &mut [T]) {
    segments.sort_by(|a, b| {
        a.lane()
            .cmp(&b.lane())
            .then(a.start().total_cmp(&b.start()))
            .then(a.end().total_cmp(&b.end()))
    });
}

/// `normalizeTrackSegments` (`:23-33`): sort, then renumber the lanes so they
/// are dense from zero. Only the three multi-lane tracks' deletes call it.
fn normalize_track<T: TrackSegmentOps>(segments: &mut [T], set_lane: impl Fn(&mut T, u32)) {
    sort_track(segments);
    let mut mapping: Vec<u32> = Vec::new();
    for segment in segments.iter_mut() {
        let lane = segment.lane();
        let next = mapping
            .iter()
            .position(|value| *value == lane)
            .unwrap_or_else(|| {
                mapping.push(lane);
                mapping.len() - 1
            });
        set_lane(segment, next as u32);
    }
    sort_track(segments);
}

/// `[...new Set(indices)].filter(in bounds).sort(descending)` -- the guard
/// every `delete*Segments` action opens with (`ED/context.ts:625-637`).
fn descending_indices(indices: &[usize], length: usize) -> Vec<usize> {
    let mut sorted: Vec<usize> = indices
        .iter()
        .copied()
        .filter(|index| *index < length)
        .collect();
    sorted.sort_unstable();
    sorted.dedup();
    sorted.reverse();
    sorted
}

/// Splice out every listed index, highest first.
fn delete_indices<T>(segments: &mut Vec<T>, indices: &[usize]) -> bool {
    let sorted = descending_indices(indices, segments.len());
    if sorted.is_empty() {
        return false;
    }
    for index in sorted {
        segments.remove(index);
    }
    true
}

/// `split*Segment(index, time)` for the seven tracks whose split is a plain
/// splice. `time` is seconds from the segment's own start.
fn split_at<T: TrackSegmentOps>(segments: &mut Vec<T>, index: usize, at: f64, min: f64) -> bool {
    let Some(segment) = segments.get(index) else {
        return false;
    };
    let duration = segment.end() - segment.start();
    if at < min || duration - at < min {
        return false;
    }
    let tail = segment.split_tail(at);
    let boundary = segment.start() + at;
    segments.insert(index + 1, tail);
    let head = &mut segments[index];
    head.set_end(boundary);
    head.split_head();
    true
}

// ---------------------------------------------------------------------------
// Track dispatch
// ---------------------------------------------------------------------------

/// Run `body` against whichever `Vec<_>` the track kind names.
///
/// The clip track is deliberately absent: its segments live in the recording
/// domain and every operation on them is special-cased below.
macro_rules! with_track {
    ($timeline:expr, $kind:expr, |$segments:ident| $body:expr) => {
        match $kind {
            TrackKind::Zoom => {
                let $segments = &mut $timeline.zoom_segments;
                $body
            }
            TrackKind::Scene => {
                let $segments = &mut $timeline.scene_segments;
                $body
            }
            TrackKind::ThreeD => {
                let $segments = &mut $timeline.camera3d_segments;
                $body
            }
            TrackKind::Text => {
                let $segments = &mut $timeline.text_segments;
                $body
            }
            TrackKind::Mask => {
                let $segments = &mut $timeline.mask_segments;
                $body
            }
            TrackKind::Audio => {
                let $segments = &mut $timeline.audio_segments;
                $body
            }
            TrackKind::Caption => {
                let $segments = &mut $timeline.caption_segments;
                $body
            }
            TrackKind::Keyboard => {
                let $segments = &mut $timeline.keyboard_segments;
                $body
            }
            TrackKind::Clip => Default::default(),
        }
    };
}

/// How many segments a track carries -- `Cmd+A`'s `segmentCount`
/// (`TL/index.tsx:1029-1039`).
pub fn segment_count(timeline: &TimelineConfiguration, kind: TrackKind) -> usize {
    match kind {
        TrackKind::Clip => timeline.segments.len(),
        TrackKind::Zoom => timeline.zoom_segments.len(),
        TrackKind::Scene => timeline.scene_segments.len(),
        TrackKind::ThreeD => timeline.camera3d_segments.len(),
        TrackKind::Text => timeline.text_segments.len(),
        TrackKind::Mask => timeline.mask_segments.len(),
        TrackKind::Audio => timeline.audio_segments.len(),
        TrackKind::Caption => timeline.caption_segments.len(),
        TrackKind::Keyboard => timeline.keyboard_segments.len(),
    }
}

/// Move one segment's start edge (a start-handle drag).
pub fn set_segment_start(
    timeline: &mut TimelineConfiguration,
    kind: TrackKind,
    index: usize,
    start: f64,
) -> bool {
    with_track!(timeline, kind, |segments| {
        let Some(segment) = segments.get_mut(index) else {
            return false;
        };
        // A write of the value already there is not a change. Solid's store
        // setters compare before they notify, so a drag pinned against its
        // clamp neither re-renders nor lands on the undo stack there either.
        if segment.start() == start {
            return false;
        }
        segment.set_start(start);
        sort_track(segments);
        true
    })
}

/// Move one segment's end edge (an end-handle drag).
pub fn set_segment_end(
    timeline: &mut TimelineConfiguration,
    kind: TrackKind,
    index: usize,
    end: f64,
) -> bool {
    with_track!(timeline, kind, |segments| {
        let Some(segment) = segments.get_mut(index) else {
            return false;
        };
        if segment.end() == end {
            return false;
        }
        segment.set_end(end);
        sort_track(segments);
        true
    })
}

/// Slide a whole segment. The source writes both fields in one `setProject`
/// and does **not** re-sort (`TL/ZoomTrack.tsx:686-689`,
/// `TL/MaskTrack.tsx:466-478` -- the mask does sort), because the move clamp
/// already forbids passing a neighbour.
pub fn move_segment(
    timeline: &mut TimelineConfiguration,
    kind: TrackKind,
    index: usize,
    start: f64,
    end: f64,
) -> bool {
    with_track!(timeline, kind, |segments| {
        let Some(segment) = segments.get_mut(index) else {
            return false;
        };
        if segment.start() == start && segment.end() == end {
            return false;
        }
        segment.set_start(start);
        segment.set_end(end);
        true
    })
}

/// `delete*Segments(indices)` for the eight non-clip tracks. The three
/// multi-lane ones renormalise their lanes afterwards; the others do not
/// (`ED/context.ts:781-799` vs `:623-639`).
pub fn delete_segments(
    timeline: &mut TimelineConfiguration,
    kind: TrackKind,
    indices: &[usize],
) -> bool {
    match kind {
        TrackKind::Mask => {
            let deleted = delete_indices(&mut timeline.mask_segments, indices);
            normalize_track(&mut timeline.mask_segments, |segment, lane| {
                segment.track = lane
            });
            deleted
        }
        TrackKind::Text => {
            let deleted = delete_indices(&mut timeline.text_segments, indices);
            normalize_track(&mut timeline.text_segments, |segment, lane| {
                segment.track = lane
            });
            deleted
        }
        TrackKind::Audio => {
            let deleted = delete_indices(&mut timeline.audio_segments, indices);
            normalize_track(&mut timeline.audio_segments, |segment, lane| {
                segment.track = lane
            });
            deleted
        }
        // `deleteSceneSegment` takes a single index and splices it
        // (`ED/context.ts:1074-1087`); the Delete binding walks the selection
        // in reverse order to call it (`TL/index.tsx:1000-1007`), which is the
        // same thing this does.
        TrackKind::Clip => delete_clip_segments(timeline, indices),
        _ => with_track!(timeline, kind, |segments| delete_indices(segments, indices)),
    }
}

/// `deleteTrackLane` (`TL/index.tsx:146-157`): drop every segment on the lane
/// and renumber the lanes above it down by one.
pub fn delete_track_lane(timeline: &mut TimelineConfiguration, kind: TrackKind, lane: u32) -> bool {
    fn apply<T: TrackSegmentOps>(
        segments: &mut Vec<T>,
        lane: u32,
        get: impl Fn(&T) -> u32,
        set: impl Fn(&mut T, u32),
    ) -> bool {
        let before = segments.len();
        segments.retain(|segment| get(segment) != lane);
        let mut changed = segments.len() != before;
        for segment in segments.iter_mut() {
            let track = get(segment);
            if track > lane {
                set(segment, track - 1);
                changed = true;
            }
        }
        changed
    }
    match kind {
        TrackKind::Text => apply(
            &mut timeline.text_segments,
            lane,
            |segment| segment.track,
            |segment, value| segment.track = value,
        ),
        TrackKind::Mask => apply(
            &mut timeline.mask_segments,
            lane,
            |segment| segment.track,
            |segment, value| segment.track = value,
        ),
        TrackKind::Audio => apply(
            &mut timeline.audio_segments,
            lane,
            |segment| segment.track,
            |segment, value| segment.track = value,
        ),
        _ => false,
    }
}

/// `deleteClipSegment` (`ED/context.ts:581-600`), including the guard that
/// makes it the one track a selection cannot empty: **the last clip cannot be
/// deleted**. The Delete binding sorts descending and deletes one at a time
/// (`TL/index.tsx:993-1000`), so the guard is re-checked per clip and a
/// "select all + delete" leaves exactly one behind.
pub fn delete_clip_segments(timeline: &mut TimelineConfiguration, indices: &[usize]) -> bool {
    let mut deleted = false;
    for index in descending_indices(indices, timeline.segments.len()) {
        if timeline.segments.len() < 2 {
            break;
        }
        timeline.segments.remove(index);
        // `transitionsAfterClipDelete` (`ED/clip-transitions.ts:259-275`): the
        // transitions on both sides of the deleted clip go, and everything
        // after it shifts down one.
        timeline.transitions.retain(|transition| {
            let at = transition.segment_index as usize;
            at != index && at != index + 1
        });
        for transition in timeline.transitions.iter_mut() {
            if transition.segment_index as usize > index {
                transition.segment_index -= 1;
            }
        }
        deleted = true;
    }
    deleted
}

/// The seven plain splits. 3D is **not** among them: `splitCamera3DSegment`
/// rebuilds both halves' pose tracks around the pose the segment held at the
/// cut (`ED/context.ts:640-676`), which needs the keyframe evaluator; see the
/// README deviation.
pub fn split_segment(
    timeline: &mut TimelineConfiguration,
    kind: TrackKind,
    index: usize,
    at: f64,
) -> bool {
    if kind == TrackKind::ThreeD || kind == TrackKind::Clip {
        return false;
    }
    let min = min_split_duration(kind);
    with_track!(timeline, kind, |segments| split_at(
        segments, index, at, min
    ))
}

// ---------------------------------------------------------------------------
// Creating a zoom segment
// ---------------------------------------------------------------------------

/// `createSegment` (`TL/ZoomTrack.tsx:202-239`): insert after every segment
/// that starts before this one, with the default amount and `mode: "auto"`.
/// Returns the index it landed at.
pub fn insert_zoom_segment(
    timeline: &mut TimelineConfiguration,
    start: f64,
    end: f64,
    amount: f64,
) -> usize {
    let mut index = 0;
    for (position, segment) in timeline.zoom_segments.iter().enumerate() {
        if segment.start < start {
            index = position + 1;
        }
    }
    timeline.zoom_segments.insert(
        index,
        ZoomSegment {
            start,
            end,
            amount,
            mode: cap_project::ZoomMode::Auto,
            glide_direction: Default::default(),
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
        },
    );
    index
}

/// `generalSettings.data?.defaultZoomAmount ?? 1.5` (`TL/ZoomTrack.tsx:226`).
pub const DEFAULT_ZOOM_AMOUNT: f64 = 1.5;

pub const MIN_AUDIO_SEGMENT_DURATION: f64 = 0.5;

pub fn used_lane_count<T: TrackSegmentOps>(segments: &[T]) -> u32 {
    segments
        .iter()
        .map(|segment| segment.lane() + 1)
        .max()
        .unwrap_or(0)
}

pub fn place_segment_at_time<T: TrackSegmentOps>(
    segments: &[T],
    time: f64,
    length: f64,
    total: f64,
) -> Option<(f64, f64)> {
    if length <= 0.0 || total <= 0.0 {
        return None;
    }
    let mut gap_start: f64 = 0.0;
    let mut gap_end = total;
    for segment in segments {
        if segment.start() <= time && time < segment.end() {
            return None;
        }
        if segment.end() <= time {
            gap_start = gap_start.max(segment.end());
        } else {
            gap_end = gap_end.min(segment.start());
        }
    }
    if gap_end - gap_start < length {
        return None;
    }
    let start = (time - length / 2.0).clamp(gap_start, gap_end - length);
    Some((start, start + length))
}

pub fn default_text_segment(start: f64, end: f64, track: u32) -> TextSegment {
    TextSegment {
        start,
        end,
        track,
        enabled: true,
        content: "Text".to_string(),
        center: XY::new(0.5, 0.5),
        size: XY::new(0.1, 0.055),
        font_family: "sans-serif".to_string(),
        font_size: 48.0,
        font_weight: 700.0,
        italic: false,
        color: "#ffffff".to_string(),
        fade_duration: 0.15,
        align: Default::default(),
        letter_spacing: 0.0,
        line_height: 1.2,
        opacity: 1.0,
        shadow: 0.0,
        animation_in: Default::default(),
        animation_out: Default::default(),
        animation_in_duration: 0.15,
        animation_out_duration: 0.15,
        layout: Default::default(),
        layout_transition: 0.5,
    }
}

pub fn default_mask_segment(start: f64, end: f64, track: u32) -> MaskSegment {
    let contract = mask_effect_contract();
    MaskSegment {
        start,
        end,
        track,
        enabled: true,
        mask_type: MaskKind::Sensitive,
        center: XY::new(0.5, 0.5),
        size: XY::new(0.35, 0.35),
        feather: 0.1,
        opacity: 1.0,
        pixelation: contract.blur_encoding_offset + contract.default_amount,
        darkness: 0.5,
        fade_duration: 0.0,
        keyframes: Default::default(),
    }
}

pub fn default_audio_segment(
    start: f64,
    end: f64,
    track: u32,
    path: String,
    name: String,
    duration: Option<f64>,
) -> AudioTrackSegment {
    AudioTrackSegment {
        start,
        end,
        track,
        path,
        name: Some(name),
        enabled: true,
        trim_start: 0.0,
        volume_db: 0.0,
        fade_in: 0.0,
        fade_out: 0.0,
        duration,
    }
}

fn sort_lane_segments<T: TrackSegmentOps>(segments: &mut [T]) {
    segments.sort_by(|a, b| {
        a.lane()
            .cmp(&b.lane())
            .then(a.start().total_cmp(&b.start()))
            .then(a.end().total_cmp(&b.end()))
    });
}

pub fn insert_text_segment(timeline: &mut TimelineConfiguration, segment: TextSegment) -> usize {
    let start = segment.start;
    let track = segment.track;
    timeline.text_segments.push(segment);
    sort_lane_segments(&mut timeline.text_segments);
    timeline
        .text_segments
        .iter()
        .rposition(|item| item.start == start && item.track == track)
        .unwrap_or(timeline.text_segments.len().saturating_sub(1))
}

pub fn insert_mask_segment(timeline: &mut TimelineConfiguration, segment: MaskSegment) -> usize {
    let start = segment.start;
    let track = segment.track;
    timeline.mask_segments.push(segment);
    sort_lane_segments(&mut timeline.mask_segments);
    timeline
        .mask_segments
        .iter()
        .rposition(|item| item.start == start && item.track == track)
        .unwrap_or(timeline.mask_segments.len().saturating_sub(1))
}

pub fn insert_audio_segment(
    timeline: &mut TimelineConfiguration,
    segment: AudioTrackSegment,
) -> usize {
    let start = segment.start;
    let track = segment.track;
    let path = segment.path.clone();
    timeline.audio_segments.push(segment);
    sort_lane_segments(&mut timeline.audio_segments);
    timeline
        .audio_segments
        .iter()
        .rposition(|item| item.start == start && item.track == track && item.path == path)
        .unwrap_or(timeline.audio_segments.len().saturating_sub(1))
}

pub fn default_camera3d_segment(start: f64, end: f64) -> Camera3DSegment {
    Camera3DSegment {
        start,
        end,
        enabled: true,
        properties: Camera3DProperties::default(),
        blur: cap_project::Camera3DBlur {
            mode: cap_project::Camera3DBlurMode::None,
            strength: 0.,
            falloff: 0.,
            focus_x: 0.37,
            focus_y: 0.5,
            focus_size: 0.5,
            angle: 0.,
            dir_position: 0.5,
            bokeh: false,
        },
        tracks: Default::default(),
        transition_in: 0.,
        transition_out: 0.,
    }
}

pub fn default_scene_segment(start: f64, end: f64) -> SceneSegment {
    SceneSegment {
        start,
        end,
        mode: SceneMode::CameraOnly,
        split_layout: None,
        transition_in: 0.3,
        transition_out: 0.3,
    }
}

pub fn insert_camera3d_segment(
    timeline: &mut TimelineConfiguration,
    segment: Camera3DSegment,
) -> usize {
    let start = segment.start;
    let mut index = 0;
    for (position, existing) in timeline.camera3d_segments.iter().enumerate() {
        if existing.start < start {
            index = position + 1;
        }
    }
    timeline.camera3d_segments.insert(index, segment);
    index
}

pub fn insert_scene_segment(timeline: &mut TimelineConfiguration, segment: SceneSegment) -> usize {
    let start = segment.start;
    let mut index = timeline.scene_segments.len();
    for (position, existing) in timeline.scene_segments.iter().enumerate().rev() {
        if existing.start > start {
            index = position;
        }
    }
    timeline.scene_segments.insert(index, segment);
    index
}

pub fn find_placement<T: TrackSegmentOps>(
    segments: &[T],
    time: f64,
    length: f64,
    total: f64,
) -> Option<(f64, f64)> {
    if length <= 0.0 || total <= 0.0 {
        return None;
    }
    let mut sorted: Vec<&T> = segments.iter().collect();
    sorted.sort_by(|a, b| a.start().total_cmp(&b.start()));

    let mut gaps = Vec::new();
    let mut cursor = 0.0;
    for segment in &sorted {
        if segment.start() - cursor >= length {
            gaps.push((cursor, segment.start()));
        }
        cursor = cursor.max(segment.end());
    }
    if total - cursor >= length {
        gaps.push((cursor, total));
    }
    if gaps.is_empty() {
        return None;
    }

    let max_start = (total - length).max(0.0);
    let desired = (time - length / 2.0).clamp(0.0, max_start);
    let containing = gaps
        .iter()
        .copied()
        .find(|(start, end)| desired >= *start && desired + length <= *end)
        .or_else(|| {
            gaps.iter()
                .copied()
                .find(|(start, _)| *start >= desired)
                .or_else(|| gaps.last().copied())
        })?;
    let start = desired.clamp(containing.0, containing.1 - length);
    Some((start, start + length))
}

pub fn ensure_timeline(project: &mut ProjectConfiguration, clip_display_durations: &[f64]) -> bool {
    if project.timeline.is_some() {
        return true;
    }
    if clip_display_durations.is_empty() {
        return false;
    }
    project.timeline = Some(TimelineConfiguration {
        segments: clip_display_durations
            .iter()
            .enumerate()
            .map(|(index, duration)| TimelineSegment {
                recording_clip: index as u32,
                timescale: 1.0,
                start: 0.0,
                end: *duration,
                name: None,
                speed_audio_mode: None,
                audio_muted: false,
            })
            .collect(),
        transitions: Vec::new(),
        zoom_segments: Vec::new(),
        scene_segments: Vec::new(),
        mask_segments: Vec::new(),
        text_segments: Vec::new(),
        caption_segments: Vec::new(),
        keyboard_segments: Vec::new(),
        audio_segments: Vec::new(),
        camera3d_segments: Vec::new(),
    });
    true
}

// ---------------------------------------------------------------------------
// The clip track
// ---------------------------------------------------------------------------

/// `minRecordedDuration` (`TL/ClipTrack.tsx:1141-1152`), identical on both
/// handles, in the **recording** domain so the pixel and transition terms are
/// scaled by `timescale`. Deliberate deviation from the source's
/// `max(1s, 100px)`: at fit-to-window zoom the 100px term alone forbids
/// trimming below several seconds, and Cap's own Clips feature emits
/// sub-second segments -- so the floor here is a tenth of a second plus a
/// 20px grabbability floor (a 20px box is still fully covered by its
/// handles). The transition term is a correctness constraint -- a crossfade
/// needs twice its duration of material -- and stays.
pub fn clip_min_recorded_duration(
    timeline: &TimelineConfiguration,
    index: usize,
    secs_per_pixel: f64,
) -> f64 {
    let Some(segment) = timeline.segments.get(index) else {
        return 0.1;
    };
    let transition = |at: usize| {
        timeline
            .effective_transition(at)
            .map_or(0., |transition| transition.duration)
    };
    let neighbouring = transition(index).max(transition(index + 1));
    0.1f64
        .max(secs_per_pixel * 20. * segment.timescale)
        .max(neighbouring * 2. * segment.timescale)
}

/// `availableTimelineDuration` (`TL/ClipTrack.tsx:1163-1167`): how much of the
/// recording is not already on the timeline, plus this clip's own share of it.
fn clip_available_timeline_duration(
    timeline: &TimelineConfiguration,
    index: usize,
    recording_duration: f64,
) -> f64 {
    let total: f64 = timeline
        .segments
        .iter()
        .map(|segment| segment.duration())
        .sum();
    let own = timeline
        .segments
        .get(index)
        .map_or(0., |segment| segment.duration());
    recording_duration - (total - own)
}

/// The clip start handle's clamp (`TL/ClipTrack.tsx:1186-1196`).
///
/// `clip_display_durations[recording_clip]` is
/// `editorInstance.recordings.segments[seg.recordingSegment].display.duration`.
pub fn clip_trim_start(
    timeline: &TimelineConfiguration,
    index: usize,
    new_start: f64,
    secs_per_pixel: f64,
    clip_display_durations: &[f64],
    recording_duration: f64,
) -> Option<f64> {
    let segment = timeline.segments.get(index)?;
    let min_recorded = clip_min_recorded_duration(timeline, index, secs_per_pixel);
    let max_segment = clip_display_durations
        .get(segment.recording_clip as usize)
        .copied()
        .unwrap_or(f64::INFINITY);
    let available = clip_available_timeline_duration(timeline, index, recording_duration);
    let max_duration = max_segment.min(available);

    // `prevSegmentIsSameClip ? prevSegment.end : 0` -- a clip split in two may
    // not be trimmed back over its own left-hand half. That floor only means
    // anything when the neighbour really is the left-hand half, i.e. ends at
    // or before this clip's start. Duplicated and auto-generated clips
    // *overlap* their neighbours' source ranges, which puts the floor above
    // the clip's own start and clamps the handle into a window it was never
    // in -- the handle teleports and cannot reduce the clip (the Tauri clamp
    // at `TL/ClipTrack.tsx:1191` shares this flaw on such projects).
    let previous_floor = index
        .checked_sub(1)
        .and_then(|previous| timeline.segments.get(previous))
        .filter(|previous| previous.recording_clip == segment.recording_clip)
        .filter(|previous| previous.end <= segment.start)
        .map_or(0., |previous| previous.end);

    // A clip already below the minimum duration must not be *grown* by its
    // own clamp -- without this, pressing the start handle of a sub-minimum
    // clip teleports its start leftwards to make up the difference.
    let ceiling = (segment.end - min_recorded).max(segment.start);
    Some(
        new_start
            .max(previous_floor)
            .max(segment.end - max_duration)
            .min(ceiling),
    )
}

/// The clip end handle's clamp (`TL/ClipTrack.tsx:1319-1334`).
pub fn clip_trim_end(
    timeline: &TimelineConfiguration,
    index: usize,
    new_end: f64,
    secs_per_pixel: f64,
    clip_display_durations: &[f64],
    recording_duration: f64,
) -> Option<f64> {
    let segment = timeline.segments.get(index)?;
    let min_recorded = clip_min_recorded_duration(timeline, index, secs_per_pixel);
    let max_segment = clip_display_durations
        .get(segment.recording_clip as usize)
        .copied()
        .unwrap_or(f64::INFINITY);
    let available = clip_available_timeline_duration(timeline, index, recording_duration);

    // Mirror of the start handle's floor: the next clip's start is only a
    // ceiling when that clip really is the right-hand half of a split,
    // starting at or after this clip's end.
    let next_ceiling = timeline
        .segments
        .get(index + 1)
        .filter(|next| next.recording_clip == segment.recording_clip)
        .filter(|next| next.start >= segment.end)
        .map_or(max_segment, |next| next.start);

    // Mirror of the start handle's growth guard for sub-minimum clips.
    let floor = (segment.start + min_recorded).min(segment.end);
    Some(
        new_end
            .min(segment.end + available * segment.timescale)
            .min(next_ceiling)
            .max(floor),
    )
}

// ---------------------------------------------------------------------------
// Auto zoom
// ---------------------------------------------------------------------------

/// `DEFAULT_AUTO_ZOOM_AMOUNT` (`src-tauri/src/recording.rs:3704`).
pub const DEFAULT_AUTO_ZOOM_AMOUNT: f64 = 2.0;

/// `generate_zoom_segments_from_clicks_impl`
/// (`src-tauri/src/recording.rs:3706-3782`), the algorithm behind the Tauri
/// command the empty zoom track's generate button invokes: every click grows
/// into a padded interval (300ms before, 2.5s after), clicks in the last
/// second are ignored, intervals closer than 2.5s merge, and the result is
/// clamped inside the recording. The Tauri signature also takes the cursor
/// *moves* and ignores them; this one does not pretend to want them.
pub fn generate_zoom_segments_from_clicks(
    mut clicks: Vec<CursorClickEvent>,
    max_duration: f64,
    zoom_amount: f64,
) -> Vec<ZoomSegment> {
    const MS_PER_SECOND: f64 = 1000.0;
    const START_MIN_MS: f64 = 1.0;
    const CLICK_PRE_PADDING_MS: f64 = 300.0;
    const CLICK_POST_PADDING_MS: f64 = 2500.0;
    const CLICK_END_CLAMP_PADDING_MS: f64 = 800.0;
    const TRAILING_CLICK_IGNORE_MS: f64 = 1000.0;
    const MERGE_GAP_MS: f64 = 2500.0;

    if max_duration <= 0.0 {
        return Vec::new();
    }

    let duration_ms = max_duration * MS_PER_SECOND;
    let click_cutoff_ms = duration_ms - TRAILING_CLICK_IGNORE_MS;
    let end_limit_ms = duration_ms - CLICK_END_CLAMP_PADDING_MS;
    if click_cutoff_ms <= 0.0 || end_limit_ms <= START_MIN_MS {
        return Vec::new();
    }

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut intervals: Vec<(f64, f64)> = Vec::new();
    for click in clicks {
        let time_ms = click.time_ms.floor();
        if time_ms >= click_cutoff_ms {
            continue;
        }

        let start = (time_ms - CLICK_PRE_PADDING_MS).max(START_MIN_MS);
        let end = (time_ms + CLICK_POST_PADDING_MS).min(end_limit_ms);

        if end > start {
            intervals.push((start, end));
        }
    }

    if intervals.is_empty() {
        return Vec::new();
    }

    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<(f64, f64)> = Vec::new();
    for interval in intervals {
        if let Some(last) = merged.last_mut()
            && interval.0 <= last.1 + MERGE_GAP_MS
        {
            last.1 = last.1.max(interval.1);
            continue;
        }
        merged.push(interval);
    }

    merged
        .into_iter()
        .map(|(start, end)| ZoomSegment {
            start: start.round() / MS_PER_SECOND,
            end: end.round() / MS_PER_SECOND,
            amount: zoom_amount,
            mode: ZoomMode::Auto,
            glide_direction: GlideDirection::None,
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
        })
        .collect()
}

/// `splitClipSegment(time, index)` (`ED/context.ts:512-580`).
///
/// `output_time` is in the *held* output domain the clip boxes are drawn in;
/// the first thing the action does is subtract the holds before it, which puts
/// it back in the gapless recording-flow domain the offsets live in.
pub fn split_clip_segment(
    timeline: &mut TimelineConfiguration,
    output_time: f64,
    requested_index: Option<usize>,
) -> bool {
    let holds = timeline.hold_windows();
    let time = output_time - held_time_before(&holds, output_time);
    let offsets = crate::editor_timeline::clip_timeline_offsets(timeline);

    let mut index = requested_index.filter(|index| *index < timeline.segments.len());
    if index.is_none() {
        for (position, segment) in timeline.segments.iter().enumerate() {
            let duration = segment.duration();
            let offset = offsets.get(position).copied().unwrap_or(0.);
            if time >= offset && time <= offset + duration {
                index = Some(position);
            }
        }
    }
    let Some(index) = index else { return false };

    let segment = timeline.segments[index].clone();
    let local_time = time - offsets.get(index).copied().unwrap_or(0.);
    let duration = segment.duration();
    if local_time <= 0. || local_time >= duration {
        return false;
    }

    let incoming = timeline
        .effective_transition(index)
        .map_or(0., |transition| transition.duration);
    let outgoing = timeline
        .effective_transition(index + 1)
        .map_or(0., |transition| transition.duration);
    if local_time < incoming * 2. || duration - local_time < outgoing * 2. {
        return false;
    }

    let boundary = segment.start + local_time * segment.timescale;
    let mut tail = segment.clone();
    tail.start = boundary;
    timeline.segments.insert(index + 1, tail);
    timeline.segments[index].end = boundary;

    // `transitionsAfterClipSplit` -- everything after the split point shifts
    // up by one, and the split boundary itself is a hard cut.
    for transition in timeline.transitions.iter_mut() {
        if transition.segment_index as usize > index {
            transition.segment_index += 1;
        }
    }
    true
}

/// `heldTimeBefore` (`ED/timeline-holds.ts`): how much held time an output
/// timestamp sits past. Rust's own copy is private, so it is transcribed the
/// same way `effective_to_output` was in E3.
pub fn held_time_before(holds: &[(f64, f64)], output_time: f64) -> f64 {
    let mut held = 0.;
    for (start, end) in holds {
        if output_time >= *end {
            held += end - start;
        } else if output_time > *start {
            held += output_time - start;
            break;
        } else {
            break;
        }
    }
    held
}

// ---------------------------------------------------------------------------
// Split snapping
// ---------------------------------------------------------------------------

/// `SPLIT_SNAP_PX` / `SPLIT_EDGE_EPSILON` (`TL/split-snapping.ts:9-10`).
pub const SPLIT_SNAP_PX: f64 = 7.;
pub const SPLIT_EDGE_EPSILON: f64 = 0.05;

/// `splitTimeAt(e)` (`TL/ClipTrack.tsx:666-682`): the raw pointer time, or the
/// snapped one. **Alt disables snapping entirely** -- `if (e.altKey) return {
/// time: raw, snapped: null }` -- which is the escape hatch for cutting
/// somewhere a boundary would otherwise pull the cut away from.
#[allow(clippy::too_many_arguments)]
pub fn split_time_at(
    raw: f64,
    clip_start: f64,
    clip_end: f64,
    radius: f64,
    timeline: &TimelineConfiguration,
    playhead: f64,
    alt: bool,
) -> (f64, bool) {
    if alt {
        return (raw, false);
    }
    snap_split_time(raw, clip_start, clip_end, radius, timeline, playhead)
}

/// `snapSplitTime` (`TL/split-snapping.ts:28-66`), verbatim.
///
/// Candidates are the playhead and every segment boundary on the eight
/// non-clip tracks, rejected outside `[clipStart + eps, clipEnd - eps]` (a cut
/// that close to an edge would leave a sliver) and outside `radius`. Ties go to
/// the earlier time. Alt skips the whole thing -- the caller's job
/// (`TL/ClipTrack.tsx:670-682`).
pub fn snap_split_time(
    raw: f64,
    clip_start: f64,
    clip_end: f64,
    radius: f64,
    timeline: &TimelineConfiguration,
    playhead: f64,
) -> (f64, bool) {
    let min = clip_start + SPLIT_EDGE_EPSILON;
    let max = clip_end - SPLIT_EDGE_EPSILON;
    let mut best: Option<f64> = None;
    let mut best_distance = f64::INFINITY;

    let mut consider = |candidate: f64| {
        if candidate < min || candidate > max {
            return;
        }
        let distance = (candidate - raw).abs();
        if distance > radius {
            return;
        }
        if distance < best_distance
            || (distance == best_distance && best.is_some_and(|current| candidate < current))
        {
            best_distance = distance;
            best = Some(candidate);
        }
    };

    consider(playhead);
    // `BOUNDARY_TRACKS` in the source's own order.
    for (start, end) in timeline
        .zoom_segments
        .iter()
        .map(|segment| (segment.start, segment.end))
        .chain(
            timeline
                .scene_segments
                .iter()
                .map(|segment| (segment.start, segment.end)),
        )
        .chain(
            timeline
                .camera3d_segments
                .iter()
                .map(|segment| (segment.start, segment.end)),
        )
        .chain(
            timeline
                .text_segments
                .iter()
                .map(|segment| (segment.start, segment.end)),
        )
        .chain(
            timeline
                .mask_segments
                .iter()
                .map(|segment| (segment.start, segment.end)),
        )
        .chain(
            timeline
                .caption_segments
                .iter()
                .map(|segment| (segment.start, segment.end)),
        )
        .chain(
            timeline
                .keyboard_segments
                .iter()
                .map(|segment| (segment.start, segment.end)),
        )
        .chain(
            timeline
                .audio_segments
                .iter()
                .map(|segment| (segment.start, segment.end)),
        )
        .collect::<Vec<_>>()
    {
        consider(start);
        consider(end);
    }

    match best {
        Some(time) => (time, true),
        None => (raw, false),
    }
}

pub fn clip_timeline_duration(timeline: &TimelineConfiguration) -> f64 {
    if timeline.segments.is_empty() {
        return 0.0;
    }
    let offsets = editor_timeline::clip_timeline_offsets(timeline);
    offsets[offsets.len() - 1] + timeline.segments[timeline.segments.len() - 1].duration()
}

fn timeline_shift_after_clip_duration_change(
    time: f64,
    old_current_start: f64,
    new_current_start: f64,
    old_stable_start: f64,
    old_next_boundary: f64,
    new_next_boundary: f64,
) -> f64 {
    if time < old_current_start {
        return 0.0;
    }
    if time < old_stable_start {
        let incoming_duration = old_stable_start - old_current_start;
        if incoming_duration <= f64::EPSILON {
            return 0.0;
        }
        return ((new_current_start - old_current_start) * (old_stable_start - time))
            / incoming_duration;
    }
    let full_shift = new_next_boundary - old_next_boundary;
    if time >= old_next_boundary {
        return full_shift;
    }
    if time <= old_stable_start {
        return 0.0;
    }
    let affected_duration = old_next_boundary - old_stable_start;
    if affected_duration <= f64::EPSILON {
        return full_shift;
    }
    (full_shift * (time - old_stable_start)) / affected_duration
}

fn scale_keyframe_times(tracks: &mut cap_project::Camera3DTracks, scale: f64) {
    for track in tracks.all_tracks_mut() {
        for keyframe in track.iter_mut() {
            keyframe.time *= scale;
        }
    }
}

fn normalize_clip_transitions(timeline: &mut TimelineConfiguration) {
    let count = timeline.segments.len();
    let mut next = Vec::new();
    for index in 1..count {
        if let Some(transition) = timeline.effective_transition(index) {
            next.push(transition);
        }
    }
    timeline.transitions = next;
}

pub fn set_clip_segment_timescale(
    timeline: &mut TimelineConfiguration,
    index: usize,
    timescale: f64,
) -> bool {
    if !(0.25..=8.0).contains(&timescale) || !timescale.is_finite() {
        return false;
    }
    let Some(segment) = timeline.segments.get(index) else {
        return false;
    };
    if (segment.timescale - timescale).abs() < f64::EPSILON {
        return false;
    }

    let old_duration = clip_timeline_duration(timeline);
    let old_offsets = editor_timeline::clip_timeline_offsets(timeline);
    let incoming_duration = timeline
        .effective_transition(index)
        .map_or(0.0, |transition| transition.duration);

    timeline.segments[index].timescale = timescale;
    normalize_clip_transitions(timeline);

    let new_duration = clip_timeline_duration(timeline);
    let new_offsets = editor_timeline::clip_timeline_offsets(timeline);
    let absolute_start = old_offsets[index] + incoming_duration;
    let old_next_boundary = old_offsets.get(index + 1).copied().unwrap_or(old_duration);
    let new_next_boundary = new_offsets.get(index + 1).copied().unwrap_or(new_duration);

    let shift = |time: f64| {
        timeline_shift_after_clip_duration_change(
            time,
            old_offsets[index],
            new_offsets[index],
            absolute_start,
            old_next_boundary,
            new_next_boundary,
        )
    };

    for segment in &mut timeline.zoom_segments {
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
    }
    for segment in &mut timeline.scene_segments {
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
    }
    for segment in &mut timeline.mask_segments {
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
    }
    for segment in &mut timeline.text_segments {
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
    }
    for segment in &mut timeline.audio_segments {
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
    }
    for segment in &mut timeline.caption_segments {
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
    }
    for segment in &mut timeline.keyboard_segments {
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
    }
    for segment in &mut timeline.camera3d_segments {
        let previous_duration = segment.end - segment.start;
        segment.start += shift(segment.start);
        segment.end += shift(segment.end);
        let next_duration = segment.end - segment.start;
        if previous_duration > 0.0 && (next_duration - previous_duration).abs() > f64::EPSILON {
            scale_keyframe_times(&mut segment.tracks, next_duration / previous_duration);
        }
    }
    true
}

pub fn clip_is_muted(segment: &TimelineSegment) -> bool {
    let speed_mode_muted = if (segment.timescale - 1.0).abs() < f64::EPSILON {
        segment.speed_audio_mode == Some(ClipSpeedAudioMode::Mute)
    } else {
        segment.speed_audio_mode.unwrap_or(ClipSpeedAudioMode::Mute) == ClipSpeedAudioMode::Mute
    };
    segment.audio_muted || speed_mode_muted
}

pub fn set_clip_muted(timeline: &mut TimelineConfiguration, index: usize, muted: bool) -> bool {
    let Some(segment) = timeline.segments.get_mut(index) else {
        return false;
    };
    if segment.audio_muted == muted {
        return false;
    }
    segment.audio_muted = muted;
    true
}

pub fn set_clip_segment_speed_audio_mode(
    timeline: &mut TimelineConfiguration,
    index: usize,
    mode: ClipSpeedAudioMode,
) -> bool {
    let Some(segment) = timeline.segments.get_mut(index) else {
        return false;
    };
    if segment.speed_audio_mode == Some(mode) {
        return false;
    }
    segment.speed_audio_mode = Some(mode);
    true
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::editor_timeline::{SegmentDetail, TimelineModel};

    const OVERLAPPING_SEGMENT_END: f64 = 314.0 / 100.0;

    fn config(json: serde_json::Value) -> ProjectConfiguration {
        serde_json::from_value(json).expect("fixture parses")
    }

    fn zoom_fixture() -> ProjectConfiguration {
        config(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 30.0 }],
                "zoomSegments": [
                    { "start": 2.0, "end": 5.0, "amount": 1.5, "mode": "auto" },
                    { "start": 20.0, "end": 24.0, "amount": 2.0, "mode": "auto" }
                ]
            }
        }))
    }

    fn segments(model: &TimelineModel, kind: TrackKind) -> Vec<Segment> {
        match kind {
            TrackKind::Zoom => model.zoom.clone(),
            TrackKind::Clip => model.clips.clone(),
            TrackKind::Mask => model.mask.clone(),
            _ => Vec::new(),
        }
    }

    // -- Selection ----------------------------------------------------------

    #[test]
    fn a_plain_click_selects_one_segment() {
        let selection = click_selection(None, TrackKind::Zoom, 3, false, false);
        assert_eq!(selection, Some(Selection::single(TrackKind::Zoom, 3)));
    }

    #[test]
    fn cmd_click_toggles_and_an_emptied_selection_clears() {
        let base = Selection {
            track: TrackKind::Zoom,
            indices: vec![1, 2],
        };
        // Adding appends, keeping click order.
        let added = click_selection(Some(&base), TrackKind::Zoom, 5, false, true).unwrap();
        assert_eq!(added.indices, vec![1, 2, 5]);
        // Removing an already-selected index drops it.
        let removed = click_selection(Some(&added), TrackKind::Zoom, 2, false, true).unwrap();
        assert_eq!(removed.indices, vec![1, 5]);
        // Emptying it clears the selection entirely.
        let single = Selection::single(TrackKind::Zoom, 4);
        assert_eq!(
            click_selection(Some(&single), TrackKind::Zoom, 4, false, true),
            None
        );
        // Against another track's selection it starts fresh.
        let other = Selection::single(TrackKind::Text, 0);
        assert_eq!(
            click_selection(Some(&other), TrackKind::Zoom, 1, false, true),
            Some(Selection::single(TrackKind::Zoom, 1))
        );
    }

    #[test]
    fn shift_click_extends_from_the_last_selected_index() {
        let base = Selection {
            track: TrackKind::Clip,
            indices: vec![4, 1],
        };
        // The anchor is `indices.at(-1)` -- 1, not 4.
        let range = click_selection(Some(&base), TrackKind::Clip, 3, true, false).unwrap();
        assert_eq!(range.indices, vec![1, 2, 3]);
        // Backwards works the same way.
        let back = click_selection(Some(&range), TrackKind::Clip, 0, true, false).unwrap();
        assert_eq!(back.indices, vec![0, 1, 2, 3]);
        // Shift with no selection on this track is a plain click.
        assert_eq!(
            click_selection(None, TrackKind::Clip, 2, true, false),
            Some(Selection::single(TrackKind::Clip, 2))
        );
    }

    #[test]
    fn select_all_expands_to_the_tracks_segment_count() {
        let selection = Selection::single(TrackKind::Zoom, 1);
        assert_eq!(
            select_all_on_track(Some(&selection), 3).unwrap().indices,
            vec![0, 1, 2]
        );
        assert_eq!(select_all_on_track(None, 3), None);
        assert_eq!(select_all_on_track(Some(&selection), 0), None);
    }

    // -- History ------------------------------------------------------------

    fn with_zoom_count(count: usize) -> ProjectConfiguration {
        let mut config = zoom_fixture();
        let timeline = config.timeline.as_mut().unwrap();
        timeline.zoom_segments.clear();
        for index in 0..count {
            insert_zoom_segment(timeline, index as f64 * 2., index as f64 * 2. + 1., 1.5);
        }
        config
    }

    fn zoom_len(config: &ProjectConfiguration) -> usize {
        config
            .timeline
            .as_ref()
            .map_or(0, |timeline| timeline.zoom_segments.len())
    }

    #[test]
    fn history_walks_back_and_forward_through_snapshots() {
        let mut history = ProjectHistory::new(with_zoom_count(0));
        assert!(!history.can_undo(), "one entry is nothing to undo");
        assert!(!history.can_redo());

        history.record(&with_zoom_count(1));
        history.record(&with_zoom_count(2));
        assert!(history.can_undo());

        assert_eq!(zoom_len(history.undo().unwrap()), 1);
        assert_eq!(zoom_len(history.undo().unwrap()), 0);
        assert!(!history.can_undo(), "the initial state is the floor");
        assert_eq!(zoom_len(history.redo().unwrap()), 1);
        assert_eq!(zoom_len(history.redo().unwrap()), 2);
        assert!(!history.can_redo());
    }

    #[test]
    fn a_new_change_truncates_the_redo_tail() {
        let mut history = ProjectHistory::new(with_zoom_count(0));
        history.record(&with_zoom_count(1));
        history.record(&with_zoom_count(2));
        history.undo();
        assert!(history.can_redo());
        history.record(&with_zoom_count(7));
        assert!(!history.can_redo(), "the 2-segment future is gone");
        assert_eq!(zoom_len(history.undo().unwrap()), 1);
    }

    /// The coalescing contract: a paused bracket that wrote something is one
    /// entry, and a paused bracket that wrote nothing is none.
    #[test]
    fn a_paused_drag_records_exactly_one_entry() {
        let mut history = ProjectHistory::new(with_zoom_count(0));
        history.pause();
        for count in 1..=20 {
            history.record(&with_zoom_count(count));
        }
        assert_eq!(history.depth(), 1, "nothing lands while paused");
        history.resume(&with_zoom_count(20));
        assert_eq!(history.depth(), 2, "the whole drag is one entry");
        assert_eq!(zoom_len(history.undo().unwrap()), 0);

        // A bracket that wrote nothing -- a click that selected and never
        // moved -- leaves the stack alone.
        let mut clean = ProjectHistory::new(with_zoom_count(0));
        clean.pause();
        clean.resume(&with_zoom_count(0));
        assert_eq!(clean.depth(), 1);
        assert!(!clean.can_undo());
    }

    #[test]
    fn the_stack_is_capped_at_a_hundred_entries() {
        let mut history = ProjectHistory::new(with_zoom_count(0));
        for count in 0..200 {
            history.record(&with_zoom_count(count % 5));
        }
        assert_eq!(history.depth(), HISTORY_LIMIT);
    }

    // -- Hit testing --------------------------------------------------------

    #[test]
    fn the_handles_reach_ten_pixels_either_side_of_an_edge() {
        let model = TimelineModel::build(&zoom_fixture(), false, false);
        let zoom = segments(&model, TrackKind::Zoom);
        // 30s over 1000px: 0.03 s/px, so the first segment spans 66.7..166.7.
        let spp = 0.03;
        let at = |x: f64| hit_test(&zoom, 0, x, 0., spp);

        assert_eq!(
            at(2.0 / spp),
            Hit::Handle {
                index: 0,
                start: true
            }
        );
        assert_eq!(
            at(2.0 / spp + 9.),
            Hit::Handle {
                index: 0,
                start: true
            },
            "inside the segment but inside the handle too"
        );
        assert_eq!(at(2.0 / spp + 11.), Hit::Body { index: 0 });
        assert_eq!(
            at(5.0 / spp - 3.),
            Hit::Handle {
                index: 0,
                start: false
            }
        );
        assert_eq!(
            at(5.0 / spp + 8.),
            Hit::Handle {
                index: 0,
                start: false
            },
            "the end handle overhangs into the gap"
        );
        assert_eq!(at(12.0 / spp), Hit::Empty);
        assert_eq!(at(21.0 / spp), Hit::Body { index: 1 });
    }

    /// Two segments that share an edge -- which every pair of adjacent clips
    /// does -- have two handles stacked on the same 20 pixels. The DOM (and so
    /// the shipping app) gives the whole zone to the later segment's start
    /// handle, which makes the earlier clip's end unreachable and turns "trim
    /// the left clip" into "grow the right clip". Here the zone is split at
    /// the boundary instead: each side belongs to the segment whose box the
    /// pointer is actually in, and only the exact shared edge keeps the
    /// paint-order tiebreak.
    #[test]
    fn a_shared_edge_splits_between_both_segments_handles() {
        let clip = |start: f64, end: f64| Segment {
            start,
            end,
            lane: 0,
            detail: SegmentDetail::Clip {
                name: "Clip".into(),
                source_start: 0.,
                source_duration: end - start,
                timescale: 1.,
                muted: false,
                recording_clip: 0,
                holds: Arc::from(&[][..]),
            },
        };
        let clips = [clip(0., 10.), clip(10., 18.)];
        // 0.0125 s/px, so the shared edge at 10s is x = 800.
        assert_eq!(
            hit_test(&clips, 0, 800., 0., 0.0125),
            Hit::Handle {
                index: 1,
                start: true
            }
        );
        // Eight pixels inside clip 0 is clip 0's own end handle.
        assert_eq!(
            hit_test(&clips, 0, 792., 0., 0.0125),
            Hit::Handle {
                index: 0,
                start: false
            }
        );
        // Eight pixels inside clip 1 is clip 1's start handle.
        assert_eq!(
            hit_test(&clips, 0, 808., 0., 0.0125),
            Hit::Handle {
                index: 1,
                start: true
            }
        );
        // Past the handle's reach, clip 0's body takes over again.
        assert_eq!(
            hit_test(&clips, 0, 780., 0., 0.0125),
            Hit::Body { index: 0 }
        );
    }

    #[test]
    fn hit_testing_ignores_other_lanes() {
        let masks = vec![
            Segment {
                start: 0.,
                end: 5.,
                lane: 0,
                detail: SegmentDetail::Mask { label: "Sensitive" },
            },
            Segment {
                start: 0.,
                end: 5.,
                lane: 1,
                detail: SegmentDetail::Mask { label: "Highlight" },
            },
        ];
        assert_eq!(hit_test(&masks, 1, 100., 0., 0.01), Hit::Body { index: 1 });
        assert_eq!(hit_test(&masks, 0, 100., 0., 0.01), Hit::Body { index: 0 });
        assert_eq!(hit_test(&masks, 2, 100., 0., 0.01), Hit::Empty);
    }

    // -- Trim ---------------------------------------------------------------

    #[test]
    fn the_trim_floor_is_the_larger_of_the_two_per_track_minimums() {
        // Zoomed out: 0.05 s/px, so 40px is 2s and the pixel floor wins.
        assert_eq!(min_segment_duration(TrackKind::Zoom, 0.05), 2.);
        // Zoomed in: 0.01 s/px puts 40px at 0.4s, so the 1s floor wins.
        assert_eq!(min_segment_duration(TrackKind::Zoom, 0.01), 1.);
        assert_eq!(min_segment_duration(TrackKind::Keyboard, 0.001), 0.3);
        assert_eq!(min_segment_duration(TrackKind::Audio, 0.001), 0.5);
        assert_eq!(min_segment_duration(TrackKind::Mask, 0.05), 4.);
    }

    #[test]
    fn trim_bounds_stop_at_the_neighbours_and_the_floor() {
        let model = TimelineModel::build(&zoom_fixture(), false, false);
        let zoom = segments(&model, TrackKind::Zoom);
        let min = min_segment_duration(TrackKind::Zoom, 0.01);
        assert_eq!(min, 1.);

        // Segment 1 (20..24): its start may go back to 5 (segment 0's end) and
        // forward to 23 (its own end less the floor).
        let start = trim_start_bounds(&zoom, 0, 1, min, 30.);
        assert_eq!(start, DragBounds { min: 5., max: 23. });
        assert_eq!(start.clamp(2.), 5.);
        assert_eq!(start.clamp(99.), 23.);

        // Its end may go from 21 (start + floor) to 30 (the timeline's end).
        let end = trim_end_bounds(&zoom, 0, 1, min, 30.);
        assert_eq!(end, DragBounds { min: 21., max: 30. });

        // Segment 0's end stops at segment 1's start.
        assert_eq!(
            trim_end_bounds(&zoom, 0, 0, min, 30.),
            DragBounds { min: 3., max: 20. }
        );

        // A move slides between the two neighbours, in *delta* terms: the
        // first segment (2..5) may go 2s left and 15s right.
        assert_eq!(
            move_bounds(&zoom, 0, 0, 30.),
            DragBounds { min: -2., max: 15. }
        );
    }

    /// A floor bigger than the gap must not invert the clamp: `maxValue` is
    /// `max(minValue, ...)` in the source for exactly this reason.
    #[test]
    fn a_floor_wider_than_the_segment_pins_rather_than_inverting() {
        let model = TimelineModel::build(&zoom_fixture(), false, false);
        let zoom = segments(&model, TrackKind::Zoom);
        // 0.2 s/px puts the 40px floor at 8s -- wider than the 3s segment.
        let min = min_segment_duration(TrackKind::Zoom, 0.2);
        assert_eq!(min, 8.);
        let bounds = trim_start_bounds(&zoom, 0, 0, min, 30.);
        assert_eq!(bounds.min, 0.);
        assert_eq!(bounds.max, 0., "pinned, not inverted");
        assert_eq!(bounds.clamp(4.), 0.);
    }

    // -- Clip trim ----------------------------------------------------------

    fn two_clip_config() -> ProjectConfiguration {
        config(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 },
                    { "recordingSegment": 1, "timescale": 1.0, "start": 0.0, "end": 8.0 }
                ],
                "zoomSegments": []
            }
        }))
    }

    #[test]
    fn the_clip_floor_carries_the_pixel_width_and_the_timescale() {
        let config = two_clip_config();
        let timeline = config.timeline.as_ref().unwrap();
        // 0.001 s/px: 20px is 0.02s, so the 0.1s floor wins.
        assert_eq!(clip_min_recorded_duration(timeline, 0, 0.001), 0.1);
        // 0.05 s/px: 20px is 1s.
        assert_eq!(clip_min_recorded_duration(timeline, 0, 0.05), 1.);

        // A transition doubles into the floor, and both terms scale with the
        // clip's own timescale.
        let mut fast = two_clip_config();
        let timeline = fast.timeline.as_mut().unwrap();
        timeline.segments[1].timescale = 2.0;
        timeline.transitions = vec![cap_project::ClipTransition {
            segment_index: 1,
            kind: cap_project::ClipTransitionType::CrossFade,
            duration: 0.6,
        }];
        let timeline = fast.timeline.as_ref().unwrap();
        assert_eq!(clip_min_recorded_duration(timeline, 1, 0.001), 2.4);
    }

    #[test]
    fn clip_trim_clamps_to_the_recording_and_the_floor() {
        let config = two_clip_config();
        let timeline = config.timeline.as_ref().unwrap();
        let displays = [12.0, 9.0];
        let recording = 21.0;
        let spp = 0.05; // floor = 20px * 0.05 = 1s

        // Trimming clip 0's start forwards by 3s is allowed.
        assert_eq!(
            clip_trim_start(timeline, 0, 3.0, spp, &displays, recording),
            Some(3.0)
        );
        // Past `end - floor` it pins at 9.
        assert_eq!(
            clip_trim_start(timeline, 0, 9.8, spp, &displays, recording),
            Some(9.0)
        );
        // Before zero it pins at zero.
        assert_eq!(
            clip_trim_start(timeline, 0, -4.0, spp, &displays, recording),
            Some(0.0)
        );
        // Clip 0's end may grow to the display track's own 12s.
        assert_eq!(
            clip_trim_end(timeline, 0, 30.0, spp, &displays, recording),
            Some(12.0)
        );
        // And may not shrink below `start + floor`.
        assert_eq!(
            clip_trim_end(timeline, 0, 0.1, spp, &displays, recording),
            Some(1.0)
        );
        // Zoomed in, the floor drops to the 0.1s minimum.
        assert_eq!(
            clip_trim_end(timeline, 0, 0.02, 0.001, &displays, recording),
            Some(0.1)
        );
    }

    /// Clips whose source ranges *overlap* their same-clip neighbours --
    /// duplicates, auto-generated cuts -- must still trim. The shape is a
    /// real six-clip recording whose non-last clips were locked: clip 0 is
    /// 2.54..3.14 but clip 1 starts at 2.14, so the old floor (previous end,
    /// 3.14) sat above clip 1's own ceiling (end - the 1s minimum, 2.29) and
    /// every drag landed on the same pinned value.
    #[test]
    fn overlapping_same_clip_neighbours_do_not_lock_the_trim() {
        let overlapping = config(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 2.54, "end": OVERLAPPING_SEGMENT_END },
                    { "recordingSegment": 0, "timescale": 1.0, "start": 2.14, "end": 3.29 },
                    { "recordingSegment": 0, "timescale": 1.0, "start": 3.29, "end": 6.68 },
                    { "recordingSegment": 0, "timescale": 1.0, "start": 5.83, "end": 6.98 }
                ],
                "zoomSegments": []
            }
        }));
        let timeline = overlapping.timeline.as_ref().unwrap();
        let displays = [47.71];
        let recording = 47.71;
        let spp = 0.05; // floor = 20px * 0.05 = 1s

        // Clip 1's start reduces freely inside its own window; the old clamp
        // pinned any drag at 2.29.
        assert_eq!(
            clip_trim_start(timeline, 1, 2.2, spp, &displays, recording),
            Some(2.2)
        );
        // And still stops at its own 1s floor.
        assert_eq!(
            clip_trim_start(timeline, 1, 3.0, spp, &displays, recording),
            Some(2.29)
        );
        // Clip 2's end grows past clip 3's (overlapping) start; the old
        // ceiling refused anything above 5.83.
        assert_eq!(
            clip_trim_end(timeline, 2, 7.5, spp, &displays, recording),
            Some(7.5)
        );
        assert_eq!(
            clip_trim_end(timeline, 2, 5.0, spp, &displays, recording),
            Some(5.0)
        );

        // The split-halves contract is untouched: abutting neighbours still
        // floor and ceiling each other.
        let split = config(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 5.0 },
                    { "recordingSegment": 0, "timescale": 1.0, "start": 5.0, "end": 9.0 }
                ],
                "zoomSegments": []
            }
        }));
        let timeline = split.timeline.as_ref().unwrap();
        assert_eq!(
            clip_trim_start(timeline, 1, 3.0, spp, &displays, recording),
            Some(5.0)
        );
        assert_eq!(
            clip_trim_end(timeline, 0, 7.0, spp, &displays, recording),
            Some(5.0)
        );
    }

    /// A clip already shorter than the 1s minimum must not be *grown* by its
    /// own clamp: clip 0 above is 0.6s, and the old floor (`start + 1s`)
    /// jumped its end to 3.54 on any handle press.
    #[test]
    fn sub_minimum_clips_hold_their_edges_instead_of_growing() {
        let overlapping = config(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "timescale": 1.0, "start": 2.54, "end": OVERLAPPING_SEGMENT_END },
                    { "recordingSegment": 0, "timescale": 1.0, "start": 2.14, "end": 3.29 }
                ],
                "zoomSegments": []
            }
        }));
        let timeline = overlapping.timeline.as_ref().unwrap();
        let displays = [47.71];
        let recording = 47.71;
        let spp = 0.05; // floor = 1s, above the clip's own 0.6s

        assert_eq!(
            clip_trim_end(timeline, 0, 2.6, spp, &displays, recording),
            Some(OVERLAPPING_SEGMENT_END)
        );
        assert_eq!(
            clip_trim_start(timeline, 0, 3.0, spp, &displays, recording),
            Some(2.54)
        );
        // Growth away from the minimum still works on both edges.
        assert_eq!(
            clip_trim_end(timeline, 0, 4.0, spp, &displays, recording),
            Some(4.0)
        );
        assert_eq!(
            clip_trim_start(timeline, 0, 1.0, spp, &displays, recording),
            Some(1.0)
        );
    }

    // -- Auto zoom ----------------------------------------------------------

    fn click(time_ms: f64) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: Vec::new(),
            cursor_num: 0,
            cursor_id: String::new(),
            time_ms,
            down: true,
        }
    }

    /// Two clicks a second apart merge into one segment, a distant one stands
    /// alone, and a click inside the trailing second is dropped -- the same
    /// cases `src-tauri/src/recording.rs` pins on its own copy.
    #[test]
    fn clicks_pad_merge_and_clamp_into_zoom_segments() {
        let segments = generate_zoom_segments_from_clicks(
            vec![click(1_000.), click(2_000.), click(10_000.), click(19_500.)],
            20.0,
            2.0,
        );
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start, 0.7);
        assert_eq!(segments[0].end, 4.5);
        assert_eq!(segments[0].amount, 2.0);
        assert_eq!(segments[1].start, 9.7);
        assert_eq!(segments[1].end, 12.5);
    }

    #[test]
    fn no_clicks_or_no_duration_generate_no_zoom_segments() {
        assert!(generate_zoom_segments_from_clicks(Vec::new(), 20.0, 2.0).is_empty());
        assert!(generate_zoom_segments_from_clicks(vec![click(1_000.)], 0.0, 2.0).is_empty());
    }

    // -- Split --------------------------------------------------------------

    #[test]
    fn splitting_a_clip_produces_two_segments_at_the_cut() {
        let mut config = two_clip_config();
        let timeline = config.timeline.as_mut().unwrap();
        assert!(split_clip_segment(timeline, 4.0, None));
        assert_eq!(timeline.segments.len(), 3);
        assert_eq!(
            (timeline.segments[0].start, timeline.segments[0].end),
            (0., 4.)
        );
        assert_eq!(
            (timeline.segments[1].start, timeline.segments[1].end),
            (4., 10.)
        );
        assert_eq!(timeline.segments[1].recording_clip, 0);
        // The second recording clip is untouched.
        assert_eq!(
            (timeline.segments[2].start, timeline.segments[2].end),
            (0., 8.)
        );
    }

    #[test]
    fn a_split_on_a_boundary_is_refused() {
        let mut config = two_clip_config();
        let timeline = config.timeline.as_mut().unwrap();
        assert!(
            !split_clip_segment(timeline, 0.0, None),
            "at the very start"
        );
        assert!(
            !split_clip_segment(timeline, 10.0, Some(0)),
            "at its own end"
        );
        assert_eq!(timeline.segments.len(), 2);
    }

    /// A fullscreen text segment pauses the clock, so a click at 12s of output
    /// time is 9s of recording time when a 3s hold sits at 8..11.
    #[test]
    fn a_clip_split_converts_out_of_held_output_time() {
        let mut config = config(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 20.0 }],
                "zoomSegments": [],
                "textSegments": [
                    { "start": 8.0, "end": 11.0, "track": 0, "content": "x", "layout": "fullscreen" }
                ]
            }
        }));
        let timeline = config.timeline.as_mut().unwrap();
        assert_eq!(held_time_before(&timeline.hold_windows(), 12.0), 3.0);
        assert!(split_clip_segment(timeline, 12.0, Some(0)));
        assert_eq!(timeline.segments[0].end, 9.0);
        assert_eq!(timeline.segments[1].start, 9.0);
    }

    #[test]
    fn a_timescaled_clip_splits_in_the_recording_domain() {
        let mut config = two_clip_config();
        let timeline = config.timeline.as_mut().unwrap();
        timeline.segments[0].timescale = 2.0;
        // The clip plays 0..10 of recording in 5s of output; cutting at 2s of
        // output is 4s into the recording.
        assert!(split_clip_segment(timeline, 2.0, Some(0)));
        assert_eq!(timeline.segments[0].end, 4.0);
        assert_eq!(timeline.segments[1].start, 4.0);
        assert_eq!(timeline.segments[1].timescale, 2.0);
    }

    #[test]
    fn a_zoom_split_needs_a_second_either_side() {
        let mut config = zoom_fixture();
        let timeline = config.timeline.as_mut().unwrap();
        // The first segment is 3s long; a cut 0.5s in leaves too little.
        assert!(!split_segment(timeline, TrackKind::Zoom, 0, 0.5));
        assert!(!split_segment(timeline, TrackKind::Zoom, 0, 2.5));
        assert!(split_segment(timeline, TrackKind::Zoom, 0, 1.5));
        assert_eq!(timeline.zoom_segments.len(), 3);
        assert_eq!(timeline.zoom_segments[0].end, 3.5);
        assert_eq!(timeline.zoom_segments[1].start, 3.5);
        assert_eq!(timeline.zoom_segments[1].end, 5.0);
        // 3D's split needs the pose evaluator and is not reproduced.
        assert!(!split_segment(timeline, TrackKind::ThreeD, 0, 1.5));
    }

    #[test]
    fn an_audio_split_moves_the_source_offset_and_hard_cuts_the_seam() {
        let mut config = config(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 30.0 }],
                "zoomSegments": [],
                "audioSegments": [{
                    "start": 2.0, "end": 12.0, "track": 0, "path": "/tmp/a.mp3",
                    "trimStart": 1.0, "fadeIn": 0.4, "fadeOut": 0.6
                }]
            }
        }));
        let timeline = config.timeline.as_mut().unwrap();
        assert!(split_segment(timeline, TrackKind::Audio, 0, 4.0));
        let head = &timeline.audio_segments[0];
        let tail = &timeline.audio_segments[1];
        assert_eq!((head.start, head.end), (2., 6.));
        assert_eq!(head.fade_in, 0.4, "the outer fade survives");
        assert_eq!(head.fade_out, 0.0, "the seam is a hard cut");
        assert_eq!((tail.start, tail.end), (6., 12.));
        assert_eq!(tail.trim_start, 5.0, "the source offset moves with the cut");
        assert_eq!(tail.fade_in, 0.0);
        assert_eq!(tail.fade_out, 0.6);
    }

    // -- Split snapping -----------------------------------------------------

    #[test]
    fn a_split_snaps_to_the_nearest_boundary_inside_the_radius() {
        let config = zoom_fixture();
        let timeline = config.timeline.as_ref().unwrap();
        let radius = SPLIT_SNAP_PX * 0.01; // 0.07s

        // 5.02 is 0.02 from the first zoom segment's end.
        let (time, snapped) = snap_split_time(5.02, 0., 30., radius, timeline, 0.);
        assert!(snapped);
        assert_eq!(time, 5.0);

        // 5.2 is outside the radius, so nothing snaps.
        let (time, snapped) = snap_split_time(5.2, 0., 30., radius, timeline, 0.);
        assert!(!snapped);
        assert_eq!(time, 5.2);

        // The playhead is a candidate too.
        let (time, snapped) = snap_split_time(12.03, 0., 30., radius, timeline, 12.0);
        assert!(snapped);
        assert_eq!(time, 12.0);
    }

    /// Alt is the escape hatch: the same pointer position that snapped above
    /// stays exactly where it is.
    #[test]
    fn alt_disables_split_snapping() {
        let config = zoom_fixture();
        let timeline = config.timeline.as_ref().unwrap();
        let radius = SPLIT_SNAP_PX * 0.01;
        assert_eq!(
            split_time_at(5.02, 0., 30., radius, timeline, 0., false),
            (5.0, true)
        );
        assert_eq!(
            split_time_at(5.02, 0., 30., radius, timeline, 0., true),
            (5.02, false)
        );
    }

    /// `SPLIT_EDGE_EPSILON`: a candidate within 0.05s of the hovered clip's own
    /// edges is rejected -- snapping there would cut off a sliver.
    #[test]
    fn the_edge_epsilon_rejects_a_boundary_on_the_clips_own_edge() {
        let config = zoom_fixture();
        let timeline = config.timeline.as_ref().unwrap();
        let radius = 1.0;
        // The clip runs 2..20, and a zoom boundary sits exactly on 2.
        let (time, snapped) = snap_split_time(2.02, 2., 20., radius, timeline, -1.);
        assert!(!snapped, "2.0 is inside the epsilon of the clip's start");
        assert_eq!(time, 2.02);
        // 0.05 past it is fair game.
        let (time, snapped) = snap_split_time(2.02, 1.9, 20., radius, timeline, -1.);
        assert!(snapped);
        assert_eq!(time, 2.0);
    }

    // -- Delete -------------------------------------------------------------

    #[test]
    fn deleting_several_indices_removes_exactly_them() {
        let mut config = with_zoom_count(5);
        let timeline = config.timeline.as_mut().unwrap();
        let starts = |timeline: &TimelineConfiguration| {
            timeline
                .zoom_segments
                .iter()
                .map(|segment| segment.start)
                .collect::<Vec<_>>()
        };
        // Out of order, duplicated and out of bounds -- all normalised.
        assert!(delete_segments(timeline, TrackKind::Zoom, &[3, 1, 1, 99]));
        assert_eq!(starts(timeline), vec![0., 4., 8.]);
        assert!(!delete_segments(timeline, TrackKind::Zoom, &[42]));
    }

    #[test]
    fn the_last_clip_cannot_be_deleted() {
        let mut config = two_clip_config();
        let timeline = config.timeline.as_mut().unwrap();
        assert!(delete_segments(timeline, TrackKind::Clip, &[0]));
        assert_eq!(timeline.segments.len(), 1);
        assert!(!delete_segments(timeline, TrackKind::Clip, &[0]));
        assert_eq!(timeline.segments.len(), 1, "the guard holds");

        // Selecting both and deleting leaves one behind, not zero.
        let mut config = two_clip_config();
        let timeline = config.timeline.as_mut().unwrap();
        assert!(delete_segments(timeline, TrackKind::Clip, &[0, 1]));
        assert_eq!(timeline.segments.len(), 1);
    }

    #[test]
    fn deleting_a_masks_only_lane_renumbers_the_lanes_above_it() {
        let mut config = config(serde_json::json!({
            "timeline": {
                "segments": [{ "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 30.0 }],
                "zoomSegments": [],
                "maskSegments": [
                    { "start": 1.0, "end": 2.0, "track": 0, "maskType": "sensitive",
                      "center": {"x": 0.5, "y": 0.5}, "size": {"x": 0.2, "y": 0.2} },
                    { "start": 3.0, "end": 4.0, "track": 1, "maskType": "highlight",
                      "center": {"x": 0.5, "y": 0.5}, "size": {"x": 0.2, "y": 0.2} }
                ]
            }
        }));
        let timeline = config.timeline.as_mut().unwrap();
        assert!(delete_segments(timeline, TrackKind::Mask, &[0]));
        assert_eq!(timeline.mask_segments.len(), 1);
        assert_eq!(
            timeline.mask_segments[0].track, 0,
            "lane 1 becomes lane 0 -- normalizeTrackSegments"
        );
    }

    // -- Creating a zoom segment --------------------------------------------

    #[test]
    fn a_new_zoom_segment_lands_in_time_order() {
        let mut config = zoom_fixture();
        let timeline = config.timeline.as_mut().unwrap();
        let index = insert_zoom_segment(timeline, 10., 11.5, DEFAULT_ZOOM_AMOUNT);
        assert_eq!(index, 1);
        assert_eq!(timeline.zoom_segments[1].start, 10.);
        assert_eq!(timeline.zoom_segments[1].amount, 1.5);
        assert!(matches!(
            timeline.zoom_segments[1].mode,
            cap_project::ZoomMode::Auto
        ));
        // Before everything.
        assert_eq!(insert_zoom_segment(timeline, 0.5, 1.5, 2.0), 0);
        // After everything.
        assert_eq!(insert_zoom_segment(timeline, 28., 29., 2.0), 4);
    }

    // -- Sorting ------------------------------------------------------------

    #[test]
    fn a_trim_keeps_the_track_sorted() {
        let mut config = zoom_fixture();
        let timeline = config.timeline.as_mut().unwrap();
        assert!(set_segment_start(timeline, TrackKind::Zoom, 1, 6.));
        assert_eq!(timeline.zoom_segments[1].start, 6.);
        assert!(set_segment_end(timeline, TrackKind::Zoom, 0, 4.));
        assert_eq!(timeline.zoom_segments[0].end, 4.);
        assert!(move_segment(timeline, TrackKind::Zoom, 0, 8., 11.));
        assert_eq!(
            (
                timeline.zoom_segments[0].start,
                timeline.zoom_segments[0].end
            ),
            (8., 11.)
        );
    }

    #[test]
    fn place_segment_at_time_fits_the_gap_around_the_playhead() {
        let existing = [default_text_segment(2.0, 4.0, 0)];
        let placed = place_segment_at_time(&existing, 6.0, 2.0, 10.0).unwrap();
        assert!((placed.0 - 5.0).abs() < 1e-9);
        assert!((placed.1 - 7.0).abs() < 1e-9);
        assert!(place_segment_at_time(&existing, 3.0, 1.0, 10.0).is_none());
        assert!(place_segment_at_time(&existing, 6.0, 8.0, 10.0).is_none());
    }

    #[test]
    fn speed_change_shift_reaches_the_outgoing_transition() {
        assert_eq!(
            timeline_shift_after_clip_duration_change(8.0, 0.0, 0.0, 0.0, 8.0, 3.0),
            -5.0
        );
    }

    #[test]
    fn speed_change_shift_uses_the_full_shift_when_boundaries_share() {
        assert_eq!(
            timeline_shift_after_clip_duration_change(4.0, 3.0, 3.0, 4.0, 4.0, 6.0),
            2.0
        );
    }

    #[test]
    fn setting_clip_timescale_ripples_later_tracks() {
        let mut project = zoom_fixture();
        let timeline = project.timeline.as_mut().unwrap();
        assert!(set_clip_segment_timescale(timeline, 0, 2.0));
        assert_eq!(timeline.segments[0].timescale, 2.0);
        assert!((timeline.zoom_segments[0].start - 1.0).abs() < 1e-9);
        assert!((timeline.zoom_segments[0].end - 2.5).abs() < 1e-9);
        assert!((timeline.zoom_segments[1].start - 10.0).abs() < 1e-9);
        assert!(!set_clip_segment_timescale(timeline, 0, 2.0));
    }

    #[test]
    fn muting_a_1x_clip_sets_audio_muted() {
        let mut project = zoom_fixture();
        let timeline = project.timeline.as_mut().unwrap();
        assert!(!clip_is_muted(&timeline.segments[0]));
        assert!(set_clip_muted(timeline, 0, true));
        assert!(clip_is_muted(&timeline.segments[0]));
        assert!(timeline.segments[0].audio_muted);
        assert_eq!(timeline.segments[0].speed_audio_mode, None);
        assert!(set_clip_muted(timeline, 0, false));
        assert!(!clip_is_muted(&timeline.segments[0]));
        assert!(!timeline.segments[0].audio_muted);
        assert_eq!(timeline.segments[0].speed_audio_mode, None);
    }

    #[test]
    fn setting_clip_speed_audio_mode_writes_the_segment() {
        let mut project = zoom_fixture();
        let timeline = project.timeline.as_mut().unwrap();
        assert!(set_clip_segment_speed_audio_mode(
            timeline,
            0,
            ClipSpeedAudioMode::MaintainPitch
        ));
        assert_eq!(
            timeline.segments[0].speed_audio_mode,
            Some(ClipSpeedAudioMode::MaintainPitch)
        );
        assert!(!set_clip_segment_speed_audio_mode(
            timeline,
            0,
            ClipSpeedAudioMode::MaintainPitch
        ));
    }
}
