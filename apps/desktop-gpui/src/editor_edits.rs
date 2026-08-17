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
    AudioTrackSegment, Camera3DSegment, CaptionTrackSegment, KeyboardTrackSegment, MaskSegment,
    ProjectConfiguration, SceneSegment, TextSegment, TimelineConfiguration, ZoomSegment,
};

use crate::editor_timeline::{Segment, TrackKind};

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
/// Painted order decides ties, exactly as the DOM's does: segments are siblings
/// in array order, so a later one is above an earlier one, and a handle
/// (`z-10`) is above its own segment's fill. Walking the list backwards and
/// testing handles before the body reproduces both.
pub fn hit_test(
    segments: &[Segment],
    lane: u32,
    x: f64,
    position: f64,
    secs_per_pixel: f64,
) -> Hit {
    for (index, segment) in segments.iter().enumerate().rev() {
        if segment.lane != lane {
            continue;
        }
        let left = (segment.start - position) / secs_per_pixel;
        let right = (segment.end - position) / secs_per_pixel;
        if (x - left).abs() <= HANDLE_HIT_PX {
            return Hit::Handle { index, start: true };
        }
        if (x - right).abs() <= HANDLE_HIT_PX {
            return Hit::Handle {
                index,
                start: false,
            };
        }
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
        let next = mapping.iter().position(|value| *value == lane).unwrap_or_else(|| {
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

// ---------------------------------------------------------------------------
// The clip track
// ---------------------------------------------------------------------------

/// `minRecordedDuration` (`TL/ClipTrack.tsx:1141-1152`), identical on both
/// handles: a second, the 100px floor and twice the larger of the two adjacent
/// transitions -- all three in the **recording** domain, so the pixel and
/// transition terms are scaled by `timescale`.
pub fn clip_min_recorded_duration(
    timeline: &TimelineConfiguration,
    index: usize,
    secs_per_pixel: f64,
) -> f64 {
    let Some(segment) = timeline.segments.get(index) else {
        return 1.;
    };
    let transition = |at: usize| {
        timeline
            .effective_transition(at)
            .map_or(0., |transition| transition.duration)
    };
    let neighbouring = transition(index).max(transition(index + 1));
    1.0f64
        .max(secs_per_pixel * 100. * segment.timescale)
        .max(neighbouring * 2. * segment.timescale)
}

/// `availableTimelineDuration` (`TL/ClipTrack.tsx:1163-1167`): how much of the
/// recording is not already on the timeline, plus this clip's own share of it.
fn clip_available_timeline_duration(
    timeline: &TimelineConfiguration,
    index: usize,
    recording_duration: f64,
) -> f64 {
    let total: f64 = timeline.segments.iter().map(|segment| segment.duration()).sum();
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
    // not be trimmed back over its own left-hand half.
    let previous_floor = index
        .checked_sub(1)
        .and_then(|previous| timeline.segments.get(previous))
        .filter(|previous| previous.recording_clip == segment.recording_clip)
        .map_or(0., |previous| previous.end);

    Some(
        new_start
            .max(previous_floor)
            .max(segment.end - max_duration)
            .min(segment.end - min_recorded),
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

    let next_ceiling = timeline
        .segments
        .get(index + 1)
        .filter(|next| next.recording_clip == segment.recording_clip)
        .map_or(max_segment, |next| next.start);

    Some(
        new_end
            .min(segment.end + available * segment.timescale)
            .min(next_ceiling)
            .max(segment.start + min_recorded),
    )
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::editor_timeline::{SegmentDetail, TimelineModel};

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
        timeline.zoom_segments.truncate(0);
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

        assert_eq!(at(2.0 / spp), Hit::Handle { index: 0, start: true });
        assert_eq!(
            at(2.0 / spp + 9.),
            Hit::Handle { index: 0, start: true },
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
    /// does -- have two handles stacked on the same 20 pixels. The later one is
    /// painted on top, so it wins, and the earlier segment's *end* handle is
    /// unreachable until a gap opens. The shipping app behaves the same way:
    /// the segments are DOM siblings in array order.
    #[test]
    fn a_shared_edge_belongs_to_the_later_segments_handle() {
        let clip = |start: f64, end: f64| Segment {
            start,
            end,
            lane: 0,
            detail: SegmentDetail::Clip {
                name: "Clip".into(),
                source_start: 0.,
                source_duration: end - start,
                timescale: 1.,
                recording_clip: 0,
                holds: Arc::from(&[][..]),
            },
        };
        let clips = [clip(0., 10.), clip(10., 18.)];
        // 0.0125 s/px, so the shared edge at 10s is x = 800.
        assert_eq!(
            hit_test(&clips, 0, 800., 0., 0.0125),
            Hit::Handle { index: 1, start: true }
        );
        // Ten pixels the other side of it is still clip 1's handle.
        assert_eq!(
            hit_test(&clips, 0, 792., 0., 0.0125),
            Hit::Handle { index: 1, start: true }
        );
        // Past the handle's reach, clip 0's body takes over again.
        assert_eq!(hit_test(&clips, 0, 780., 0., 0.0125), Hit::Body { index: 0 });
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
    fn the_clip_floor_carries_the_hundred_pixel_width_and_the_timescale() {
        let config = two_clip_config();
        let timeline = config.timeline.as_ref().unwrap();
        // 0.005 s/px: 100px is 0.5s, so the 1s floor wins.
        assert_eq!(clip_min_recorded_duration(timeline, 0, 0.005), 1.);
        // 0.05 s/px: 100px is 5s.
        assert_eq!(clip_min_recorded_duration(timeline, 0, 0.05), 5.);

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
        let spp = 0.005; // floor = 1s

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
    }

    // -- Split --------------------------------------------------------------

    #[test]
    fn splitting_a_clip_produces_two_segments_at_the_cut() {
        let mut config = two_clip_config();
        let timeline = config.timeline.as_mut().unwrap();
        assert!(split_clip_segment(timeline, 4.0, None));
        assert_eq!(timeline.segments.len(), 3);
        assert_eq!((timeline.segments[0].start, timeline.segments[0].end), (0., 4.));
        assert_eq!((timeline.segments[1].start, timeline.segments[1].end), (4., 10.));
        assert_eq!(timeline.segments[1].recording_clip, 0);
        // The second recording clip is untouched.
        assert_eq!((timeline.segments[2].start, timeline.segments[2].end), (0., 8.));
    }

    #[test]
    fn a_split_on_a_boundary_is_refused() {
        let mut config = two_clip_config();
        let timeline = config.timeline.as_mut().unwrap();
        assert!(!split_clip_segment(timeline, 0.0, None), "at the very start");
        assert!(!split_clip_segment(timeline, 10.0, Some(0)), "at its own end");
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
}
