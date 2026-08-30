//! `ClipsSidebar` (`routes/editor/ClipsSidebar.tsx`) -- the layout mode that
//! replaces the config sidebar while the header's Clips button is active:
//! list, rename, reorder and delete the timeline's clip segments, plus the
//! import and record-a-new-clip entry points.
//!
//! Three seams differ from the Tauri app, each marked where it bites:
//!
//! * **Thumbnails** are decoded in-process off the main thread and cached in
//!   memory keyed by `(recording segment, start ms)` -- `get_clip_thumbnail`
//!   (`src-tauri/src/clip_thumbnails.rs`) writes a JPEG cache under the
//!   bundle instead, because a webview needs a URL. Same decode, same key.
//! * **"Existing recording"** ports `add_existing_recording_to_editor`
//!   (`src-tauri/src/import.rs`) whole: the source bundle's segments are
//!   copied into this bundle, the metas and the timeline extended, and the
//!   editor reloaded -- `window.location.reload()`'s native spelling is
//!   [`crate::app_windows::reload_editor`].
//! * **"Record a new clip"** is the whole `setEditorRecordingTarget` flow,
//!   natively: the modal's start actions arm the session's editor recording
//!   target (`EditorRecordingTarget`, `src-tauri/src/windows.rs:3679-3697`)
//!   and open the target-select overlays with the editor hidden for the
//!   picker; the capture is forced into Studio mode; and when it stops
//!   cleanly the session observer reveals this editor and hands it the
//!   bundle, which lands through the same whole-segment-copy the import path
//!   uses, followed by the recording directory's deletion and an editor
//!   reload -- the `EditorRecordingAdded` listener (`Editor.tsx:312-335`),
//!   transcribed. The Display/Window chevron menus list the same enumeration
//!   the main window's pickers use, with the same live ScreenCaptureKit
//!   thumbnails and app icons -- `ClipsSidebar.tsx:378-385` runs the same two
//!   `*WithThumbnails` queries the main window does, through the same
//!   `TargetCard`.

use std::{
    cell::RefCell,
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
};

use cap_project::{
    AudioMeta, ClipConfiguration, ClipTransition, CursorEvents, CursorMeta, Cursors,
    MultipleSegment, MultipleSegments, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration, TimelineSegment, VideoMeta,
    XY,
};
use gpui::{
    AnyElement, AppContext as _, Bounds, Context, CursorStyle, Entity, FontWeight, Hsla,
    InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, Point, RenderImage, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled, StyledImage as _, Task, Window, div, img,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    app_windows,
    devices::{CameraOption, DeviceSnapshot, DisplayOption, MicrophoneOption, WindowOption},
    editor_edits::{self as edits, TrackSegmentOps},
    editor_timeline::clip_timeline_offsets,
    editor_window::EditorWindow,
    main_window::{Mode, TargetType},
    session::{Phase, RecordingSession},
    target_thumbnails,
    theme::Theme,
    ui,
};

/// The width one target card gets in the record modal, computed rather than
/// flexed.
///
/// The modal is `w-full max-w-[460px]` and the editor's minimum window width is
/// 1275, so 460 is always what it gets; its body is `p-5`, and the grid has an
/// 8px gutter: `(460 - 40 - 8) / 2`. Stating the width keeps `flex_1` off a
/// text-bearing card in a grid that can hold every window on the machine --
/// the same reason `MainWindow::target_card_width` exists.
const RECORD_TARGET_CARD_WIDTH: f32 = 206.;

// ---------------------------------------------------------------------------
// Naming (`ClipsSidebar.tsx:558-609`)
// ---------------------------------------------------------------------------

/// `formatClipDuration` (`ClipsSidebar.tsx:79-85`).
pub(crate) fn format_clip_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds <= 0.0 {
        return "0:00".to_string();
    }
    let total = seconds.round() as i64;
    format!("{}:{:02}", total / 60, total % 60)
}

/// `clipLabel` (`:563`).
pub(crate) fn clip_label(clip_index: usize) -> String {
    format!("Clip {}", clip_index + 1)
}

/// `segmentClipIndex` (`:565-567`). The `?? Math.min(index, ...)` fallback is
/// for a null `recordingSegment`, which the Rust config cannot hold --
/// `#[serde(default)]` already resolves a missing value to 0.
fn segment_clip_index(segment: &TimelineSegment) -> usize {
    segment.recording_clip as usize
}

/// `segmentSplitNumber` (`:569-580`): this segment's 1-based position among
/// the timeline segments cut from the same recording clip.
fn segment_split_number(segments: &[TimelineSegment], index: usize) -> usize {
    let clip = segment_clip_index(&segments[index]);
    segments[..=index]
        .iter()
        .filter(|segment| segment_clip_index(segment) == clip)
        .count()
}

/// `segmentLabel` (`:582-587`): `"Clip N"` for the first piece of a recording
/// clip, `"Split N"` for the later ones.
pub(crate) fn segment_label(segments: &[TimelineSegment], index: usize) -> String {
    let split_number = segment_split_number(segments, index);
    if split_number == 1 {
        clip_label(segment_clip_index(&segments[index]))
    } else {
        format!("Split {}", split_number - 1)
    }
}

/// `displayName` (`:589-592`): the custom name when one is set, the derived
/// label otherwise.
pub(crate) fn display_name(segments: &[TimelineSegment], index: usize) -> String {
    let name = segments[index]
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if name.is_empty() {
        segment_label(segments, index)
    } else {
        name.to_string()
    }
}

/// `displayNameAt` (`:593-596`) -- the drag ghost's caption.
fn display_name_at(segments: &[TimelineSegment], index: usize) -> String {
    if index < segments.len() {
        display_name(segments, index)
    } else {
        clip_label(index)
    }
}

/// `segmentDescription` (`:598-609`): `m:ss`, prefixed with the parent clip's
/// label for a split.
pub(crate) fn segment_description(segments: &[TimelineSegment], index: usize) -> String {
    let formatted = format_clip_duration(segments[index].duration());
    if segment_split_number(segments, index) > 1 {
        format!(
            "{} · {}",
            clip_label(segment_clip_index(&segments[index])),
            formatted
        )
    } else {
        formatted
    }
}

// ---------------------------------------------------------------------------
// Reorder (`ClipsSidebar.tsx:639-713`, `ED/clip-transitions.ts:277-306`)
// ---------------------------------------------------------------------------

/// `transitionsAfterClipMove` (`ED/clip-transitions.ts:277-306`): a transition
/// survives the move only if the two clips it joined are still adjacent in the
/// new order, in which case it follows them to their new boundary.
pub(crate) fn transitions_after_clip_move(
    segment_count: usize,
    transitions: &[ClipTransition],
    from: usize,
    to: usize,
) -> (Vec<ClipTransition>, Vec<ClipTransition>) {
    let mut order: Vec<usize> = (0..segment_count).collect();
    let moved = order.remove(from);
    order.insert(to, moved);

    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for transition in transitions {
        let original = transition.segment_index as usize;
        let next_index = (original > 0)
            .then(|| {
                order.iter().enumerate().position(|(index, segment)| {
                    index > 0 && order[index - 1] == original - 1 && *segment == original
                })
            })
            .flatten();
        match next_index {
            Some(next) => kept.push(ClipTransition {
                segment_index: next as u32,
                ..*transition
            }),
            None => dropped.push(*transition),
        }
    }

    kept.sort_by_key(|transition| transition.segment_index);
    (kept, dropped)
}

/// `rippleTimelineTrack` (`ED/clip-transitions.ts:208-221`).
fn ripple_track<T: TrackSegmentOps>(track: &mut [T], boundary: f64, shift: f64) {
    for item in track {
        if item.start() >= boundary {
            item.set_start(item.start() + shift);
            item.set_end(item.end() + shift);
        } else if item.end() > boundary {
            item.set_end(item.start().max(item.end() + shift));
        }
    }
}

/// `moveClip` (`ClipsSidebar.tsx:639-690`): reorder `timeline.segments`,
/// remapping the transitions that survive and -- for each one that does not --
/// rippling every other track across the boundary the removed overlap used to
/// occupy, so nothing downstream shifts under the user.
pub(crate) fn move_clip(
    timeline: &mut TimelineConfiguration,
    from: usize,
    insertion_index: usize,
) -> bool {
    let count = timeline.segments.len();
    if from >= count || insertion_index > count {
        return false;
    }
    let mut to = insertion_index;
    if from < insertion_index {
        to -= 1;
    }
    if from == to {
        return false;
    }

    let mut proposed = timeline.segments.clone();
    let moved = proposed.remove(from);
    proposed.insert(to, moved);

    let (kept, mut dropped) = transitions_after_clip_move(count, &timeline.transitions, from, to);
    dropped.sort_by_key(|transition| std::cmp::Reverse(transition.segment_index));

    for transition in &dropped {
        let Some(effective) = timeline.effective_transition(transition.segment_index as usize)
        else {
            continue;
        };
        let boundary = clip_timeline_offsets(timeline)
            .get(transition.segment_index as usize)
            .copied()
            .unwrap_or(0.)
            + effective.duration;
        timeline
            .transitions
            .retain(|candidate| candidate.segment_index != transition.segment_index);
        // The source ripples these seven tracks and no others (`:672-682`).
        ripple_track(&mut timeline.zoom_segments, boundary, effective.duration);
        ripple_track(&mut timeline.scene_segments, boundary, effective.duration);
        ripple_track(&mut timeline.mask_segments, boundary, effective.duration);
        ripple_track(&mut timeline.text_segments, boundary, effective.duration);
        ripple_track(&mut timeline.caption_segments, boundary, effective.duration);
        ripple_track(
            &mut timeline.keyboard_segments,
            boundary,
            effective.duration,
        );
        ripple_track(&mut timeline.audio_segments, boundary, effective.duration);
    }

    timeline.segments = proposed;
    timeline.transitions = kept;
    true
}

/// `computeDropIndex` (`ClipsSidebar.tsx:692-703`): the insertion point is
/// after every card whose vertical midpoint the pointer has passed.
pub(crate) fn compute_drop_index(pointer_y: Pixels, cards: &[Option<Bounds<Pixels>>]) -> usize {
    let mut insertion = 0;
    for (index, bounds) in cards.iter().enumerate() {
        let Some(bounds) = bounds else { continue };
        if pointer_y > bounds.origin.y + bounds.size.height / 2. {
            insertion = index + 1;
        }
    }
    insertion
}

/// `startClipDrag`'s activation threshold (`:729`).
const DRAG_THRESHOLD_PX: f32 = 5.;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// A thumbnail cache key: `(recordingSegment, start ms)` --
/// `clipThumbnailKey` (`ClipsSidebar.tsx:95-99`) minus the project path,
/// which is constant per window.
type ThumbKey = (u32, i64);

enum ClipThumb {
    Loading,
    Ready(Arc<RenderImage>),
    Failed,
}

/// `MAX_THUMBNAIL_LOADS` (`:93`).
const MAX_THUMBNAIL_LOADS: usize = 2;

/// A live card drag: armed on mouse-down, activated past the 5px threshold.
pub(crate) struct ClipDrag {
    index: usize,
    start: Point<Pixels>,
    position: Point<Pixels>,
    active: bool,
}

/// Which of the record modal's device selects is unfolded --
/// `CameraSelectBase` / `MicrophoneSelectBase`'s open dropdown
/// (`ClipsSidebar.tsx:1084-1122`), drawn here as an in-modal list the way the
/// chevron target menus are (a KSelect popover has no gpui counterpart).
#[derive(Clone, Copy, PartialEq, Eq)]
enum RecordDeviceMenu {
    Camera,
    Microphone,
}

/// Everything the clips layout mode owns. Lives on [`EditorWindow`] so the
/// mode is hidden, not destroyed, while closed -- the Tauri sidebar stays
/// mounted with `class="hidden"` (`Editor.tsx:739-746`).
pub(crate) struct ClipsState {
    /// `isClipsMode()` (`Editor.tsx:347-350`).
    pub(crate) open: bool,
    /// `recordOpen`.
    record_open: bool,
    /// `displayMenuOpen` / `windowMenuOpen` (`:292-296`) -- which chevron
    /// target menu the modal body is showing. Only `Display` and `Window`
    /// ever land here.
    record_target_menu: Option<TargetType>,
    /// Which device select is unfolded.
    record_device_menu: Option<RecordDeviceMenu>,
    /// `targetSearch`, as the shared text-input entity (created on first use,
    /// like the rename field -- it needs a window).
    target_search_input: Option<Entity<ui::TextInputState>>,
    /// `createDevicesQuery` (`:365`): enumerated when the modal opens, `None`
    /// while the scan is in flight so the menus can say "Loading...".
    record_devices: Option<DeviceSnapshot>,
    /// Thumbnails and app icons for the record modal's target cards.
    /// `ClipsSidebar.tsx:378-385` runs the same
    /// `listDisplaysWithThumbnails`/`listWindowsWithThumbnails` queries the
    /// main window does, so the cards look the same -- but on this route's own
    /// `QueryClient`, which is why this cache is per-view too.
    record_thumbnails: target_thumbnails::ThumbnailCache,
    /// The in-flight sweep for whichever target menu is open. Dropping it
    /// stops the loop; the loop also stops itself the moment the menu closes.
    record_thumbnail_task: Option<Task<()>>,
    /// The import menu's anchor, while it is up. A native `Menu.popup()` in
    /// the Tauri app (`:541-556`); here the `ui::Menu` shape -- full-window
    /// backdrop, panel at the click position.
    import_menu: Option<Point<Pixels>>,
    /// `importing`.
    importing: bool,
    /// `editingIndex`.
    editing: Option<usize>,
    /// The inline rename field, created on first use (it needs a window).
    rename_input: Option<Entity<ui::TextInputState>>,
    drag: Option<ClipDrag>,
    /// `dropIndex`.
    drop_index: Option<usize>,
    /// Every card's painted bounds, written by a per-card canvas probe --
    /// `getBoundingClientRect` for `computeDropIndex`.
    card_bounds: Rc<RefCell<Vec<Option<Bounds<Pixels>>>>>,
    scroll: ScrollHandle,
    thumbs: HashMap<ThumbKey, ClipThumb>,
    thumbs_inflight: usize,
}

impl Default for ClipsState {
    fn default() -> Self {
        Self {
            open: false,
            record_open: false,
            record_target_menu: None,
            record_device_menu: None,
            target_search_input: None,
            record_devices: None,
            record_thumbnails: target_thumbnails::ThumbnailCache::default(),
            record_thumbnail_task: None,
            import_menu: None,
            importing: false,
            editing: None,
            rename_input: None,
            drag: None,
            drop_index: None,
            card_bounds: Rc::new(RefCell::new(Vec::new())),
            scroll: ScrollHandle::new(),
            thumbs: HashMap::new(),
            thumbs_inflight: 0,
        }
    }
}

/// `hover:bg-red-3 hover:text-red-11` (`ClipsSidebar.tsx:953`): the theme
/// carries only the red steps the settings pages use, so these two are the
/// stock Radix values `theme.css` leaves untouched.
fn red_3(theme: &Theme) -> Hsla {
    if theme.is_dark() {
        gpui::rgb(0x3b1219)
    } else {
        gpui::rgb(0xfeebec)
    }
    .into()
}

fn red_11(theme: &Theme) -> Hsla {
    if theme.is_dark() {
        gpui::rgb(0xff9592)
    } else {
        gpui::rgb(0xce2c31)
    }
    .into()
}

/// `bg-gray-2 dark:bg-gray-3` -- the card and the drag ghost (`:877, 1228`).
fn card_bg(theme: &Theme) -> Hsla {
    if theme.is_dark() {
        theme.gray_3
    } else {
        theme.gray_2
    }
    .into()
}

impl EditorWindow {
    fn clip_segments(&self) -> &[TimelineSegment] {
        self.project
            .timeline
            .as_ref()
            .map(|timeline| timeline.segments.as_slice())
            .unwrap_or_default()
    }

    // -- The header pill and the mode toggle ---------------------------------

    /// The Clips toggle (`Header.tsx:173-187`): `Button variant={open ?
    /// "white" : "gray"}` at `flex gap-1.5 justify-center h-[40px]`, clearing
    /// the timeline selection on every press.
    pub(crate) fn render_clips_pill(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let variant = if self.clips.open {
            ui::ButtonVariant::White
        } else {
            ui::ButtonVariant::Gray
        };
        ui::Button::plain(&self.theme, "clips-pill", variant, ui::ButtonSize::Md)
            .icon("icons/clapperboard.svg")
            .label("Clips")
            .height(px(40.))
            .font_weight(FontWeight::MEDIUM)
            .on_click(cx.listener(|this, _, window, cx| this.toggle_clips(window, cx)))
    }

    pub(crate) fn toggle_clips(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_selection(None, cx);
        if self.clips.open {
            self.close_clips(window, cx);
        } else {
            self.clips.open = true;
        }
        cx.notify();
    }

    /// `backToEditor` and the close half of the `createEffect(on(open))`
    /// cleanup (`ClipsSidebar.tsx:278, 343-363`), `resetRecordingTarget`
    /// included: a target armed by the modal but never recorded is cleared so
    /// it cannot redirect a later capture. Guarded on Idle -- mid-recording
    /// the target belongs to the live capture and must survive (the Tauri
    /// effect runs unguarded, but its editor window is hidden then, so the
    /// guard only closes a hole rather than changing behaviour). A live
    /// rename commits first: hiding the DOM input blurs it, and blur commits.
    pub(crate) fn close_clips(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clips.editing.is_some() {
            self.commit_clip_rename(window, cx);
        }
        self.clips.open = false;
        self.clips.record_open = false;
        self.clips.record_target_menu = None;
        self.clips.record_device_menu = None;
        self.clips.import_menu = None;
        self.clips.drag = None;
        self.clips.drop_index = None;
        let session = RecordingSession::global(cx);
        if session.read(cx).phase == Phase::Idle {
            session.update(cx, |session, _| session.set_editor_recording_target(None));
        }
        cx.notify();
    }

    /// Escape while a clips overlay is up, checked from the window's own
    /// key handler alongside the other overlay guards.
    pub(crate) fn clips_overlay_escape(&mut self, cx: &mut Context<Self>) -> bool {
        if self.clips.import_menu.is_some() {
            self.clips.import_menu = None;
            cx.notify();
            return true;
        }
        if self.clips.record_open {
            // The modal's own Escape ladder (`ClipsSidebar.tsx:764-775`): an
            // open target or device menu closes first, the modal second.
            if self.clips.record_target_menu.is_some() || self.clips.record_device_menu.is_some() {
                self.clips.record_target_menu = None;
                self.clips.record_device_menu = None;
            } else {
                self.clips.record_open = false;
            }
            cx.notify();
            return true;
        }
        false
    }

    // -- Rename (`ClipsSidebar.tsx:611-629`) ----------------------------------

    fn ensure_clip_rename_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clips.rename_input.is_some() {
            return;
        }
        let input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let subscription = cx.subscribe_in(
            &input,
            window,
            |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                this.on_clip_rename_event(event, window, cx);
            },
        );
        self.push_text_subscription(subscription);
        self.clips.rename_input = Some(input);
    }

    /// `startRename(index, segment.name ?? "")` (`:613-616`), plus the
    /// focus-and-select the source does through `requestAnimationFrame`. A
    /// rename already live on another card commits first -- in the DOM the
    /// old input blurs before the new one mounts.
    fn start_clip_rename(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.clips.editing.is_some_and(|editing| editing != index) {
            self.commit_clip_rename(window, cx);
        }
        self.ensure_clip_rename_input(window, cx);
        let segments = self.clip_segments();
        if index >= segments.len() {
            return;
        }
        let current = segments[index].name.clone().unwrap_or_default();
        let placeholder = segment_label(segments, index);
        if let Some(input) = self.clips.rename_input.clone() {
            input.update(cx, |input, cx| {
                input.set_placeholder(placeholder);
                input.set_text(current, cx);
                input.focus_and_select_all(window, cx);
            });
        }
        self.clips.editing = Some(index);
        cx.notify();
    }

    /// `commitRename` (`:617-628`): the trimmed draft, or `null` when empty.
    fn commit_clip_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(index) = self.clips.editing.take() else {
            return;
        };
        let Some(input) = self.clips.rename_input.clone() else {
            return;
        };
        let value = input.read(cx).text().trim().to_string();
        let name = (!value.is_empty()).then_some(value);
        self.edit_project("clip-rename", window, cx, move |project| {
            let Some(timeline) = project.timeline.as_mut() else {
                return false;
            };
            let Some(segment) = timeline.segments.get_mut(index) else {
                return false;
            };
            if segment.name == name {
                return false;
            }
            segment.name = name;
            true
        });
        cx.notify();
    }

    fn on_clip_rename_event(
        &mut self,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Confirmed => {
                self.commit_clip_rename(window, cx);
                self.focus_root(window, cx);
            }
            ui::TextInputEvent::Cancelled => {
                self.clips.editing = None;
                self.focus_root(window, cx);
                cx.notify();
            }
            ui::TextInputEvent::Blurred => self.commit_clip_rename(window, cx),
            ui::TextInputEvent::Changed => {}
        }
    }

    // -- Delete (`ClipsSidebar.tsx:759-762`) ----------------------------------

    /// `deleteClip`: `projectActions.deleteClipSegment(index)`, whose maths
    /// already lives in [`edits::delete_clip_segments`] -- one undo entry,
    /// selection cleared, last clip protected.
    fn delete_clip(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.clip_segments().len() < 2 {
            return;
        }
        self.edit_project("clip-delete", window, cx, move |project| {
            project
                .timeline
                .as_mut()
                .is_some_and(|timeline| edits::delete_clip_segments(timeline, &[index]))
        });
        self.set_selection(None, cx);
    }

    // -- Drag reorder (`ClipsSidebar.tsx:631-757`) -----------------------------

    fn clip_card_mouse_down(
        &mut self,
        index: usize,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.button != MouseButton::Left || self.clips.editing == Some(index) {
            return;
        }
        // A press outside the rename input is the DOM's blur: commit.
        if self.clips.editing.is_some() {
            self.commit_clip_rename(window, cx);
        }
        self.clips.drag = Some(ClipDrag {
            index,
            start: event.position,
            position: event.position,
            active: false,
        });
        cx.notify();
    }

    fn clips_drag_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let card_bounds = self.clips.card_bounds.clone();
        let Some(drag) = self.clips.drag.as_mut() else {
            return;
        };
        if !drag.active {
            let dx = f32::from(event.position.x - drag.start.x);
            let dy = f32::from(event.position.y - drag.start.y);
            if dx.hypot(dy) < DRAG_THRESHOLD_PX {
                return;
            }
            drag.active = true;
        }
        drag.position = event.position;
        self.clips.drop_index = Some(compute_drop_index(event.position.y, &card_bounds.borrow()));
        cx.notify();
    }

    /// `commitDrop` (`:705-713`).
    fn clips_drag_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let drag = self.clips.drag.take();
        let insertion = self.clips.drop_index.take();
        cx.notify();
        let Some(drag) = drag else { return };
        let (Some(insertion), true) = (insertion, drag.active) else {
            return;
        };

        // `moveClip`'s own no-op gate (`:639-642`), checked here so a no-op
        // drop neither records history nor clears the selection.
        let from = drag.index;
        let mut to = insertion;
        if from < insertion {
            to -= 1;
        }
        if from == to || from >= self.clip_segments().len() {
            return;
        }

        self.edit_project("clip-reorder", window, cx, move |project| {
            project
                .timeline
                .as_mut()
                .is_some_and(|timeline| move_clip(timeline, from, insertion))
        });
        self.set_selection(None, cx);
    }

    // -- Thumbnails ------------------------------------------------------------

    /// Queue background decodes for every card without a picture, at most
    /// [`MAX_THUMBNAIL_LOADS`] in flight -- each completion notifies, which
    /// re-runs this and pulls the next one off the "queue".
    fn request_clip_thumbnails(&mut self, cx: &mut Context<Self>) {
        let wanted: Vec<(ThumbKey, f64)> = self
            .clip_segments()
            .iter()
            .map(|segment| {
                (
                    (
                        segment.recording_clip,
                        (segment.start * 1000.0).round() as i64,
                    ),
                    segment.start,
                )
            })
            .collect();
        for (key, start) in wanted {
            if self.clips.thumbs_inflight >= MAX_THUMBNAIL_LOADS {
                break;
            }
            if self.clips.thumbs.contains_key(&key) {
                continue;
            }
            self.clips.thumbs.insert(key, ClipThumb::Loading);
            self.clips.thumbs_inflight += 1;
            let project_path = self.project_path.clone();
            cx.spawn(async move |this, cx| {
                let decoded = cx
                    .background_executor()
                    .spawn(async move { decode_clip_thumbnail(&project_path, key.0, start) })
                    .await;
                this.update(cx, |this, cx| {
                    this.clips.thumbs_inflight = this.clips.thumbs_inflight.saturating_sub(1);
                    let entry = match decoded {
                        Ok(image) => ClipThumb::Ready(image),
                        Err(error) => {
                            tracing::warn!(
                                segment = key.0,
                                start_ms = key.1,
                                "clip thumbnail decode failed: {error}"
                            );
                            ClipThumb::Failed
                        }
                    };
                    this.clips.thumbs.insert(key, entry);
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
    }

    // -- The sidebar ------------------------------------------------------------

    /// The whole clips column, drawn in the config sidebar's slot while the
    /// mode is open. Same `ml-2 w-104` wrapper the config sidebar carries
    /// (`Editor.tsx:728`); the card itself is `flex flex-col flex-1 min-h-0
    /// rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3
    /// overflow-hidden` (`ClipsSidebar.tsx:791-797`).
    pub(crate) fn render_clips_sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        self.request_clip_thumbnails(cx);
        let theme = self.theme;

        div()
            .ml(px(8.))
            .w(px(crate::editor_window::SIDEBAR_WIDTH))
            .flex_none()
            .flex()
            .min_h_0()
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .rounded(px(12.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .bg(self.panel_bg())
                    .child(self.render_clips_back_header(cx))
                    .child(self.render_clips_body(cx)),
            )
    }

    /// The back header (`:798-805`): `h-16 px-4 gap-2 border-b border-gray-3
    /// text-sm font-medium text-gray-12 hover:bg-gray-3`.
    fn render_clips_back_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .id("clips-back")
            .flex()
            .flex_none()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(16.))
            .w_full()
            .h(px(64.))
            .border_b_1()
            .border_color(Hsla::from(theme.gray_3))
            .text_size(px(14.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(Hsla::from(theme.gray_12))
            .hover(move |style| style.bg(Hsla::from(theme.gray_3)))
            .child(
                svg()
                    .path("icons/move-left.svg")
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_11)),
            )
            .child("Back to editor")
            .on_click(cx.listener(|this, _, window, cx| this.close_clips(window, cx)))
    }

    /// `flex flex-col flex-1 gap-3 p-3 min-h-0` (`:807`).
    fn render_clips_body(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let recorded_clip_count = self
            .summary()
            .map(|summary| summary.recording_clips)
            .unwrap_or_default();

        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap(px(12.))
            .p(px(12.))
            .min_h_0()
            // The action row (`:808-826`).
            .child(
                div()
                    .flex()
                    .flex_none()
                    .flex_row()
                    .gap(px(8.))
                    .child(
                        div().flex_1().child(
                            ui::Button::plain(
                                &theme,
                                "clips-record",
                                ui::ButtonVariant::Blue,
                                ui::ButtonSize::Md,
                            )
                            .icon("icons/video.svg")
                            .label("Record a new clip")
                            .height(px(40.))
                            .gap(px(8.))
                            .font_weight(FontWeight::MEDIUM)
                            .full_width()
                            .on_click(cx.listener(
                                |this, _, window, cx| {
                                    this.open_record_modal(window, cx);
                                },
                            )),
                        ),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "clips-import",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Md,
                        )
                        .icon("icons/circle-plus.svg")
                        .label("Import")
                        .height(px(40.))
                        .gap(px(8.))
                        .font_weight(FontWeight::MEDIUM)
                        .disabled(self.clips.importing)
                        .on_click(cx.listener(
                            |this, event: &gpui::ClickEvent, _window, cx| {
                                if this.clips.importing {
                                    return;
                                }
                                this.clips.import_menu = Some(event.position());
                                cx.notify();
                            },
                        )),
                    ),
            )
            // The section label and the recording-clip count (`:828-835`).
            .child(
                div()
                    .flex()
                    .flex_none()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child("Clips"),
                    )
                    .children((recorded_clip_count > 0).then(|| {
                        div()
                            .rounded(px(6.))
                            .bg(Hsla::from(theme.gray_3))
                            .px(px(6.))
                            .py(px(2.))
                            .text_size(px(10.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_11))
                            .child(recorded_clip_count.to_string())
                    })),
            )
            // The scroll region (`:837`): `overflow-y-auto flex-1 -mx-1 px-1`.
            .child(
                div()
                    .id("clips-scroll")
                    .flex_1()
                    .min_h_0()
                    .mx(px(-4.))
                    .px(px(4.))
                    .overflow_y_scroll()
                    .track_scroll(&self.clips.scroll)
                    .child(if self.clip_segments().is_empty() {
                        self.render_clips_empty().into_any_element()
                    } else {
                        self.render_clip_list(cx).into_any_element()
                    }),
            )
    }

    /// The empty state (`:841-849`).
    fn render_clips_empty(&self) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .justify_center()
            .items_center()
            .px(px(16.))
            .py(px(48.))
            .text_center()
            .child(
                div()
                    .flex()
                    .justify_center()
                    .items_center()
                    .size(px(40.))
                    .rounded_full()
                    .bg(Hsla::from(theme.gray_3))
                    .child(
                        svg()
                            .path("icons/clapperboard.svg")
                            .size(px(20.))
                            .text_color(Hsla::from(theme.gray_9)),
                    ),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.gray_12))
                    .child("No clips yet"),
            )
            .child(
                div()
                    .max_w(px(200.))
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child("Record or import a clip and it will show up here."),
            )
    }

    /// The card list (`:852-964`).
    fn render_clip_list(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let count = self.clip_segments().len();
        self.clips.card_bounds.borrow_mut().resize(count, None);

        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .children((0..count).map(|index| self.render_clip_card(index, cx)))
    }

    fn render_clip_card(&self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let segments = self.clip_segments();
        let segment = &segments[index];
        let count = segments.len();
        let title = display_name(segments, index);
        let subtitle = segment_description(segments, index);
        let editing = self.clips.editing == Some(index);
        let dragging = self.clips.drag.as_ref().is_some_and(|drag| drag.active);
        let is_dragged = dragging
            && self
                .clips
                .drag
                .as_ref()
                .is_some_and(|drag| drag.index == index);
        let show_top_bar = dragging && self.clips.drop_index == Some(index);
        let show_bottom_bar =
            dragging && index == count - 1 && self.clips.drop_index == Some(count);

        let thumb_key: ThumbKey = (
            segment.recording_clip,
            (segment.start * 1000.0).round() as i64,
        );
        let thumb = match self.clips.thumbs.get(&thumb_key) {
            Some(ClipThumb::Ready(image)) => Some(image.clone()),
            _ => None,
        };
        let group: SharedString = SharedString::from(format!("clip-card-{index}"));
        let probe = {
            let cell = self.clips.card_bounds.clone();
            gpui::canvas(
                move |bounds, _window, _cx| {
                    let mut slots = cell.borrow_mut();
                    if index < slots.len() {
                        slots[index] = Some(bounds);
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full()
        };

        div()
            .relative()
            // The drop indicators (`:867-872`).
            .children(show_top_bar.then(|| {
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(-4.))
                    .h(px(2.))
                    .rounded_full()
                    .bg(Hsla::from(theme.blue_9))
            }))
            .children(show_bottom_bar.then(|| {
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(px(-4.))
                    .h(px(2.))
                    .rounded_full()
                    .bg(Hsla::from(theme.blue_9))
            }))
            .child(
                // The card (`:873-879`).
                div()
                    .id(SharedString::from(format!("clip-card-box-{index}")))
                    .group(group.clone())
                    .relative()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_4))
                    .p(px(8.))
                    .bg(card_bg(&theme))
                    .cursor(if dragging {
                        CursorStyle::ClosedHand
                    } else {
                        CursorStyle::OpenHand
                    })
                    .hover(move |style| style.border_color(Hsla::from(theme.gray_7)))
                    .when(is_dragged, |this| this.opacity(0.4))
                    .child(probe)
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            this.clip_card_mouse_down(index, event, window, cx);
                        }),
                    )
                    // The thumbnail well (`:881-887`): `w-24 aspect-video
                    // rounded-md bg-gray-4`, the 1-based index as the
                    // placeholder until a frame lands.
                    .child(
                        div()
                            .relative()
                            .overflow_hidden()
                            .w(px(96.))
                            .h(px(54.))
                            .rounded(px(6.))
                            .flex_shrink_0()
                            .bg(Hsla::from(theme.gray_4))
                            .child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .flex()
                                    .justify_center()
                                    .items_center()
                                    .bg(if theme.is_dark() {
                                        Hsla::from(theme.gray_4)
                                    } else {
                                        Hsla::from(theme.gray_3)
                                    })
                                    .text_size(px(14.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(Hsla::from(theme.gray_9))
                                    .child((index + 1).to_string()),
                            )
                            .children(thumb.map(|image| {
                                div().absolute().inset_0().child(
                                    img(image).size_full().object_fit(gpui::ObjectFit::Cover),
                                )
                            })),
                    )
                    // Title and duration (`:889-934`).
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .gap(px(2.))
                            .min_w_0()
                            .child(if editing {
                                match self.clips.rename_input.as_ref() {
                                    Some(input) => ui::TextInput::plain(
                                        &theme,
                                        SharedString::from(format!("clip-rename-{index}")),
                                        input,
                                    )
                                    .height(px(24.))
                                    .text_size(px(14.))
                                    .padding_x(px(6.))
                                    .radius(px(4.))
                                    .bg(if theme.is_dark() {
                                        Hsla::from(theme.gray_4)
                                    } else {
                                        Hsla::from(theme.gray_1)
                                    })
                                    .border(Hsla::from(theme.gray_6))
                                    .flex(true)
                                    .into_any_element(),
                                    None => div().into_any_element(),
                                }
                            } else {
                                div()
                                    .id(SharedString::from(format!("clip-title-{index}")))
                                    .text_size(px(14.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .truncate()
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(title)
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(
                                            move |this, event: &MouseDownEvent, window, cx| {
                                                if event.click_count == 2 {
                                                    cx.stop_propagation();
                                                    this.start_clip_rename(index, window, cx);
                                                }
                                            },
                                        ),
                                    )
                                    .into_any_element()
                            })
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(theme.gray_10))
                                    .child(subtitle),
                            ),
                    )
                    // The hover actions (`:935-958`).
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .flex_row()
                            .items_center()
                            .gap(px(2.))
                            .child(
                                div()
                                    .id(SharedString::from(format!("clip-edit-{index}")))
                                    .flex()
                                    .flex_none()
                                    .justify_center()
                                    .items_center()
                                    .rounded(px(6.))
                                    .size(px(28.))
                                    .opacity(0.)
                                    .group_hover(group.clone(), |style| style.opacity(1.))
                                    .text_color(Hsla::from(theme.gray_10))
                                    .hover(move |style| {
                                        style
                                            .bg(Hsla::from(theme.gray_5))
                                            .text_color(Hsla::from(theme.gray_12))
                                    })
                                    .child(svg().path("icons/edit.svg").size(px(14.)))
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation();
                                    })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.start_clip_rename(index, window, cx);
                                    })),
                            )
                            .children((count > 1).then(|| {
                                div()
                                    .id(SharedString::from(format!("clip-delete-{index}")))
                                    .flex()
                                    .flex_none()
                                    .justify_center()
                                    .items_center()
                                    .rounded(px(6.))
                                    .size(px(28.))
                                    .opacity(0.)
                                    .group_hover(group.clone(), |style| style.opacity(1.))
                                    .text_color(Hsla::from(theme.gray_10))
                                    .hover(move |style| {
                                        style.bg(red_3(&theme)).text_color(red_11(&theme))
                                    })
                                    .child(svg().path("icons/trash.svg").size(px(14.)))
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation();
                                    })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.delete_clip(index, window, cx);
                                    }))
                            })),
                    ),
            )
            .into_any_element()
    }

    // -- Record a new clip (`ClipsSidebar.tsx:434-501`, `Editor.tsx:312-335`) --

    /// The action row's blue button: open the modal and refresh the device
    /// enumeration behind it (`createDevicesQuery` is enabled by
    /// `props.open && recordOpen()`, so the lists are re-read per opening).
    fn open_record_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clips.record_open = true;
        self.clips.record_target_menu = None;
        self.clips.record_device_menu = None;
        // Whatever the last session cached is stale by now (and the queries
        // would refetch on mount anyway), so release the sprite-atlas tiles
        // rather than carry them for the life of the editor window.
        for image in self.clips.record_thumbnails.reset() {
            let _ = window.drop_image(image);
        }
        self.clips.record_thumbnail_task = None;
        self.refresh_record_devices(cx);
        cx.notify();
    }

    /// The record modal's thumbnail loop.
    ///
    /// `ClipsSidebar.tsx:378-385` enables each thumbnail query on
    /// `props.open && recordOpen() && <kind>MenuOpen()` and takes the query's
    /// own `refetchInterval` -- 10s for displays (`utils/queries.ts:75`),
    /// none for windows (`:66`). So: capture once when the menu opens, and for
    /// displays keep re-capturing every `THUMBNAIL_STALE_TIME` until it closes.
    ///
    /// Unlike the main window there is no cheap-list poll and no signature
    /// comparison, because the sidebar does not run `listScreens`/`listWindows`
    /// at all. Each sweep re-enumerates, so the target rows still refresh.
    fn start_record_thumbnails(
        &mut self,
        kind: TargetType,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(kind, TargetType::Area | TargetType::CameraOnly) {
            self.clips.record_thumbnail_task = None;
            return;
        }

        self.clips.record_thumbnail_task = Some(cx.spawn_in(window, async move |this, cx| {
            let mut captured = false;
            loop {
                // The loop owns its own lifetime: every path that closes the
                // modal or the menu is a state change, so reading the state
                // here beats hunting down six call sites to cancel a task.
                let Ok(open) = this.update(cx, |this, _| {
                    this.clips.record_open && this.clips.record_target_menu == Some(kind)
                }) else {
                    return;
                };
                if !open {
                    // Closing the modal releases the atlas tiles; closing just
                    // the menu keeps them, the way a 60s `gcTime` would.
                    this.update_in(cx, |this, window, _| {
                        if !this.clips.record_open {
                            for image in this.clips.record_thumbnails.reset() {
                                let _ = window.drop_image(image);
                            }
                        }
                    })
                    .ok();
                    return;
                }

                // Displays re-capture on every tick (`refetchInterval:
                // 10_000`); windows capture once and the loop stays only to
                // notice the menu closing (`refetchInterval: false`).
                if kind == TargetType::Display || !captured {
                    let Ok(sweep) = this.update_in(cx, |this, window, cx| {
                        this.start_record_capture(kind, window, cx)
                    }) else {
                        return;
                    };
                    if let Some(sweep) = sweep {
                        sweep.await;
                        captured = true;
                    }
                }

                cx.background_executor()
                    .timer(target_thumbnails::THUMBNAIL_STALE_TIME)
                    .await;
            }
        }));
    }

    /// One sweep, the editor twin of `MainWindow::start_capture` -- same
    /// in-flight guard, same off-thread split, same reconcile-by-id install.
    fn start_record_capture(
        &mut self,
        kind: TargetType,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Task<()>> {
        match kind {
            TargetType::Display => {
                if self.clips.record_thumbnails.display_inflight() {
                    return None;
                }
                self.clips.record_thumbnails.set_display_inflight(true);

                let (events_tx, events) = flume::unbounded();
                let capture = gpui_tokio::Tokio::spawn(cx, async move {
                    target_thumbnails::capture_displays(events_tx).await;
                });

                Some(cx.spawn_in(window, async move |this, cx| {
                    let _capture = capture;
                    while let Ok(first) = events.recv_async().await {
                        let mut batch = vec![first];
                        batch.extend(events.try_iter());
                        if this
                            .update_in(cx, |this, window, cx| {
                                this.apply_record_display_events(batch, window, cx)
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    this.update(cx, |this, _| {
                        this.clips.record_thumbnails.set_display_inflight(false)
                    })
                    .ok();
                }))
            }
            TargetType::Window => {
                if self.clips.record_thumbnails.window_inflight() {
                    return None;
                }
                self.clips.record_thumbnails.set_window_inflight(true);

                let (events_tx, events) = flume::unbounded();
                let capture = gpui_tokio::Tokio::spawn(cx, async move {
                    target_thumbnails::capture_windows(events_tx).await;
                });

                Some(cx.spawn_in(window, async move |this, cx| {
                    let _capture = capture;
                    while let Ok(first) = events.recv_async().await {
                        let mut batch = vec![first];
                        batch.extend(events.try_iter());
                        if this
                            .update_in(cx, |this, window, cx| {
                                this.apply_record_window_events(batch, window, cx)
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    this.update(cx, |this, _| {
                        this.clips.record_thumbnails.set_window_inflight(false)
                    })
                    .ok();
                }))
            }
            TargetType::Area | TargetType::CameraOnly => None,
        }
    }

    fn apply_record_display_events(
        &mut self,
        batch: Vec<target_thumbnails::DisplayEvent>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for event in batch {
            match event {
                target_thumbnails::DisplayEvent::Listed(list) => {
                    for image in self.clips.record_thumbnails.retain_displays(&list) {
                        let _ = window.drop_image(image);
                    }
                    if let Some(devices) = self.clips.record_devices.as_mut() {
                        devices.displays = list;
                    }
                }
                target_thumbnails::DisplayEvent::Captured(id, image) => {
                    if let Some(old) = self.clips.record_thumbnails.insert_display(&id, image) {
                        let _ = window.drop_image(old);
                    }
                }
            }
        }
        cx.notify();
        // The editor is not necessarily the active window while a sweep lands,
        // and an inactive window only repaints when asked.
        window.refresh();
    }

    fn apply_record_window_events(
        &mut self,
        batch: Vec<target_thumbnails::WindowEvent>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for event in batch {
            match event {
                target_thumbnails::WindowEvent::Listed(list) => {
                    for image in self.clips.record_thumbnails.retain_windows(&list) {
                        let _ = window.drop_image(image);
                    }
                    if let Some(devices) = self.clips.record_devices.as_mut() {
                        devices.windows = list;
                    }
                }
                target_thumbnails::WindowEvent::Captured {
                    id,
                    image,
                    app_icon,
                } => {
                    let icon = app_icon.map(|bytes| {
                        Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes))
                    });
                    if let Some(old) = self.clips.record_thumbnails.insert_window(&id, image, icon)
                    {
                        let _ = window.drop_image(old);
                    }
                }
            }
        }
        cx.notify();
        window.refresh();
    }

    /// The enumeration hits AVFoundation and the window server, so it runs on
    /// the background executor -- the `start_enumeration` rule from the main
    /// window, which shares `DeviceSnapshot`.
    fn refresh_record_devices(&mut self, cx: &mut Context<Self>) {
        self.clips.record_devices = None;
        cx.spawn(async move |this, cx| {
            let snapshot = cx
                .background_executor()
                .spawn(async move { DeviceSnapshot::enumerate() })
                .await;
            this.update(cx, |this, cx| {
                this.clips.record_devices = Some(snapshot);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The chevron menus' search field, created on first use like the rename
    /// input. Escape with text clears it (the source input's own
    /// `onKeyDown`, `:1155-1161`); Escape empty falls back to closing the
    /// menu, which is what bubbling to the window handler would do.
    fn ensure_target_search_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clips.target_search_input.is_some() {
            return;
        }
        let input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let subscription = cx.subscribe_in(
            &input,
            window,
            |this: &mut Self, input, event: &ui::TextInputEvent, _window, cx| match event {
                ui::TextInputEvent::Changed => cx.notify(),
                ui::TextInputEvent::Cancelled => {
                    if input.read(cx).text().is_empty() {
                        this.clips.record_target_menu = None;
                        this.clips.record_device_menu = None;
                    } else {
                        input.update(cx, |input, cx| input.set_text("", cx));
                    }
                    cx.notify();
                }
                ui::TextInputEvent::Confirmed | ui::TextInputEvent::Blurred => {}
            },
        );
        self.push_text_subscription(subscription);
        self.clips.target_search_input = Some(input);
    }

    fn target_search_text(&self, cx: &Context<Self>) -> String {
        self.clips
            .target_search_input
            .as_ref()
            .map(|input| input.read(cx).text().trim().to_lowercase())
            .unwrap_or_default()
    }

    /// Toggle a chevron target menu open (`:1029-1035, 1062-1068`), focusing
    /// the search field the way the Tauri menu's `Input` autofocuses.
    fn toggle_record_target_menu(
        &mut self,
        kind: TargetType,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.clips.record_target_menu == Some(kind) {
            self.clips.record_target_menu = None;
        } else {
            self.ensure_target_search_input(window, cx);
            if let Some(input) = self.clips.target_search_input.clone() {
                input.update(cx, |input, cx| {
                    // `placeholder={... ? "Search windows" : "Search displays"}`
                    // (`:1162-1166`).
                    input.set_placeholder(if kind == TargetType::Window {
                        "Search windows"
                    } else {
                        "Search displays"
                    });
                    input.set_text("", cx);
                    input.focus_and_select_all(window, cx);
                });
            }
            self.clips.record_target_menu = Some(kind);
            self.clips.record_device_menu = None;
            // `enabled: props.open && recordOpen() && <kind>MenuOpen()` --
            // the thumbnail query only runs while this menu is up, and each
            // sweep re-enumerates, so the list refreshes with it.
            self.start_record_thumbnails(kind, window, cx);
        }
        cx.notify();
    }

    /// `beginEditorRecording` (`ClipsSidebar.tsx:434-445`): close the modal,
    /// stop playback, persist the live project config (the `setProjectConfig`
    /// call -- the finish-time append merges into what is on disk), and arm
    /// the session's editor recording target. Studio mode is forced app-side
    /// (`begin_recording`), so the persisted recording-mode setting is left
    /// alone -- the sidebar's `previousMode` save/restore dance nets out to
    /// exactly that.
    ///
    /// Returns false without arming when a recording is already live: the
    /// Tauri backend refuses the second start in `set_pending_recording`, and
    /// refusing *before* the target write means the modal cannot re-point a
    /// live recording's append at a different project.
    fn begin_editor_recording(&mut self, cx: &mut Context<Self>) -> bool {
        let session = RecordingSession::global(cx);
        if session.read(cx).phase != Phase::Idle {
            tracing::warn!("a recording is already live; not starting another from the editor");
            return false;
        }
        self.clips.record_open = false;
        self.clips.record_target_menu = None;
        self.clips.record_device_menu = None;
        if self.playing {
            self.stop_playback(cx);
        }
        self.pending_save().borrow_mut().flush();
        if let Err(error) = self.project.write(&self.project_path) {
            tracing::error!("failed to persist the project config before recording: {error}");
        }
        session.update(cx, |session, _| {
            session.set_editor_recording_target(Some(self.project_path.clone()))
        });
        cx.notify();
        true
    }

    /// `openTargetMode` (`:447-463`): arm the target, then the picker
    /// overlays with the editor hidden behind them.
    fn open_editor_target_mode(&mut self, kind: TargetType, cx: &mut Context<Self>) {
        if !self.begin_editor_recording(cx) {
            return;
        }
        if kind == TargetType::CameraOnly {
            // `setOptions("captureSystemAudio", false)` (`:452-458`): a
            // camera-only capture records no system audio, and the option is
            // the shared one the main window owns.
            let main = cx.global::<app_windows::AppWindows>().main;
            cx.defer(move |cx: &mut gpui::App| {
                main.update(cx, |view, _window, cx| view.set_system_audio(false, cx))
                    .ok();
            });
        }
        let project_path = self.project_path.clone();
        let request = app_windows::OverlayRequest {
            mode: kind,
            recording_mode: Mode::Studio,
            display: None,
            pinned_window: None,
        };
        cx.defer(move |cx: &mut gpui::App| {
            app_windows::open_editor_target_overlays(project_path, request, cx)
        });
    }

    /// `selectDisplayTarget` (`:465-479`): the overlays narrowed to the
    /// picked display, editor hidden.
    fn select_record_display(&mut self, display: DisplayOption, cx: &mut Context<Self>) {
        if !self.begin_editor_recording(cx) {
            return;
        }
        let project_path = self.project_path.clone();
        let request = app_windows::OverlayRequest {
            mode: TargetType::Display,
            recording_mode: Mode::Studio,
            display: Some(display.id),
            pinned_window: None,
        };
        cx.defer(move |cx: &mut gpui::App| {
            app_windows::open_editor_target_overlays(project_path, request, cx)
        });
    }

    /// `selectWindowTarget` (`:481-501`): the overlays pinned to the picked
    /// window, and then the picked window's app brought forward -- the
    /// trailing `commands.focusWindow(target.id)` (`:497`), which the main
    /// window's own window list does too. Only windows: `selectDisplayTarget`
    /// has no such call, and neither has a click on the overlay itself.
    fn select_record_window(&mut self, target: WindowOption, cx: &mut Context<Self>) {
        if !self.begin_editor_recording(cx) {
            return;
        }
        let project_path = self.project_path.clone();
        let focus = target.id.clone();
        let request = app_windows::OverlayRequest {
            mode: TargetType::Window,
            recording_mode: Mode::Studio,
            display: None,
            pinned_window: Some(target.id),
        };
        cx.defer(move |cx: &mut gpui::App| {
            app_windows::open_editor_target_overlays(project_path, request, cx);
            // After the overlays, the way the source awaits `focusWindow` last,
            // and off the main thread: the Tauri command runs on an async
            // command thread, and activating another application inside this
            // update would re-enter gpui's window callbacks.
            cx.background_executor()
                .spawn(async move {
                    crate::platform::focus_capture_target_window(&focus);
                })
                .detach();
        });
    }

    /// The picker was cancelled while this editor was hidden for it
    /// (`rawOptions.targetMode == null && hiddenForPicker`,
    /// `ClipsSidebar.tsx:413-426`): the reveal and the target clear happen in
    /// `app_windows::dismiss_target_overlays`; this is the modal-state half
    /// (`restoreMode(); closeRecord()`).
    pub(crate) fn editor_picker_dismissed(&mut self, cx: &mut Context<Self>) {
        self.clips.record_open = false;
        self.clips.record_target_menu = None;
        self.clips.record_device_menu = None;
        cx.notify();
    }

    /// `appendRecordedClip` (`Editor.tsx:319-335`), driven by the session
    /// observer where the Tauri app has the `EditorRecordingAdded` event:
    /// stop playback, persist the live config, append the finished bundle
    /// through the same whole-segment-copy the import path uses, delete the
    /// recording directory (best-effort, the `.catch(() => {})`), and reload
    /// the editor. On failure the recording directory is left alone -- it
    /// stays a standalone library project, exactly what an errored append
    /// leaves behind over there.
    pub(crate) fn append_recorded_clip(
        &mut self,
        recording_dir: PathBuf,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.clips.importing {
            // A concurrent import owns the bundle merge; the capture stays in
            // the library and can be pulled in through "Existing recording".
            tracing::warn!(
                recording = %recording_dir.display(),
                "an import is already running; leaving the recording in the library"
            );
            return;
        }
        if self.playing {
            self.stop_playback(cx);
        }
        self.pending_save().borrow_mut().flush();
        if let Err(error) = self.project.write(&self.project_path) {
            tracing::error!("failed to persist the project config before append: {error}");
        }
        self.clips.importing = true;
        cx.notify();

        let target = self.project_path.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let target = target.clone();
                    let recording_dir = recording_dir.clone();
                    async move {
                        let count = append_cap_project_to_editor(&target, &recording_dir)?;
                        if let Err(error) =
                            crate::recording::delete_recording_directory(&recording_dir)
                        {
                            tracing::warn!(
                                recording = %recording_dir.display(),
                                "could not delete the appended recording: {error}"
                            );
                        }
                        Ok::<usize, String>(count)
                    }
                })
                .await;
            match result {
                Ok(count) => {
                    tracing::info!(
                        count,
                        path = %target.display(),
                        "recorded clip appended to the editor project"
                    );
                    cx.update(|cx| crate::app_windows::reload_editor(&target, cx));
                }
                Err(error) => {
                    tracing::error!("failed to add the recorded clip: {error}");
                    this.update(cx, |this, cx| {
                        this.clips.importing = false;
                        cx.notify();
                    })
                    .ok();
                    show_append_error(&error);
                }
            }
        })
        .detach();
    }

    // -- Overlays: import menu, record modal, drag ghost -----------------------

    pub(crate) fn render_clips_overlays(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut overlays = Vec::new();
        if let Some(menu) = self.render_clips_import_menu(cx) {
            overlays.push(menu);
        }
        if let Some(modal) = self.render_clips_record_modal(cx) {
            overlays.push(modal);
        }
        if let Some(layer) = self.render_clips_drag_layer(cx) {
            overlays.push(layer);
        }
        overlays
    }

    /// The import menu (`:541-556`): a native `Menu.popup()` in the Tauri
    /// app, here the `ui::Menu` shape -- backdrop plus a panel at the click
    /// position -- because it needs a disabled row, which `ui::Menu` has no
    /// arm for.
    fn render_clips_import_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let origin = self.clips.import_menu?;
        let theme = self.theme;

        let row = |id: &str, label: &'static str| {
            div()
                .id(SharedString::from(id.to_string()))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.))
                .h(px(24.))
                .px(px(6.))
                .rounded(px(4.))
                .child(div().w(px(12.)).flex_shrink_0())
                .child(div().flex_1().min_w_0().truncate().child(label))
        };

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("clips-import-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.clips.import_menu = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .absolute()
                        .left(origin.x)
                        .top(origin.y)
                        .flex()
                        .flex_col()
                        .min_w(px(180.))
                        .p(px(4.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_1))
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.gray_12))
                        .child(
                            row("clips-import-existing", "Existing recording")
                                .hover(move |style| style.bg(Hsla::from(theme.gray_3)))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.clips.import_menu = None;
                                    this.pick_existing_recording(window, cx);
                                })),
                        )
                        .child(
                            // Disabled: `crate::import` only creates *new*
                            // library bundles (`pick_and_import_video`);
                            // appending an MP4 to the open project
                            // (`append_mp4_to_editor_project`) has no seam
                            // here yet.
                            row("clips-import-mp4", "MP4 Video…").opacity(0.5),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The drag layer: gpui has no pointer capture, so while a card drag is
    /// live a full-window transparent layer owns the move/up handlers (the
    /// `createRoot` window listeners at `:726-756`), and the floating ghost
    /// (`:1224-1240`) rides on it.
    fn render_clips_drag_layer(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let drag = self.clips.drag.as_ref()?;
        let theme = self.theme;
        let ghost = drag.active.then(|| {
            let segments = self.clip_segments();
            div()
                .absolute()
                .left(drag.position.x + px(14.))
                .top(drag.position.y + px(14.))
                .flex()
                .flex_col()
                .items_center()
                .px(px(12.))
                .py(px(8.))
                .rounded(px(8.))
                .border_1()
                .border_color(Hsla::from(theme.gray_6))
                .shadow_lg()
                .bg(card_bg(&theme))
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(theme.gray_12))
                .child(display_name_at(segments, drag.index))
        });

        Some(
            div()
                .id("clips-drag-layer")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .when(drag.active, |this| this.cursor(CursorStyle::ClosedHand))
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                    this.clips_drag_move(event, cx);
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.clips_drag_up(window, cx);
                    }),
                )
                .children(ghost)
                .into_any_element(),
        )
    }

    /// The record modal (`:969-1222`), chrome 1:1 and live: the four target
    /// actions arm the session's editor recording target and open the picker
    /// overlays, the chevron menus unfold the concrete display/window lists,
    /// and the device selects read and write the shared recording options on
    /// the main window (the gpui home of `rawOptions`).
    fn render_clips_record_modal(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.clips.record_open {
            return None;
        }
        let theme = self.theme;

        // `activeTargetMenu()` swaps the whole body (`:1001-1217`); the
        // device selects reuse the same swap where the Tauri KSelect floats a
        // popover, which has no gpui counterpart here.
        let body: AnyElement = if let Some(kind) = self.clips.record_target_menu {
            self.render_record_target_menu(kind, cx).into_any_element()
        } else if let Some(menu) = self.clips.record_device_menu {
            self.render_record_device_menu(menu, cx).into_any_element()
        } else {
            self.render_record_modal_home(cx).into_any_element()
        };

        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .p(px(24.))
                .child(
                    // `backdrop-blur-sm bg-black/60` -- gpui elements cannot
                    // blur what is behind them, so the wash carries it alone.
                    div()
                        .id("clips-record-backdrop")
                        .absolute()
                        .inset_0()
                        .bg(gpui::hsla(0., 0., 0., 0.6))
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.clips.record_open = false;
                            cx.notify();
                        })),
                )
                .child(
                    // The panel (`:977`): `max-w-[460px] h-[480px] rounded-2xl
                    // border shadow-2xl bg-gray-1 dark:bg-gray-2 border-gray-3`.
                    div()
                        .occlude()
                        .relative()
                        .flex()
                        .flex_col()
                        .w_full()
                        .max_w(px(460.))
                        .h(px(480.))
                        .overflow_hidden()
                        .rounded(px(16.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(self.panel_bg())
                        .shadow_lg()
                        // The header (`:978-998`).
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .flex_row()
                                .gap(px(12.))
                                .items_center()
                                .px(px(20.))
                                .py(px(16.))
                                .border_b_1()
                                .border_color(Hsla::from(theme.gray_3))
                                .child(
                                    div()
                                        .flex()
                                        .flex_none()
                                        .justify_center()
                                        .items_center()
                                        .size(px(40.))
                                        .rounded(px(12.))
                                        .bg(Hsla::from(theme.blue_3))
                                        .child(
                                            svg()
                                                .path("icons/clapperboard.svg")
                                                .size(px(20.))
                                                .text_color(Hsla::from(theme.blue_10)),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(2.))
                                        .min_w_0()
                                        .child(
                                            div()
                                                .text_size(px(14.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(Hsla::from(theme.gray_12))
                                                .child("Record a new clip"),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(Hsla::from(theme.gray_10))
                                                .child(
                                                    "Captured in Studio Mode and added to \
                                                     this project.",
                                                ),
                                        ),
                                )
                                .child(
                                    div()
                                        .id("clips-record-close")
                                        .flex()
                                        .flex_none()
                                        .justify_center()
                                        .items_center()
                                        .ml_auto()
                                        .rounded(px(6.))
                                        .size(px(28.))
                                        .text_color(Hsla::from(theme.gray_11))
                                        .hover(move |style| {
                                            style
                                                .bg(Hsla::from(theme.gray_4))
                                                .text_color(Hsla::from(theme.gray_12))
                                        })
                                        .child(svg().path("icons/x.svg").size(px(12.)))
                                        .on_click(cx.listener(|this, _, _window, cx| {
                                            this.clips.record_open = false;
                                            cx.notify();
                                        })),
                                ),
                        )
                        // The body container (`:1000`): `flex flex-col flex-1
                        // p-5 min-h-0`.
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .p(px(20.))
                                .min_h_0()
                                .child(body),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The modal's home body (`:1004-1125`): the target grid over the device
    /// selects.
    fn render_record_modal_home(&self, cx: &mut Context<Self>) -> gpui::Div {
        let (camera, microphone, system_audio) = record_input_snapshot(cx);

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .w_full()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(8.))
                            .w_full()
                            .child(self.record_split_target(
                                "clips-record-display",
                                "icons/monitor.svg",
                                "Display",
                                TargetType::Display,
                                cx,
                            ))
                            .child(self.record_split_target(
                                "clips-record-window",
                                "icons/app-window-mac.svg",
                                "Window",
                                TargetType::Window,
                                cx,
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(8.))
                            .w_full()
                            .child(self.record_type_button(
                                "clips-record-area",
                                "icons/area.svg",
                                "Area",
                                TargetType::Area,
                                true,
                                cx,
                            ))
                            .child(self.record_type_button(
                                "clips-record-camera-only",
                                "icons/video.svg",
                                "Camera Only",
                                TargetType::CameraOnly,
                                true,
                                cx,
                            )),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(self.record_select_row(
                        "clips-record-camera",
                        "icons/camera.svg",
                        camera.unwrap_or_else(|| "No Camera".to_string()),
                        true,
                        cx.listener(|this, _, _window, cx| {
                            this.clips.record_device_menu = Some(RecordDeviceMenu::Camera);
                            this.clips.record_target_menu = None;
                            cx.notify();
                        }),
                    ))
                    .child(self.record_select_row(
                        "clips-record-mic",
                        "icons/microphone.svg",
                        microphone.unwrap_or_else(|| "No Microphone".to_string()),
                        true,
                        cx.listener(|this, _, _window, cx| {
                            this.clips.record_device_menu = Some(RecordDeviceMenu::Microphone);
                            this.clips.record_target_menu = None;
                            cx.notify();
                        }),
                    ))
                    .child(self.record_select_row(
                        "clips-record-system-audio",
                        "icons/volume-2.svg",
                        if system_audio {
                            "Record System Audio".to_string()
                        } else {
                            "No System Audio".to_string()
                        },
                        false,
                        cx.listener(|_this, _, _window, cx| {
                            // A plain toggle, like the main window's own
                            // system-audio row -- on the shared option, so it
                            // goes through that window's entity, deferred.
                            let main = cx.global::<app_windows::AppWindows>().main;
                            cx.defer(move |cx: &mut gpui::App| {
                                main.update(cx, |view, _window, cx| {
                                    let next = !view.system_audio_enabled();
                                    view.set_system_audio(next, cx);
                                })
                                .ok();
                            });
                            cx.notify();
                        }),
                    )),
            )
    }

    /// `TargetTypeButton` (`new-main/TargetTypeButton.tsx:28-48`), the
    /// name-only variant: `flex flex-col items-center gap-1 rounded-lg
    /// border py-2 justify-end`, icon `size-5 text-gray-10`, text-xs.
    fn record_type_button(
        &self,
        id: &'static str,
        icon: &'static str,
        name: &'static str,
        kind: TargetType,
        bordered: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .flex_1()
            .flex_col()
            .items_center()
            .justify_end()
            .gap(px(4.))
            .py(px(8.))
            .when(bordered, |this| {
                this.rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_6))
                    .bg(Hsla::from(theme.gray_2))
            })
            .cursor(CursorStyle::PointingHand)
            .hover(move |style| style.bg(Hsla::from(theme.gray_4)))
            .text_color(Hsla::from(theme.gray_12))
            .child(
                svg()
                    .path(icon)
                    .size(px(20.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_10)),
            )
            .child(div().text_size(px(12.)).child(name))
            .on_click(cx.listener(move |this, _, _window, cx| {
                this.open_editor_target_mode(kind, cx);
            }))
    }

    /// The Display/Window split buttons (`:1006-1072`): a shared `rounded-lg
    /// border border-gray-5 bg-gray-3` shell -- the type half opens the
    /// picker across every display, the `border-l border-gray-6` chevron
    /// unfolds the concrete list.
    fn record_split_target(
        &self,
        id: &'static str,
        icon: &'static str,
        name: &'static str,
        kind: TargetType,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let theme = self.theme;
        div()
            .flex()
            .flex_1()
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(Hsla::from(theme.gray_5))
            .bg(Hsla::from(theme.gray_3))
            .child(self.record_type_button(id, icon, name, kind, false, cx))
            .child(
                div()
                    .id(SharedString::from(format!("{id}-menu")))
                    .flex()
                    .items_center()
                    .justify_center()
                    .px(px(8.))
                    .border_l_1()
                    .border_color(Hsla::from(theme.gray_6))
                    .cursor(CursorStyle::PointingHand)
                    .hover(move |style| style.bg(Hsla::from(theme.gray_5)))
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(14.))
                            .text_color(Hsla::from(theme.gray_10)),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.toggle_record_target_menu(kind, window, cx);
                    })),
            )
    }

    /// `CameraSelectBase` / `MicrophoneSelectBase`'s shell (`:1106, 1119`):
    /// `h-[42px] rounded-lg border border-gray-5 bg-gray-3 px-2 gap-2`, live.
    /// `chevron` marks the two pickers; the system-audio toggle goes without.
    fn record_select_row(
        &self,
        id: &'static str,
        icon: &'static str,
        label: String,
        chevron: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .w_full()
            .h(px(42.))
            .rounded(px(8.))
            .border_1()
            .border_color(Hsla::from(theme.gray_5))
            .bg(Hsla::from(theme.gray_3))
            .cursor(CursorStyle::PointingHand)
            .hover(move |style| style.bg(Hsla::from(theme.gray_4)))
            .text_size(px(13.))
            .text_color(Hsla::from(theme.gray_12))
            .child(
                svg()
                    .path(icon)
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_10)),
            )
            .child(div().flex_1().min_w_0().truncate().child(label))
            .when(chevron, |this| {
                this.child(
                    svg()
                        .path("icons/chevron-down.svg")
                        .size(px(12.))
                        .flex_shrink_0()
                        .text_color(Hsla::from(theme.gray_10)),
                )
            })
            .on_click(on_click)
    }

    /// The back row shared by the unfolded menus (`:1129-1145`).
    fn record_menu_back(&self, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id("clips-record-menu-back")
            .flex()
            .flex_none()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .h(px(36.))
            .px(px(8.))
            .rounded(px(6.))
            .text_size(px(12.))
            .text_color(Hsla::from(theme.gray_11))
            .cursor(CursorStyle::PointingHand)
            .hover(move |style| style.bg(Hsla::from(theme.gray_4)))
            .child(
                svg()
                    .path("icons/move-left.svg")
                    .size(px(12.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_11)),
            )
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.gray_12))
                    .child("Back"),
            )
            .on_click(cx.listener(|this, _, _window, cx| {
                this.clips.record_target_menu = None;
                this.clips.record_device_menu = None;
                cx.notify();
            }))
    }

    /// A chevron menu's body (`:1128-1216`): back, search, and the concrete
    /// targets -- `TargetMenuGrid` as two columns of cards, each leading with
    /// the live ScreenCaptureKit thumbnail `target_thumbnails` captures.
    fn render_record_target_menu(&self, kind: TargetType, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let query = self.target_search_text(cx);
        let matches = |value: &str| query.is_empty() || value.to_lowercase().contains(&query);

        let loading = self.clips.record_devices.is_none();
        let mut cards: Vec<AnyElement> = Vec::new();
        if let Some(devices) = &self.clips.record_devices {
            match kind {
                TargetType::Display => {
                    for display in devices
                        .displays
                        .iter()
                        .filter(|display| matches(&display.label))
                    {
                        let chosen = display.clone();
                        cards.push(
                            self.record_target_card(
                                SharedString::from(format!("record-display-{}", display.id)),
                                self.clips.record_thumbnails.display(&display.id),
                                "icons/monitor.svg",
                                display.label.clone(),
                                None,
                                display.describe_refresh_rate(),
                                cx.listener(move |this, _, _window, cx| {
                                    this.select_record_display(chosen.clone(), cx);
                                }),
                            )
                            .into_any_element(),
                        );
                    }
                }
                TargetType::Window => {
                    for target in devices
                        .windows
                        .iter()
                        .filter(|window| matches(&window.label) || matches(&window.app))
                    {
                        let chosen = target.clone();
                        cards.push(
                            self.record_target_card(
                                SharedString::from(format!("record-window-{}", target.id)),
                                self.clips.record_thumbnails.window(&target.id),
                                "icons/app-window-mac.svg",
                                target.label.clone(),
                                Some(target.app.clone()),
                                target.describe_metadata(),
                                cx.listener(move |this, _, _window, cx| {
                                    this.select_record_window(chosen.clone(), cx);
                                }),
                            )
                            .into_any_element(),
                        );
                    }
                }
                TargetType::Area | TargetType::CameraOnly => {}
            }
        }

        let empty_message = |theme: &Theme, message: &'static str| {
            div()
                .py(px(24.))
                .w_full()
                .text_size(px(13.))
                .text_color(Hsla::from(theme.gray_11))
                .child(message)
        };

        let content: AnyElement = if loading {
            empty_message(&theme, "Loading...").into_any_element()
        } else if cards.is_empty() {
            empty_message(
                &theme,
                match (kind, query.is_empty()) {
                    (TargetType::Display, true) => "No displays found",
                    (TargetType::Display, false) => "No matching displays",
                    (_, true) => "No windows found",
                    (_, false) => "No matching windows",
                },
            )
            .into_any_element()
        } else {
            // Two columns as rows of two, the `render_target_grid` layout. The
            // cards carry their own width, so a lone trailing card keeps half
            // the row without a spacer holding the other half open.
            let mut grid = div().flex().flex_col().gap(px(8.)).w_full();
            let mut cards = cards.into_iter();
            while let Some(first) = cards.next() {
                let mut row = div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .w_full()
                    .items_stretch()
                    .child(first);
                if let Some(second) = cards.next() {
                    row = row.child(second);
                }
                grid = grid.child(row);
            }
            grid.into_any_element()
        };

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .flex_none()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .min_h(px(36.))
                    .child(self.record_menu_back(cx))
                    .children(self.clips.target_search_input.as_ref().map(|input| {
                        div().flex_1().min_w_0().child(
                            ui::TextInput::plain(&theme, "clips-record-target-search", input)
                                .height(px(36.))
                                .text_size(px(13.))
                                .padding_x(px(8.))
                                .radius(px(6.))
                                .bg(Hsla::from(theme.gray_3))
                                .border(Hsla::from(theme.gray_5))
                                .flex(true),
                        )
                    })),
            )
            .child(
                div()
                    .id("clips-record-menu-scroll")
                    .flex_1()
                    .min_h_0()
                    .pt(px(16.))
                    .overflow_y_scroll()
                    .child(content),
            )
    }

    /// `TargetCard`: the live thumbnail block over three 11px lines, the same
    /// component the main window's picker renders.
    #[allow(clippy::too_many_arguments)]
    fn record_target_card(
        &self,
        id: SharedString,
        thumb: target_thumbnails::TargetThumb,
        icon: &'static str,
        label: String,
        subtitle: Option<String>,
        metadata: Option<String>,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .flex_col()
            .w(px(RECORD_TARGET_CARD_WIDTH))
            .flex_none()
            .min_w_0()
            .overflow_hidden()
            .rounded(px(8.))
            .bg(theme.body_fill(3))
            .cursor(CursorStyle::PointingHand)
            .child(target_thumbnails::render_thumbnail_slot(thumb, icon, theme))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w_full()
                    .min_w_0()
                    .px(px(8.))
                    .py(px(6.))
                    .text_size(px(11.))
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child(label),
                    )
                    .children(subtitle.map(|subtitle| {
                        div()
                            .w_full()
                            .truncate()
                            .text_color(Hsla::from(theme.gray_11))
                            .child(subtitle)
                    }))
                    .children(metadata.map(|metadata| {
                        div()
                            .w_full()
                            .truncate()
                            .text_color(Hsla::from(theme.gray_10))
                            .child(metadata)
                    })),
            )
            .hover(move |style| style.bg(theme.body_hover_fill(4)))
            .on_click(on_click)
    }

    /// A device select unfolded (`:1084-1122`): the "none" row first --
    /// turning the device off is not a search result -- then the enumerated
    /// options, exactly the main window panel's ordering. The selection
    /// lands on the shared options through the same setters that window's
    /// own rows use, deferred because it is another window's entity.
    fn render_record_device_menu(
        &self,
        menu: RecordDeviceMenu,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let theme = self.theme;
        let (camera, microphone, _) = record_input_snapshot(cx);

        let mut rows: Vec<AnyElement> = Vec::new();

        let none_selected = match menu {
            RecordDeviceMenu::Camera => camera.is_none(),
            RecordDeviceMenu::Microphone => microphone.is_none(),
        };
        rows.push(
            self.record_device_row(
                SharedString::from("clips-record-device-none"),
                "icons/circle-x.svg",
                match menu {
                    RecordDeviceMenu::Camera => "No Camera",
                    RecordDeviceMenu::Microphone => "No Microphone",
                }
                .to_string(),
                none_selected,
                cx.listener(move |this, _, _window, cx| match menu {
                    RecordDeviceMenu::Camera => this.set_record_camera(None, cx),
                    RecordDeviceMenu::Microphone => this.set_record_microphone(None, cx),
                }),
            )
            .into_any_element(),
        );

        match &self.clips.record_devices {
            None => rows.push(
                div()
                    .py(px(16.))
                    .w_full()
                    .text_size(px(13.))
                    .text_color(Hsla::from(theme.gray_11))
                    .child("Loading...")
                    .into_any_element(),
            ),
            Some(devices) => match menu {
                RecordDeviceMenu::Camera => {
                    for option in &devices.cameras {
                        let selected = camera.as_deref() == Some(option.label.as_str());
                        let chosen = option.clone();
                        rows.push(
                            self.record_device_row(
                                SharedString::from(format!(
                                    "clips-record-camera-{}",
                                    option.device_id
                                )),
                                "icons/camera.svg",
                                option.label.clone(),
                                selected,
                                cx.listener(move |this, _, _window, cx| {
                                    this.set_record_camera(Some(chosen.clone()), cx);
                                }),
                            )
                            .into_any_element(),
                        );
                    }
                }
                RecordDeviceMenu::Microphone => {
                    for option in &devices.microphones {
                        let selected = microphone.as_deref() == Some(option.name.as_str());
                        let chosen = option.clone();
                        rows.push(
                            self.record_device_row(
                                SharedString::from(format!("clips-record-mic-{}", option.name)),
                                "icons/microphone.svg",
                                option.name.clone(),
                                selected,
                                cx.listener(move |this, _, _window, cx| {
                                    this.set_record_microphone(Some(chosen.clone()), cx);
                                }),
                            )
                            .into_any_element(),
                        );
                    }
                }
            },
        }

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .flex_none()
                    .flex_row()
                    .items_center()
                    .min_h(px(36.))
                    .child(self.record_menu_back(cx)),
            )
            .child(
                div()
                    .id("clips-record-device-scroll")
                    .flex_1()
                    .min_h_0()
                    .pt(px(16.))
                    .overflow_y_scroll()
                    .child(div().flex().flex_col().gap(px(8.)).children(rows)),
            )
    }

    /// One row of a device select.
    fn record_device_row(
        &self,
        id: SharedString,
        icon: &'static str,
        label: String,
        selected: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .w_full()
            .h(px(42.))
            .rounded(px(8.))
            .border_1()
            .border_color(if selected {
                Hsla::from(theme.blue_9)
            } else {
                Hsla::from(theme.gray_5)
            })
            .bg(Hsla::from(theme.gray_3))
            .cursor(CursorStyle::PointingHand)
            .hover(move |style| style.bg(Hsla::from(theme.gray_4)))
            .text_size(px(13.))
            .text_color(Hsla::from(theme.gray_12))
            .child(
                svg()
                    .path(icon)
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_10)),
            )
            .child(div().flex_1().min_w_0().truncate().child(label))
            .on_click(on_click)
    }

    /// `createCameraMutation` from the modal (`:1089-1103`), routed through
    /// the main window's setter (state plus the app-scoped feed, preview
    /// bubble included). The `skipCameraWindow: isCameraOnly` refinement has
    /// no seam here -- the bubble opens either way, as it does for every
    /// other selection path in this app.
    fn set_record_camera(&mut self, camera: Option<CameraOption>, cx: &mut Context<Self>) {
        self.clips.record_device_menu = None;
        let main = cx.global::<app_windows::AppWindows>().main;
        cx.defer(move |cx: &mut gpui::App| {
            main.update(cx, |view, _window, cx| {
                view.set_camera_selection(camera, cx)
            })
            .ok();
        });
        cx.notify();
    }

    /// `setOptions("micName", ...) + commands.setMicInput` (`:1113-1116`).
    fn set_record_microphone(
        &mut self,
        microphone: Option<MicrophoneOption>,
        cx: &mut Context<Self>,
    ) {
        self.clips.record_device_menu = None;
        let main = cx.global::<app_windows::AppWindows>().main;
        cx.defer(move |cx: &mut gpui::App| {
            main.update(cx, |view, _window, cx| {
                view.set_microphone_selection(microphone, cx)
            })
            .ok();
        });
        cx.notify();
    }

    // -- Import (`ClipsSidebar.tsx:503-539`) -----------------------------------

    /// `pickCapRecording` (`:533-539`): the `.cap` picker, rooted at the
    /// recordings directory where the platform dialog supports a root.
    fn pick_existing_recording(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clips.importing {
            return;
        }
        cx.spawn_in(window, async move |this, cx| {
            // Blocking modal, so from a spawned task with no borrow held --
            // the `save_file_panel` rule.
            let Some(path) = pick_existing_recording_path() else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                this.import_recording_path(path, window, cx);
            })
            .ok();
        })
        .detach();
    }

    /// `importRecordingPath` (`:503-523`): stop playback, persist the live
    /// config (the `setProjectConfig` call -- the import merges into what is
    /// on disk), run the import off-thread, then reload the editor the way
    /// `window.location.reload()` does.
    fn import_recording_path(
        &mut self,
        source: PathBuf,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.clips.importing {
            return;
        }
        if self.playing {
            self.stop_playback(cx);
        }
        self.pending_save().borrow_mut().flush();
        if let Err(error) = self.project.write(&self.project_path) {
            tracing::error!("failed to persist the project config before import: {error}");
        }
        self.clips.importing = true;
        cx.notify();

        let target = self.project_path.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let target = target.clone();
                    async move { append_cap_project_to_editor(&target, &source) }
                })
                .await;
            match result {
                Ok(count) => {
                    tracing::info!(count, path = %target.display(), "clips imported");
                    cx.update(|cx| crate::app_windows::reload_editor(&target, cx));
                }
                Err(error) => {
                    tracing::error!("failed to import clip: {error}");
                    this.update(cx, |this, cx| {
                        this.clips.importing = false;
                        cx.notify();
                    })
                    .ok();
                    // Outside the update: the modal spins AppKit's own run
                    // loop and may not hold a gpui borrow.
                    show_import_error(&error);
                }
            }
        })
        .detach();
    }
}

/// `getExistingRecordingPickerOptions` (`ED/existing-recording-picker.ts`):
/// a `.cap` filter on macOS (bundles are packages there), a directory picker
/// on Windows, both rooted at the recordings directory where the dialog
/// supports one.
fn pick_existing_recording_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        crate::platform::open_image_panel(&["cap"])
    }
    #[cfg(not(target_os = "macos"))]
    {
        rfd::FileDialog::new()
            .set_directory(crate::recording::recordings_dir())
            .add_filter("Cap Recording", &["cap"])
            .pick_file()
    }
}

/// `toast.error(\`Failed to import clip: ...\`)` (`:520`), as the blocking
/// dialog this app uses where the webview has toasts.
fn show_import_error(message: &str) {
    let _ = rfd::MessageDialog::new()
        .set_title("Import Error")
        .set_description(format!("Failed to import clip: {message}"))
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// `toast.error(\`Failed to add clip: ...\`)` (`Editor.tsx:332-333`), same
/// stand-in.
fn show_append_error(message: &str) {
    let _ = rfd::MessageDialog::new()
        .set_title("Recording Error")
        .set_description(format!("Failed to add clip: {message}"))
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// The shared recording options, read off the main window -- the gpui home of
/// `rawOptions`: the selected camera's label, the microphone name, and the
/// system-audio flag, in that order.
fn record_input_snapshot(cx: &gpui::App) -> (Option<String>, Option<String>, bool) {
    let main = cx.global::<app_windows::AppWindows>().main;
    main.read(cx)
        .map(|view| {
            (
                view.camera_selection().map(|camera| camera.label.clone()),
                view.microphone_selection().map(|mic| mic.name.clone()),
                view.system_audio_enabled(),
            )
        })
        .unwrap_or((None, None, false))
}

// ---------------------------------------------------------------------------
// Thumbnail decode -- `decode_clip_thumbnail`
// (`src-tauri/src/clip_thumbnails.rs:67-215`), minus the JPEG cache: the
// frame goes straight into a `RenderImage` and lives in [`ClipsState`].
// ---------------------------------------------------------------------------

/// 96px cards at 2x (`w-24` at `ClipsSidebar.tsx:881`).
const THUMB_MAX_WIDTH: u32 = 192;
const SEEK_DECODE_PACKET_LIMIT: usize = 240;

fn decode_clip_thumbnail(
    project_path: &Path,
    recording_segment: u32,
    time: f64,
) -> Result<Arc<RenderImage>, String> {
    let meta = RecordingMeta::load_for_project(project_path)
        .map_err(|error| format!("Failed to load recording meta: {error}"))?;
    let RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Err("Clip thumbnails are only available for studio recordings".to_string());
    };
    let display_path = match studio.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => meta.path(&segment.display.path),
        StudioRecordingMeta::MultipleSegments { inner } => {
            let segment = inner
                .segments
                .get(recording_segment as usize)
                .ok_or_else(|| format!("Recording segment {recording_segment} not found"))?;
            meta.path(&segment.display.path)
        }
    };
    decode_thumbnail_frame(&display_path, time.max(0.0))
}

fn decode_thumbnail_frame(input: &Path, time: f64) -> Result<Arc<RenderImage>, String> {
    use ffmpeg::rescale::{Rescale, TIME_BASE};

    let mut ictx =
        ffmpeg::format::input(input).map_err(|e| format!("Failed to open video: {e}"))?;

    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("No video stream found")?;
    let stream_index = stream.index();

    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| e.to_string())?
        .decoder()
        .video()
        .map_err(|e| e.to_string())?;

    let src_width = decoder.width();
    let src_height = decoder.height();
    if src_width == 0 || src_height == 0 {
        return Err("Invalid video dimensions".to_string());
    }

    let scale = (THUMB_MAX_WIDTH as f32 / src_width as f32).min(1.0);
    let target_width = ((src_width as f32 * scale).round() as u32).max(1);
    let target_height = ((src_height as f32 * scale).round() as u32).max(1);

    // Straight to BGRA: gpui's sprite atlas wants BGRA bytes, the same reason
    // `decode_poster` channel-swaps its RGBA (`editor_window.rs:423-443`).
    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        decoder.format(),
        src_width,
        src_height,
        ffmpeg::format::Pixel::BGRA,
        target_width,
        target_height,
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .map_err(|e| e.to_string())?;

    if time > 0.0 {
        let position_us = (time * 1_000_000.0) as i64;
        let seek_target = position_us.rescale((1, 1_000_000), TIME_BASE);
        decoder.flush();
        ictx.seek(seek_target, ..seek_target)
            .map_err(|e| format!("Failed to seek to {position_us}us: {e}"))?;
    }

    let mut frame = ffmpeg::frame::Video::empty();
    let mut got_frame = false;
    let mut packets_tried = 0usize;

    'outer: for (packet_stream, packet) in ictx.packets() {
        if packet_stream.index() != stream_index {
            continue;
        }

        packets_tried += 1;

        if decoder.send_packet(&packet).is_err() {
            if packets_tried >= SEEK_DECODE_PACKET_LIMIT {
                break;
            }
            continue;
        }

        match decoder.receive_frame(&mut frame) {
            Ok(()) => {
                got_frame = true;
                break 'outer;
            }
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => {}
            Err(ffmpeg::Error::Eof) => break 'outer,
            Err(e) => {
                if packets_tried >= SEEK_DECODE_PACKET_LIMIT {
                    return Err(format!("Failed to decode frame: {e}"));
                }
            }
        }

        if packets_tried >= SEEK_DECODE_PACKET_LIMIT {
            break;
        }
    }

    if !got_frame {
        decoder
            .send_eof()
            .map_err(|e| format!("Failed to flush decoder: {e}"))?;
        loop {
            match decoder.receive_frame(&mut frame) {
                Ok(()) => {
                    got_frame = true;
                    break;
                }
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
                Err(e) => return Err(format!("Failed to flush decoder: {e}")),
            }
        }
    }

    if !got_frame {
        return Err("No decodable frames found".to_string());
    }

    let mut bgra_frame = ffmpeg::frame::Video::empty();
    scaler
        .run(&frame, &mut bgra_frame)
        .map_err(|e| e.to_string())?;

    let width = bgra_frame.width() as usize;
    let height = bgra_frame.height() as usize;
    let src_stride = bgra_frame.stride(0);
    let dst_stride = width * 4;
    if src_stride < dst_stride {
        return Err(format!(
            "Unexpected BGRA stride: src_stride={src_stride}, expected >= {dst_stride}"
        ));
    }
    let mut buffer = vec![0u8; height * dst_stride];
    for (y, row) in buffer.chunks_exact_mut(dst_stride).enumerate() {
        row.copy_from_slice(&bgra_frame.data(0)[y * src_stride..y * src_stride + dst_stride]);
    }

    let image = image::RgbaImage::from_raw(width as u32, height as u32, buffer)
        .ok_or("Failed to build thumbnail image")?;
    Ok(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(image)
    ])))
}

// ---------------------------------------------------------------------------
// "Existing recording" -- `add_existing_recording_to_editor` and its helpers
// (`apps/desktop/src-tauri/src/import.rs`), the `.cap` branch. The MP4 branch
// (`append_mp4_to_editor_project`) is the transcode pipeline `crate::import`
// owns and is not duplicated here. Relative paths travel as `String`s: the
// `relative-path` crate is `cap-project`'s dependency, not this workspace's,
// so the type can be assigned (`.into()`) but not named.
// ---------------------------------------------------------------------------

/// `import.rs:38-43` in the Tauri binary.
const VIDEO_IMPORT_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"];
const IMAGE_IMPORT_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const AUDIO_IMPORT_EXTENSIONS: &[&str] = &["ogg", "m4a", "mp3", "wav", "aac", "flac"];
const KEYBOARD_IMPORT_EXTENSIONS: &[&str] = &["bin", "json"];
const CURSOR_EVENTS_IMPORT_EXTENSIONS: &[&str] = &["json"];

fn has_allowed_extension(path: &str, extensions: &[&str]) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

/// `is_cap_project_path` (`import.rs:160-162`).
fn is_cap_project_path(path: &Path) -> bool {
    path.is_dir() && path.join("recording-meta.json").is_file()
}

/// `same_project_path` (`import.rs:267-271`).
fn same_project_path(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    a == b
}

/// `normalized_metadata_relative_path` (`import.rs:164-184`): reject absolute
/// paths, drive letters and `..` components before a metadata path is allowed
/// to resolve inside either bundle.
fn normalized_relative(raw: &str, asset_kind: &str) -> Result<String, String> {
    let normalized = raw.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.split('/').any(|component| component == "..")
    {
        return Err(format!(
            "Invalid {asset_kind} path in recording metadata: {normalized}"
        ));
    }
    Ok(normalized)
}

/// `source_asset_path` (`import.rs:186-221`).
fn source_asset_path(
    source_project_path: &Path,
    source_relative_path: &str,
    asset_kind: &str,
    allowed_extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    let relative = normalized_relative(source_relative_path, asset_kind)?;

    if !has_allowed_extension(&relative, allowed_extensions) {
        return Err(format!("Unsupported {asset_kind} file type: {relative}"));
    }

    let source_path = source_project_path.join(&relative);
    if !source_path.is_file() {
        return Ok(None);
    }

    let source_root = source_project_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve source project path: {e}"))?;
    let canonical = source_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {asset_kind} path: {e}"))?;
    if !canonical.starts_with(&source_root) {
        return Err(format!(
            "{asset_kind} path escapes source project: {relative}"
        ));
    }

    Ok(Some(canonical))
}

/// `ensure_multiple_segments` (`import.rs:273-303`): normalise a
/// single-segment studio bundle into the multi-segment shape imports extend.
fn ensure_multiple_segments(meta: &mut RecordingMeta) -> Result<&mut MultipleSegments, String> {
    let RecordingMetaInner::Studio(studio_meta) = &mut meta.inner else {
        return Err("Instant mode recordings cannot be edited".to_string());
    };

    if let StudioRecordingMeta::SingleSegment { segment } = studio_meta.as_ref() {
        let segment = segment.clone();
        **studio_meta = StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: segment.display,
                    camera: segment.camera,
                    mic: segment.audio,
                    system_audio: None,
                    cursor: segment.cursor,
                    keyboard: None,
                    display_notch: None,
                }],
                cursors: Cursors::default(),
                status: Some(StudioRecordingStatus::Complete),
            },
        };
    }

    match studio_meta.as_mut() {
        StudioRecordingMeta::MultipleSegments { inner } => Ok(inner),
        StudioRecordingMeta::SingleSegment { .. } => {
            Err("Failed to normalize project recording segments".to_string())
        }
    }
}

/// `get_media_duration` (`crates/enc-ffmpeg/src/remux.rs:543-557`), which is
/// not a dependency of this workspace.
fn media_duration_secs(path: &Path) -> Option<f64> {
    let input = ffmpeg::format::input(path).ok()?;
    let duration = input.duration();
    (duration > 0).then(|| duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE))
}

fn get_video_duration_secs(path: &Path) -> Result<f64, String> {
    media_duration_secs(path)
        .ok_or_else(|| format!("Could not determine video duration: {}", path.display()))
}

/// `full_timeline_for_segments` (`import.rs:311-330`).
fn full_timeline_for_segments(
    project_path: &Path,
    segments: &[MultipleSegment],
) -> Result<Vec<TimelineSegment>, String> {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let duration =
                get_video_duration_secs(&project_path.join(segment.display.path.as_str()))?;
            Ok(TimelineSegment {
                recording_clip: index as u32,
                timescale: 1.0,
                start: 0.0,
                end: duration,
                name: None,
                speed_audio_mode: None,
                audio_muted: false,
            })
        })
        .collect()
}

/// `ensure_project_timeline` (`import.rs:366-390`).
fn ensure_project_timeline<'a>(
    config: &'a mut ProjectConfiguration,
    project_path: &Path,
    segments: &[MultipleSegment],
) -> Result<&'a mut TimelineConfiguration, String> {
    if config.timeline.is_none() {
        config.timeline = Some(TimelineConfiguration {
            segments: full_timeline_for_segments(project_path, segments)?,
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
    }

    config
        .timeline
        .as_mut()
        .ok_or_else(|| "Failed to prepare project timeline".to_string())
}

/// `add_clip_configs` (`import.rs:392-412`).
fn add_clip_configs(
    config: &mut ProjectConfiguration,
    base_index: u32,
    segments: &[MultipleSegment],
) {
    for (offset, segment) in segments.iter().enumerate() {
        let index = base_index + offset as u32;
        let offsets = segment.calculate_audio_offsets();

        if let Some(existing) = config.clips.iter_mut().find(|clip| clip.index == index) {
            existing.offsets = offsets;
            existing.offsets_auto_calculated = true;
        } else {
            config.clips.push(ClipConfiguration {
                index,
                offsets,
                offsets_auto_calculated: true,
            });
        }
    }
}

/// `unique_segment_dir` (`import.rs:414-435`).
fn unique_segment_dir(project_path: &Path, index: u32) -> Result<(PathBuf, String), String> {
    let segments_root = project_path.join("content").join("segments");
    std::fs::create_dir_all(&segments_root)
        .map_err(|e| format!("Failed to create imported segment directory: {e}"))?;

    let mut counter = 0;
    loop {
        let name = if counter == 0 {
            format!("segment-{index}")
        } else {
            format!("segment-{index}-import-{counter}")
        };
        let path = segments_root.join(&name);
        if !path.exists() {
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("Failed to create imported segment directory: {e}"))?;
            return Ok((path, format!("content/segments/{name}")));
        }
        counter += 1;
    }
}

/// `sanitize_filename` (`import.rs:125-132`).
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// `relative_file_extension` (`import.rs:437-444`).
fn relative_file_extension(path: &str, fallback: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// `relative_file_name` (`import.rs:446-453`).
fn relative_file_name(path: &str, fallback: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// `unique_file_name` (`import.rs:455-492`).
fn unique_file_name(dir: &Path, preferred: &str) -> String {
    let sanitized = sanitize_filename(preferred);
    let sanitized = if sanitized.is_empty() {
        "file".to_string()
    } else {
        sanitized
    };

    let path = Path::new(&sanitized);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("file")
        .to_string();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let mut counter = 0;
    loop {
        let candidate = if counter == 0 {
            sanitized.clone()
        } else if let Some(extension) = &extension {
            format!("{stem}-{counter}.{extension}")
        } else {
            format!("{stem}-{counter}")
        };

        if !dir.join(&candidate).exists() {
            return candidate;
        }

        counter += 1;
    }
}

/// `copy_file_to_relative_path` (`import.rs:494-509`).
fn copy_file_to_relative(
    source_path: &Path,
    target_project_path: &Path,
    target_relative_path: &str,
) -> Result<(), String> {
    let target_path = target_project_path.join(target_relative_path);

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create import directory: {e}"))?;
    }

    std::fs::copy(source_path, &target_path)
        .map(|_| ())
        .map_err(|e| format!("Failed to copy {}: {e}", source_path.display()))
}

/// `probe_video_can_decode` (`crates/enc-ffmpeg/src/remux.rs:322-390`), the
/// same lean transcription `crate::import` carries.
fn probe_video_can_decode(path: &Path) -> Result<bool, String> {
    let input = ffmpeg::format::input(path).map_err(|e| format!("Failed to open file: {e}"))?;

    let input_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "No video stream found".to_string())?;

    let decoder_ctx = ffmpeg::codec::context::Context::from_parameters(input_stream.parameters())
        .map_err(|e| format!("Failed to create decoder context: {e}"))?;
    let mut decoder = decoder_ctx
        .decoder()
        .video()
        .map_err(|e| format!("Failed to create video decoder: {e}"))?;

    let stream_index = input_stream.index();
    let mut input =
        ffmpeg::format::input(path).map_err(|e| format!("Failed to reopen file: {e}"))?;

    let mut frame = ffmpeg::frame::Video::empty();
    let mut packets_tried = 0;
    const MAX_PACKETS: usize = 100;

    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }

        packets_tried += 1;

        if let Err(e) = decoder.send_packet(&packet) {
            if packets_tried >= MAX_PACKETS {
                return Err(format!(
                    "Failed to send packet after {packets_tried} attempts: {e}"
                ));
            }
            continue;
        }

        match decoder.receive_frame(&mut frame) {
            Ok(()) => return Ok(true),
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
            Err(ffmpeg::Error::Eof) => break,
            Err(e) => {
                if packets_tried >= MAX_PACKETS {
                    return Err(format!(
                        "Failed to decode frame after {packets_tried} packets: {e}"
                    ));
                }
                continue;
            }
        }
    }

    if let Err(e) = decoder.send_eof() {
        return Err(format!("Failed to send EOF: {e}"));
    }

    loop {
        match decoder.receive_frame(&mut frame) {
            Ok(()) => return Ok(true),
            Err(ffmpeg::Error::Eof) => break,
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
            Err(e) => return Err(format!("Failed to receive frame after EOF: {e}")),
        }
    }

    Ok(false)
}

/// `copy_video_meta` (`import.rs:511-552`).
fn copy_video_meta(
    source_project_path: &Path,
    target_project_path: &Path,
    source: &VideoMeta,
    target_relative_dir: &str,
    name: &str,
    required: bool,
) -> Result<Option<VideoMeta>, String> {
    let Some(source_path) = source_asset_path(
        source_project_path,
        source.path.as_str(),
        "video",
        VIDEO_IMPORT_EXTENSIONS,
    )?
    else {
        if required {
            return Err(format!(
                "Missing video file: {}",
                source_project_path.join(source.path.as_str()).display()
            ));
        }
        return Ok(None);
    };

    let can_decode = probe_video_can_decode(&source_path)
        .map_err(|e| format!("Cannot decode video {}: {e}", source_path.display()))?;
    if !can_decode {
        if required {
            return Err(format!("Unsupported video file: {}", source_path.display()));
        }
        return Ok(None);
    }

    let extension = relative_file_extension(source.path.as_str(), "mp4");
    let target_relative_path = format!("{target_relative_dir}/{name}.{extension}");
    copy_file_to_relative(&source_path, target_project_path, &target_relative_path)?;

    let mut copied = source.clone();
    copied.path = target_relative_path.as_str().into();
    Ok(Some(copied))
}

/// `copy_audio_meta` (`import.rs:554-579`).
fn copy_audio_meta(
    source_project_path: &Path,
    target_project_path: &Path,
    source: &AudioMeta,
    target_relative_dir: &str,
    name: &str,
) -> Result<Option<AudioMeta>, String> {
    let Some(source_path) = source_asset_path(
        source_project_path,
        source.path.as_str(),
        "audio",
        AUDIO_IMPORT_EXTENSIONS,
    )?
    else {
        return Ok(None);
    };

    let extension = relative_file_extension(source.path.as_str(), "ogg");
    let target_relative_path = format!("{target_relative_dir}/{name}.{extension}");
    copy_file_to_relative(&source_path, target_project_path, &target_relative_path)?;

    let mut copied = source.clone();
    copied.path = target_relative_path.as_str().into();
    Ok(Some(copied))
}

/// `copy_keyboard_path` (`import.rs:581-638`): the metadata's own path when
/// it names one, else the two conventional file names next to the display
/// track.
fn copy_keyboard_path(
    source_meta: &RecordingMeta,
    source_segment: &MultipleSegment,
    target_project_path: &Path,
    target_relative_dir: &str,
) -> Result<Option<String>, String> {
    if let Some(source_relative_path) = &source_segment.keyboard {
        let file_name = relative_file_name(
            source_relative_path.as_str(),
            cap_project::KEYBOARD_EVENTS_FILE_NAME,
        );
        let Some(source_path) = source_asset_path(
            &source_meta.project_path,
            source_relative_path.as_str(),
            "keyboard events",
            KEYBOARD_IMPORT_EXTENSIONS,
        )?
        else {
            return Ok(None);
        };

        let target_relative_path =
            format!("{target_relative_dir}/{}", sanitize_filename(&file_name));
        copy_file_to_relative(&source_path, target_project_path, &target_relative_path)?;

        return Ok(Some(target_relative_path));
    }

    let Some(display_dir) = source_segment.display.path.parent() else {
        return Ok(None);
    };

    for file_name in [
        cap_project::KEYBOARD_EVENTS_FILE_NAME,
        cap_project::LEGACY_KEYBOARD_EVENTS_FILE_NAME,
    ] {
        let source_relative_path = display_dir.join(file_name);
        let Some(source_path) = source_asset_path(
            &source_meta.project_path,
            source_relative_path.as_str(),
            "keyboard events",
            KEYBOARD_IMPORT_EXTENSIONS,
        )?
        else {
            continue;
        };

        let target_relative_path =
            format!("{target_relative_dir}/{}", sanitize_filename(file_name));
        copy_file_to_relative(&source_path, target_project_path, &target_relative_path)?;

        return Ok(Some(target_relative_path));
    }

    Ok(None)
}

/// `normalize_cursors_to_correct` (`import.rs:640-662`).
fn normalize_cursors_to_correct(cursors: &mut Cursors) -> &mut HashMap<String, CursorMeta> {
    if let Cursors::Old(old) = cursors {
        let converted = old
            .iter()
            .map(|(id, path)| {
                (
                    id.clone(),
                    CursorMeta {
                        image_path: path.as_str().into(),
                        hotspot: XY::new(0.0, 0.0),
                        shape: None,
                    },
                )
            })
            .collect();
        *cursors = Cursors::Correct(converted);
    }

    match cursors {
        Cursors::Correct(map) => map,
        Cursors::Old(_) => unreachable!(),
    }
}

/// `unique_cursor_id` (`import.rs:664-687`).
fn unique_cursor_id(
    cursors: &HashMap<String, CursorMeta>,
    import_token: &str,
    source_id: &str,
) -> String {
    let source_id = if source_id.is_empty() {
        "cursor"
    } else {
        source_id
    };
    let base = format!("{import_token}-{source_id}");
    if !cursors.contains_key(&base) {
        return base;
    }

    let mut counter = 1;
    loop {
        let candidate = format!("{base}-{counter}");
        if !cursors.contains_key(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

/// `copy_source_cursor_images` (`import.rs:689-780`).
fn copy_source_cursor_images(
    source_meta: &RecordingMeta,
    source_cursors: &Cursors,
    target_project_path: &Path,
    target_cursors: &mut Cursors,
    import_token: &str,
) -> Result<HashMap<String, String>, String> {
    let target_cursor_dir = target_project_path.join("content").join("cursors");
    std::fs::create_dir_all(&target_cursor_dir)
        .map_err(|e| format!("Failed to create cursor directory: {e}"))?;

    let target_cursors = normalize_cursors_to_correct(target_cursors);
    let mut id_map = HashMap::new();

    // The `Old` arm's values are bare path strings; normalising a copy of the
    // source map first collapses the Tauri version's two near-identical loops
    // (`import.rs:703-777`) into one -- and sidesteps `CursorMeta::shape`'s
    // type, whose crate is not a dependency of this workspace.
    let mut source_cursors = source_cursors.clone();
    let source_map = normalize_cursors_to_correct(&mut source_cursors);

    for (source_id, cursor) in source_map.iter() {
        let source_relative = normalized_relative(cursor.image_path.as_str(), "cursor image")?;
        let Some(source_path) = source_asset_path(
            &source_meta.project_path,
            &source_relative,
            "cursor image",
            IMAGE_IMPORT_EXTENSIONS,
        )?
        else {
            continue;
        };

        let new_id = unique_cursor_id(target_cursors, import_token, source_id);
        let source_file_name = relative_file_name(&source_relative, "cursor.png");
        let target_file_name =
            unique_file_name(&target_cursor_dir, &format!("{new_id}-{source_file_name}"));
        let target_relative_path = format!("content/cursors/{target_file_name}");

        copy_file_to_relative(&source_path, target_project_path, &target_relative_path)?;

        target_cursors.insert(
            new_id.clone(),
            CursorMeta {
                image_path: target_relative_path.as_str().into(),
                hotspot: cursor.hotspot,
                shape: cursor.shape,
            },
        );
        id_map.insert(source_id.clone(), new_id);
    }

    Ok(id_map)
}

/// `copy_cursor_events_path` (`import.rs:782-839`): the events file follows
/// its images, with every cursor id remapped to its imported name.
fn copy_cursor_events_path(
    source_meta: &RecordingMeta,
    source_relative_path: &str,
    target_project_path: &Path,
    target_relative_dir: &str,
    cursor_id_map: &HashMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(source_path) = source_asset_path(
        &source_meta.project_path,
        source_relative_path,
        "cursor events",
        CURSOR_EVENTS_IMPORT_EXTENSIONS,
    )?
    else {
        return Ok(None);
    };

    let target_relative_path = format!("{target_relative_dir}/cursor.json");
    let target_path = target_project_path.join(&target_relative_path);
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cursor event directory: {e}"))?;
    }

    if cursor_id_map.is_empty() {
        std::fs::copy(&source_path, &target_path)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy cursor events: {e}"))?;
        return Ok(Some(target_relative_path));
    }

    match CursorEvents::load_from_file(&source_path) {
        Ok(mut events) => {
            for event in &mut events.moves {
                if let Some(new_id) = cursor_id_map.get(&event.cursor_id) {
                    event.cursor_id = new_id.clone();
                }
            }
            for event in &mut events.clicks {
                if let Some(new_id) = cursor_id_map.get(&event.cursor_id) {
                    event.cursor_id = new_id.clone();
                }
            }

            let file = std::fs::File::create(&target_path)
                .map_err(|e| format!("Failed to create cursor event file: {e}"))?;
            serde_json::to_writer_pretty(file, &events)
                .map_err(|e| format!("Failed to write cursor event file: {e}"))?;
        }
        Err(_) => {
            std::fs::copy(&source_path, &target_path)
                .map(|_| ())
                .map_err(|e| format!("Failed to copy cursor events: {e}"))?;
        }
    }

    Ok(Some(target_relative_path))
}

/// `single_segment_to_multiple` (`import.rs:841-851`).
fn single_segment_to_multiple(segment: &cap_project::SingleSegment) -> MultipleSegment {
    MultipleSegment {
        display: segment.display.clone(),
        camera: segment.camera.clone(),
        mic: segment.audio.clone(),
        system_audio: None,
        cursor: segment.cursor.clone(),
        keyboard: None,
        display_notch: None,
    }
}

/// `studio_segments_for_import` (`import.rs:853-860`).
fn studio_segments_for_import(studio_meta: &StudioRecordingMeta) -> Vec<MultipleSegment> {
    match studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            vec![single_segment_to_multiple(segment)]
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.clone(),
    }
}

/// `full_timeline_for_source_segments` (`import.rs:345-364`).
fn full_timeline_for_source_segments(
    source_meta: &RecordingMeta,
    segments: &[MultipleSegment],
) -> Result<Vec<TimelineSegment>, String> {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let duration = get_source_video_duration_secs(source_meta, &segment.display)?;
            Ok(TimelineSegment {
                recording_clip: index as u32,
                timescale: 1.0,
                start: 0.0,
                end: duration,
                name: None,
                speed_audio_mode: None,
                audio_muted: false,
            })
        })
        .collect()
}

/// `get_source_video_duration_secs` (`import.rs:332-343`).
fn get_source_video_duration_secs(
    source_meta: &RecordingMeta,
    video: &VideoMeta,
) -> Result<f64, String> {
    let source_path = source_asset_path(
        &source_meta.project_path,
        video.path.as_str(),
        "video",
        VIDEO_IMPORT_EXTENSIONS,
    )?
    .ok_or_else(|| {
        format!(
            "Missing video file: {}",
            source_meta.project_path.join(video.path.as_str()).display()
        )
    })?;
    get_video_duration_secs(&source_path)
}

/// `source_timeline_segments_for_import` (`import.rs:862-931`): the source's
/// own edited timeline, clamped and cleaned, or a full-length timeline per
/// segment when it has none.
fn source_timeline_segments_for_import(
    source_meta: &RecordingMeta,
    source_segments: &[MultipleSegment],
) -> Result<Vec<TimelineSegment>, String> {
    let source_config = ProjectConfiguration::load(&source_meta.project_path).unwrap_or_default();
    let Some(timeline) = source_config.timeline else {
        return full_timeline_for_source_segments(source_meta, source_segments);
    };

    if timeline.segments.is_empty() {
        return full_timeline_for_source_segments(source_meta, source_segments);
    }

    let mut duration_cache = HashMap::new();
    let mut imported_segments = Vec::new();

    for segment in timeline.segments {
        let source_index = segment.recording_clip;
        let Some(source_segment) = source_segments.get(source_index as usize) else {
            continue;
        };

        let max_duration = if let Some(duration) = duration_cache.get(&source_index) {
            *duration
        } else {
            let duration = get_source_video_duration_secs(source_meta, &source_segment.display)?;
            duration_cache.insert(source_index, duration);
            duration
        };

        if max_duration <= 0.0 {
            continue;
        }

        let raw_start = if segment.start.is_finite() {
            segment.start
        } else {
            0.0
        };
        let raw_end = if segment.end.is_finite() {
            segment.end
        } else {
            max_duration
        };
        let start = raw_start.clamp(0.0, max_duration);
        let end = raw_end.clamp(start, max_duration);
        if end <= start {
            continue;
        }

        imported_segments.push(TimelineSegment {
            recording_clip: source_index,
            timescale: if segment.timescale.is_finite() && segment.timescale > 0.0 {
                segment.timescale
            } else {
                1.0
            },
            start,
            end,
            name: None,
            speed_audio_mode: None,
            audio_muted: segment.audio_muted,
        });
    }

    if imported_segments.is_empty() {
        full_timeline_for_source_segments(source_meta, source_segments)
    } else {
        Ok(imported_segments)
    }
}

/// `copy_source_segment` (`import.rs:933-1027`).
fn copy_source_segment(
    source_meta: &RecordingMeta,
    source_segment: &MultipleSegment,
    target_project_path: &Path,
    target_relative_dir: &str,
    cursor_id_map: &HashMap<String, String>,
) -> Result<MultipleSegment, String> {
    let display = copy_video_meta(
        &source_meta.project_path,
        target_project_path,
        &source_segment.display,
        target_relative_dir,
        "display",
        true,
    )?
    .ok_or_else(|| "Missing display video".to_string())?;

    let camera = source_segment
        .camera
        .as_ref()
        .map(|camera| {
            copy_video_meta(
                &source_meta.project_path,
                target_project_path,
                camera,
                target_relative_dir,
                "camera",
                false,
            )
        })
        .transpose()?
        .flatten();

    let mic = source_segment
        .mic
        .as_ref()
        .map(|mic| {
            copy_audio_meta(
                &source_meta.project_path,
                target_project_path,
                mic,
                target_relative_dir,
                "mic",
            )
        })
        .transpose()?
        .flatten();

    let system_audio = source_segment
        .system_audio
        .as_ref()
        .map(|system_audio| {
            copy_audio_meta(
                &source_meta.project_path,
                target_project_path,
                system_audio,
                target_relative_dir,
                "system-audio",
            )
        })
        .transpose()?
        .flatten();

    let cursor = source_segment
        .cursor
        .as_ref()
        .map(|cursor| {
            copy_cursor_events_path(
                source_meta,
                cursor.as_str(),
                target_project_path,
                target_relative_dir,
                cursor_id_map,
            )
        })
        .transpose()?
        .flatten();

    let keyboard = copy_keyboard_path(
        source_meta,
        source_segment,
        target_project_path,
        target_relative_dir,
    )?;

    Ok(MultipleSegment {
        display,
        camera,
        mic,
        system_audio,
        cursor: cursor.map(|path| path.as_str().into()),
        keyboard: keyboard.map(|path| path.as_str().into()),
        display_notch: source_segment.display_notch,
    })
}

/// `add_existing_recording_to_editor` +
/// `append_cap_project_to_editor_project` (`import.rs:1746-1895`), the
/// studio-`.cap` branch. Blocking; the caller runs it on the background
/// executor. Returns how many recording segments were imported.
///
/// Deviations, both erroring where the Tauri binary has machinery this app
/// does not: an instant-mode source is routed to the MP4 transcode there, and
/// an in-progress source is awaited (`wait_for_recording_ready`) rather than
/// refused.
pub(crate) fn append_cap_project_to_editor(
    target_project_path: &Path,
    source_path: &Path,
) -> Result<usize, String> {
    if same_project_path(target_project_path, source_path) {
        return Err("Cannot import a recording into itself".to_string());
    }
    if !is_cap_project_path(source_path) {
        return Err("Select a Cap project folder".to_string());
    }

    let source_meta = RecordingMeta::load_for_project(source_path)
        .map_err(|e| format!("Failed to load source project metadata: {e}"))?;

    let RecordingMetaInner::Studio(source_studio_meta) = &source_meta.inner else {
        return Err("Instant recordings can't be imported into a project yet".to_string());
    };
    match source_studio_meta.status() {
        StudioRecordingStatus::InProgress => {
            return Err("Source Cap project is still recording".to_string());
        }
        StudioRecordingStatus::Failed { error } => {
            return Err(format!("Source Cap project failed: {error}"));
        }
        StudioRecordingStatus::Complete | StudioRecordingStatus::NeedsRemux => {}
    }

    let source_segments = studio_segments_for_import(source_studio_meta);
    if source_segments.is_empty() {
        return Err("Source Cap project has no recording segments".to_string());
    }

    let source_timeline = source_timeline_segments_for_import(&source_meta, &source_segments)?;
    let source_cursors = match source_studio_meta.as_ref() {
        StudioRecordingMeta::MultipleSegments { inner } => Some(inner.cursors.clone()),
        StudioRecordingMeta::SingleSegment { .. } => None,
    };

    let mut target_meta = RecordingMeta::load_for_project(target_project_path)
        .map_err(|e| format!("Failed to load target project metadata: {e}"))?;
    let mut config = ProjectConfiguration::load(target_project_path).unwrap_or_default();
    let existing_segments = {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.clone()
    };
    ensure_project_timeline(&mut config, target_project_path, &existing_segments)?;

    let (base_index, copied_segments, source_to_target_index) = {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        let base_index = inner.segments.len() as u32;
        // A uuid in the Tauri binary; only uniqueness matters.
        let import_token = format!(
            "import-{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or_default()
        );
        let cursor_id_map = if let Some(source_cursors) = &source_cursors {
            copy_source_cursor_images(
                &source_meta,
                source_cursors,
                target_project_path,
                &mut inner.cursors,
                &import_token,
            )?
        } else {
            HashMap::new()
        };

        let mut copied_segments = Vec::new();
        let mut source_to_target_index = HashMap::new();

        for (source_index, source_segment) in source_segments.iter().enumerate() {
            let target_index = base_index + copied_segments.len() as u32;
            let (_, target_relative_dir) = unique_segment_dir(target_project_path, target_index)?;
            let copied_segment = copy_source_segment(
                &source_meta,
                source_segment,
                target_project_path,
                &target_relative_dir,
                &cursor_id_map,
            )?;

            inner.segments.push(copied_segment.clone());
            copied_segments.push(copied_segment);
            source_to_target_index.insert(source_index as u32, target_index);
        }

        (base_index, copied_segments, source_to_target_index)
    };

    if copied_segments.is_empty() {
        return Err("Source Cap project has no importable recording segments".to_string());
    }

    {
        let timeline =
            ensure_project_timeline(&mut config, target_project_path, &existing_segments)?;
        for source_segment in source_timeline {
            let Some(target_index) = source_to_target_index.get(&source_segment.recording_clip)
            else {
                continue;
            };

            timeline.segments.push(TimelineSegment {
                recording_clip: *target_index,
                timescale: source_segment.timescale,
                start: source_segment.start,
                end: source_segment.end,
                name: None,
                speed_audio_mode: source_segment.speed_audio_mode,
                audio_muted: source_segment.audio_muted,
            });
        }
    }

    add_clip_configs(&mut config, base_index, &copied_segments);

    target_meta
        .save_for_project()
        .map_err(|e| format!("Failed to save project metadata: {e:?}"))?;
    config
        .write(target_project_path)
        .map_err(|e| format!("Failed to save project config: {e}"))?;

    Ok(copied_segments.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, size};

    fn segment(recording_clip: u32, start: f64, end: f64) -> TimelineSegment {
        TimelineSegment {
            recording_clip,
            timescale: 1.0,
            start,
            end,
            name: None,
            speed_audio_mode: None,
            audio_muted: false,
        }
    }

    fn timeline(segments: Vec<TimelineSegment>) -> TimelineConfiguration {
        serde_json::from_value(serde_json::json!({
            "segments": [],
            "zoomSegments": []
        }))
        .map(|mut timeline: TimelineConfiguration| {
            timeline.segments = segments;
            timeline
        })
        .unwrap()
    }

    fn transition(segment_index: u32, duration: f64) -> ClipTransition {
        ClipTransition {
            segment_index,
            kind: cap_project::ClipTransitionType::CrossFade,
            duration,
        }
    }

    #[test]
    fn durations_format_like_the_source() {
        assert_eq!(format_clip_duration(0.0), "0:00");
        assert_eq!(format_clip_duration(-3.0), "0:00");
        assert_eq!(format_clip_duration(f64::NAN), "0:00");
        assert_eq!(format_clip_duration(0.4), "0:00");
        assert_eq!(format_clip_duration(0.6), "0:01");
        assert_eq!(format_clip_duration(59.6), "1:00");
        assert_eq!(format_clip_duration(75.0), "1:15");
        assert_eq!(format_clip_duration(600.0), "10:00");
    }

    /// `segmentLabel` (`ClipsSidebar.tsx:582-587`): the first piece of a
    /// recording clip is "Clip N", the later pieces "Split 1", "Split 2"...
    #[test]
    fn labels_number_clips_and_their_splits() {
        let segments = vec![
            segment(0, 0.0, 10.0),
            segment(0, 10.0, 20.0),
            segment(1, 0.0, 5.0),
            segment(0, 20.0, 30.0),
        ];
        assert_eq!(segment_label(&segments, 0), "Clip 1");
        assert_eq!(segment_label(&segments, 1), "Split 1");
        assert_eq!(segment_label(&segments, 2), "Clip 2");
        assert_eq!(segment_label(&segments, 3), "Split 2");
    }

    #[test]
    fn a_custom_name_wins_and_whitespace_does_not() {
        let mut segments = vec![segment(0, 0.0, 10.0), segment(1, 0.0, 5.0)];
        segments[0].name = Some("Intro".to_string());
        segments[1].name = Some("   ".to_string());
        assert_eq!(display_name(&segments, 0), "Intro");
        assert_eq!(display_name(&segments, 1), "Clip 2");
    }

    /// `segmentDescription` (`:598-609`): splits carry their parent clip's
    /// label ahead of the duration.
    #[test]
    fn descriptions_prefix_splits_with_the_clip_label() {
        let segments = vec![segment(0, 0.0, 90.0), segment(0, 90.0, 100.0)];
        assert_eq!(segment_description(&segments, 0), "1:30");
        assert_eq!(segment_description(&segments, 1), "Clip 1 · 0:10");
    }

    /// `moveClip`'s insertion arithmetic (`:639-642`): an insertion point
    /// after the dragged card shifts down by one once the card is removed.
    #[test]
    fn move_clip_reorders_with_the_insertion_shift() {
        let mut config = timeline(vec![
            segment(0, 0.0, 1.0),
            segment(1, 0.0, 1.0),
            segment(2, 0.0, 1.0),
        ]);
        // Drop clip 0 after clip 1 (insertion index 2 -> to = 1).
        assert!(move_clip(&mut config, 0, 2));
        let order: Vec<u32> = config
            .segments
            .iter()
            .map(|segment| segment.recording_clip)
            .collect();
        assert_eq!(order, vec![1, 0, 2]);

        // Dropping a card back onto its own slot is a no-op...
        assert!(!move_clip(&mut config, 1, 1));
        assert!(!move_clip(&mut config, 1, 2));
        // ...and out-of-range indices do nothing.
        assert!(!move_clip(&mut config, 9, 0));
    }

    #[test]
    fn move_clip_to_the_front_and_the_back() {
        let mut config = timeline(vec![
            segment(0, 0.0, 1.0),
            segment(1, 0.0, 1.0),
            segment(2, 0.0, 1.0),
        ]);
        assert!(move_clip(&mut config, 2, 0));
        let order: Vec<u32> = config
            .segments
            .iter()
            .map(|segment| segment.recording_clip)
            .collect();
        assert_eq!(order, vec![2, 0, 1]);

        assert!(move_clip(&mut config, 0, 3));
        let order: Vec<u32> = config
            .segments
            .iter()
            .map(|segment| segment.recording_clip)
            .collect();
        assert_eq!(order, vec![0, 1, 2]);
    }

    /// `transitionsAfterClipMove` (`ED/clip-transitions.ts:277-306`): a
    /// transition survives only if its two clips stay adjacent.
    #[test]
    fn moving_a_clip_keeps_only_the_transitions_whose_pairs_stay_adjacent() {
        // Order 0-1-2-3 with transitions at 1 (0|1) and 3 (2|3); moving 3 to
        // the front keeps 0|1 (now at index 2) and drops 2|3.
        let transitions = vec![transition(1, 0.5), transition(3, 0.5)];
        let (kept, dropped) = transitions_after_clip_move(4, &transitions, 3, 0);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].segment_index, 2);
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].segment_index, 3);
    }

    /// The dropped transition's overlap is given back: every later segment on
    /// the other tracks shifts right by its effective duration
    /// (`ClipsSidebar.tsx:656-683`).
    #[test]
    fn a_dropped_transition_ripples_the_other_tracks() {
        let mut config = timeline(vec![
            segment(0, 0.0, 10.0),
            segment(1, 0.0, 10.0),
            segment(2, 0.0, 10.0),
        ]);
        config.transitions = vec![transition(1, 1.0)];
        config.zoom_segments = vec![cap_project::ZoomSegment {
            start: 15.0,
            end: 18.0,
            amount: 1.5,
            mode: cap_project::ZoomMode::Auto,
            glide_direction: Default::default(),
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
        }];

        // Moving clip 0 to the end separates the 0|1 pair, dropping the 1s
        // transition whose boundary sat at offset(1) + 1.0 = 10.0.
        assert!(move_clip(&mut config, 0, 3));
        assert!(config.transitions.is_empty());
        assert_eq!(config.zoom_segments[0].start, 16.0);
        assert_eq!(config.zoom_segments[0].end, 19.0);
    }

    /// `computeDropIndex` (`:692-703`): the insertion point is after every
    /// card whose midpoint the pointer has passed.
    #[test]
    fn drop_index_follows_the_card_midpoints() {
        let card = |top: f32| {
            Some(Bounds {
                origin: point(px(0.), px(top)),
                size: size(px(100.), px(72.)),
            })
        };
        let cards = vec![card(0.), card(80.), card(160.)];
        assert_eq!(compute_drop_index(px(-10.), &cards), 0);
        assert_eq!(compute_drop_index(px(35.), &cards), 0);
        assert_eq!(compute_drop_index(px(37.), &cards), 1);
        assert_eq!(compute_drop_index(px(120.), &cards), 2);
        assert_eq!(compute_drop_index(px(500.), &cards), 3);
    }

    #[test]
    fn relative_paths_are_validated_before_they_resolve() {
        assert!(normalized_relative("content/segments/segment-0/display.mp4", "video").is_ok());
        assert!(normalized_relative("a\\b\\c.mp4", "video").is_ok_and(|p| p == "a/b/c.mp4"));
        assert!(normalized_relative("", "video").is_err());
        assert!(normalized_relative("/etc/passwd", "video").is_err());
        assert!(normalized_relative("../outside.mp4", "video").is_err());
        assert!(normalized_relative("a/../../outside.mp4", "video").is_err());
        assert!(normalized_relative("C:/windows.mp4", "video").is_err());
    }
}
