//! The editor window -- `routes/editor/` shell, project load, real rendered
//! frames, and playback.
//!
//! E1 built the 1275x800 window, the three regions at their exact dimensions
//! and frame 0 of a real project on screen; E2 made the transport real:
//! play/pause on the button and on Space, a live playhead and clock driven by
//! `on_state_change`, click and drag-scrub seeking on the timeline, and the
//! source's end-of-media stop. E3 drew the whole timeline strip and E4 made it
//! **write**: selection, trim, move, split, create, delete, undo/redo and the
//! debounced save, all of whose maths lives in [`crate::editor_edits`]. The
//! config sidebar's controls still come later, so every affordance that unit
//! owns renders **in place and disabled** rather than being left out -- the
//! layout is the deliverable, and a sidebar missing its rail would not be one.
//!
//! Three seams matter here, all proved by `tests/editor_frame0.rs` first:
//!
//! * **`preview_tx` is the only thing that produces a picture.** `seek_to` and
//!   `set_playhead_position` have identical bodies and move nothing but
//!   `state.playhead_position`. The initial frame comes from
//!   `preview_tx.send_modify(|v| *v = Some((0, fps, resolution_base)))`, which
//!   is exactly what `lib.rs:6617-6618` does after creating an instance.
//! * **`RenderedFrame` is row-padded** to wgpu's 256-byte copy alignment, and
//!   its bytes are RGBA while gpui's sprite atlas wants BGRA. Both conversions
//!   happen in [`frame_image`].
//! * **`ProjectRecordingsMeta::new` panics** (`.expect("Failed to read display
//!   video")`, `crates/rendering/src/project_recordings.rs:127`) on a bundle
//!   whose display track will not open. [`preflight`] runs that exact call
//!   under `catch_unwind` on a background thread before `EditorInstance::new`
//!   ever sees the path, so a corrupt `.cap` becomes an in-window error state
//!   instead of taking the process down.
//!
//! E2 adds a fourth: **`on_state_change` and `frame_cb` are both called from
//! foreign threads** -- the `cap-playback` OS thread and tokio workers -- so
//! neither may touch a gpui `Context`. Both go through channels drained on the
//! main thread ([`PlayheadSignal`], the frame pump), and every transport call
//! that locks `instance.state` runs on the tokio runtime ([`run_transport`]).

use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use cap_cursor_info::CursorFamily;
use cap_editor::{EditorFrameOutput, EditorInstance, EditorState};
use cap_project::{
    ClipSpeedAudioMode, Cursors, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, TimelineConfiguration, XY,
};
use cap_rendering::{FrameLayout, ProjectRecordingsMeta, RenderedFrame};
#[cfg(target_os = "macos")]
use core_foundation::base::TCFType;
#[cfg(target_os = "macos")]
use core_video::pixel_buffer::{CVPixelBuffer, CVPixelBufferRef};
use gpui::{
    AppContext as _, Context, Entity, FocusHandle, FontWeight, Hsla, InteractiveElement,
    IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
    Point, Render, RenderImage, SharedString, StatefulInteractiveElement as _, StyleRefinement,
    Styled, StyledImage as _, Subscription, WeakEntity, Window, div, point, prelude::FluentBuilder,
    px, svg,
};

use crate::{
    editor_edits::{self as edits, DragBounds, Hit, ProjectHistory, SPLIT_SNAP_PX, Selection},
    editor_export::ExportUi,
    store::SettingsEnum,
    theme::Theme,
    ui,
};

mod frame;

// ---------------------------------------------------------------------------
// Window geometry
// ---------------------------------------------------------------------------

/// `.inner_size(1275.0, 800.0)` / `.min_inner_size(1275.0, 800.0)` on the
/// `ShowCapWindow::Editor` arm (`windows.rs:1934-1935`), and the same pair
/// again from `CapWindowId::Editor::min_size` (`windows.rs:1112`).
pub const EDITOR_WIDTH: f32 = 1275.;
pub const EDITOR_HEIGHT: f32 = 800.;

/// `CapWindowId::Editor::traffic_lights_position` is
/// `Some(Some(LogicalPosition::new(20.0, 32.0)))` (`windows.rs:1092-1094`) --
/// but the Tauri inset is NOT the button's top-left corner.
/// `position_window_controls` (`platform/macos/delegates.rs`) builds a
/// titlebar of height `button_height + inset.y`, centers the buttons in it and
/// nudges them 4px down, which lands the close button's top-left at
/// `(inset.x, inset.y / 2 + 4)` -- button height cancels out. gpui's
/// `traffic_light_position` IS the literal top-left, so the value here is the
/// resolved position, not the raw Tauri inset: (20, 32) -> (20, 20).
pub const TRAFFIC_LIGHTS: Option<Point<Pixels>> = Some(point(px(20.), px(20.)));

// ---------------------------------------------------------------------------
// Preview numbers -- the app's, not the crate's
// ---------------------------------------------------------------------------

/// `FPS = 60` (`routes/editor/context.ts:148`), mirrored in Rust as
/// `EDITOR_PREVIEW_FPS` (`apps/desktop/src-tauri/src/lib.rs:146`). FPS is not
/// a constant inside `cap-editor` -- it is a parameter on `start_playback` and
/// on the `preview_tx` tuple, so the app owns it.
pub const EDITOR_PREVIEW_FPS: u32 = 60;

/// `OUTPUT_SIZE = { x: 1920, y: 1080 }` (`context.ts:150-153`,
/// `lib.rs:147`).
const EDITOR_OUTPUT_SIZE: XY<u32> = XY { x: 1920, y: 1080 };

pub fn preview_resolution(quality: crate::store::EditorPreviewQuality) -> XY<u32> {
    let scale = quality.scale();
    let width = ((EDITOR_OUTPUT_SIZE.x as f32 * scale).round() as u32)
        .max(4)
        .div_ceil(4)
        * 4;
    let height = ((EDITOR_OUTPUT_SIZE.y as f32 * scale).round() as u32)
        .max(2)
        .div_ceil(2)
        * 2;
    XY::new(width, height)
}

pub fn default_preview_resolution() -> XY<u32> {
    preview_resolution(crate::store::EditorPreviewQuality::Half)
}

// ---------------------------------------------------------------------------
// Shell metrics (`routes/editor/Editor.tsx:77-82`)
// ---------------------------------------------------------------------------

/// `DEFAULT_TIMELINE_HEIGHT`.
const DEFAULT_TIMELINE_HEIGHT: f32 = 260.;
/// `MIN_TIMELINE_HEIGHT`.
pub const MIN_TIMELINE_HEIGHT: f32 = 240.;
/// `RESIZE_HANDLE_HEIGHT`.
const RESIZE_HANDLE_HEIGHT: f32 = 16.;
/// `MIN_PLAYER_CONTENT_HEIGHT` + `RESIZE_HANDLE_HEIGHT` = `MIN_PLAYER_HEIGHT`.
const MIN_PLAYER_CONTENT_HEIGHT: f32 = 320.;
const MIN_PLAYER_HEIGHT: f32 = MIN_PLAYER_CONTENT_HEIGHT + RESIZE_HANDLE_HEIGHT;

/// The magnetic radius for a segment drag, in pixels. Shift disables it, the
/// same as the canvas overlays' snap.
const DRAG_SNAP_PX: f64 = 8.;

/// Blip's `TIMELINE_RESIZE_DURATION`: releasing a ghost trim glides every clip
/// box into its packed position over this window, on a quintic ease-out.
const CLIP_RESIZE_ANIM_DURATION: Duration = Duration::from_millis(180);
const CLIP_RESIZE_ANIM_TICK: Duration = Duration::from_millis(16);

/// `h-14` on the header row (`Header.tsx:92`).
const HEADER_HEIGHT: f32 = 56.;

/// `w-104 min-w-104` on the sidebar column (`Editor.tsx:728`). Tailwind v4
/// arbitrary spacing: 104 x 0.25rem = 26rem = 416px. The column also carries
/// `ml-2`, i.e. an 8px gutter.
pub(crate) const SIDEBAR_WIDTH: f32 = 416.;
/// `h-16` on the sidebar's tab bar (`ConfigSidebar.tsx:595`).
pub(crate) const SIDEBAR_TAB_BAR_HEIGHT: f32 = 64.;

/// `padding = 4` inside `PreviewCanvas` (`Player.tsx:566`).
const PLAYER_CANVAS_PADDING: f32 = 4.;

// ---------------------------------------------------------------------------
// Timeline metrics -- all of them now live in [`crate::editor_timeline`],
// which owns the strip itself (`routes/editor/Timeline/index.tsx:62-68`).
// ---------------------------------------------------------------------------

use crate::editor_timeline::{
    self as timeline, ADD_TRACK_OPTIONS, MINIMAP_HEIGHT, MINIMAP_TOP, SCROLL_BODY_PADDING_RIGHT,
    START_SNAP_PX, TIMELINE_HEADER_HEIGHT, TIMELINE_PADDING, TIMELINE_SLOT_PADDING,
    TIMELINE_TOP_PADDING, TRACK_GUTTER, TRACK_ICON_WIDTH, TRACK_ROW_GAP, TimelineModel,
    TimelineView, TrackKind, TrackLanes, Transform,
};

// ---------------------------------------------------------------------------
// Letterboxing
// ---------------------------------------------------------------------------

/// `PreviewCanvas`'s fit maths (`Player.tsx:566-601`), verbatim: subtract the
/// 4px padding from both axes, then fit the frame's aspect inside what is
/// left. With no frame yet the source defaults to 1920x1080 (`:567-568`).
///
/// Returns the on-screen size of the frame, in logical pixels.
pub fn letterbox(container: (f32, f32), frame: (f32, f32)) -> (f32, f32) {
    let available_width = (container.0 - PLAYER_CANVAS_PADDING * 2.).max(0.);
    let available_height = (container.1 - PLAYER_CANVAS_PADDING * 2.).max(0.);

    let container_aspect = if available_width == 0. || available_height == 0. {
        1.
    } else {
        available_width / available_height
    };
    let frame_aspect = if frame.0 == 0. || frame.1 == 0. {
        container_aspect
    } else {
        frame.0 / frame.1
    };

    if frame_aspect < container_aspect {
        (available_height * frame_aspect, available_height)
    } else {
        (available_width, available_width / frame_aspect)
    }
}

fn frame_layout_requires_editor_invalidation(
    first_frame: bool,
    playing: bool,
    layout_changed: bool,
    cleared_drag_rect: bool,
) -> bool {
    first_frame || cleared_drag_rect || (!playing && layout_changed)
}

// ---------------------------------------------------------------------------
// Loading a project
// ---------------------------------------------------------------------------

/// What the shell needs off the bundle before (and independently of) the
/// renderer: the header's name, the timeline's clips, and the two sidebar tabs
/// whose disabled state is data-driven.
#[derive(Debug, Clone)]
pub struct ProjectSummary {
    pub recordings: Arc<ProjectRecordingsMeta>,
    /// `meta().prettyName` -- the header's editable name.
    pub pretty_name: String,
    /// Every track the timeline draws, derived from the bundle's own
    /// `project-config.json`. Replaced once the instance exists, because
    /// `EditorInstance::new` synthesises a timeline for a raw bundle.
    pub timeline: TimelineModel,
    /// `timeline.duration()`, the transport's total.
    pub duration: f64,
    /// The camera tab is disabled when every segment has `camera === null`
    /// (`ConfigSidebar.tsx:602-604`).
    pub has_camera: bool,
    /// The cursor tab is disabled on `!meta().hasRecordedCursorData`
    /// (`ConfigSidebar.tsx:610`).
    pub has_cursor_data: bool,
    /// The asset family the recorded cursor shapes belong to, which the style
    /// picker highlights as "Recorded" and falls back to while the project's
    /// own type is `Auto`.
    pub recorded_cursor_family: Option<CursorFamily>,
    /// `editorInstance.recordings.segments[i].display.duration` -- the ceiling
    /// a clip's end handle trims out to (`TL/ClipTrack.tsx:1160-1162`).
    pub clip_display_durations: Vec<f64>,
    /// `editorInstance.recordingDuration` (`lib.rs:3114` =
    /// `recordings.duration()`), the other half of that clamp.
    pub recording_duration: f64,
    /// Whether the bundle has more than one recording clip, which decides
    /// `"Clip"` vs `"Clip N"`. Kept so the model can be rebuilt after an edit.
    pub multiple_clips: bool,
    /// `meta().hasMicrophone` / `hasSystemAudio` (`ED/context.ts:1776-1783`):
    /// the first segment's tracks, which is what the audio tab's two volume
    /// fields and the sync-offset block are gated on.
    pub has_microphone: bool,
    pub has_system_audio: bool,
    /// `recordings.segments[0].mic?.channels` -- the stereo-mode row appears
    /// only for a two-channel microphone (`ConfigSidebar.tsx:712`).
    pub mic_channels: Option<u16>,
    /// `editorInstance.recordings.segments.length`, which is what
    /// `SyncOffsetsConfig` iterates: offsets are per *recording* clip.
    pub recording_clips: usize,
}

/// Validate a `.cap` before handing it to `EditorInstance::new`.
///
/// Two classes of failure are separated here on purpose:
///
/// * the ones `EditorInstance::new` already returns as `Err` (missing path,
///   unparseable meta, a non-studio recording, zero segments) -- reproduced so
///   the window can say *which*, and so the panicking call below is never
///   reached with input it cannot survive;
/// * the one it does **not**: `ProjectRecordingsMeta::new` `.expect()`s on a
///   display or camera track it cannot open, which aborts the whole app if it
///   unwinds out of the renderer's task. It is a plain synchronous function,
///   so running it here under `catch_unwind` -- on a background thread, in
///   Rust-only frames, never across an objc boundary -- converts the panic
///   into a message. The validated metadata is reused by `EditorInstance`.
///
/// Blocking; callers run it on the background executor.
pub fn preflight(path: &std::path::Path) -> Result<ProjectSummary, String> {
    if !path.exists() {
        return Err(format!("Video path {} not found!", path.display()));
    }

    let meta = RecordingMeta::load_for_project(path)
        .map_err(|error| format!("Failed to load recording meta: {error}"))?;

    let RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Err("Cannot edit non-studio recordings".to_string());
    };

    let (segment_count, has_camera, multiple_recording_segments) = match studio.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => (1, segment.camera.is_some(), false),
        StudioRecordingMeta::MultipleSegments { inner } => (
            inner.segments.len(),
            inner.segments.iter().any(|s| s.camera.is_some()),
            inner.segments.len() > 1,
        ),
    };

    // `hasMicrophone` reads `audio` on a single-segment recording and `mic` on
    // a multi-segment one; `hasSystemAudio` is a multi-segment concept only
    // (`ED/context.ts:1776-1783`).
    let (has_microphone, has_system_audio) = match studio.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => (segment.audio.is_some(), false),
        StudioRecordingMeta::MultipleSegments { inner } => {
            inner.segments.first().map_or((false, false), |segment| {
                (segment.mic.is_some(), segment.system_audio.is_some())
            })
        }
    };

    if segment_count == 0 {
        return Err("Recording has no segments. It may need to be recovered first.".to_string());
    }

    // The panicking call, contained. `AssertUnwindSafe` because neither
    // borrow escapes the closure and nothing is left half-mutated by an
    // unwind here -- the value is constructed and dropped inside it.
    let owned_path = path.to_path_buf();
    let recordings = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ProjectRecordingsMeta::new(&owned_path, studio.as_ref())
    }))
    .map_err(|_| {
        "This recording's video tracks could not be opened. The bundle looks damaged.".to_string()
    })?
    .map_err(|error| format!("Failed to read this recording's media: {error}"))?;
    let recordings = Arc::new(recordings);

    // `RecordingMeta::project_config()` loads `project-config.json` (falling
    // back to the default) and overlays `captions.json` -- the same read
    // `EditorInstance::new` starts from, so the timeline shown here is the one
    // that will be rendered.
    let mut config = meta.project_config();
    // With no persisted timeline `EditorInstance::new` synthesises one from
    // the per-segment display durations (`editor_instance.rs:210-230`) and
    // writes it back. Synthesise the same shape here so the strip is not empty
    // for the second or two before the instance exists -- the timeline the
    // instance hands over then replaces it wholesale.
    if config.timeline.is_none() {
        config.timeline = Some(cap_project::TimelineConfiguration {
            segments: recordings
                .segments
                .iter()
                .enumerate()
                .map(|(index, segment)| cap_project::TimelineSegment {
                    recording_clip: index as u32,
                    timescale: 1.0,
                    start: 0.0,
                    end: segment.duration(),
                    name: None,
                    speed_audio_mode: None,
                    audio_muted: false,
                })
                .collect(),
            // `TimelineConfiguration` has no `Default`, so the eight other
            // track vectors are spelled out empty.
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

    let timeline = TimelineModel::build(&config, has_camera, multiple_recording_segments);
    let duration = timeline.total_duration;

    Ok(ProjectSummary {
        recordings: recordings.clone(),
        pretty_name: meta.pretty_name.clone(),
        timeline,
        duration: duration.max(0.0),
        has_camera,
        has_cursor_data: has_recorded_cursor_data(&meta, studio.as_ref()),
        recorded_cursor_family: recorded_cursor_family(studio.as_ref()),
        clip_display_durations: recordings
            .segments
            .iter()
            .map(|segment| segment.display.duration)
            .collect(),
        recording_duration: recordings.duration(),
        multiple_clips: multiple_recording_segments,
        has_microphone,
        has_system_audio,
        mic_channels: recordings
            .segments
            .first()
            .and_then(|segment| segment.mic.as_ref())
            .map(|mic| mic.channels),
        recording_clips: recordings.segments.len(),
    })
}

/// `meta().hasRecordedCursorData` -- any segment with a cursor file on disk.
/// The click half of `generate_zoom_segments_for_project`
/// (`src-tauri/src/recording.rs:3806-3848`): every recorded cursor click, with
/// the same short-lived-shape stabilisation the Tauri command applies.
fn load_recording_clicks(project_path: &std::path::Path) -> Vec<cap_project::CursorClickEvent> {
    let Ok(meta) = RecordingMeta::load_for_project(project_path) else {
        return Vec::new();
    };
    let cap_project::RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Vec::new();
    };
    match &**studio {
        StudioRecordingMeta::SingleSegment { segment } => {
            let Some(cursor) = &segment.cursor else {
                return Vec::new();
            };
            let mut events =
                cap_project::CursorEvents::load_from_file(&meta.path(cursor)).unwrap_or_default();
            let pointer_ids = studio.pointer_cursor_ids();
            events.stabilize_short_lived_cursor_shapes(
                (!pointer_ids.is_empty()).then_some(&pointer_ids),
                cap_project::cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
            );
            events.clicks
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .flat_map(|segment| segment.cursor_events(&meta).clicks)
            .collect(),
    }
}

fn has_recorded_cursor_data(meta: &RecordingMeta, studio: &StudioRecordingMeta) -> bool {
    match studio {
        StudioRecordingMeta::SingleSegment { segment } => segment
            .cursor
            .as_ref()
            .is_some_and(|cursor| meta.path(cursor).exists()),
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.iter().any(|segment| {
            segment
                .cursor
                .as_ref()
                .is_some_and(|cursor| meta.path(cursor).exists())
        }),
    }
}

/// The family the recording's own cursor shapes belong to.
///
/// Keyed by cursor id so the answer does not depend on `HashMap` iteration
/// order: a bundle whose shapes span two families would otherwise pick a
/// different card between two opens of the same recording.
fn recorded_cursor_family(studio: &StudioRecordingMeta) -> Option<CursorFamily> {
    let StudioRecordingMeta::MultipleSegments { inner } = studio else {
        return None;
    };
    let Cursors::Correct(cursors) = &inner.cursors else {
        return None;
    };
    let mut ids: Vec<_> = cursors.keys().collect();
    ids.sort();
    ids.into_iter()
        .find_map(|id| cursors.get(id).and_then(|cursor| cursor.shape))
        .map(|shape| shape.family())
}

/// One rendered frame, lifted into gpui's sprite atlas.
///
/// Two conversions, both mandatory:
///
/// * **un-padding.** `RenderedFrame.data` is `padded_bytes_per_row * height`
///   bytes, where the stride is rounded up to wgpu's 256-byte
///   `COPY_BYTES_PER_ROW_ALIGNMENT` -- 1080x702 arrives as 4352 bytes per row,
///   not 4320. Feeding the padded buffer to `from_raw` gives a sheared image.
/// * **RGBA -> BGRA.** The render target is `Rgba8Unorm`
///   (`frame_pipeline.rs:809-827`) and gpui's atlas expects BGRA, the same
///   swap `library::decode_thumbnail` does after decoding a thumbnail.
pub fn frame_image(frame: &RenderedFrame) -> Option<Arc<RenderImage>> {
    let row_bytes = frame.width as usize * 4;
    let mut tight = Vec::with_capacity(row_bytes * frame.height as usize);
    for row in frame.data.chunks(frame.padded_bytes_per_row as usize) {
        if row.len() < row_bytes {
            return None;
        }
        tight.extend_from_slice(&row[..row_bytes]);
    }
    for pixel in tight.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let buffer = image::RgbaImage::from_raw(frame.width, frame.height, tight)?;
    Some(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(buffer)
    ])))
}

/// The poster: the recording's own first-frame JPEG, decoded to at most the
/// canvas's retina size. `thumbnail` (a box filter) over `resize` because the
/// picture is on screen for well under a second.
fn decode_poster(path: &std::path::Path) -> Option<Arc<RenderImage>> {
    let bytes = std::fs::read(path).ok()?;
    let image = image::load_from_memory(&bytes).ok()?;
    let (width, height) = (image.width().max(1), image.height().max(1));
    let scale = (1920. / width as f32).min(1080. / height as f32).min(1.);
    let mut scaled = if scale < 1. {
        image::imageops::thumbnail(
            &image.into_rgba8(),
            ((width as f32 * scale) as u32).max(1),
            ((height as f32 * scale) as u32).max(1),
        )
    } else {
        image.into_rgba8()
    };
    for pixel in scaled.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(scaled)
    ])))
}

/// What the frame pump hands the window.
#[derive(Clone)]
pub(crate) enum EditorPreviewFrame {
    Image(Arc<RenderImage>),
    #[cfg(target_os = "macos")]
    Surface(CVPixelBuffer),
}

impl EditorPreviewFrame {
    pub(crate) fn paint(&self, bounds: gpui::Bounds<Pixels>, window: &mut Window) {
        match self {
            Self::Image(image) => {
                let _ = window.paint_image(
                    bounds,
                    gpui::Corners::default(),
                    Arc::clone(image),
                    0,
                    false,
                );
            }
            #[cfg(target_os = "macos")]
            Self::Surface(surface) => window.paint_surface(bounds, surface.clone()),
        }
    }
}

struct PreviewFrameView {
    frame: Option<EditorPreviewFrame>,
    frame_size: (f32, f32),
    frame_rect: crate::editor_canvas::CanvasRect,
    stats: Option<Arc<PumpStats>>,
}

impl PreviewFrameView {
    fn new(frame_rect: crate::editor_canvas::CanvasRect) -> Self {
        Self {
            frame: None,
            frame_size: (1920., 1080.),
            frame_rect,
            stats: None,
        }
    }

    fn set_frame(
        &mut self,
        frame: EditorPreviewFrame,
        frame_size: (f32, f32),
        stats: Option<Arc<PumpStats>>,
        cx: &mut Context<Self>,
    ) -> Option<EditorPreviewFrame> {
        self.frame_size = frame_size;
        self.stats = stats;
        let previous = self.frame.replace(frame);
        cx.notify();
        previous
    }
}

impl Render for PreviewFrameView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let Some(frame) = self.frame.clone() else {
            return div().size_full().into_any_element();
        };
        let frame_size = self.frame_size;
        let frame_rect = self.frame_rect.clone();
        let painted = self.stats.clone();

        gpui::canvas(
            |bounds, _window, _cx| bounds,
            move |_, bounds, window, _cx| {
                let container_width: f32 = bounds.size.width.into();
                let container_height: f32 = bounds.size.height.into();
                let (width, height) = letterbox((container_width, container_height), frame_size);
                let fitted = gpui::Bounds {
                    origin: gpui::point(
                        bounds.origin.x + px((container_width - width) / 2.),
                        bounds.origin.y + px((container_height - height) / 2.),
                    ),
                    size: gpui::size(px(width), px(height)),
                };
                frame_rect.set(Some(crate::editor_canvas::PlayerFrame {
                    container: bounds,
                    frame: fitted,
                }));
                window.paint_quad(gpui::fill(fitted, gpui::black()));
                frame.paint(fitted, window);
                if let Some(stats) = &painted {
                    stats.painted.fetch_add(1, Ordering::Relaxed);
                }
            },
        )
        .size_full()
        .into_any_element()
    }
}

#[derive(Clone, Copy)]
enum EditorSection {
    Header,
    Toolbar,
    Transport,
    Sidebar,
    Timeline,
}

struct EditorSectionView {
    editor: WeakEntity<EditorWindow>,
    section: EditorSection,
    _editor_subscription: Subscription,
}

impl EditorSectionView {
    fn new(editor: &Entity<EditorWindow>, section: EditorSection, cx: &mut Context<Self>) -> Self {
        let editor_subscription = cx.observe(editor, |_, _, cx| cx.notify());
        Self {
            editor: editor.downgrade(),
            section,
            _editor_subscription: editor_subscription,
        }
    }
}

impl Render for EditorSectionView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(editor) = self.editor.upgrade() else {
            return div().into_any_element();
        };
        editor.update(cx, |editor, cx| match self.section {
            EditorSection::Header => editor.render_header(window, cx).into_any_element(),
            EditorSection::Toolbar => editor.render_player_toolbar(cx).into_any_element(),
            EditorSection::Transport => editor.render_transport(cx).into_any_element(),
            // The Clips layout mode swaps the config sidebar's column for the
            // clips sidebar; the config sidebar is hidden, not destroyed
            // (`Editor.tsx:728-747`).
            EditorSection::Sidebar => {
                if editor.clips.open {
                    editor.render_clips_sidebar(cx).into_any_element()
                } else {
                    editor.render_sidebar(cx).into_any_element()
                }
            }
            EditorSection::Timeline => {
                let viewport_width: f32 = window.viewport_size().width.into();
                editor
                    .render_timeline(viewport_width, cx)
                    .into_any_element()
            }
        })
    }
}

pub struct EditorFrame {
    pub(crate) frame: EditorPreviewFrame,
    pub layout: FrameLayout,
    /// `RenderedFrame.frame_number` -- which frame this picture actually is.
    /// Logged at debug so a seek can be checked against what it asked for.
    pub number: u32,
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

/// Counters along the frame pump, so a playback run can be *measured* rather
/// than eyeballed. Every stage between the renderer and the screen gets one,
/// because "playback is slow" has four different answers and they need
/// separating:
///
/// * `rendered` -- `frame_cb` invocations, i.e. frames the editor's renderer
///   actually produced. Compare with the engine's own `Playback stats`
///   `total_rendered` to see what the renderer's latest-wins drain discarded.
/// * `dropped` -- frames the pump's bounded channel refused because the UI was
///   behind.
/// * `presented` -- frames that reached [`EditorWindow::frame_arrived`]. This
///   is the frame rate: distinct pictures per second.
/// * `painted` -- *paints* of the preview canvas, not frames. The window also
///   repaints for the clock and the playhead, so this runs ahead of
///   `presented` (~1.65x during playback) and must never be reported as fps.
///   It is here to show the invalidation cost, and because a `painted` that
///   fell *below* `presented` would mean gpui was coalescing frames away.
/// * `convert_nanos` / `convert_samples` -- the cost of [`frame_image`], which
///   is the CPU-vs-zero-copy decision's evidence.
#[derive(Default, Debug)]
pub struct PumpStats {
    pub rendered: AtomicU64,
    pub dropped: AtomicU64,
    pub presented: AtomicU64,
    pub painted: AtomicU64,
    pub convert_nanos: AtomicU64,
    pub convert_samples: AtomicU64,
}

/// A read of every counter at one instant. Deltas between two of these are
/// what a run reports; the counters themselves are cumulative for the window's
/// whole life.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatsSnapshot {
    pub rendered: u64,
    pub dropped: u64,
    pub presented: u64,
    pub painted: u64,
    pub convert_nanos: u64,
    pub convert_samples: u64,
}

impl PumpStats {
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            rendered: self.rendered.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            presented: self.presented.load(Ordering::Relaxed),
            painted: self.painted.load(Ordering::Relaxed),
            convert_nanos: self.convert_nanos.load(Ordering::Relaxed),
            convert_samples: self.convert_samples.load(Ordering::Relaxed),
        }
    }
}

impl StatsSnapshot {
    pub fn since(self, before: StatsSnapshot) -> StatsSnapshot {
        StatsSnapshot {
            rendered: self.rendered.saturating_sub(before.rendered),
            dropped: self.dropped.saturating_sub(before.dropped),
            presented: self.presented.saturating_sub(before.presented),
            painted: self.painted.saturating_sub(before.painted),
            convert_nanos: self.convert_nanos.saturating_sub(before.convert_nanos),
            convert_samples: self.convert_samples.saturating_sub(before.convert_samples),
        }
    }

    /// Average `frame_image` cost, in microseconds.
    pub fn convert_micros(self) -> f64 {
        if self.convert_samples == 0 {
            return 0.0;
        }
        self.convert_nanos as f64 / self.convert_samples as f64 / 1000.0
    }

    /// The one line the perf gate asks for, plus the stage breakdown that says
    /// *where* a shortfall happened.
    ///
    /// `fps` is **delivered** frames per second -- distinct pictures that
    /// reached the window. `paints` is deliberately separate and is *not* a
    /// frame rate: the window also repaints for the playhead and the clock, so
    /// it runs ahead of the frame count and would flatter the number.
    pub fn report(self, seconds: f64) -> String {
        let seconds = seconds.max(0.001);
        format!(
            "playback fps={:.1} frames={} dropped={} (rendered={} rendered_fps={:.1} paints={} \
             convert_avg={:.0}us over {:.2}s)",
            self.presented as f64 / seconds,
            self.presented,
            self.dropped,
            self.rendered,
            self.rendered as f64 / seconds,
            self.painted,
            self.convert_micros(),
            seconds,
        )
    }
}

// ---------------------------------------------------------------------------
// The playhead signal
// ---------------------------------------------------------------------------

/// `on_state_change` is a `Fn + Send + Sync` the instance calls from whichever
/// thread moved the playhead -- the `cap-playback` OS thread during playback,
/// a tokio worker on a seek. It may never touch a gpui `Context`, so it does
/// the only two things that are safe from a foreign thread: store the position
/// and poke a bounded channel.
///
/// The channel holds one token, not one message per event: playhead updates
/// are latest-wins, and at 60 Hz a queue would only ever describe the past.
/// The drain reads the atomic, so no update is ever *lost* -- only coalesced.
pub struct PlayheadSignal {
    position: AtomicU32,
    wake: flume::Sender<()>,
}

impl PlayheadSignal {
    pub fn new() -> (Arc<Self>, flume::Receiver<()>) {
        let (wake, rx) = flume::bounded(1);
        (
            Arc::new(Self {
                position: AtomicU32::new(0),
                wake,
            }),
            rx,
        )
    }

    pub fn position(&self) -> u32 {
        self.position.load(Ordering::Relaxed)
    }
}

/// The `on_state_change` E1 left as `|_state| {}`.
pub fn make_state_callback(
    signal: Arc<PlayheadSignal>,
) -> impl Fn(&EditorState) + Send + Sync + 'static {
    move |state: &EditorState| {
        signal
            .position
            .store(state.playhead_position, Ordering::Relaxed);
        let _ = signal.wake.try_send(());
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// The transport as a *desired state* rather than a command stream.
///
/// Every UI action writes this and pokes the driver; the driver applies the
/// difference between it and what the engine is actually doing. Latest-wins
/// state cannot queue up a backlog of stale positions, which is the property
/// the source built by hand with `beginRulerScrub`'s
/// `seekInFlight`/`seekQueued` (`Timeline/index.tsx:890-909`). Where the
/// source then pays a stop/seek/restart round trip per applied seek
/// (`Timeline/index.tsx:829-853`), the driver seeks the running engine in
/// place (`PlaybackHandle::seek`) and restarts only when the engine is not
/// running.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Desired {
    pub playing: bool,
    /// The frame the *last* seek asked for, with a generation so that seeking
    /// to the frame you are already on still re-applies.
    pub seek: Option<u32>,
    pub seek_gen: u64,
    pub resolution: XY<u32>,
}

impl Default for Desired {
    fn default() -> Self {
        Self {
            playing: false,
            seek: None,
            seek_gen: 0,
            resolution: default_preview_resolution(),
        }
    }
}

/// The UI half. Cheap to clone, safe to call from the main thread: writing it
/// takes an uncontended `Mutex` and a `try_send` on a one-slot channel.
#[derive(Clone)]
pub struct TransportHandle {
    desired: Arc<Mutex<Desired>>,
    wake: flume::Sender<()>,
}

/// The driver half, handed to [`run_transport`] on the tokio runtime.
///
/// `engine_stopped` is the driver's one message back to the window: the
/// engine went away on its own -- end of timeline, warmup abort, error --
/// while the desired state still said playing. The UI answers by running its
/// ordinary pause path, so `Desired` stays written by the UI alone and the
/// driver never mutates it.
pub struct TransportDriver {
    desired: Arc<Mutex<Desired>>,
    wake: flume::Receiver<()>,
    engine_stopped: flume::Sender<()>,
}

pub fn transport() -> (TransportHandle, TransportDriver, flume::Receiver<()>) {
    let desired = Arc::new(Mutex::new(Desired::default()));
    let (tx, rx) = flume::bounded(1);
    let (stopped_tx, stopped_rx) = flume::bounded(1);
    (
        TransportHandle {
            desired: desired.clone(),
            wake: tx,
        },
        TransportDriver {
            desired,
            wake: rx,
            engine_stopped: stopped_tx,
        },
        stopped_rx,
    )
}

impl TransportHandle {
    fn modify(&self, change: impl FnOnce(&mut Desired)) {
        {
            let mut desired = self
                .desired
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            change(&mut desired);
        }
        // A full channel means the driver has not read the previous poke yet,
        // and it will read the *latest* state when it does -- so dropping this
        // one loses nothing.
        let _ = self.wake.try_send(());
    }

    /// `seekTo(frame)` then `startPlayback(FPS, previewResolutionBase())` --
    /// the shape every play in `handlePlayPauseClick` takes
    /// (`Player.tsx:212-233`).
    pub fn set_resolution(&self, resolution: XY<u32>) {
        self.modify(|desired| desired.resolution = resolution);
    }

    pub fn play_from(&self, frame: u32) {
        self.modify(|desired| {
            desired.playing = true;
            desired.seek = Some(frame);
            desired.seek_gen += 1;
        });
    }

    /// `stopPlayback()`: `state.playback_task.take().map(|h| h.stop())`.
    pub fn pause(&self) {
        self.modify(|desired| desired.playing = false);
    }

    /// A paused seek: move `playhead_position` *and* push `preview_tx`, which
    /// is the only thing that produces a picture.
    pub fn seek(&self, frame: u32) {
        self.modify(|desired| {
            desired.seek = Some(frame);
            desired.seek_gen += 1;
        });
    }
}

/// Apply the desired transport state to the instance, forever.
///
/// Runs on the tokio runtime because every call here locks
/// `instance.state` -- `start_playback` also decodes the project's music
/// tracks before it can begin. None of it may happen on the UI thread.
pub async fn run_transport(instance: Arc<EditorInstance>, driver: TransportDriver) {
    let fps = EDITOR_PREVIEW_FPS;
    let mut applied_playing = false;
    let mut applied_gen = 0u64;
    // The engine's own liveness, epoch-guarded inside `EditorInstance` so a
    // deliberate stop/start transition can never masquerade as a death.
    let mut active_rx = instance.playback_watch();
    active_rx.mark_unchanged();

    loop {
        tokio::select! {
            wake = driver.wake.recv_async() => {
                if wake.is_err() {
                    break;
                }
            }
            changed = active_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let active = *active_rx.borrow_and_update();
                // A false while this driver believes it is playing is an
                // engine-initiated stop: the driver marks the engine gone and
                // tells the window, which answers through its ordinary pause
                // path (so `Desired` remains UI-owned). A deliberate stop
                // below flips `applied_playing` first, so it never lands here.
                if !active && applied_playing {
                    tracing::debug!("engine stopped without a pause request");
                    applied_playing = false;
                    let _ = driver.engine_stopped.try_send(());
                }
                continue;
            }
        }

        let want = *driver
            .desired
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let seeking = want.seek_gen != applied_gen;

        // A pause stops the engine outright. A seek no longer does: the
        // engine holds a live-seek input (`PlaybackHandle::seek`), so
        // scrubbing during playback re-anchors the running engine in place
        // instead of paying stop/warmup/audio-attach per tick -- the round
        // trip the source pays in `seekPlayheadTo`
        // (`Timeline/index.tsx:829-853`).
        if applied_playing && !want.playing {
            applied_playing = false;
            let handle = {
                let mut state = instance.state.lock().await;
                state.playback_task.take()
            };
            if let Some(handle) = handle {
                handle.stop();
            }
        }

        if seeking {
            applied_gen = want.seek_gen;
            if let Some(frame) = want.seek {
                if want.playing && applied_playing {
                    if !instance.seek_playback(frame).await {
                        // The engine died between the UI's write and this
                        // apply. Clean up the dead handle and fall through to
                        // the restart below, which begins from this playhead.
                        applied_playing = false;
                        let handle = {
                            let mut state = instance.state.lock().await;
                            state.playback_task.take()
                        };
                        if let Some(handle) = handle {
                            handle.stop();
                        }
                        instance
                            .modify_and_emit_state(|state| state.playhead_position = frame)
                            .await;
                    }
                } else {
                    // `seek_to` (`lib.rs:4230`) -- moves the playhead the next
                    // `start_playback` will begin from, and renders nothing.
                    instance
                        .modify_and_emit_state(|state| state.playhead_position = frame)
                        .await;
                    if !want.playing {
                        // The repaint half, which `seek_to` does not do: the
                        // frontend emits `RenderFrameEvent` and Rust forwards
                        // it into `preview_tx` (`lib.rs:3009-3014,
                        // 6603-6614`).
                        request_frame(&instance, frame, want.resolution);
                    }
                }
            }
        }

        if want.playing && !applied_playing {
            instance.start_playback(fps, want.resolution).await;
            applied_playing = true;
        }
    }
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

enum LoadState {
    /// `<Suspense fallback={<EditorSkeleton/>}>` plus the spinner at
    /// `Editor.tsx:216-217`; here, the same message the skeleton implies.
    Loading,
    Ready(Box<ProjectSummary>),
    /// `EditorErrorScreen` (`Editor.tsx:234-241, 282-289`).
    Failed(String),
}

/// A press or drag on the timeline.
///
/// The two are separate because the source's are: the ruler's own hit surface
/// scrubs continuously from the mousedown onwards (`beginRulerScrub`,
/// `Timeline/index.tsx:873-957`), while a press anywhere else in the timeline
/// seeks **once, on release, to the press position** -- `handleUpdatePlayhead`
/// is registered on mouseup but closes over the mousedown event
/// (`Timeline/index.tsx:1155-1169`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Scrub {
    Ruler,
    Press { time: f64 },
}

/// `PROJECT_SAVE_DEBOUNCE_MS` (`ED/context.ts:185`).
const PROJECT_SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

/// The debounced `project-config.json` write.
///
/// The Tauri editor's `scheduleProjectConfigSave` restarts a 250ms timer on
/// every store change and `flushProjectConfig` serialises the whole config
/// through `commands.setProjectConfig` (`ED/context.ts:1186-1252`), which is
/// `config.write(&project_path)` on the Rust side (`lib.rs:3346-3360`). The
/// pending value lives behind an `Rc<RefCell<..>>` so the close path -- which
/// only ever gets an `&mut App` -- can force it out, the same shape the
/// teleprompter's `onCloseRequested` save uses.
#[derive(Default)]
pub struct PendingProjectSave {
    path: Option<PathBuf>,
    config: Option<ProjectConfiguration>,
}

impl PendingProjectSave {
    /// Drop a scheduled write without performing it -- the reload path after
    /// an import, where the config on disk is newer than the editor's copy.
    pub fn discard(&mut self) {
        self.config = None;
    }

    pub fn flush(&mut self) {
        let (Some(path), Some(config)) = (self.path.clone(), self.config.take()) else {
            return;
        };
        match config.write(&path) {
            Ok(()) => tracing::debug!(path = %path.display(), "project config written"),
            Err(error) => {
                tracing::error!(path = %path.display(), "failed to persist project config: {error}")
            }
        }
    }
}

/// Which edge -- or the whole box -- a live drag is moving.
#[derive(Clone, Copy, Debug, PartialEq)]
enum DragKind {
    /// `SegmentContent`'s drag: the whole segment slides between its
    /// neighbours (`TL/MaskTrack.tsx:445-479`).
    Move {
        start: f64,
        end: f64,
        bounds: DragBounds,
    },
    /// `SegmentHandle position="start"`.
    TrimStart {
        start: f64,
        bounds: DragBounds,
    },
    /// `SegmentHandle position="end"`.
    TrimEnd {
        end: f64,
        bounds: DragBounds,
    },
    /// The clip track's own handles, which move a *recording*-domain edge
    /// scaled by the clip's timescale (`TL/ClipTrack.tsx:1134-1230`).
    ClipTrimStart {
        start: f64,
    },
    ClipTrimEnd {
        end: f64,
    },
    /// `TL/ZoomTrack.tsx:188-295`: a press on bare zoom track, which becomes a
    /// segment either on the first move (dragged to length) or on release
    /// (the default one-`minDuration` box).
    CreateZoom {
        base_start: f64,
        base_end: f64,
        max: f64,
        min_duration: f64,
        created: Option<usize>,
    },
}

/// One live pointer drag on a segment.
///
/// `createMouseDownDrag` (`TL/ZoomTrack.tsx:401-513` and its seven siblings) is
/// the shape: a press arms the drag, the *second* pointer position more than
/// 2px away promotes it to a move, and a release that never promoted is a
/// selection instead. `initialMouseX` is captured at promotion, not at the
/// press, so the first two pixels are a genuine dead zone.
#[derive(Clone, Copy, Debug)]
struct Drag {
    track: TrackKind,
    index: usize,
    kind: DragKind,
    down_x: f32,
    /// `initialMouseX` -- `None` until the drag promotes.
    origin_x: Option<f32>,
    moved: bool,
    /// The promotion threshold in pixels. 2 on every track that goes through
    /// `createMouseDownDrag` (`ZoomTrack.tsx:485`); 0 on the clip's handles,
    /// which bind `update` straight to `mousemove` and measure from the press.
    threshold: f32,
    /// Whether a release without movement selects. The clip's handles do not
    /// (their press never reaches `selectClip`).
    selects_on_click: bool,
    shift: bool,
    multi: bool,
    /// The time the press landed on, for the `handleUpdatePlayhead` a
    /// selection carries with it (`TL/ZoomTrack.tsx:478`).
    press_time: f64,
    /// Whether this drag took `projectHistory.pause()` and owes a resume.
    paused: bool,
}

/// The recording-domain edges a clip handle is dragging, uncommitted.
#[derive(Clone, Copy, Debug)]
struct ClipDraft {
    index: usize,
    start_edge: bool,
    start: f64,
    end: f64,
}

/// One release animation: where every clip box was drawn when the pointer
/// came up, eased toward wherever the committed config puts it.
struct ClipReleaseAnim {
    from: Vec<(f64, f64)>,
    started: Instant,
    generation: u64,
}

pub struct EditorWindow {
    pub(crate) theme: Theme,
    pub(crate) project_path: PathBuf,
    state: LoadState,
    pub(crate) latest_frame: Option<EditorPreviewFrame>,
    /// The bundle's `screenshots/display.jpg`, letterboxed into the canvas
    /// until the first composed frame lands -- decoded in parallel with
    /// `EditorInstance` construction, so the editor opens onto a picture
    /// rather than "Loading project...". The Solid app hides the same wait
    /// behind a skeleton; a poster is the native equivalent with the added
    /// courtesy of showing the recording itself.
    poster: Option<Arc<RenderImage>>,
    preview: Entity<PreviewFrameView>,
    header: Entity<EditorSectionView>,
    toolbar: Entity<EditorSectionView>,
    transport_controls: Entity<EditorSectionView>,
    sidebar_view: Entity<EditorSectionView>,
    timeline_view: Entity<EditorSectionView>,
    pub(crate) frame_layout: Option<FrameLayout>,
    /// Kept alive for the window's lifetime: dropping the last `Arc` is what
    /// tears the decoders down, and `dispose()` on close does it explicitly.
    pub(crate) instance: Option<Arc<EditorInstance>>,
    focus: FocusHandle,

    // -- Transport ----------------------------------------------------------
    /// `editorState.playing`.
    pub(crate) playing: bool,
    /// `editorState.playbackTime`, in seconds.
    playhead: f64,
    last_playhead_redraw: Instant,
    /// Whether the current play epoch has applied at least one engine sample.
    /// Every path that (re)starts the engine clears it -- `start_playback`,
    /// and `seek_to_time` while playing, which is a stop/seek/restart round
    /// trip in the driver -- and the first sample past the epoch's start
    /// frame sets it. Until then the drawn line must not extrapolate, because
    /// `last_playhead_redraw` still dates from the previous epoch. See
    /// [`playhead_extrapolation`].
    playhead_epoch_live: bool,
    /// The frame the current epoch's engine was told to start from. The
    /// driver's own seek echo and the engine's first tick both report exactly
    /// this frame, and neither proves frames are flowing yet -- only a sample
    /// past it arms extrapolation.
    playhead_epoch_start: u32,
    /// `totalDuration()`. Taken from the instance's own timeline once it
    /// exists, because that is the number the playback engine stops at
    /// (`playback.rs:560-570`, `TimelineConfiguration::duration`).
    total: f64,
    transport: Option<TransportHandle>,
    scrub: Option<Scrub>,
    stats: Option<Arc<PumpStats>>,
    /// Wall clock and counters at the moment playback started, so a run can be
    /// reported as a rate.
    play_mark: Option<(Instant, StatsSnapshot)>,

    // -- Timeline -----------------------------------------------------------
    /// Every track the strip draws.
    timeline: TimelineModel,
    /// The viewport, the hover ghost and the hovered track.
    view: TimelineView,
    /// `onMount`'s `checkBounds` runs once, when the timeline first has a
    /// width (`TL/index.tsx:689-703`). There is no mount hook here, so the
    /// first render that knows both the width and the duration does it.
    fitted: bool,
    /// The transport's zoom slider track rect, written by the slider's own
    /// prepaint canvas and read by the pointer maths.
    zoom_slider_track: ui::SliderTrack,
    /// A live drag on the zoom slider. Window-wide, the camera bubble's
    /// root-handler pattern -- a slider drag that leaves its 96px row keeps
    /// tracking.
    zoom_slider_drag: bool,

    // -- Editing (E4) --------------------------------------------------------
    /// The live project. Every edit mutates this, the watch channel carries it
    /// to the renderer, and the debounced save writes it. Seeded from the
    /// instance's own config once it exists -- `EditorInstance::new`
    /// synthesises a timeline for a raw bundle, so the pre-flight's is not the
    /// one being rendered.
    pub(crate) project: ProjectConfiguration,
    /// `projectHistory` (`ED/context.ts:1724`).
    pub(crate) history: ProjectHistory,
    /// `editorState.timeline.selection`.
    pub(crate) selection: Option<Selection>,
    /// `editorState.timeline.interactMode === "split"`.
    split_mode: bool,
    /// `editorState.timeline.splitPreview` -- `(time, snapped)`.
    split_preview: Option<(f64, bool)>,
    /// The segment under the pointer: `(track, lane, index)`. This is the
    /// `group-hover` the trim handles' reveal hangs off.
    hovered_segment: Option<(TrackKind, u32, usize)>,
    /// The gutter chip under the pointer, which is what reveals the red
    /// per-track delete button (`TL/index.tsx:1516-1546`, `group/icon`).
    hovered_gutter: Option<(TrackKind, u32)>,
    /// The live segment drag, if any.
    drag: Option<Drag>,
    /// Generation guard for the 60Hz playback redraw ticker.
    playback_tick: u64,
    /// `isGeneratingAutoZoom` / `sessionDismissedGenerateZoomPrompt`
    /// (`TL/ZoomTrack.tsx:60-65`).
    generating_auto_zoom: bool,
    zoom_prompt_dismissed: bool,
    hovering_generate_zoom: bool,
    clip_speed: Option<ClipSpeedMenu>,
    timeline_scroll: gpui::ScrollHandle,
    /// Magnetic edges for the live drag: playhead, clip cuts and every other
    /// segment's edges, gathered once when the drag arms.
    drag_snap_targets: Vec<f64>,
    /// The target the drag is currently snapped onto, for the guide line.
    drag_snap_time: Option<f64>,
    /// Blip-style ghost trim: while a clip handle drags, only this draft
    /// moves -- the config is untouched until release, so nothing downstream
    /// shuffles mid-drag and nothing rebuilds or publishes per pointer move.
    clip_draft: Option<ClipDraft>,
    /// The release animation gliding the clip boxes from the ghost layout to
    /// the committed one.
    clip_anim: Option<ClipReleaseAnim>,
    clip_anim_generation: u64,
    /// `editorInstance.recordings.segments[i].display.duration`, which the clip
    /// trim clamps read (`TL/ClipTrack.tsx:1160-1162`).
    clip_display_durations: Vec<f64>,
    /// `editorInstance.recordingDuration` = `recordings.duration()`.
    recording_duration: f64,
    /// `meta().hasCamera` and "more than one recording clip", the two facts
    /// outside the config that [`TimelineModel::build`] needs. Kept so the
    /// model can be rebuilt after every edit.
    has_camera: bool,
    multiple_clips: bool,
    /// `ProjectSummary::recorded_cursor_family`, kept here because the cursor
    /// tab renders long before (and independently of) the load state's box.
    pub(crate) recorded_cursor_family: Option<CursorFamily>,
    /// The debounced `project-config.json` write, and the task driving it.
    pending_save: Rc<RefCell<PendingProjectSave>>,
    save_task: Option<gpui::Task<()>>,

    // -- Text fields (E5.5) ---------------------------------------------------
    /// `NameEditor` (`Header.tsx:276-330`). The value lives in
    /// `recording-meta.json`, not in `project-config.json`, so it is committed
    /// through `RecordingMeta::save_for_project` rather than through the
    /// project's own debounced write -- and, exactly as in the Tauri app, it is
    /// therefore not part of the project undo history.
    pub(crate) name_input: Entity<ui::TextInputState>,
    /// One hex field per `RgbInput` / `HexColorInput` the sidebar can show.
    /// The background tab's four exist up front; the tabs' and panels' are
    /// created on the first frame that draws them, because `TextInputState`
    /// needs a `&mut Window` and the sidebar renders from `&self`.
    pub(crate) hex_inputs: HashMap<crate::editor_sidebar::ColorTarget, Entity<ui::TextInputState>>,
    /// The colour picker popover's own hex field. One entity for the window:
    /// the popover edits one colour at a time, and its commits route through
    /// whatever `sidebar.color_target` is current.
    pub(crate) picker_hex: Entity<ui::TextInputState>,
    /// The preset create/rename dialogs' name field, shared between the two.
    preset_name_input: Entity<ui::TextInputState>,
    /// Every other text field the sidebar can show -- segment content, names,
    /// numeric boxes -- same lazy story, keyed by what it edits.
    pub(crate) fields: HashMap<crate::editor_panels::FieldKey, Entity<ui::TextInputState>>,
    /// Whether a field is currently holding a `history.pause()`, and which.
    pub(crate) field_editing: Option<crate::editor_panels::FieldKey>,
    _text_events: Vec<gpui::Subscription>,

    // -- Config sidebar (E5a) -------------------------------------------------
    /// The sidebar's own state: the tab, the background source panel, the
    /// collapsibles, the live slider drag and the colour panel. Everything it
    /// *writes* lives in `project` like every other edit.
    pub(crate) sidebar: crate::editor_sidebar::SidebarState,
    /// `generalSettings.data?.custom_cursor_capture2` -- the one shared-store
    /// setting the sidebar reads (`ConfigSidebar.tsx:5633, 6008`). The source
    /// resolves it through a `createResource` and never refetches inside the
    /// editor, so one read at open is the same behaviour.
    pub(crate) cursor_capture: bool,

    // -- Crop mode (E6) -------------------------------------------------------
    /// The open crop dialog, if any. `None` is `dialog().type !== "crop"`.
    pub(crate) crop: Option<crate::editor_crop::CropState>,
    /// `snapToRatio`, a `makePersisted` signal defaulting to `true`
    /// (`Editor.tsx:1143-1146`). It lives on the window rather than in the
    /// dialog so it survives a close, which is the closest thing to the
    /// source's `localStorage` this app has -- see the README deviation.
    pub(crate) crop_snap_to_ratio: bool,
    /// The crop box's painted rect, written from its own prepaint canvas and
    /// read by the pointer maths -- gpui has no `getBoundingClientRect`.
    pub(crate) crop_area_rect: ui::SliderTrack,

    // -- The canvas display drag (E6) -----------------------------------------
    /// The letterboxed frame rect the preview canvas last painted.
    pub(crate) player_frame_rect: crate::editor_canvas::CanvasRect,
    /// `editorState.canvasSelection`.
    pub(crate) canvas_selection: Option<crate::editor_canvas::CanvasSelection>,
    /// `hovered` on `ElementBox` (`CanvasElementsOverlay.tsx:790`).
    pub(crate) hovered_canvas: Option<crate::editor_canvas::CanvasSelection>,
    /// The live display/camera drag.
    pub(crate) canvas_drag: Option<crate::editor_canvas::CanvasDrag>,
    /// `dragRects().display` -- the optimistic rect that follows the pointer
    /// at input rate while the rendered frame catches up.
    pub(crate) canvas_drag_rect: Option<crate::editor_canvas::NormRect>,
    /// `dragRects().camera`.
    pub(crate) canvas_drag_camera_rect: Option<crate::editor_canvas::NormRect>,
    pub(crate) canvas_overlay_rect: Option<crate::editor_canvas::NormRect>,
    /// `snapGuides()`.
    pub(crate) snap_guides: Vec<crate::editor_canvas::SnapGuide>,

    preview_quality: crate::store::EditorPreviewQuality,
    pub(crate) tracks: TrackLanes,
    toolbar_menu: Option<OpenToolbarMenu>,
    frame_controls: frame::FrameControls,
    add_track: Option<AddTrackMenu>,
    pub(crate) audio_picker: Option<crate::editor_audio::AudioPicker>,
    pub(crate) camera3d_setup: Option<Camera3DSetup>,
    timeline_height: f32,
    timeline_resize: Option<(f32, f32)>,
    /// The header's Presets dropdown (`PresetsDropdown.tsx`), and whichever
    /// of its three dialogs is up. The dialog closes the menu when it opens,
    /// exactly as the Solid dialogs replace the dropdown.
    presets_menu: Option<PresetsMenu>,
    preset_dialog: Option<PresetDialog>,
    /// The last caption-projection signature -- clip list, transitions, text
    /// holds and the caption source master -- so `project_changed` only
    /// re-derives `timeline.captionSegments` when one of those moved, the
    /// same inputs the Solid effect keys on (`ED/context.ts:1630-1661`).
    caption_track_sig: Option<u64>,
    pub(crate) export: Option<ExportUi>,
    /// The Clips layout mode (`ClipsSidebar.tsx`): while open, the config
    /// sidebar's column draws the clips sidebar instead.
    pub(crate) clips: crate::editor_clips::ClipsState,
}

struct PresetsMenu {
    origin: gpui::Point<Pixels>,
    store: crate::presets::PresetsStore,
    /// An open per-preset submenu: which row, and where it was summoned.
    submenu: Option<(usize, gpui::Point<Pixels>)>,
    scroll: gpui::ScrollHandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PresetDialog {
    Create { default: bool },
    Rename { index: usize },
    Delete { index: usize },
}

/// The add-track popover's geometry, computed once when it opens. Anchored to
/// the trigger's top-left with an 8px gutter (Kobalte `placement:
/// "bottom-start"` flipped upward), growing up and capped so it never leaves
/// the viewport -- `fitViewport` -- with the list scrolling instead
/// (`TrackManager.tsx:166-209`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct AddTrackMenu {
    left: Pixels,
    /// Distance from the window's bottom edge to the popover's bottom edge.
    bottom: Pixels,
    max_height: Pixels,
}

#[derive(Clone, Copy)]
struct ClipSpeedMenu {
    index: usize,
    origin: Point<Pixels>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolbarMenu {
    AspectRatio,
    PreviewQuality,
}

struct OpenToolbarMenu {
    kind: ToolbarMenu,
    state: ui::MenuState,
}

impl EditorWindow {
    pub fn new(project_path: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        // `CapWindowId::Editor`'s `Destroyed` arm drops the window from
        // `EditorWindowIds`, disposes the instance and calls
        // `restore_main_windows_if_no_editors` (`lib.rs:5777-5792`). Deferred
        // out of the callback -- it fires with the App borrowed.
        let path = project_path.clone();
        window.on_window_should_close(cx, move |_window, cx| {
            let path = path.clone();
            cx.defer(move |cx| crate::app_windows::editor_closed(&path, cx));
            true
        });

        // Decode the poster off-thread immediately: it races EditorInstance
        // construction and reliably wins, so the first paint has a picture.
        let poster_path = project_path.join("screenshots").join("display.jpg");
        cx.spawn_in(window, async move |this, cx| {
            let Some(poster) = cx
                .background_executor()
                .spawn(async move { decode_poster(&poster_path) })
                .await
            else {
                return;
            };
            this.update(cx, |this, cx| {
                if this.latest_frame.is_none() {
                    this.poster = Some(poster);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();

        let name_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let hex_targets = [
            crate::editor_sidebar::ColorTarget::BackgroundColor,
            crate::editor_sidebar::ColorTarget::GradientFrom,
            crate::editor_sidebar::ColorTarget::GradientTo,
            crate::editor_sidebar::ColorTarget::BorderColor,
        ];
        let hex_inputs: HashMap<_, _> = hex_targets
            .iter()
            .map(|target| {
                (
                    *target,
                    cx.new(|cx| ui::TextInputState::single_line(window, cx)),
                )
            })
            .collect();
        let mut text_events = vec![cx.subscribe_in(
            &name_input,
            window,
            |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                this.on_name_event(event, window, cx)
            },
        )];
        for (target, input) in &hex_inputs {
            let target = *target;
            text_events.push(cx.subscribe_in(
                input,
                window,
                move |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                    this.on_hex_event(target, event, window, cx)
                },
            ));
        }
        let picker_hex = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        text_events.push(cx.subscribe_in(
            &picker_hex,
            window,
            |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                this.on_picker_hex_event(event, window, cx)
            },
        ));
        let preset_name_input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("Preset name");
            input
        });
        text_events.push(cx.subscribe_in(
            &preset_name_input,
            window,
            |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| match event {
                ui::TextInputEvent::Confirmed => this.commit_preset_dialog(window, cx),
                ui::TextInputEvent::Cancelled => {
                    this.preset_dialog = None;
                    cx.notify();
                }
                _ => {}
            },
        ));
        let player_frame_rect = crate::editor_canvas::canvas_rect_cell();
        let preview = cx.new(|_| PreviewFrameView::new(player_frame_rect.clone()));
        let editor = cx.entity();
        let header = cx.new({
            let editor = editor.clone();
            move |cx| EditorSectionView::new(&editor, EditorSection::Header, cx)
        });
        let toolbar = cx.new({
            let editor = editor.clone();
            move |cx| EditorSectionView::new(&editor, EditorSection::Toolbar, cx)
        });
        let transport_controls = cx.new({
            let editor = editor.clone();
            move |cx| EditorSectionView::new(&editor, EditorSection::Transport, cx)
        });
        let sidebar_view = cx.new({
            let editor = editor.clone();
            move |cx| EditorSectionView::new(&editor, EditorSection::Sidebar, cx)
        });
        let timeline_view =
            cx.new(move |cx| EditorSectionView::new(&editor, EditorSection::Timeline, cx));

        Self {
            // No material and no transparency: `applyMacOSWindowMaterial` runs
            // in the `(window-chrome)` layout and `/editor` is not one of its
            // routes, and `is_transparent()` (`windows.rs:1069-1082`) does not
            // list Editor. The root paints `bg-gray-2 dark:bg-gray-1`.
            theme: Theme::for_window(window, cx, false),
            project_path,
            state: LoadState::Loading,
            latest_frame: None,
            preview,
            header,
            toolbar,
            transport_controls,
            sidebar_view,
            timeline_view,
            frame_layout: None,
            instance: None,
            focus: cx.focus_handle(),
            playing: false,
            playhead: 0.0,
            last_playhead_redraw: Instant::now().checked_sub(Duration::from_secs(1)).unwrap(),
            playhead_epoch_live: false,
            playhead_epoch_start: 0,
            total: 0.0,
            transport: None,
            scrub: None,
            stats: None,
            play_mark: None,
            timeline: TimelineModel::default(),
            view: TimelineView::default(),
            fitted: false,
            zoom_slider_track: ui::SliderTrack::default(),
            zoom_slider_drag: false,
            project: ProjectConfiguration::default(),
            history: ProjectHistory::new(ProjectConfiguration::default()),
            selection: None,
            split_mode: false,
            split_preview: None,
            hovered_segment: None,
            hovered_gutter: None,
            drag: None,
            playback_tick: 0,
            generating_auto_zoom: false,
            zoom_prompt_dismissed: false,
            hovering_generate_zoom: false,
            clip_speed: None,
            timeline_scroll: gpui::ScrollHandle::new(),
            drag_snap_targets: Vec::new(),
            drag_snap_time: None,
            clip_draft: None,
            clip_anim: None,
            clip_anim_generation: 0,
            clip_display_durations: Vec::new(),
            recording_duration: 0.0,
            has_camera: false,
            multiple_clips: false,
            recorded_cursor_family: None,
            pending_save: Rc::new(RefCell::new(PendingProjectSave::default())),
            save_task: None,
            name_input,
            hex_inputs,
            picker_hex,
            preset_name_input,
            fields: HashMap::new(),
            field_editing: None,
            _text_events: text_events,
            sidebar: crate::editor_sidebar::SidebarState::new(&ProjectConfiguration::default()),
            cursor_capture: crate::store::GeneralSettings::load().custom_cursor_capture,
            crop: None,
            crop_snap_to_ratio: true,
            crop_area_rect: ui::SliderTrack::default(),
            player_frame_rect,
            canvas_selection: None,
            hovered_canvas: None,
            canvas_drag: None,
            canvas_drag_rect: None,
            canvas_drag_camera_rect: None,
            canvas_overlay_rect: None,
            snap_guides: Vec::new(),
            preview_quality: crate::store::GeneralSettings::load().editor_preview_quality,
            tracks: TrackLanes::from_project(&ProjectConfiguration::default(), false),
            toolbar_menu: None,
            frame_controls: frame::FrameControls::default(),
            add_track: None,
            audio_picker: None,
            camera3d_setup: None,
            timeline_height: DEFAULT_TIMELINE_HEIGHT,
            timeline_resize: None,
            presets_menu: None,
            preset_dialog: None,
            caption_track_sig: None,
            poster: None,
            export: None,
            clips: crate::editor_clips::ClipsState::default(),
        }
    }

    /// `frameNumberToRender`'s time: `previewTime ?? playbackTime`
    /// (`Editor.tsx:515-519`), floored at zero.
    pub(crate) fn preview_or_playhead(&self) -> f64 {
        self.view.preview_time.unwrap_or(self.playhead).max(0.0)
    }

    pub(crate) fn preview_resolution(&self) -> XY<u32> {
        preview_resolution(self.preview_quality)
    }

    /// The transport's own play toggle, reachable from the crop dialog's open
    /// path (which stops playback first).
    pub(crate) fn toggle_play_from_crop(&mut self, cx: &mut Context<Self>) {
        self.stop_playback(cx);
    }

    /// Hand the close path the pending write, so a `.cap` closed inside the
    /// 250ms debounce still lands on disk -- `onCleanup(() => { ...
    /// flushProjectConfig() })` (`ED/context.ts:1246-1252`).
    pub fn pending_save(&self) -> Rc<RefCell<PendingProjectSave>> {
        self.pending_save.clone()
    }

    /// Every lazily-created field's subscription lives here for the window's
    /// lifetime; dropping one would stop the field reporting.
    pub(crate) fn push_text_subscription(&mut self, subscription: gpui::Subscription) {
        self._text_events.push(subscription);
    }

    /// Where focus goes when a menu opens or a field commits: the root, so the
    /// window's own key handling (and the menu's arrows) resume.
    pub(crate) fn focus_handle_for_menu(&self) -> FocusHandle {
        self.focus.clone()
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    pub fn set_summary(
        &mut self,
        summary: ProjectSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.timeline = summary.timeline.clone();
        self.clip_display_durations = summary.clip_display_durations.clone();
        self.recording_duration = summary.recording_duration;
        self.has_camera = summary.has_camera;
        self.multiple_clips = summary.multiple_clips;
        self.recorded_cursor_family = summary.recorded_cursor_family;
        self.pending_save.borrow_mut().path = Some(self.project_path.clone());
        // `zoom: zoomOutLimit()` is the store's *initial* value
        // (`ED/context.ts:1455`), so it is set the moment a duration exists --
        // the on-mount 80px fit then narrows it on the first render that knows
        // the timeline's width.
        self.view.transform = Transform::initial(summary.duration);
        self.name_input.update(cx, |input, cx| {
            input.set_text(summary.pretty_name.clone(), cx)
        });
        self.state = LoadState::Ready(Box::new(summary));
        cx.notify();
        window.refresh();
    }

    /// The project `EditorInstance::new` actually loaded, which may differ from
    /// the pre-flight's: the constructor synthesises a timeline and clip
    /// offsets for a raw bundle and writes them back
    /// (`editor_instance.rs:227, 263`). This is the config every edit mutates
    /// from here on, and the first entry on the undo stack.
    pub fn set_project(
        &mut self,
        config: ProjectConfiguration,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.project = config;
        self.history = ProjectHistory::new(self.project.clone());
        self.tracks = TrackLanes::from_project(&self.project, self.has_camera);
        self.rebuild_timeline();
        // The sidebar's own signals are seeded from the config the instance
        // actually loaded, not the pre-flight's: `backgroundSourceTab`'s
        // initial value reads `background.padding`/`rounding` (`CS:1799-1802`).
        self.flush_animated_gradient_selection();
        self.sidebar = crate::editor_sidebar::SidebarState::new(&self.project);
        self.sidebar_loaded(window, cx);
        cx.notify();
        window.refresh();
    }

    /// Re-derive the drawn model from the live config. Runs after every edit;
    /// the waveforms arrive separately and later, so whatever has landed is
    /// carried across.
    fn rebuild_timeline(&mut self) {
        let mic = std::mem::take(&mut self.timeline.mic_waveforms);
        let system = std::mem::take(&mut self.timeline.system_waveforms);
        self.timeline = TimelineModel::build_with_lanes(
            &self.project,
            self.has_camera,
            self.multiple_clips,
            &self.tracks,
        );
        self.timeline.mic_waveforms = mic;
        self.timeline.system_waveforms = system;
        self.timeline.camera3d_setup_ghosts = self.camera3d_setup_preview();
        if self.timeline.total_duration > 0.0 {
            self.total = self.timeline.total_duration;
        }
    }

    /// `getMicWaveforms()` / `getSystemAudioWaveforms()` resolving
    /// (`ED/context.ts:1526-1539`). Plain state, not a resource: the decode
    /// runs in the background after the editor opens, so the waveform simply
    /// appears once it lands and the editor never falls back to a skeleton.
    pub fn set_waveforms(
        &mut self,
        mic: Vec<std::sync::Arc<Vec<f32>>>,
        system: Vec<std::sync::Arc<Vec<f32>>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.timeline.mic_waveforms = mic;
        self.timeline.system_waveforms = system;
        cx.notify();
        window.refresh();
    }

    // -- Editing: the write path ---------------------------------------------

    /// Every mutation goes through here.
    ///
    /// The Tauri editor's writes fan out three ways from one store change, and
    /// so do these:
    ///
    /// * **the undo stack** -- the tracked memo snapshots the store
    ///   (`ED/context.ts:1921-1929`), suppressed while a drag holds the pause;
    /// * **the renderer** -- `updateProjectConfigInMemory(config, frame, fps,
    ///   base)` (`Editor.tsx:536-541`) pushes the config into
    ///   `editor_instance.project_config` *and* re-renders the current frame
    ///   through `preview_tx`, which is what makes an edit visible
    ///   immediately;
    /// * **the disk** -- `scheduleProjectConfigSave`'s 250ms debounce
    ///   (`ED/context.ts:1235-1244`), so a drag writes once rather than sixty
    ///   times.
    fn edit(
        &mut self,
        change: impl FnOnce(&mut TimelineConfiguration) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(timeline) = self.project.timeline.as_mut() else {
            return false;
        };
        if !change(timeline) {
            return false;
        }
        self.project_changed(window, cx);
        true
    }

    /// One line per *committed* edit, at `info`, for the same reason
    /// `note_transform` exists: a drag's arithmetic is only checkable end to
    /// end if the numbers come out of the running app. Intermediate drag
    /// frames log at `debug`; the line below is the settled one.
    fn note_edit(&self, reason: &'static str, track: Option<TrackKind>) {
        let timeline = self.project.timeline.as_ref();
        // The affected track's boxes, four decimals, so a scripted drag's
        // predicted seconds can be checked against what actually landed.
        let bounds = track.map(|track| {
            if track == TrackKind::Clip {
                timeline.map_or_else(String::new, |timeline| {
                    timeline
                        .segments
                        .iter()
                        .map(|segment| format!("{:.4}..{:.4}", segment.start, segment.end))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
            } else {
                self.timeline
                    .segments(track)
                    .iter()
                    .map(|segment| format!("{:.4}..{:.4}", segment.start, segment.end))
                    .collect::<Vec<_>>()
                    .join(" ")
            }
        });
        tracing::info!(
            reason,
            track = ?track,
            bounds,
            clips = timeline.map_or(0, |timeline| timeline.segments.len()),
            zoom = timeline.map_or(0, |timeline| timeline.zoom_segments.len()),
            total = format!("{:.4}", self.timeline.total_duration),
            selection = ?self.selection.as_ref().map(|selection| (selection.track, selection.indices.clone())),
            undo = self.history.can_undo(),
            redo = self.history.can_redo(),
            "timeline edit"
        );
    }

    pub(crate) fn project_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Before `history.record`, so the re-projected caption track is part
        // of the same undo entry as the edit that moved it.
        self.rederive_caption_track();
        self.history.record(&self.project);
        self.rebuild_timeline();
        self.publish_project();
        self.schedule_save(window, cx);
        cx.notify();
        window.refresh();
    }

    pub(crate) fn project_changed_live(&mut self, cx: &mut Context<Self>) {
        self.publish_project();
        cx.notify();
    }

    /// The Solid effect at `ED/context.ts:1630-1704`: whenever the clip list,
    /// transitions, text holds or the caption source master move, re-project
    /// `timeline.captionSegments` through the edit list so captions follow
    /// trims, deletes, reorders and inserts with no re-transcription.
    fn rederive_caption_track(&mut self) {
        let Some(sig) = self.caption_projection_signature() else {
            self.caption_track_sig = None;
            return;
        };
        if self.caption_track_sig == Some(sig) {
            return;
        }
        self.caption_track_sig = Some(sig);
        let Some(summary) = self.summary() else {
            return;
        };
        let durations = summary.clip_display_durations.clone();
        let Some(captions) = self.project.captions.as_ref() else {
            return;
        };
        let segments = captions.segments.clone();
        if let Some(timeline) = self.project.timeline.as_mut() {
            timeline.caption_segments = crate::transcription::derive_caption_track_segments(
                &segments, timeline, &durations,
            );
        }
    }

    /// The effect's dependency signature (`ED/context.ts:1632-1661`): caption
    /// sources, clip segments, transitions and hold windows. `None` when
    /// there is nothing to project -- no captions, legacy non-source-timed
    /// data, or no timeline.
    fn caption_projection_signature(&self) -> Option<u64> {
        use std::hash::{Hash, Hasher};

        let captions = self.project.captions.as_ref()?;
        if !captions.source_timed || captions.segments.is_empty() {
            return None;
        }
        let timeline = self.project.timeline.as_ref()?;

        let mut hasher = std::hash::DefaultHasher::new();
        for segment in &captions.segments {
            segment.id.hash(&mut hasher);
            segment.start.to_bits().hash(&mut hasher);
            segment.end.to_bits().hash(&mut hasher);
            segment.text.hash(&mut hasher);
            for word in &segment.words {
                word.text.hash(&mut hasher);
                word.start.to_bits().hash(&mut hasher);
                word.end.to_bits().hash(&mut hasher);
            }
        }
        for segment in &timeline.segments {
            segment.start.to_bits().hash(&mut hasher);
            segment.end.to_bits().hash(&mut hasher);
            segment.timescale.to_bits().hash(&mut hasher);
            segment.recording_clip.hash(&mut hasher);
        }
        for transition in &timeline.transitions {
            transition.segment_index.hash(&mut hasher);
            format!("{:?}", transition.kind).hash(&mut hasher);
            transition.duration.to_bits().hash(&mut hasher);
        }
        for (start, end) in timeline.hold_windows() {
            start.to_bits().hash(&mut hasher);
            end.to_bits().hash(&mut hasher);
        }
        Some(hasher.finish())
    }

    /// The renderer half. `frameNumberToRender` is `previewTime ??
    /// playbackTime` (`Editor.tsx:515-519`), floored into a frame number, and
    /// the re-render is skipped while playing exactly as `emitRenderFrame`'s
    /// `if (!editorState.playing)` gate does (`:493`).
    pub(crate) fn publish_project(&self) {
        let Some(instance) = &self.instance else {
            return;
        };
        instance.project_config.0.send(self.project.clone()).ok();
        if !self.playing {
            let time = self.view.preview_time.unwrap_or(self.playhead).max(0.0);
            request_frame(
                instance,
                (time * EDITOR_PREVIEW_FPS as f64).floor() as u32,
                self.preview_resolution(),
            );
        }
    }

    /// The disk half: restart the 250ms timer, then write on the background
    /// executor. A later edit drops this task, which is `clearTimeout` plus a
    /// fresh `setTimeout`.
    pub(crate) fn schedule_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pending_save.borrow_mut().config = Some(self.project.clone());
        let pending = self.pending_save.clone();
        self.save_task = Some(cx.spawn_in(window, async move |_, cx| {
            cx.background_executor().timer(PROJECT_SAVE_DEBOUNCE).await;
            pending.borrow_mut().flush();
        }));
    }

    // -- Editing: undo and redo ----------------------------------------------

    /// `projectHistory.undo()` -- reconcile the previous snapshot back over the
    /// store. The playhead is not moved and the selection is not restored;
    /// neither is in the snapshot (`editorState` is a separate store).
    fn undo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(config) = self.history.undo().cloned() else {
            return;
        };
        self.apply_history(config, window, cx);
        self.note_edit("undo", None);
    }

    fn redo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(config) = self.history.redo().cloned() else {
            return;
        };
        self.apply_history(config, window, cx);
        self.note_edit("redo", None);
    }

    /// The `ignoreNext` half of `move()`: applying a history entry must not
    /// push a new one, so this deliberately skips `history.record`.
    fn apply_history(
        &mut self,
        config: ProjectConfiguration,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let previous_animated_gradient = self.animated_gradient_config().cloned();
        let animated_background_changed = self.animated_gradient_config()
            != match &config.background.source {
                cap_project::BackgroundSource::AnimatedGradient { config } => Some(config),
                _ => None,
            }
            || crate::editor_sidebar::is_none_background(&self.project)
                != crate::editor_sidebar::is_none_background(&config);
        self.project = config;
        self.rebuild_timeline();
        if self.animated_gradient_config().is_some() {
            self.sidebar.source_tab = crate::editor_sidebar::initial_source_tab(&self.project);
        } else {
            self.sync_background_source_tab();
        }
        self.publish_project();
        self.schedule_save(window, cx);
        if animated_background_changed {
            self.remember_animated_gradient_selection(previous_animated_gradient, window, cx);
        }
        // A segment the undo removed must not stay selected.
        if let Some(selection) = &self.selection
            && let Some(timeline) = self.project.timeline.as_ref()
        {
            let count = edits::segment_count(timeline, selection.track);
            if selection.indices.iter().any(|index| *index >= count) {
                self.selection = None;
            }
        }
        cx.notify();
        window.refresh();
    }

    pub fn set_error(&mut self, message: String, window: &mut Window, cx: &mut Context<Self>) {
        tracing::error!(path = %self.project_path.display(), "editor project failed to open: {message}");
        self.state = LoadState::Failed(message);
        cx.notify();
        window.refresh();
    }

    // The two seams the config-sidebar unit reads. Unused here by design: this
    // unit owns the selection, the next one routes on it.
    #[allow(dead_code)]
    /// The timeline selection, for the config sidebar's context-sensitive
    /// panels. `editorState.timeline.selection` is what `ConfigSidebar` reads
    /// to decide whether it is showing the project's settings or a selected
    /// segment's, and the sidebar unit reads it from here.
    pub fn selection(&self) -> Option<&Selection> {
        self.selection.as_ref()
    }

    #[allow(dead_code)]
    /// The live project config, for the units that render from it (the config
    /// sidebar's controls) or serialise it (export).
    pub fn project(&self) -> &ProjectConfiguration {
        &self.project
    }

    pub fn set_instance(&mut self, instance: Arc<EditorInstance>) {
        self.instance = Some(instance);
    }

    pub fn take_instance(&mut self) -> Option<Arc<EditorInstance>> {
        self.instance.take()
    }

    /// Hand the window its transport, the pump's counters, and the duration
    /// the engine will actually stop at.
    pub fn set_transport(
        &mut self,
        transport: TransportHandle,
        stats: Arc<PumpStats>,
        total: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        transport.set_resolution(self.preview_resolution());
        self.transport = Some(transport);
        self.stats = Some(stats);
        if total > 0.0 {
            self.total = total;
        }
        if let Some(instance) = &self.instance {
            request_frame(instance, 0, self.preview_resolution());
        }
        cx.notify();
        window.refresh();
    }

    // -- Transport -----------------------------------------------------------

    /// `isAtEnd()` (`Player.tsx:156-159`): `total > 0 && total - playbackTime
    /// <= 0.1`.
    fn is_at_end(&self) -> bool {
        is_at_end(self.total, self.playhead)
    }

    pub(crate) fn total_duration(&self) -> f64 {
        if self.total > 0.0 {
            self.total
        } else {
            self.summary().map_or(0.0, |summary| summary.duration)
        }
    }

    /// A playhead position off `on_state_change`, drained on the main thread.
    ///
    /// This is the whole live-playhead path: the engine emits
    /// `PlaybackEvent::Frame(n)`, `EditorInstance` turns it into
    /// `modify_and_emit_state(|s| s.playhead_position = n)`
    /// (`editor_instance.rs:476-482`), and the frontend's equivalent of this
    /// is `setEditorState("playbackTime", payload.playhead_position / FPS)`
    /// (`Editor.tsx:482-486`).
    pub fn playhead_changed(&mut self, frame: u32, window: &mut Window, cx: &mut Context<Self>) {
        let next = frame as f64 / EDITOR_PREVIEW_FPS as f64;
        if (next - self.playhead).abs() < f64::EPSILON {
            return;
        }
        self.playhead = next;
        self.view.playhead = next;
        self.view.playing = self.playing;
        if self.playing && frame != self.playhead_epoch_start {
            // The first sample past the epoch's start frame is what proves
            // the engine is live. Samples *at* the start frame are the play
            // command's own seek echo and the engine's first tick -- both can
            // arrive long before frames actually flow, and anchoring the
            // extrapolation on them would re-create the jump.
            self.playhead_epoch_live = true;
        }

        // `createEffect(() => { if (isAtEnd() && editorState.playing) {
        // commands.stopPlayback(); setEditorState("playing", false); } })`
        // (`Player.tsx:205-210`). The playhead is *not* rewound -- it stays at
        // the end, which is what makes the button show Play again and the next
        // press restart from 0.
        if self.playing && self.is_at_end() {
            self.stop_playback(cx);
        }

        self.last_playhead_redraw = Instant::now();
        self.invalidate_playback_chrome(window, cx);
    }

    /// The pause half of `handlePlayPauseClick`, also used by the end-of-media
    /// effect, by prev/next, and by the clips sidebar's import path
    /// (`ClipsSidebar.tsx:508-511`).
    pub(crate) fn stop_playback(&mut self, cx: &mut Context<Self>) {
        if let Some(transport) = &self.transport {
            transport.pause();
        }
        if self.playing {
            self.playing = false;
            self.view.playing = false;
            self.report_playback();
        }
        cx.notify();
    }

    /// The engine stopped without being asked -- end of timeline under a live
    /// seek, the warmup's no-frames abort, or an error. Without this the
    /// window would keep showing Pause over a dead engine until the user
    /// pressed it twice. Runs the ordinary pause path so `Desired` stays
    /// UI-owned and the run's stats still get reported.
    pub fn engine_stopped(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.playing {
            return;
        }
        tracing::info!("playback engine stopped on its own; resetting transport UI");
        self.stop_playback(cx);
        window.refresh();
    }

    fn start_playback(&mut self, from: f64, cx: &mut Context<Self>) {
        let Some(transport) = &self.transport else {
            return;
        };
        // `Math.floor(editorState.playbackTime * FPS)`.
        let frame = (from.max(0.0) * EDITOR_PREVIEW_FPS as f64).floor() as u32;
        transport.play_from(frame);
        self.playhead = from.max(0.0);
        self.view.playhead = self.playhead;
        // A new play epoch: `last_playhead_redraw` still points at the
        // previous epoch's final sample, so extrapolating from it would draw
        // the playhead ahead of where it stands and snap back when the
        // engine's first frame lands. Parked until `playhead_changed` applies
        // a sample from this epoch.
        self.playhead_epoch_live = false;
        self.playhead_epoch_start = frame;
        self.playing = true;
        self.view.playing = true;
        self.play_mark = self
            .stats
            .as_ref()
            .map(|stats| (Instant::now(), stats.snapshot()));
        // Playhead events land at the preview fps (`EDITOR_PREVIEW_FPS`,
        // 60Hz), and each one already repaints the timeline and transport
        // through `invalidate_playback_chrome`. The ticker exists for render
        // stalls: when frames stop arriving, it keeps the extrapolated
        // playhead line (`last_playhead_redraw` in the ruler render) gliding.
        // In steady state a tick that lands right after a playhead event
        // would be a duplicate rebuild of both sections, so it only notifies
        // once an event is overdue.
        self.playback_tick += 1;
        let generation = self.playback_tick;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let keep = this
                    .update(cx, |this, cx| {
                        if this.playback_tick != generation || !this.playing {
                            return false;
                        }
                        if this.last_playhead_redraw.elapsed() < Duration::from_millis(15) {
                            return true;
                        }
                        this.timeline_view.update(cx, |_, cx| cx.notify());
                        this.transport_controls.update(cx, |_, cx| cx.notify());
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
        cx.notify();
    }

    /// The perf gate's line, emitted every time playback stops.
    fn report_playback(&mut self) {
        let (Some((started, before)), Some(stats)) = (self.play_mark.take(), self.stats.as_ref())
        else {
            return;
        };
        let elapsed = started.elapsed().as_secs_f64();
        let delta = stats.snapshot().since(before);
        tracing::info!("{}", delta.report(elapsed));
    }

    /// `handlePlayPauseClick` (`Player.tsx:212-233`), verbatim: at the end,
    /// restart from 0; playing, stop; otherwise seek to the playhead and go.
    pub fn toggle_play(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.transport.is_none() {
            return;
        }
        if self.is_at_end() {
            self.stop_playback(cx);
            self.start_playback(0.0, cx);
        } else if self.playing {
            self.stop_playback(cx);
        } else {
            let from = self.playhead;
            self.start_playback(from, cx);
        }
    }

    /// `seekPlayheadTo` (`Timeline/index.tsx:829-853`), minus the source's
    /// stop/seek/restart round trip: the driver live-seeks the running engine
    /// (`PlaybackHandle::seek`), so a scrub during playback holds the last
    /// picture for one decode instead of paying a warmup per tick.
    pub fn seek_to_time(&mut self, time: f64, cx: &mut Context<Self>) {
        let Some(transport) = &self.transport else {
            return;
        };
        let time = time.clamp(0.0, self.total_duration());
        // `Math.round(newTime * FPS)` -- "round to nearest frame to prevent
        // off-by-one drift".
        let frame = (time * EDITOR_PREVIEW_FPS as f64).round() as u32;
        if self.playing {
            // A live seek re-anchors the engine's clock at the target, and
            // the drawn line re-anchors with it: the engine's immediate
            // `Frame(target)` echo lands at exactly `playhead_epoch_start`,
            // and only a sample past it proves frames are flowing again (see
            // `playhead_extrapolation`).
            self.playhead_epoch_live = false;
            self.playhead_epoch_start = frame;
            transport.play_from(frame);
        } else {
            transport.seek(frame);
        }
        self.playhead = time;
        self.view.playhead = time;
        self.view.playing = self.playing;
        cx.notify();
    }

    /// The prev button (`Player.tsx:370-381`): stop, playhead to 0, and the
    /// timeline transform back to the start. **Not** a frame step -- neither
    /// transport button is one in the Tauri editor.
    pub fn jump_to_start(&mut self, cx: &mut Context<Self>) {
        self.stop_playback(cx);
        self.seek_to_time(0.0, cx);
    }

    /// The next button (`Player.tsx:395-405`): stop, playhead to the end.
    pub fn jump_to_end(&mut self, cx: &mut Context<Self>) {
        self.stop_playback(cx);
        let total = self.total_duration();
        self.seek_to_time(total, cx);
    }

    /// Harness only (`CAP_GPUI_AUTO_SEEK`, `CAP_GPUI_AUTO_PLAYBACK_TORTURE`):
    /// seek to a fraction along the timeline.
    ///
    /// It goes the long way round -- fraction to a window x, then through the
    /// same [`Self::time_at`] mapping a real click takes -- so the geometry is
    /// exercised too. Only gpui's event delivery is skipped, for the same
    /// reason as every other `CAP_GPUI_AUTO_*` hook: unprivileged synthetic
    /// clicks are dropped.
    pub fn seek_fraction(&mut self, fraction: f64, window: &mut Window, cx: &mut Context<Self>) {
        let viewport_width: f32 = window.viewport_size().width.into();
        let x = timeline::content_left()
            + timeline::content_width(viewport_width) * fraction.clamp(0.0, 1.0) as f32;
        let time = self.time_at(x, viewport_width);
        self.seek_to_time(time, cx);
    }

    /// Harness only (`CAP_GPUI_AUTO_PLAYBACK`): stop and emit the run's
    /// numbers. Identical to pressing pause -- the report is emitted on every
    /// stop, this just guarantees one happens.
    pub fn stop_for_measurement(&mut self, cx: &mut Context<Self>) {
        self.stop_playback(cx);
    }

    fn capture_playback_key(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !is_playback_shortcut(&event.keystroke, ui::text_input_has_focus(window, cx)) {
            return;
        }
        // Focused GPUI buttons arm a second click on key-up unless Space is
        // consumed before their key-down listener runs.
        window.prevent_default();
        cx.stop_propagation();
        if !event.is_held {
            self.toggle_play(window, cx);
        }
    }

    /// The editor's key bindings live in `useEditorShortcuts`
    /// (`Player.tsx:236-286`): `Space` play/pause, `S` split (E4's) and
    /// `Mod+=` / `Mod+-` zoom. `Mod` is Cmd-or-Ctrl
    /// (`useEditorShortcuts.ts:10`) and `e.repeat` is ignored there
    /// (`:42`) as `is_held` is here.
    fn on_key(&mut self, event: &gpui::KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.frame_controls.is_open() && event.keystroke.key == "escape" {
            self.close_frame_controls(window, cx);
            cx.stop_propagation();
            return;
        }
        // Crop mode first. It takes Escape and the four arrows and lets
        // **everything else through**, which is what the source does: the
        // dialog is a Kobalte modal but `useEditorShortcuts` and the
        // timeline's own listener are both bound on `document`, and Kobalte
        // does not stop key events reaching them. So Space still plays, `S`
        // still toggles the scissors and Backspace still deletes the timeline
        // selection with the cropper open. See the README.
        if self.crop.is_some() {
            // gpui delivers AppKit's key repeat; the cropper's own rAF ticker
            // owns repetition (`Cropper.tsx:1019-1022`), so a repeat must not
            // double-apply.
            if event.is_held {
                if crate::editor_crop::is_nudge_key(event.keystroke.key.as_str()).is_some() {
                    cx.stop_propagation();
                }
                return;
            }
            if self.crop_key_down(event, window, cx) {
                cx.stop_propagation();
                window.refresh();
                return;
            }
        }

        // The canvas arrow-key nudge is scoped outside `useEditorShortcuts`
        // precisely so held keys repeat (`CanvasElementsOverlay.tsx:561-565`),
        // so it is the one editor shortcut that runs on a repeat.
        if !event.keystroke.modifiers.platform
            && !event.keystroke.modifiers.control
            && !event.keystroke.modifiers.alt
            && !ui::text_input_has_focus(window, cx)
            && self.canvas_selection.is_some()
        {
            let key = event.keystroke.key.as_str();
            if key == "escape" && !event.is_held {
                self.canvas_selection = None;
                cx.stop_propagation();
                cx.notify();
                window.refresh();
                return;
            }
            let direction = match key {
                "left" => Some((-1., 0.)),
                "right" => Some((1., 0.)),
                "up" => Some((0., -1.)),
                "down" => Some((0., 1.)),
                _ => None,
            };
            if let Some(direction) = direction
                && self.canvas_nudge(direction, event.keystroke.modifiers.shift, window, cx)
            {
                cx.stop_propagation();
                window.refresh();
                return;
            }
        }

        if event.is_held {
            return;
        }
        // `useEditorShortcuts`' scope gate (`Player.tsx:236-245`) and the
        // timeline listener's own guard (`TL/index.tsx:960-966`): a focused
        // `input`/`textarea` suppresses every editor shortcut.
        //
        // Only the *bare* keys below need it. Backspace, Cmd-Z, Cmd-Y, Cmd-A
        // and Cmd-=/- are all bound as actions in the `TextInput` key context,
        // and a matched binding consumes the keystroke before any
        // `on_key_down` listener on the dispatch path runs
        // (`gpui/src/window.rs:5280-5296`), so they never reach here at all.
        // `s`, `c`, `space`, `delete` and `escape` cannot be bound that way:
        // a binding is matched *before* AppKit hands the event to the input
        // context (`gpui_macos/src/window.rs:2217-2250`), so binding a
        // printable key would mean it could never be typed. Hence the gate.
        // An open `KSelect` menu takes its own keys first -- arrows, Home /
        // End, Enter, Escape -- and consuming Escape here is what keeps it from
        // also clearing the timeline selection underneath.
        if self.sidebar.menu.is_some()
            && self.sidebar_menu_key(event.keystroke.key.as_str(), window, cx)
        {
            cx.stop_propagation();
            return;
        }
        if self.toolbar_menu.is_some()
            && self.toolbar_menu_key(event.keystroke.key.as_str(), window, cx)
        {
            cx.stop_propagation();
            return;
        }
        if self.add_track.is_some() && event.keystroke.key.as_str() == "escape" {
            self.add_track = None;
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if self.clip_speed.is_some() && event.keystroke.key.as_str() == "escape" {
            self.clip_speed = None;
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if self.sidebar.color_picker.is_some() && event.keystroke.key.as_str() == "escape" {
            self.close_color_picker(cx);
            cx.stop_propagation();
            return;
        }
        if event.keystroke.key.as_str() == "escape"
            && (self.presets_menu.is_some() || self.preset_dialog.is_some())
        {
            self.presets_menu = None;
            self.preset_dialog = None;
            cx.stop_propagation();
            cx.notify();
            return;
        }
        // The clips overlays -- the import menu and the record modal
        // (`ClipsSidebar.tsx:764-775`).
        if event.keystroke.key.as_str() == "escape" && self.clips_overlay_escape(cx) {
            cx.stop_propagation();
            return;
        }
        if ui::text_input_has_focus(window, cx) {
            return;
        }
        let keystroke = &event.keystroke;
        let modifier = keystroke.modifiers.platform || keystroke.modifiers.control;

        // `if (e.code === "Backspace" || (e.code === "Delete" &&
        // hasNoModifiers))` (`TL/index.tsx:963`) -- note the asymmetry:
        // **Backspace deletes whatever is held**, forward-delete only bare. It
        // is checked before the modifier gates below for that reason.
        if keystroke.key.as_str() == "backspace" {
            cx.stop_propagation();
            self.delete_selection(window, cx);
            return;
        }

        // Undo / redo, registered on `window` by `createStoreHistory`
        // (`ED/context.ts:1931-1948`): `Mod+Z`, `Shift+Mod+Z` and `Mod+Y`.
        if modifier && !keystroke.modifiers.alt {
            match keystroke.key.as_str() {
                "z" => {
                    cx.stop_propagation();
                    if keystroke.modifiers.shift {
                        self.redo(window, cx);
                    } else {
                        self.undo(window, cx);
                    }
                    window.refresh();
                    return;
                }
                "y" => {
                    cx.stop_propagation();
                    self.redo(window, cx);
                    window.refresh();
                    return;
                }
                // `Cmd/Ctrl+A` expands the selection to the whole track.
                "a" if !keystroke.modifiers.shift => {
                    cx.stop_propagation();
                    self.select_all_on_track(cx);
                    window.refresh();
                    return;
                }
                _ => {}
            }
        }

        if modifier && !keystroke.modifiers.alt {
            // The combo normaliser maps both `=` and `+` onto `=`
            // (`useEditorShortcuts.ts:12-30`); gpui reports the unshifted key,
            // so `shift-=` arrives as `=` too.
            let step = match keystroke.key.as_str() {
                "=" | "+" => Some(1. / 1.1),
                "-" | "_" => Some(1.1),
                _ => None,
            };
            if let Some(step) = step {
                cx.stop_propagation();
                // The origin is `editorState.playbackTime` -- the playhead, not
                // the pointer and not `previewTime` (`Player.tsx:256-271`).
                let origin = self.playhead;
                self.zoom_by(step, origin, cx);
                window.refresh();
            }
            return;
        }
        if keystroke.modifiers.platform
            || keystroke.modifiers.control
            || keystroke.modifiers.alt
            || keystroke.modifiers.shift
        {
            return;
        }
        match keystroke.key.as_str() {
            // `e.code === "Backspace" || (e.code === "Delete" &&
            // hasNoModifiers)` (`TL/index.tsx:963`). gpui reports the main
            // delete key as `backspace` and forward-delete as `delete`, which
            // is the same split `e.code` makes.
            "delete" => {
                cx.stop_propagation();
                self.delete_selection(window, cx);
            }
            // `S` toggles the scissors (`Player.tsx:246-254`) and `C` performs
            // the cut (`TL/index.tsx:1007-1013`) -- two different keys, and
            // two different listeners in the source.
            "s" => {
                cx.stop_propagation();
                self.toggle_split_mode(cx);
                window.refresh();
            }
            "c" => {
                cx.stop_propagation();
                self.split_at_playhead(window, cx);
            }
            "escape" => {
                cx.stop_propagation();
                if self.audio_picker.is_some() {
                    self.audio_picker = None;
                    cx.notify();
                    return;
                }
                if self.camera3d_setup.is_some() {
                    self.close_camera3d_setup(cx);
                    return;
                }
                if self.selection.is_some() {
                    self.set_selection(None, cx);
                    self.note_edit("deselect", None);
                }
                window.refresh();
            }
            _ => {}
        }
    }

    // -- The timeline transform ----------------------------------------------

    /// `transform.updateZoom(zoom * factor, origin)`.
    fn zoom_by(&mut self, factor: f64, origin: f64, cx: &mut Context<Self>) {
        let total = self.total_duration();
        let zoom = self.view.transform.zoom;
        self.view
            .transform
            .update_zoom(zoom * factor, origin, total);
        self.note_transform("zoom", Some(origin));
        cx.notify();
    }

    /// One line per transform change. The zoom anchor and the pan clamp are
    /// only checkable end to end if the numbers come out of the running app,
    /// so they do -- at `info`, because the frame pump's own logging is at
    /// `debug` and would drown it.
    fn note_transform(&self, reason: &'static str, origin: Option<f64>) {
        tracing::info!(
            reason,
            zoom = format!("{:.4}", self.view.transform.zoom),
            position = format!("{:.4}", self.view.transform.position),
            origin = origin.map(|origin| format!("{origin:.4}")),
            "timeline transform"
        );
    }

    /// The wheel (`TL/index.tsx:1189-1207`), rAF-coalescing aside.
    ///
    /// gpui's scroll delta is the amount the *content* moves, which is the
    /// opposite sign to the DOM's `deltaX`/`deltaY` (`div.rs:3123-3124` adds it
    /// straight onto a scroll offset that is negative when scrolled down), so
    /// it is negated back into the source's convention before any of the
    /// source's arithmetic touches it.
    fn timeline_wheel(
        &mut self,
        event: &gpui::ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let pixels = event.delta.pixel_delta(window.line_height());
        let delta_x = -f32::from(pixels.x) as f64;
        let delta_y = -f32::from(pixels.y) as f64;
        let total = self.total_duration();

        let horizontal = delta_x.abs() > delta_y.abs() * 0.5 || event.modifiers.shift;
        if event.modifiers.control || horizontal {
            let offset = self.timeline_scroll.offset();
            let editor = cx.entity().downgrade();
            cx.defer(move |cx| {
                if let Some(editor) = editor.upgrade() {
                    editor.update(cx, |this, _| {
                        this.timeline_scroll.set_offset(offset);
                    });
                }
            });
        }

        if event.modifiers.control {
            let origin = self.view.preview_time.unwrap_or(self.playhead);
            let delta = timeline::wheel_zoom_delta(delta_y, self.view.transform.zoom);
            let zoom = self.view.transform.zoom;
            self.view.transform.update_zoom(zoom + delta, origin, total);
        } else if horizontal {
            let delta = if delta_x.abs() > 0.5 {
                delta_x
            } else {
                delta_y
            };
            let viewport_width: f32 = window.viewport_size().width.into();
            let secs_per_pixel = self
                .view
                .transform
                .secs_per_pixel(timeline::content_width(viewport_width));
            let position = self.view.transform.position + secs_per_pixel * delta;
            self.view.transform.set_position(position, total);
        } else {
            return;
        }
        self.note_transform("wheel", None);
        cx.notify();
    }

    /// Pinch-to-zoom. In the webview a trackpad pinch arrives as `ctrl+wheel`
    /// and goes down the `e.ctrlKey` branch above; gpui delivers a native
    /// [`gpui::PinchEvent`] instead, so this is the one place the transcription
    /// cannot be literal. The mapping is Chromium's own synthesis --
    /// `deltaY = -delta * 100` -- fed into the same
    /// `deltaY * sqrt(zoom) / 30`, so the feel and the anchor match.
    fn timeline_pinch(
        &mut self,
        event: &gpui::PinchEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let total = self.total_duration();
        let origin = self.view.preview_time.unwrap_or(self.playhead);
        let delta_y = -(event.delta as f64) * 100.;
        let delta = timeline::wheel_zoom_delta(delta_y, self.view.transform.zoom);
        let zoom = self.view.transform.zoom;
        self.view.transform.update_zoom(zoom + delta, origin, total);
        self.note_transform("pinch", Some(origin));
        cx.notify();
    }

    fn invalidate_playback_chrome(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.timeline_view.update(cx, |_, cx| cx.notify());
        self.transport_controls.update(cx, |_, cx| cx.notify());
        // While playing, nothing else the parent renders reads the playhead:
        // the canvas overlay is hidden (`canvas_overlay_visible`) and the
        // scene-mode pane gates on it too. Notifying the parent here would
        // rebuild every cached section -- header, toolbar, sidebar included --
        // at the 60Hz playhead rate, which is the same class of rebuild that
        // measured 40ms/frame on the text-panel sidebar. Paused paths (hover,
        // seeks) keep the full invalidation: the overlay's element boxes
        // appear and disappear as the playhead crosses segments.
        if !self.playing {
            cx.notify();
        }
    }

    fn emit_preview_frame(&self) {
        let Some(instance) = &self.instance else {
            return;
        };
        if self.playing {
            return;
        }
        let time = self.view.preview_time.unwrap_or(self.playhead).max(0.0);
        request_frame(
            instance,
            (time * EDITOR_PREVIEW_FPS as f64).floor() as u32,
            self.preview_resolution(),
        );
    }

    /// `onMouseMove` on the timeline container (`TL/index.tsx:1170-1188`):
    /// while paused, the pointer's time becomes `previewTime`; outside the
    /// content column, and at all times while playing, it is cleared.
    fn timeline_hover(&mut self, x: f32, window: &mut Window, cx: &mut Context<Self>) {
        // `if (editorState.playing) return;` -- the handler bails *before* it
        // writes, so a preview time set while paused survives a play rather
        // than being cleared. The ghost is hidden by the render's own
        // `!editorState.playing` gate instead (`TL/index.tsx:1246-1253`).
        if self.playing || self.drag.is_some() {
            return;
        }
        let viewport_width: f32 = window.viewport_size().width.into();
        let next = timeline::preview_time_from_x(x, viewport_width, self.view.transform);
        if next != self.view.preview_time {
            self.view.preview_time = next;
            self.emit_preview_frame();
            self.invalidate_playback_chrome(window, cx);
        }
    }

    fn timeline_hover_leave(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.playing || self.view.preview_time.is_none() {
            return;
        }
        self.view.preview_time = None;
        self.emit_preview_frame();
        self.invalidate_playback_chrome(window, cx);
    }

    fn set_hovered_track(
        &mut self,
        track: Option<TrackKind>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.view.hovered_track != track {
            self.view.hovered_track = track;
            cx.notify();
        }
    }

    // -- Timeline seeking ----------------------------------------------------

    fn time_at(&self, x: f32, viewport_width: f32) -> f64 {
        timeline::time_from_x(
            x,
            viewport_width,
            self.view.transform,
            self.total_duration(),
        )
    }

    fn timeline_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        ruler: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.button != MouseButton::Left || self.transport.is_none() {
            return;
        }
        self.focus_root(window, cx);
        let viewport_width: f32 = window.viewport_size().width.into();
        let time = self.time_at(f32::from(event.position.x), viewport_width);
        if ruler {
            // `applyScrub()` runs immediately on mousedown.
            self.scrub = Some(Scrub::Ruler);
            self.seek_to_time(time, cx);
        } else {
            self.scrub = Some(Scrub::Press { time });
        }
        cx.notify();
    }

    fn timeline_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.scrub != Some(Scrub::Ruler) {
            return;
        }
        // The source clamps the pointer to the content edges while scrubbing
        // (`beginRulerScrub`'s `contentEdges`), so a drag past either end
        // parks the playhead there instead of doing nothing.
        let viewport_width: f32 = window.viewport_size().width.into();
        let left = timeline::content_left();
        let right = left + timeline::content_width(viewport_width);
        let x = f32::from(event.position.x).clamp(left, right);
        let time = self.time_at(x, viewport_width);
        // No throttle: `preview_tx` is a `watch`, so a push that a newer one
        // supersedes is simply overwritten, and the preview renderer cancels
        // in-flight work when it sees a newer instruction
        // (`editor_instance.rs:563-575`).
        self.seek_to_time(time, cx);
    }

    /// The **timeline's own** mouseup, the one the source registers on
    /// `e.currentTarget` (`TL/index.tsx:1157-1162`): a press that is released
    /// over the timeline seeks to where it landed.
    fn timeline_mouse_up(&mut self, cx: &mut Context<Self>) {
        if let Some(Scrub::Press { time }) = self.scrub.take() {
            self.seek_to_time(time, cx);
            // The other half of that listener: a press on bare timeline also
            // clears the selection (`TL/index.tsx:1157-1163`). It is gated on
            // the zoom drag state being idle there, which it always is by the
            // time this runs -- a press *on* a segment stops propagating and
            // never arms this.
            let had = self.selection.is_some();
            self.set_selection(None, cx);
            if had {
                self.note_edit("deselect", None);
            }
        }
        cx.notify();
    }

    /// The **window's** mouseup, which the source uses only to dispose the
    /// press listener (`createEventListener(window, "mouseup", () =>
    /// dispose())`) and to end a ruler scrub. It runs after the timeline's own
    /// handler -- gpui bubbles child to parent -- so a press released *outside*
    /// the timeline is dropped rather than seeking.
    fn window_mouse_up(&mut self, cx: &mut Context<Self>) {
        if self.scrub.take().is_some() {
            cx.notify();
        }
    }

    // -- Editing: the pointer ------------------------------------------------

    /// `secsPerPixel()` (`TL/context.ts:91-92`), over the clip track's own box.
    fn secs_per_pixel(&self, viewport_width: f32) -> f64 {
        self.view
            .transform
            .secs_per_pixel(timeline::content_width(viewport_width))
    }

    /// A window x as pixels into the track content column, the space every
    /// segment box is laid out in.
    fn content_x(&self, window_x: f32) -> f64 {
        (window_x - timeline::content_left()) as f64
    }

    /// `useSetPreviewTime` (`TL/Track.tsx:260-266`): every trim writes the edge
    /// it is moving into `previewTime`, so the transport clock reads out the
    /// value being dragged.
    fn set_preview_time(&mut self, time: f64) {
        self.view.preview_time = Some(time.clamp(0.0, self.total_duration()));
        self.emit_preview_frame();
    }

    /// `setEditorState("timeline", "selection", ...)`.
    pub(crate) fn set_selection(&mut self, selection: Option<Selection>, cx: &mut Context<Self>) {
        if self.selection != selection {
            self.selection = selection;
            cx.notify();
        }
    }

    /// A press on a track row. Whatever it lands on decides everything:
    /// a handle trims, a body moves (or splits, in split mode), and bare track
    /// falls through to the timeline container's own press-to-seek -- except on
    /// the zoom track, which creates a segment there.
    fn track_mouse_down(
        &mut self,
        kind: TrackKind,
        lane: u32,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.button != MouseButton::Left || self.transport.is_none() {
            return;
        }
        self.focus_root(window, cx);
        if self.clip_anim.is_some() {
            self.clip_anim = None;
            self.clip_anim_generation += 1;
        }
        let viewport_width: f32 = window.viewport_size().width.into();
        let secs_per_pixel = self.secs_per_pixel(viewport_width);
        let x = self.content_x(f32::from(event.position.x));
        let position = self.view.transform.position;
        let total = self.total_duration();
        let hit = edits::hit_test(
            self.timeline.segments(kind),
            lane,
            x,
            position,
            secs_per_pixel,
        );
        let press_time = self.time_at(f32::from(event.position.x), viewport_width);
        // The whole geometry of the press, so a scripted click's predicted
        // seconds can be checked against what the app actually resolved.
        tracing::debug!(
            track = ?kind,
            lane,
            hit = ?hit,
            x = format!("{x:.2}"),
            secs_per_pixel = format!("{secs_per_pixel:.6}"),
            press_time = format!("{press_time:.4}"),
            split = self.split_mode,
            shift = event.modifiers.shift,
            platform = event.modifiers.platform,
            control = event.modifiers.control,
            alt = event.modifiers.alt,
            selection = ?self.selection,
            "timeline press"
        );

        let index = match hit {
            Hit::Empty => {
                if kind == TrackKind::Zoom {
                    self.begin_gap_create(
                        TrackKind::Zoom,
                        secs_per_pixel,
                        f32::from(event.position.x),
                        cx,
                    );
                } else if kind == TrackKind::ThreeD {
                    if self
                        .project
                        .timeline
                        .as_ref()
                        .is_none_or(|timeline| timeline.camera3d_segments.is_empty())
                    {
                        cx.stop_propagation();
                        self.start_camera3d_setup(cx);
                    } else if self.camera3d_setup.is_none() {
                        self.begin_gap_create(
                            TrackKind::ThreeD,
                            secs_per_pixel,
                            f32::from(event.position.x),
                            cx,
                        );
                    }
                } else if kind == TrackKind::Audio {
                    cx.stop_propagation();
                    self.open_audio_picker(lane, cx);
                } else if matches!(kind, TrackKind::Text | TrackKind::Mask | TrackKind::Scene) {
                    cx.stop_propagation();
                    self.add_segment_at_click(kind, lane, press_time, window, cx);
                }
                return;
            }
            Hit::Body { index } | Hit::Handle { index, .. } => index,
        };

        // Everything below is inside a segment, and the source stops the press
        // there (`e.stopPropagation()` at the top of every `SegmentRoot`'s
        // `onMouseDown`, and inside `createMouseDownDrag`).
        cx.stop_propagation();

        if self.split_mode {
            self.split_at_pointer(
                kind,
                index,
                x,
                secs_per_pixel,
                event.modifiers.alt,
                window,
                cx,
            );
            return;
        }

        let modifiers = (
            event.modifiers.shift,
            event.modifiers.platform || event.modifiers.control,
        );
        let segments = self.timeline.segments(kind);
        if index >= segments.len() {
            return;
        }
        let (start, end) = (segments[index].start, segments[index].end);

        // The clip's own recording-domain edges, which its handles move.
        let source_edges = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.segments.get(index))
            .map(|segment| (segment.start, segment.end));

        let kind_of_drag = match (kind, hit) {
            // The clip's handles: recording-domain, no promotion threshold, no
            // selection on release.
            (TrackKind::Clip, Hit::Handle { start: true, .. }) => {
                source_edges.map(|(start, _)| DragKind::ClipTrimStart { start })
            }
            (TrackKind::Clip, Hit::Handle { start: false, .. }) => {
                source_edges.map(|(_, end)| DragKind::ClipTrimEnd { end })
            }
            // The clip's *body* drag is a crossfade-duration drag, not a move
            // (`TL/ClipTrack.tsx:849-945`); transitions have no drawn
            // affordance here, so a body press only ever selects.
            (TrackKind::Clip, Hit::Body { .. }) => None,
            (_, Hit::Handle { start: true, .. }) => {
                let min = edits::min_segment_duration(kind, secs_per_pixel);
                Some(DragKind::TrimStart {
                    start,
                    bounds: edits::trim_start_bounds(segments, lane, index, min, total),
                })
            }
            (_, Hit::Handle { start: false, .. }) => {
                let min = edits::min_segment_duration(kind, secs_per_pixel);
                Some(DragKind::TrimEnd {
                    end,
                    bounds: edits::trim_end_bounds(segments, lane, index, min, total),
                })
            }
            (_, Hit::Body { .. }) => Some(DragKind::Move {
                start,
                end,
                bounds: edits::move_bounds(segments, lane, index, total),
            }),
            (_, Hit::Empty) => None,
        };

        let clip_handle = matches!(
            kind_of_drag,
            Some(DragKind::ClipTrimStart { .. } | DragKind::ClipTrimEnd { .. })
        );
        let Some(drag_kind) = kind_of_drag else {
            // A clip body press: select on release, nothing else.
            self.drag = Some(Drag {
                track: kind,
                index,
                kind: DragKind::Move {
                    start,
                    end,
                    bounds: DragBounds { min: 0., max: 0. },
                },
                down_x: f32::from(event.position.x),
                origin_x: None,
                moved: false,
                // 4px, the clip body's own promotion (`TL/ClipTrack.tsx:875`).
                // Nothing happens past it here -- the transition drag is not
                // reproduced -- but the threshold still decides whether the
                // release selects.
                threshold: 4.,
                selects_on_click: true,
                shift: modifiers.0,
                multi: modifiers.1,
                press_time,
                paused: false,
            });
            cx.notify();
            return;
        };

        // `projectHistory.pause()` for the whole drag: sixty intermediate
        // states become one undo entry.
        self.history.pause();
        self.arm_drag_snap(kind, Some(index));
        tracing::debug!(track = ?kind, lane, index, kind = ?drag_kind, "timeline drag armed");
        self.drag = Some(Drag {
            track: kind,
            index,
            kind: drag_kind,
            down_x: f32::from(event.position.x),
            // The clip's handles measure from the press; every other drag
            // measures from wherever the 2px promotion happened.
            origin_x: clip_handle.then_some(f32::from(event.position.x)),
            moved: false,
            threshold: if clip_handle { 0. } else { 2. },
            selects_on_click: !clip_handle,
            shift: modifiers.0,
            multi: modifiers.1,
            press_time,
            paused: true,
        });
        cx.notify();
    }

    /// `newSegmentDetails()` plus `createSegment` (`TL/ZoomTrack.tsx:104-295`).
    /// The ghost the track already draws is where the segment lands; the press
    /// arms a drag that stretches its end until the button comes up.
    fn begin_gap_create(
        &mut self,
        kind: TrackKind,
        secs_per_pixel: f64,
        down_x: f32,
        cx: &mut Context<Self>,
    ) {
        let ghost = (self.view.hovered_track == Some(kind))
            .then_some(self.view.preview_time)
            .flatten()
            .and_then(|preview| {
                timeline::new_gap_segment(&self.timeline, kind, preview, secs_per_pixel)
                    .map(|ghost| (preview, ghost))
            });
        let Some((preview, (start, end))) = ghost else {
            return;
        };
        let max = self
            .timeline
            .segments(kind)
            .iter()
            .find(|segment| preview <= segment.start)
            .map_or(self.total_duration(), |segment| segment.start);
        let min_duration = timeline::new_segment_min_duration(secs_per_pixel);

        self.history.pause();
        self.arm_drag_snap(kind, None);
        self.drag = Some(Drag {
            track: kind,
            index: 0,
            kind: DragKind::CreateZoom {
                base_start: start,
                base_end: end,
                max,
                min_duration,
                created: None,
            },
            down_x,
            origin_x: Some(down_x),
            moved: false,
            threshold: 0.,
            selects_on_click: false,
            shift: false,
            multi: false,
            press_time: preview,
            paused: true,
        });
        cx.notify();
    }

    /// Every edge a live drag can magnetise onto: the playhead, zero, the
    /// total duration, and every other segment's edges across every track.
    /// Gathered once when the drag arms; Shift bypasses them.
    fn arm_drag_snap(&mut self, kind: TrackKind, exclude: Option<usize>) {
        let mut targets = vec![0.0, self.playhead];
        // A clip trim moves every box after it, so downstream clip edges and
        // the total are not stable targets for one; the overlay tracks keep
        // absolute times and are.
        if kind != TrackKind::Clip {
            targets.push(self.total_duration());
        }
        for track in [
            TrackKind::Clip,
            TrackKind::Caption,
            TrackKind::Keyboard,
            TrackKind::Text,
            TrackKind::Mask,
            TrackKind::Audio,
            TrackKind::Zoom,
            TrackKind::ThreeD,
            TrackKind::Scene,
        ] {
            if kind == TrackKind::Clip && track == TrackKind::Clip {
                continue;
            }
            for (index, segment) in self.timeline.segments(track).iter().enumerate() {
                if track == kind && Some(index) == exclude {
                    continue;
                }
                targets.push(segment.start);
                targets.push(segment.end);
            }
        }
        self.drag_snap_targets = targets;
        self.drag_snap_time = None;
    }

    /// Snap `value` to the nearest armed target within [`DRAG_SNAP_PX`].
    fn snap_dragged_time(
        &self,
        value: f64,
        secs_per_pixel: f64,
        disabled: bool,
    ) -> (f64, Option<f64>) {
        if disabled {
            return (value, None);
        }
        let radius = DRAG_SNAP_PX * secs_per_pixel;
        let mut best: Option<f64> = None;
        for &target in &self.drag_snap_targets {
            let distance = (target - value).abs();
            if distance <= radius && best.is_none_or(|b| (b - value).abs() > distance) {
                best = Some(target);
            }
        }
        match best {
            Some(target) => (target, Some(target)),
            None => (value, None),
        }
    }

    /// A pointer move with a segment drag live. Runs off the root's handler, so
    /// a drag that leaves its own row keeps tracking -- which is what
    /// `createEventListenerMap(window, ...)` gives the source.
    fn drag_mouse_move(
        &mut self,
        x: f32,
        snap_disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        // The promotion: `Math.abs(event.clientX - downEvent.clientX) > 2`,
        // capturing `initialMouseX` the first time it holds.
        if (x - drag.down_x).abs() > drag.threshold && !drag.moved {
            drag.moved = true;
            if drag.origin_x.is_none() {
                drag.origin_x = Some(x);
            }
        }
        // `origin_x` *is* the promotion marker on every drag with a threshold:
        // it is only filled in once the pointer has passed it.
        let Some(origin_x) = drag.origin_x else {
            return;
        };
        let drag = *drag;

        let viewport_width: f32 = window.viewport_size().width.into();
        let secs_per_pixel = self.secs_per_pixel(viewport_width);
        let delta = (x - origin_x) as f64 * secs_per_pixel;

        match drag.kind {
            DragKind::Move { start, end, bounds } => {
                let raw = bounds.clamp(delta);
                let mut shift = raw;
                let mut engaged = None;
                if !snap_disabled {
                    let radius = DRAG_SNAP_PX * secs_per_pixel;
                    let mut best = f64::INFINITY;
                    for &target in &self.drag_snap_targets {
                        for edge in [start + raw, end + raw] {
                            let adjust = target - edge;
                            if adjust.abs() <= radius && adjust.abs() < best.abs() {
                                best = adjust;
                                engaged = Some(target);
                            }
                        }
                    }
                    if best.is_finite() {
                        let snapped = bounds.clamp(raw + best);
                        if (snapped - (raw + best)).abs() < 1e-9 {
                            shift = snapped;
                        } else {
                            engaged = None;
                        }
                    }
                }
                self.drag_snap_time = engaged;
                let (track, index) = (drag.track, drag.index);
                self.edit_live(
                    |timeline| {
                        edits::move_segment(timeline, track, index, start + shift, end + shift)
                    },
                    cx,
                );
            }
            DragKind::TrimStart { start, bounds } => {
                let (snapped, engaged) =
                    self.snap_dragged_time(start + delta, secs_per_pixel, snap_disabled);
                let next = bounds.clamp(snapped);
                self.drag_snap_time = engaged.filter(|target| (target - next).abs() < 1e-9);
                let (track, index) = (drag.track, drag.index);
                if self.edit_live(
                    |timeline| edits::set_segment_start(timeline, track, index, next),
                    cx,
                ) {
                    self.set_preview_time(next);
                }
            }
            DragKind::TrimEnd { end, bounds } => {
                let (snapped, engaged) =
                    self.snap_dragged_time(end + delta, secs_per_pixel, snap_disabled);
                let next = bounds.clamp(snapped);
                self.drag_snap_time = engaged.filter(|target| (target - next).abs() < 1e-9);
                let (track, index) = (drag.track, drag.index);
                if self.edit_live(
                    |timeline| edits::set_segment_end(timeline, track, index, next),
                    cx,
                ) {
                    self.set_preview_time(next);
                }
            }
            DragKind::ClipTrimStart { start } => {
                self.clip_trim(
                    drag.index,
                    start,
                    delta,
                    true,
                    secs_per_pixel,
                    snap_disabled,
                    window,
                    cx,
                );
            }
            DragKind::ClipTrimEnd { end } => {
                self.clip_trim(
                    drag.index,
                    end,
                    delta,
                    false,
                    secs_per_pixel,
                    snap_disabled,
                    window,
                    cx,
                );
            }
            DragKind::CreateZoom {
                base_start,
                base_end,
                max,
                min_duration,
                created,
            } => {
                let delta_time = delta - (base_end - base_start);
                let new_end = base_end + delta_time;
                let (new_end, engaged) =
                    self.snap_dragged_time(new_end, secs_per_pixel, snap_disabled);
                let min_end = base_start + min_duration;
                let clamped = new_end.max(min_end).min(max.max(min_end));
                self.drag_snap_time = engaged.filter(|target| (target - clamped).abs() < 1e-9);
                match created {
                    None => {
                        let index =
                            self.create_gap_segment(drag.track, base_start, clamped, window, cx);
                        if let Some(drag) = self.drag.as_mut()
                            && let DragKind::CreateZoom { created, .. } = &mut drag.kind
                        {
                            *created = Some(index);
                        }
                    }
                    Some(index) => {
                        if delta_time < 0. {
                            return;
                        }
                        self.edit_live(
                            |timeline| edits::set_segment_end(timeline, drag.track, index, clamped),
                            cx,
                        );
                    }
                }
            }
        }
    }

    /// The clip handles' shared update (`TL/ClipTrack.tsx:1186-1213,
    /// 1319-1348`). `delta` is already in output seconds; the recording domain
    /// is `delta * timescale`.
    #[allow(clippy::too_many_arguments)]
    fn clip_trim(
        &mut self,
        index: usize,
        anchor: f64,
        delta: f64,
        start_edge: bool,
        secs_per_pixel: f64,
        snap_disabled: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(timeline) = self.project.timeline.as_ref() else {
            return;
        };
        let Some(segment) = timeline.segments.get(index) else {
            return;
        };
        let timescale = segment.timescale;
        let segment_start = segment.start;
        let requested = anchor + delta * timescale;
        let displays = self.clip_display_durations.clone();
        let recording = self.recording_duration;

        let clamped = if start_edge {
            edits::clip_trim_start(
                timeline,
                index,
                requested,
                secs_per_pixel,
                &displays,
                recording,
            )
        } else {
            edits::clip_trim_end(
                timeline,
                index,
                requested,
                secs_per_pixel,
                &displays,
                recording,
            )
        };
        let Some(mut clamped) = clamped else { return };

        // The end handle is the one whose box edge moves on screen, so it is
        // the one that magnetises: project the edge into output time, snap it,
        // and map the snapped time back into the recording domain.
        self.drag_snap_time = None;
        if !start_edge && !snap_disabled && timescale > 0. {
            let box_start = self.timeline.clips.get(index).map_or(0., |clip| clip.start);
            let out_edge = box_start + (clamped - segment_start) / timescale;
            let (snapped_out, engaged) = self.snap_dragged_time(out_edge, secs_per_pixel, false);
            if let Some(target) = engaged
                && (snapped_out - out_edge).abs() > f64::EPSILON
                && let Some(timeline) = self.project.timeline.as_ref()
            {
                let requested = segment_start + (snapped_out - box_start) * timescale;
                if let Some(resnapped) = edits::clip_trim_end(
                    timeline,
                    index,
                    requested,
                    secs_per_pixel,
                    &displays,
                    recording,
                ) && (resnapped - requested).abs() < 1e-9
                {
                    clamped = resnapped;
                    self.drag_snap_time = Some(target);
                }
            } else if engaged.is_some() {
                self.drag_snap_time = engaged;
            }
        }

        // The ghost trim: the config stays untouched for the whole drag --
        // only this draft moves, exactly Blip's `draft_source_*`. Downstream
        // boxes hold still, the removed span is drawn as a gap, and the
        // commit happens once on release.
        let Some(segment) = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.segments.get(index))
        else {
            return;
        };
        self.clip_draft = Some(if start_edge {
            ClipDraft {
                index,
                start_edge,
                start: clamped,
                end: segment.end,
            }
        } else {
            ClipDraft {
                index,
                start_edge,
                start: segment.start,
                end: clamped,
            }
        });
        // The frame under the dragged edge: output `box_start + (edge -
        // original_start) / timescale` maps through the *unchanged* config to
        // the draft's source frame, so the preview scrubs the material being
        // trimmed without a commit.
        let box_start = self.timeline.clips.get(index).map_or(0., |clip| clip.start);
        self.set_preview_time(box_start + (clamped - segment_start) / timescale);
        cx.notify();
    }

    /// Blip's `video_segment_drag_layout` in Ghost mode, expressed as deltas
    /// over the frozen model boxes: the dragged edge follows the draft,
    /// shrinking opens a gap in place, growing pushes the boxes after it.
    fn ghost_clip_boxes(&self) -> Option<GhostClipLayout> {
        let draft = self.clip_draft?;
        let timeline = self.project.timeline.as_ref()?;
        let segment = timeline.segments.get(draft.index)?;
        let timescale = segment.timescale.max(0.0001);
        let original_out = (segment.end - segment.start) / timescale;
        let draft_out = (draft.end - draft.start) / timescale;
        let growth = draft_out - original_out;

        let mut boxes = Vec::with_capacity(self.timeline.clips.len());
        let mut gap = None;
        for (index, clip) in self.timeline.clips.iter().enumerate() {
            let range = match index.cmp(&draft.index) {
                std::cmp::Ordering::Less => (clip.start, clip.end),
                std::cmp::Ordering::Greater => {
                    (clip.start + growth.max(0.), clip.end + growth.max(0.))
                }
                std::cmp::Ordering::Equal => {
                    if growth >= 0. {
                        (clip.start, clip.end + growth)
                    } else if draft.start_edge {
                        gap = Some((clip.start, clip.start - growth));
                        (clip.start - growth, clip.end)
                    } else {
                        gap = Some((clip.start + draft_out, clip.end));
                        (clip.start, clip.start + draft_out)
                    }
                }
            };
            boxes.push(range);
        }
        Some((boxes, gap))
    }

    /// The model the timeline should *draw* this frame: the real one, or a
    /// clone with the clip boxes replaced by the ghost layout (mid-drag) or
    /// the release animation's eased positions.
    fn display_timeline_model(&self) -> Option<timeline::TimelineModel> {
        if let Some(draft) = self.clip_draft {
            let (boxes, gap) = self.ghost_clip_boxes()?;
            let mut model = self.timeline.clone();
            for (clip, (start, end)) in model.clips.iter_mut().zip(&boxes) {
                clip.start = *start;
                clip.end = *end;
            }
            if let Some(clip) = model.clips.get_mut(draft.index)
                && let timeline::SegmentDetail::Clip {
                    source_start,
                    source_duration,
                    ..
                } = &mut clip.detail
            {
                *source_start = draft.start;
                *source_duration = draft.end - draft.start;
            }
            model.clip_ghost_gap = gap;
            return Some(model);
        }
        let anim = self.clip_anim.as_ref()?;
        if anim.from.len() != self.timeline.clips.len() {
            return None;
        }
        let progress = (anim.started.elapsed().as_secs_f64()
            / CLIP_RESIZE_ANIM_DURATION.as_secs_f64())
        .clamp(0., 1.);
        if progress >= 1. {
            return None;
        }
        let eased = 1. - (1. - progress).powi(5);
        let mut model = self.timeline.clone();
        for (clip, (from_start, from_end)) in model.clips.iter_mut().zip(&anim.from) {
            clip.start = from_start + (clip.start - from_start) * eased;
            clip.end = from_end + (clip.end - from_end) * eased;
        }
        Some(model)
    }

    /// Commit the ghost draft once, then glide every box from where the drag
    /// left it to where the packed layout puts it -- Blip's
    /// `animate_video_timeline_resize`, 180ms of quintic ease-out.
    fn commit_clip_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.clip_draft.take() else {
            return;
        };
        let Some((from, _)) = self.ghost_clip_boxes_for(draft) else {
            return;
        };
        let committed = self.edit(
            |timeline| {
                let Some(segment) = timeline.segments.get_mut(draft.index) else {
                    return false;
                };
                if segment.start == draft.start && segment.end == draft.end {
                    return false;
                }
                segment.start = draft.start;
                segment.end = draft.end;
                true
            },
            window,
            cx,
        );
        if !committed {
            return;
        }
        self.note_edit("trim", Some(TrackKind::Clip));
        if from.len() != self.timeline.clips.len()
            || from
                .iter()
                .zip(&self.timeline.clips)
                .all(|((start, end), clip)| {
                    (start - clip.start).abs() < 1e-6 && (end - clip.end).abs() < 1e-6
                })
        {
            return;
        }
        self.clip_anim_generation += 1;
        let generation = self.clip_anim_generation;
        self.clip_anim = Some(ClipReleaseAnim {
            from,
            started: Instant::now(),
            generation,
        });
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(CLIP_RESIZE_ANIM_TICK).await;
                let keep = this
                    .update(cx, |this, cx| {
                        let Some(anim) = this.clip_anim.as_ref() else {
                            return false;
                        };
                        if anim.generation != generation {
                            return false;
                        }
                        let done = anim.started.elapsed() >= CLIP_RESIZE_ANIM_DURATION;
                        if done {
                            this.clip_anim = None;
                        }
                        cx.notify();
                        !done
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    fn ghost_clip_boxes_for(&mut self, draft: ClipDraft) -> Option<GhostClipLayout> {
        self.clip_draft = Some(draft);
        let result = self.ghost_clip_boxes();
        self.clip_draft = None;
        result
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Camera3DSetup {
    pub scene_id: &'static str,
    pub shots: usize,
}

type GhostClipLayout = (Vec<(f64, f64)>, Option<(f64, f64)>);

impl EditorWindow {
    fn clamp_timeline_height(&self, value: f32, viewport_height: f32) -> f32 {
        let available = (viewport_height - HEADER_HEIGHT - 8.).max(MIN_TIMELINE_HEIGHT);
        let max_height = (available - MIN_PLAYER_HEIGHT).max(MIN_TIMELINE_HEIGHT);
        value.clamp(MIN_TIMELINE_HEIGHT, max_height)
    }

    fn edit_live(
        &mut self,
        change: impl FnOnce(&mut TimelineConfiguration) -> bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(timeline) = self.project.timeline.as_mut() else {
            return false;
        };
        if !change(timeline) {
            return false;
        }
        self.rebuild_timeline();
        self.publish_project();
        cx.notify();
        true
    }

    pub(crate) fn open_audio_picker(&mut self, lane: u32, cx: &mut Context<Self>) {
        self.audio_picker = Some(crate::editor_audio::AudioPicker::Add { lane });
        self.camera3d_setup = None;
        self.set_selection(None, cx);
        cx.notify();
    }

    pub(crate) fn open_audio_replace(&mut self, index: usize, cx: &mut Context<Self>) {
        self.audio_picker = Some(crate::editor_audio::AudioPicker::Replace { index });
        self.camera3d_setup = None;
        cx.notify();
    }

    pub(crate) fn add_library_track(
        &mut self,
        id: &'static str,
        name: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = self.audio_picker else {
            return;
        };
        let project_path = self.project_path.clone();
        cx.spawn_in(window, async move |this, cx| {
            let imported = cx
                .background_executor()
                .spawn(
                    async move { crate::editor_audio::copy_library_track(&project_path, id, name) },
                )
                .await;
            match imported {
                Ok((path, name, duration)) => {
                    this.update_in(cx, |this, window, cx| {
                        this.commit_picked_audio(picker, path, name, duration, window, cx);
                    })
                    .ok();
                }
                Err(error) => tracing::error!("adding library audio failed: {error}"),
            }
        })
        .detach();
    }

    pub(crate) fn import_audio_from_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.audio_picker {
            Some(crate::editor_audio::AudioPicker::Add { lane }) => {
                self.import_audio_for_lane(lane, window, cx);
            }
            Some(crate::editor_audio::AudioPicker::Replace { index }) => {
                self.replace_audio_from_file(index, window, cx);
            }
            None => {}
        }
    }

    fn commit_picked_audio(
        &mut self,
        picker: crate::editor_audio::AudioPicker,
        path: String,
        name: String,
        duration: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match picker {
            crate::editor_audio::AudioPicker::Add { lane } => {
                self.commit_audio_import(
                    lane,
                    ImportedAudio {
                        path,
                        name,
                        duration,
                    },
                    window,
                    cx,
                );
            }
            crate::editor_audio::AudioPicker::Replace { index } => {
                self.replace_audio_segment(index, path, name, duration, window, cx);
            }
        }
        self.audio_picker = None;
    }

    fn replace_audio_from_file(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let project_path = self.project_path.clone();
        cx.spawn_in(window, async move |this, cx| {
            let Some(source) = crate::platform::open_audio_panel() else {
                return;
            };
            let imported = cx
                .background_executor()
                .spawn(async move { import_audio_file(&project_path, &source) })
                .await;
            match imported {
                Ok(imported) => {
                    this.update_in(cx, |this, window, cx| {
                        this.replace_audio_segment(
                            index,
                            imported.path,
                            imported.name,
                            imported.duration,
                            window,
                            cx,
                        );
                        this.audio_picker = None;
                    })
                    .ok();
                }
                Err(error) => tracing::error!("replacing audio failed: {error}"),
            }
        })
        .detach();
    }

    fn replace_audio_segment(
        &mut self,
        index: usize,
        path: String,
        name: String,
        duration: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let changed = self.edit(
            |timeline| {
                let Some(segment) = timeline.audio_segments.get_mut(index) else {
                    return false;
                };
                segment.path = path;
                segment.name = Some(name);
                segment.duration = (duration > 0.0).then_some(duration);
                true
            },
            window,
            cx,
        );
        if changed {
            self.note_edit("replace-audio", Some(TrackKind::Audio));
        }
    }

    /// `handleGenerateZoomSegments` (`TL/ZoomTrack.tsx:84-93`): read the
    /// recorded clicks off the bundle, run the auto-zoom pass, and land the
    /// result as the zoom track.
    fn generate_auto_zoom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.generating_auto_zoom {
            return;
        }
        self.generating_auto_zoom = true;
        cx.notify();
        let path = self.project_path.clone();
        let duration = self.recording_duration;
        let amount = f64::from(
            crate::store::GeneralSettings::load()
                .default_zoom_amount
                .unwrap_or(edits::DEFAULT_AUTO_ZOOM_AMOUNT as f32),
        );
        cx.spawn_in(window, async move |this, cx| {
            let segments = cx
                .background_executor()
                .spawn(async move {
                    let clicks = load_recording_clicks(&path);
                    edits::generate_zoom_segments_from_clicks(clicks, duration, amount)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.generating_auto_zoom = false;
                this.hovering_generate_zoom = false;
                if segments.is_empty() {
                    tracing::info!("auto zoom produced no segments");
                    cx.notify();
                    return;
                }
                edits::ensure_timeline(&mut this.project, &this.clip_display_durations);
                let applied = this.edit(
                    |timeline| {
                        timeline.zoom_segments = segments;
                        true
                    },
                    window,
                    cx,
                );
                if applied {
                    this.note_edit("generate-zoom", Some(TrackKind::Zoom));
                }
            })
            .ok();
        })
        .detach();
    }

    fn create_gap_segment(
        &mut self,
        kind: TrackKind,
        start: f64,
        end: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> usize {
        edits::ensure_timeline(&mut self.project, &self.clip_display_durations);
        let mut index = 0;
        self.edit(
            |timeline| {
                index = match kind {
                    TrackKind::ThreeD => edits::insert_camera3d_segment(
                        timeline,
                        edits::default_camera3d_segment(start, end),
                    ),
                    _ => {
                        edits::insert_zoom_segment(timeline, start, end, edits::DEFAULT_ZOOM_AMOUNT)
                    }
                };
                true
            },
            window,
            cx,
        );
        self.set_selection(Some(Selection::single(kind, index)), cx);
        index
    }

    fn add_segment_at_click(
        &mut self,
        kind: TrackKind,
        lane: u32,
        time: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !edits::ensure_timeline(&mut self.project, &self.clip_display_durations) {
            return;
        }
        let viewport_width: f32 = window.viewport_size().width.into();
        let secs_per_pixel = self.secs_per_pixel(viewport_width);
        let total = self.total_duration();
        let length = (1.0_f64).max(secs_per_pixel * 80.).min(total);
        if length <= 0.0 {
            return;
        }
        let Some(timeline) = self.project.timeline.as_ref() else {
            return;
        };
        let placement = match kind {
            TrackKind::Text => {
                let lane_segments: Vec<_> = timeline
                    .text_segments
                    .iter()
                    .filter(|segment| segment.track == lane)
                    .cloned()
                    .collect();
                edits::find_placement(&lane_segments, time, length, total)
            }
            TrackKind::Mask => {
                let lane_segments: Vec<_> = timeline
                    .mask_segments
                    .iter()
                    .filter(|segment| segment.track == lane)
                    .cloned()
                    .collect();
                edits::find_placement(&lane_segments, time, length, total)
            }
            TrackKind::Scene => {
                let max_duration = {
                    let next = timeline
                        .scene_segments
                        .iter()
                        .filter(|segment| segment.start > time)
                        .map(|segment| segment.start)
                        .min_by(|a, b| a.total_cmp(b));
                    let available = next.unwrap_or(total) - time;
                    3.0_f64.min(available)
                };
                if max_duration < 0.5 {
                    None
                } else {
                    Some((time, time + max_duration))
                }
            }
            _ => None,
        };
        let Some((start, end)) = placement else {
            return;
        };
        match kind {
            TrackKind::Text => self.tracks.text = self.tracks.text.max(lane + 1),
            TrackKind::Mask => self.tracks.mask = self.tracks.mask.max(lane + 1),
            TrackKind::Scene => self.tracks.scene = true,
            _ => {}
        }
        let mut index = 0;
        let inserted = self.edit(
            |timeline| {
                index = match kind {
                    TrackKind::Text => edits::insert_text_segment(
                        timeline,
                        edits::default_text_segment(start, end, lane),
                    ),
                    TrackKind::Mask => edits::insert_mask_segment(
                        timeline,
                        edits::default_mask_segment(start, end, lane),
                    ),
                    TrackKind::Scene => edits::insert_scene_segment(
                        timeline,
                        edits::default_scene_segment(start, end),
                    ),
                    _ => return false,
                };
                true
            },
            window,
            cx,
        );
        if !inserted {
            return;
        }
        self.set_selection(Some(Selection::single(kind, index)), cx);
        self.seek_to_time(time.clamp(start, end), cx);
        self.view.preview_time = None;
        self.audio_picker = None;
        self.note_edit("add-track", Some(kind));
    }

    fn close_camera3d_setup(&mut self, cx: &mut Context<Self>) {
        self.camera3d_setup = None;
        self.rebuild_timeline();
        cx.notify();
    }

    fn start_camera3d_setup(&mut self, cx: &mut Context<Self>) {
        self.set_selection(None, cx);
        self.audio_picker = None;
        self.tracks.three_d = true;
        self.camera3d_setup = Some(Camera3DSetup {
            scene_id: "showcase",
            shots: 3,
        });
        self.rebuild_timeline();
        cx.notify();
    }

    fn camera3d_setup_preview(&self) -> Vec<(f64, f64, String)> {
        let Some(setup) = self.camera3d_setup else {
            return Vec::new();
        };
        let Some(scene) = crate::editor_panels::CAMERA3D_SCENES
            .iter()
            .find(|scene| scene.id == setup.scene_id)
        else {
            return Vec::new();
        };
        let shots = setup.shots.clamp(1, scene.shots.len());
        let limited = crate::editor_panels::Camera3DScene {
            id: scene.id,
            name: scene.name,
            shots: &scene.shots[..shots],
        };
        let clip_cuts: Vec<f64> = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| {
                let mut acc = 0.0;
                timeline
                    .segments
                    .iter()
                    .map(|segment| {
                        acc += (segment.end - segment.start) / segment.timescale.max(0.0001);
                        acc
                    })
                    .collect()
            })
            .unwrap_or_default();
        crate::editor_panels::apply_scene_to_range(&limited, 0.0, self.total_duration(), &clip_cuts)
            .into_iter()
            .enumerate()
            .map(|(index, segment)| (segment.start, segment.end, format!("Shot {}", index + 1)))
            .collect()
    }

    pub(crate) fn confirm_camera3d_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(setup) = self.camera3d_setup else {
            return;
        };
        if self
            .project
            .timeline
            .as_ref()
            .is_some_and(|timeline| !timeline.camera3d_segments.is_empty())
        {
            return;
        }
        if !edits::ensure_timeline(&mut self.project, &self.clip_display_durations) {
            return;
        }
        let total = self.total_duration();
        let clip_cuts: Vec<f64> = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| {
                let mut acc = 0.0;
                timeline
                    .segments
                    .iter()
                    .map(|segment| {
                        acc += (segment.end - segment.start) / segment.timescale.max(0.0001);
                        acc
                    })
                    .collect()
            })
            .unwrap_or_default();
        let Some(scene) = crate::editor_panels::CAMERA3D_SCENES
            .iter()
            .find(|scene| scene.id == setup.scene_id)
        else {
            return;
        };
        let shots = setup.shots.clamp(1, scene.shots.len());
        let limited = crate::editor_panels::Camera3DScene {
            id: scene.id,
            name: scene.name,
            shots: &scene.shots[..shots],
        };
        let generated =
            crate::editor_panels::apply_scene_to_range(&limited, 0.0, total, &clip_cuts);
        if generated.is_empty() {
            return;
        }
        let inserted = self.edit(
            |timeline| {
                timeline.camera3d_segments.extend(generated);
                true
            },
            window,
            cx,
        );
        if !inserted {
            return;
        }
        self.camera3d_setup = None;
        self.tracks.three_d = true;
        self.set_selection(Some(Selection::single(TrackKind::ThreeD, 0)), cx);
        self.seek_to_time(0.0, cx);
        self.view.preview_time = None;
        self.note_edit("add-track", Some(TrackKind::ThreeD));
    }

    pub(crate) fn render_camera3d_setup(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let setup = self.camera3d_setup.unwrap_or(Camera3DSetup {
            scene_id: "showcase",
            shots: 3,
        });
        let scene = crate::editor_panels::CAMERA3D_SCENES
            .iter()
            .find(|scene| scene.id == setup.scene_id)
            .unwrap_or(&crate::editor_panels::CAMERA3D_SCENES[0]);
        let max_shots = ((self.total_duration() / crate::editor_panels::CAMERA3D_MIN_SHOT_DURATION)
            .floor() as usize)
            .clamp(1, scene.shots.len());
        let shots = setup.shots.min(max_shots);

        div()
            .id("camera3d-setup")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p(px(16.))
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        ui::EditorButton::plain(&theme, "camera3d-setup-close")
                            .left_icon("icons/x-mark.svg")
                            .icon_size(px(16.))
                            .label("Close")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.close_camera3d_setup(cx);
                            })),
                    )
                    .child(
                        div()
                            .text_size(px(14.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child("New 3D scene"),
                    ),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child("Lay a chain of camera moves over the whole video"),
            )
            .child(
                ui::Field::plain(&theme, "Style")
                    .icon("icons/rotate-3d.svg")
                    .child(div().flex().flex_row().gap(px(8.)).children(
                        crate::editor_panels::CAMERA3D_SCENES.iter().map(|item| {
                            let selected = item.id == scene.id;
                            let id = item.id;
                            div()
                                .id(SharedString::from(format!("camera3d-setup-{id}")))
                                .flex_1()
                                .px(px(10.))
                                .py(px(12.))
                                .rounded(px(12.))
                                .border_1()
                                .border_color(Hsla::from(if selected {
                                    theme.blue_9
                                } else {
                                    theme.gray_4
                                }))
                                .bg(Hsla::from(if selected {
                                    theme.gray_3
                                } else {
                                    theme.gray_2
                                }))
                                .cursor_pointer()
                                .tab_index(0)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(setup) = this.camera3d_setup.as_mut() {
                                        setup.scene_id = id;
                                    }
                                    this.rebuild_timeline();
                                    cx.notify();
                                }))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(Hsla::from(theme.gray_12))
                                        .child(item.name),
                                )
                                .child(
                                    div()
                                        .mt(px(4.))
                                        .text_size(px(10.))
                                        .text_color(Hsla::from(theme.gray_11))
                                        .child(format!(
                                            "{} {}",
                                            item.shots.len(),
                                            if item.shots.len() == 1 {
                                                "shot"
                                            } else {
                                                "shots"
                                            }
                                        )),
                                )
                        }),
                    )),
            )
            .child(
                ui::Field::plain(&theme, "How many shots?").child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(4.))
                                .p(px(4.))
                                .rounded(px(8.))
                                .bg(Hsla::from(theme.gray_3))
                                .children((1..=scene.shots.len()).map(|count| {
                                    let selected = shots == count;
                                    let too_short = count > max_shots;
                                    div()
                                        .id(SharedString::from(format!(
                                            "camera3d-setup-shots-{count}"
                                        )))
                                        .flex_1()
                                        .py(px(4.))
                                        .rounded(px(6.))
                                        .text_center()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(Hsla::from(theme.gray_11))
                                        .when(selected, |this| {
                                            this.bg(if theme.is_dark() {
                                                Hsla::from(theme.gray_5)
                                            } else {
                                                Hsla::from(theme.gray_1)
                                            })
                                            .text_color(Hsla::from(theme.gray_12))
                                        })
                                        .when(too_short, |this| this.opacity(0.4))
                                        .when(!too_short, |this| {
                                            this.cursor_pointer().tab_index(0).on_click(
                                                cx.listener(move |this, _, _, cx| {
                                                    if let Some(setup) =
                                                        this.camera3d_setup.as_mut()
                                                    {
                                                        setup.shots = count;
                                                    }
                                                    this.rebuild_timeline();
                                                    cx.notify();
                                                }),
                                            )
                                        })
                                        .child(count.to_string())
                                })),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(Hsla::from(theme.gray_10))
                                .child("Shots split the video into separate camera moves."),
                        ),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        ui::Button::plain(
                            &theme,
                            "camera3d-setup-add",
                            ui::ButtonVariant::Primary,
                            ui::ButtonSize::Md,
                        )
                        .label("Add scene")
                        .disabled(self.total_duration() <= 0.0)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.confirm_camera3d_setup(window, cx);
                        })),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "camera3d-setup-cancel",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Md,
                        )
                        .label("Cancel")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.close_camera3d_setup(cx);
                        })),
                    ),
            )
            .into_any_element()
    }

    /// `finish(e)`: resume the history, and -- if the drag never promoted --
    /// select instead, which also moves the playhead
    /// (`props.handleUpdatePlayhead(e)`).
    fn drag_mouse_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.drag_snap_targets = Vec::new();
        self.drag_snap_time = None;
        let Some(drag) = self.drag.take() else {
            self.clip_draft = None;
            return;
        };

        // The ghost trim's single commit, before the history resume below so
        // the resumed snapshot records the committed config.
        if matches!(
            drag.kind,
            DragKind::ClipTrimStart { .. } | DragKind::ClipTrimEnd { .. }
        ) {
            self.commit_clip_draft(window, cx);
        }

        if let DragKind::CreateZoom {
            base_start,
            base_end,
            created,
            ..
        } = drag.kind
        {
            // "If no movement, create a default 1-second segment"
            // (`TL/ZoomTrack.tsx:284-287`) -- `initialEndTime` is the ghost's
            // own end, which is where the drawn `+` box already was.
            if created.is_none() {
                self.create_gap_segment(drag.track, base_start, base_end, window, cx);
            }
        } else if !drag.moved && drag.selects_on_click {
            let selection = edits::click_selection(
                self.selection.as_ref(),
                drag.track,
                drag.index,
                drag.shift,
                drag.multi,
            );
            self.set_selection(selection, cx);
            self.seek_to_time(drag.press_time, cx);
        }

        if drag.paused {
            let config = self.project.clone();
            self.history.resume(&config);
        }
        if drag.moved {
            self.schedule_save(window, cx);
        }

        if matches!(
            drag.kind,
            DragKind::ClipTrimStart { .. } | DragKind::ClipTrimEnd { .. }
        ) {
            self.on_handle_released(cx);
        }

        self.note_edit(
            match (drag.moved, drag.kind) {
                (_, DragKind::CreateZoom { .. }) => "create",
                (true, DragKind::Move { .. }) => "move",
                (true, _) => "trim",
                (false, _) => "select",
            },
            Some(drag.track),
        );
        cx.notify();
    }

    /// `onHandleReleased` (`TL/ClipTrack.tsx:549-559`): a trim that shortened
    /// the project below the viewport pulls the viewport back over it.
    /// `normalizeClipTransitions` is the other half and is a no-op here --
    /// `effective_transition` already clamps a transition against the clips it
    /// joins on every read.
    fn on_handle_released(&mut self, cx: &mut Context<Self>) {
        let total = self.total_duration();
        let transform = self.view.transform;
        if transform.position + transform.zoom > total + 4. {
            let origin = self.view.preview_time.unwrap_or(self.playhead);
            self.view.transform.update_zoom(total, origin, total);
            self.note_transform("trim", Some(origin));
            cx.notify();
        }
    }

    /// The pointer over a track row: which segment it is on (the `group-hover`
    /// that reveals the trim handles) and, in split mode, where the cut would
    /// land (`splitPreview`, `TL/ClipTrack.tsx:827-838`).
    fn track_hover(
        &mut self,
        kind: TrackKind,
        lane: u32,
        window_x: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.drag.is_some() {
            return;
        }
        let viewport_width: f32 = window.viewport_size().width.into();
        let secs_per_pixel = self.secs_per_pixel(viewport_width);
        let x = self.content_x(window_x);
        let position = self.view.transform.position;
        let hit = edits::hit_test(
            self.timeline.segments(kind),
            lane,
            x,
            position,
            secs_per_pixel,
        );

        let hovered = match hit {
            Hit::Body { index } | Hit::Handle { index, .. } => Some((kind, lane, index)),
            Hit::Empty => None,
        };
        let mut changed = false;
        if self.hovered_segment != hovered {
            self.hovered_segment = hovered;
            changed = true;
        }

        let preview = match (self.split_mode, kind, hit) {
            (true, TrackKind::Clip, Hit::Body { index } | Hit::Handle { index, .. }) => {
                self.split_preview_at(index, x, secs_per_pixel, false)
            }
            _ => None,
        };
        if self.split_preview != preview {
            self.split_preview = preview;
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    /// `splitTimeAt(e)` (`TL/ClipTrack.tsx:666-682`): the pointer's output
    /// time, snapped to the nearest boundary unless Alt is held.
    fn split_preview_at(
        &self,
        index: usize,
        x: f64,
        secs_per_pixel: f64,
        alt: bool,
    ) -> Option<(f64, bool)> {
        let clip = self.timeline.clips.get(index)?;
        let timeline = self.project.timeline.as_ref()?;
        let raw = self.view.transform.position + x * secs_per_pixel;
        Some(edits::split_time_at(
            raw,
            clip.start,
            clip.end,
            SPLIT_SNAP_PX * secs_per_pixel,
            timeline,
            self.playhead,
            alt,
        ))
    }

    /// A press in split mode. On a clip it is `splitClipSegment(time, i)` with
    /// the snapped output time; on every other track it is that track's own
    /// `split*Segment(i, localTime)` with a plain fraction of the box
    /// (`TL/ZoomTrack.tsx:531-543`, `TL/MaskTrack.tsx:391-399`).
    #[allow(clippy::too_many_arguments)]
    fn split_at_pointer(
        &mut self,
        kind: TrackKind,
        index: usize,
        x: f64,
        secs_per_pixel: f64,
        alt: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if kind == TrackKind::Clip {
            let Some((time, _)) = self.split_preview_at(index, x, secs_per_pixel, alt) else {
                return;
            };
            if self.edit(
                |timeline| edits::split_clip_segment(timeline, time, Some(index)),
                window,
                cx,
            ) {
                self.set_selection(None, cx);
                self.note_edit("split", Some(TrackKind::Clip));
            }
            return;
        }
        if kind == TrackKind::ThreeD {
            let Some(segment) = self.timeline.segments(kind).get(index) else {
                return;
            };
            let left = (segment.start - self.view.transform.position) / secs_per_pixel;
            let width = (segment.end - segment.start) / secs_per_pixel;
            if width <= 0. {
                return;
            }
            let local = ((x - left) / width) * (segment.end - segment.start);
            if self.edit(
                |timeline| split_camera3d_segment(timeline, index, local),
                window,
                cx,
            ) {
                self.note_edit("split", Some(kind));
            }
            return;
        }
        let Some(segment) = self.timeline.segments(kind).get(index) else {
            return;
        };
        let left = (segment.start - self.view.transform.position) / secs_per_pixel;
        let width = (segment.end - segment.start) / secs_per_pixel;
        if width <= 0. {
            return;
        }
        let local = ((x - left) / width) * (segment.end - segment.start);
        if self.edit(
            |timeline| edits::split_segment(timeline, kind, index, local),
            window,
            cx,
        ) {
            self.note_edit("split", Some(kind));
        }
    }

    // -- Editing: the keyboard -----------------------------------------------

    /// The `Backspace` / `Delete` binding (`TL/index.tsx:963-1006`).
    ///
    /// Every track deletes its selected indices; the clip track alone walks
    /// them in reverse and refuses to empty itself, and the scene track's
    /// action takes one index at a time for the same reason.
    pub(crate) fn delete_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(selection) = self.selection.clone() else {
            return;
        };
        let deleted = self.edit(
            |timeline| edits::delete_segments(timeline, selection.track, &selection.indices),
            window,
            cx,
        );
        if deleted {
            self.set_selection(None, cx);
            self.note_edit("delete", Some(selection.track));
        }
    }

    /// `handleDeleteTrackLane` (`TL/index.tsx:497-555`): the red gutter button
    /// on a text/mask/audio row -- drop the lane's segments, renumber the
    /// lanes above it, and lower the lane count.
    fn delete_track_lane(
        &mut self,
        kind: TrackKind,
        lane: u32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.track == kind)
        {
            self.set_selection(None, cx);
        }
        self.edit(
            |timeline| edits::delete_track_lane(timeline, kind, lane),
            window,
            cx,
        );
        let count = match kind {
            TrackKind::Text => &mut self.tracks.text,
            TrackKind::Mask => &mut self.tracks.mask,
            TrackKind::Audio => &mut self.tracks.audio,
            _ => return,
        };
        let current = *count;
        let used = match (kind, self.project.timeline.as_ref()) {
            (TrackKind::Text, Some(timeline)) => edits::used_lane_count(&timeline.text_segments),
            (TrackKind::Mask, Some(timeline)) => edits::used_lane_count(&timeline.mask_segments),
            (TrackKind::Audio, Some(timeline)) => edits::used_lane_count(&timeline.audio_segments),
            _ => 0,
        };
        let next = used.max(current.saturating_sub(1));
        match kind {
            TrackKind::Text => self.tracks.text = next,
            TrackKind::Mask => self.tracks.mask = next,
            TrackKind::Audio => self.tracks.audio = next,
            _ => {}
        }
        self.hovered_gutter = None;
        self.rebuild_timeline();
        self.note_edit("delete-track", Some(kind));
        cx.notify();
    }

    /// `handleDeleteSingleTrack` (`TL/index.tsx:557-620`): caption and
    /// keyboard clear their segments and switch themselves off.
    fn delete_single_track(
        &mut self,
        kind: TrackKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.track == kind)
        {
            self.set_selection(None, cx);
        }
        match kind {
            TrackKind::Caption => {
                if let Some(captions) = self.project.captions.as_mut() {
                    captions.segments.clear();
                    captions.settings.enabled = false;
                }
                if let Some(timeline) = self.project.timeline.as_mut() {
                    timeline.caption_segments.clear();
                }
                self.tracks.caption = false;
            }
            TrackKind::Keyboard => {
                if let Some(keyboard) = self.project.keyboard.as_mut() {
                    keyboard.settings.enabled = false;
                }
                if let Some(timeline) = self.project.timeline.as_mut() {
                    timeline.keyboard_segments.clear();
                }
                self.tracks.keyboard = false;
            }
            _ => return,
        }
        self.hovered_gutter = None;
        self.project_changed(window, cx);
        self.note_edit("delete-track", Some(kind));
    }

    /// `handleClearTrackSegments` (`TL/index.tsx:624-644`): zoom, scene and 3D
    /// keep their row; the button clears every segment on it.
    fn clear_track_segments(
        &mut self,
        kind: TrackKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.track == kind)
        {
            self.set_selection(None, cx);
        }
        let cleared = self.edit(
            |timeline| match kind {
                TrackKind::Zoom => {
                    let had = !timeline.zoom_segments.is_empty();
                    timeline.zoom_segments.clear();
                    had
                }
                TrackKind::ThreeD => {
                    let had = !timeline.camera3d_segments.is_empty();
                    timeline.camera3d_segments.clear();
                    had
                }
                TrackKind::Scene => {
                    let had = !timeline.scene_segments.is_empty();
                    timeline.scene_segments.clear();
                    had
                }
                _ => false,
            },
            window,
            cx,
        );
        if cleared {
            self.hovered_gutter = None;
            self.note_edit("clear-track", Some(kind));
        }
    }

    /// The `C` binding (`TL/index.tsx:1007-1013`): cut the clip under
    /// `previewTime ?? playbackTime`. Works while playing, which is why it
    /// falls back to the playhead.
    fn split_at_playhead(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let time = self.view.preview_time.unwrap_or(self.playhead);
        if self.edit(
            |timeline| edits::split_clip_segment(timeline, time, None),
            window,
            cx,
        ) {
            self.set_selection(None, cx);
            self.note_edit("split", Some(TrackKind::Clip));
        }
    }

    /// `Cmd/Ctrl+A` (`TL/index.tsx:1019-1045`).
    fn select_all_on_track(&mut self, cx: &mut Context<Self>) {
        let Some(timeline) = self.project.timeline.as_ref() else {
            return;
        };
        let Some(selection) = self.selection.as_ref() else {
            return;
        };
        let count = edits::segment_count(timeline, selection.track);
        let next = edits::select_all_on_track(Some(selection), count);
        if next.is_some() {
            self.set_selection(next, cx);
            self.note_edit("select-all", self.selection.as_ref().map(|s| s.track));
        }
    }

    /// The scissors toggle -- `S` and the transport button
    /// (`Player.tsx:246-254, 409-427`).
    fn toggle_split_mode(&mut self, cx: &mut Context<Self>) {
        self.split_mode = !self.split_mode;
        if !self.split_mode {
            // `createEffect(() => { if (!split()) setSplitPreview(null) })`
            // (`TL/ClipTrack.tsx:566-568`).
            self.split_preview = None;
        }
        cx.notify();
    }

    /// A frame off the pump. `refresh` as well as `notify`: this window may be
    /// inactive when the first frame lands, and an inactive window repaints
    /// only when explicitly asked (the unit-2 finding).
    ///
    /// The refresh covers **every** frame delivered while inactive, not just
    /// the first: a deactivated editor measured 259 paints against 292
    /// delivered frames, because a plain `notify` on the preview entity leaves
    /// gpui free to coalesce. The engine-side half of the same finding is the
    /// fork's `will_draw` bypass -- a pending next-frame callback used to arm
    /// the inactive-window energy saver and cap fresh frames at 30fps.
    pub fn frame_arrived(
        &mut self,
        frame: EditorFrame,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let first_frame = self.latest_frame.is_none();
        let layout_changed = self.frame_layout != Some(frame.layout);
        if self.frame_layout.map(|layout| layout.output_size) != Some(frame.layout.output_size) {
            tracing::info!(
                output_size = ?frame.layout.output_size,
                display = ?frame.layout.display,
                camera = ?frame.layout.camera,
                active = window.is_window_active(),
                "editor frame size"
            );
        }
        tracing::debug!(number = frame.number, "editor frame");
        self.frame_layout = Some(frame.layout);
        // `createEffect(on(latestFrameLayout, () => { if (!dragging)
        // setDragRects(null) }))` (`CanvasElementsOverlay.tsx:214-222`): the
        // optimistic rect is dropped the moment the renderer agrees with it.
        let cleared_drag_rect = self.canvas_drag.is_none()
            && (self.canvas_drag_rect.take().is_some()
                || self.canvas_drag_camera_rect.take().is_some());
        let frame_size = (
            frame.layout.output_size[0] as f32,
            frame.layout.output_size[1] as f32,
        );
        self.latest_frame = Some(frame.frame.clone());
        // The composed frame supersedes the poster; free its atlas memory.
        self.poster = None;
        let previous = self.preview.update(cx, |preview, cx| {
            preview.set_frame(frame.frame, frame_size, self.stats.clone(), cx)
        });
        if let Some(EditorPreviewFrame::Image(previous)) = previous {
            let _ = window.drop_image(previous);
        }
        if let Some(stats) = &self.stats {
            stats.presented.fetch_add(1, Ordering::Relaxed);
        }
        if frame_layout_requires_editor_invalidation(
            first_frame,
            self.playing,
            layout_changed,
            cleared_drag_rect,
        ) {
            cx.notify();
        }
        // `refresh()` is a whole-window invalidation, so calling it per frame on
        // an inactive window rebuilds the sidebar, timeline and panels at 60Hz:
        // measured, that saturates the main thread and the pump drops 224 of 298
        // frames. The preview entity's own `notify` already marks the frame
        // dirty, and the fork's `will_draw` bypass is what lets a dirty frame
        // through the inactive-window throttle -- so the cheap half is enough
        // and this stays scoped to the first frame and the paused re-render.
        if !window.is_window_active() && (first_frame || !self.playing) {
            window.refresh();
        }
    }

    fn sync_appearance(&mut self, window: &Window, cx: &gpui::App) {
        self.theme.refresh(window, cx, false);
    }

    /// `NameEditor`'s commit (`Header.tsx:303-318`), verbatim.
    ///
    /// Return and Escape both call `blur()` there, and it is `onBlur` that
    /// does the work -- so **Escape commits rather than reverts** in the
    /// shipping app, and it does here too. The guard is the same: a trimmed
    /// name shorter than 5 or longer than 100 characters is rejected and the
    /// field snaps back to the stored one.
    fn on_name_event(
        &mut self,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // `onKeyDown`: Enter and Escape both blur, which is what commits.
            ui::TextInputEvent::Confirmed | ui::TextInputEvent::Cancelled => {
                let focus = self.focus.clone();
                window.focus(&focus, cx);
            }
            ui::TextInputEvent::Blurred => self.commit_pretty_name(cx),
            ui::TextInputEvent::Changed => {}
        }
    }

    fn commit_pretty_name(&mut self, cx: &mut Context<Self>) {
        let Some(stored) = self.summary().map(|summary| summary.pretty_name.clone()) else {
            return;
        };
        let draft = self.name_input.read(cx).text().trim().to_string();
        let count = draft.chars().count();
        if !(5..=100).contains(&count) || draft == stored {
            if draft != stored {
                self.name_input
                    .update(cx, |input, cx| input.set_text(stored, cx));
                cx.notify();
            }
            return;
        }

        // `set_pretty_name` (`apps/desktop/src-tauri/src/lib.rs:3175-3179`):
        // load the meta, replace one field, save it back. It is
        // `recording-meta.json`, not `project-config.json`, so it goes nowhere
        // near the debounced project write or the undo history -- the Tauri
        // history is `createStoreHistory` over the *project* store alone
        // (`ED/context.ts:1920-1930`), so a rename is not undoable there either.
        let path = self.project_path.clone();
        match RecordingMeta::load_for_project(&path) {
            Ok(mut meta) => {
                meta.pretty_name = draft.clone();
                match meta.save_for_project() {
                    Ok(()) => {
                        if let LoadState::Ready(summary) = &mut self.state {
                            summary.pretty_name = draft.clone();
                        }
                        tracing::info!(name = %draft, "renamed project");
                    }
                    Err(error) => {
                        tracing::error!(?error, "failed to save recording-meta.json");
                        self.name_input
                            .update(cx, |input, cx| input.set_text(stored, cx));
                    }
                }
            }
            Err(error) => {
                tracing::error!(?error, "failed to load recording-meta.json");
                self.name_input
                    .update(cx, |input, cx| input.set_text(stored, cx));
            }
        }
        cx.notify();
    }

    pub(crate) fn hex_input(
        &self,
        target: crate::editor_sidebar::ColorTarget,
    ) -> Option<&Entity<ui::TextInputState>> {
        self.hex_inputs.get(&target)
    }

    /// Create a hex field the first time a frame draws it, and subscribe to it.
    /// The three-line dance is the same one `new` does for the four the
    /// background tab always has.
    pub(crate) fn ensure_hex_input(
        &mut self,
        target: crate::editor_sidebar::ColorTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.hex_inputs.contains_key(&target) {
            return;
        }
        let input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        self.push_text_subscription(cx.subscribe_in(
            &input,
            window,
            move |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                this.on_hex_event(target, event, window, cx)
            },
        ));
        self.hex_inputs.insert(target, input);
    }

    /// `createWritableMemo(() => rgbToHex(props.value))`: each hex field
    /// re-derives from the colour whenever the colour moves under it -- the
    /// `NSColorPanel`, a preset swatch, an undo -- but never while it has
    /// focus, or it would fight what is being typed.
    ///
    /// It runs from `render` rather than from `render_rgb_input` because the
    /// focus test needs a `&Window` and the sidebar's render chain is threaded
    /// with `&self` alone.
    pub(crate) fn sync_hex_inputs(&mut self, window: &Window, cx: &mut Context<Self>) {
        for (target, input) in self.hex_inputs.clone() {
            let Some(value) = self.color_for(target) else {
                continue;
            };
            if input.read(cx).focus_handle().is_focused(window) {
                continue;
            }
            let hex = crate::editor_sidebar::rgb_to_hex(value);
            if input.read(cx).text() != hex {
                input.update(cx, |input, cx| input.set_text(hex, cx));
            }
        }
    }

    /// `RgbInput`'s three handlers (`color-utils.tsx:27-96`).
    ///
    /// * `onInput` commits live, but only once the text holds a complete
    ///   6- or 8-digit colour -- which is what stops `#4` from being read as
    ///   `#440044` halfway through a paste.
    /// * `onKeyDown` Enter and `onBlur` both commit, and both revert the text
    ///   to the value in force when the field was entered if it does not parse.
    fn on_hex_event(
        &mut self,
        target: crate::editor_sidebar::ColorTarget,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                let Some(input) = self.hex_input(target) else {
                    return;
                };
                let text = input.read(cx).text().to_string();
                let digits = crate::editor_sidebar::hex_digit_count(&text);
                if digits != 6 && digits != 8 {
                    return;
                }
                let Some(rgba) = crate::editor_sidebar::hex_to_rgb(text.trim()) else {
                    return;
                };
                let rgb = hex_to_color(rgba);
                if self.color_for(target) != Some(rgb) {
                    self.set_color(target, rgb, window, cx);
                }
            }
            ui::TextInputEvent::Confirmed | ui::TextInputEvent::Cancelled => {
                self.commit_hex(target, window, cx);
                let focus = self.focus.clone();
                window.focus(&focus, cx);
            }
            ui::TextInputEvent::Blurred => self.commit_hex(target, window, cx),
        }
    }

    /// The popover's own hex field -- the same three handlers as
    /// [`Self::on_hex_event`], but a commit also re-seats the picker's HSV so
    /// the field and hue thumb jump to the typed colour.
    fn on_picker_hex_event(
        &mut self,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                let text = self.picker_hex.read(cx).text().to_string();
                let digits = crate::editor_sidebar::hex_digit_count(&text);
                if digits != 6 && digits != 8 {
                    return;
                }
                if let Some(rgba) = crate::editor_sidebar::hex_to_rgb(text.trim()) {
                    self.apply_picker_rgb([rgba[0], rgba[1], rgba[2]], window, cx);
                }
            }
            ui::TextInputEvent::Confirmed | ui::TextInputEvent::Cancelled => {
                self.commit_picker_hex(window, cx);
                let focus = self.focus.clone();
                window.focus(&focus, cx);
            }
            ui::TextInputEvent::Blurred => self.commit_picker_hex(window, cx),
        }
    }

    fn commit_picker_hex(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.picker_hex.read(cx).text().trim().to_string();
        match crate::editor_sidebar::hex_to_rgb(&text) {
            Some(rgba) => {
                self.apply_picker_rgb([rgba[0], rgba[1], rgba[2]], window, cx);
                let rgb = crate::editor_sidebar::rgb_to_hex([
                    u16::from(rgba[0]),
                    u16::from(rgba[1]),
                    u16::from(rgba[2]),
                ]);
                self.picker_hex
                    .update(cx, |input, cx| input.set_text(rgb, cx));
            }
            None => {
                let current = self
                    .sidebar
                    .color_picker
                    .map(|picker| {
                        let rgb = picker.rgb();
                        crate::editor_sidebar::rgb_to_hex([
                            u16::from(rgb[0]),
                            u16::from(rgb[1]),
                            u16::from(rgb[2]),
                        ])
                    })
                    .unwrap_or_default();
                self.picker_hex
                    .update(cx, |input, cx| input.set_text(current, cx));
            }
        }
        cx.notify();
    }

    fn apply_picker_rgb(&mut self, rgb: [u8; 3], window: &mut Window, cx: &mut Context<Self>) {
        let (hue, sat, val) = ui::rgb_to_hsv(rgb);
        self.apply_picker_color(hue, sat, val, window, cx);
    }

    fn commit_hex(
        &mut self,
        target: crate::editor_sidebar::ColorTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(input) = self.hex_input(target).cloned() else {
            return;
        };
        let text = input.read(cx).text().trim().to_string();
        match crate::editor_sidebar::hex_to_rgb(&text) {
            Some(rgba) => {
                let rgb = hex_to_color(rgba);
                // `props.onChange(props.value)` on an invalid blur re-fires with
                // the value already in force; pushing a history step for a
                // no-op would cost the user an extra Cmd-Z for nothing.
                if self.color_for(target) != Some(rgb) {
                    self.set_color(target, rgb, window, cx);
                }
                input.update(cx, |input, cx| {
                    input.set_text(crate::editor_sidebar::rgb_to_hex(rgb), cx)
                });
            }
            // `if (!commitValue(..)) { setText(prevHex); props.onChange(props.value) }`
            None => {
                let current = self
                    .color_for(target)
                    .map(crate::editor_sidebar::rgb_to_hex)
                    .unwrap_or_default();
                input.update(cx, |input, cx| input.set_text(current, cx));
            }
        }
        cx.notify();
    }

    pub(crate) fn summary(&self) -> Option<&ProjectSummary> {
        match &self.state {
            LoadState::Ready(summary) => Some(summary),
            _ => None,
        }
    }

    /// `bg-gray-1 dark:bg-gray-2` -- the card/sidebar/panel surface. The
    /// editor takes the plain Radix values, not the material remaps: it is not
    /// a chrome route, so none of the `--macos-settings-*` overrides apply.
    pub(crate) fn panel_bg(&self) -> Hsla {
        if self.theme.is_dark() {
            self.theme.gray_2.into()
        } else {
            self.theme.gray_1.into()
        }
    }

    /// The root's `dark:bg-gray-1 bg-gray-2` (`routes/editor/index.tsx:46-57`).
    fn root_bg(&self) -> Hsla {
        if self.theme.is_dark() {
            self.theme.gray_1.into()
        } else {
            self.theme.gray_2.into()
        }
    }

    // -- Header --------------------------------------------------------------

    /// `EditorButton`: `group flex flex-row items-center px-1.5 gap-1.5 h-8
    /// rounded-lg text-[0.875rem]`, `disabled:opacity-50 disabled:text-gray-11`
    /// (`ui.tsx:317-334`).
    ///
    /// Every one of these is inert this unit -- see the README's deviation
    /// table -- so they all render in the disabled state rather than pretending
    /// to be live.
    /// The header's and player toolbar's unbuilt affordances, drawn at their
    /// real metrics in `EditorButton`'s disabled state -- the shared component
    /// the config sidebar's Reset and Import actions use live.
    fn editor_button(
        &self,
        icon: &'static str,
        label: Option<&'static str>,
        right_icon: Option<&'static str>,
        width: Option<f32>,
    ) -> impl IntoElement {
        ui::EditorButton::plain(&self.theme, icon)
            .disabled(true)
            .when_some(label, |this, label| this.label(label))
            .left_icon(icon)
            .when_some(right_icon, |this, icon| this.right_icon(icon))
            .when_some(width, |this, width| this.width(px(width)))
    }

    /// The header's undo and redo buttons (`Header.tsx:145-168`).
    ///
    /// Two quirks, both transcribed: the click **clears the timeline selection
    /// first** and only then walks the history, and the disabled predicate is
    /// `!canUndo() && !selection` -- so a button with nothing to undo is still
    /// enabled while something is selected, and pressing it just deselects.
    fn history_button(
        &self,
        id: &'static str,
        icon: &'static str,
        undo: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let can = if undo {
            self.history.can_undo()
        } else {
            self.history.can_redo()
        };
        let enabled = can || self.selection.is_some();
        ui::EditorButton::plain(&theme, id)
            .left_icon(icon)
            .disabled(!enabled)
            .on_click(cx.listener(move |this, _, window, cx| {
                if !(this.history.can_undo() || this.history.can_redo() || this.selection.is_some())
                {
                    return;
                }
                let had_selection = this.selection.is_some();
                if had_selection {
                    this.set_selection(None, cx);
                }
                if undo {
                    this.undo(window, cx);
                } else {
                    this.redo(window, cx);
                }
                window.refresh();
            }))
    }

    fn aspect_ratio_label(aspect: Option<&cap_project::AspectRatio>) -> &'static str {
        match aspect {
            None => "Auto",
            Some(cap_project::AspectRatio::Wide) => "Wide",
            Some(cap_project::AspectRatio::Vertical) => "Vertical",
            Some(cap_project::AspectRatio::Square) => "Square",
            Some(cap_project::AspectRatio::Classic) => "Classic",
            Some(cap_project::AspectRatio::Tall) => "Tall",
        }
    }

    fn toolbar_menu_items(&self, kind: ToolbarMenu) -> Vec<ui::MenuItem> {
        match kind {
            ToolbarMenu::AspectRatio => {
                const OPTIONS: &[(Option<cap_project::AspectRatio>, &str)] = &[
                    (None, "Auto"),
                    (Some(cap_project::AspectRatio::Wide), "Wide ⋅16:9"),
                    (Some(cap_project::AspectRatio::Vertical), "Vertical ⋅9:16"),
                    (Some(cap_project::AspectRatio::Square), "Square ⋅1:1"),
                    (Some(cap_project::AspectRatio::Classic), "Classic ⋅4:3"),
                    (Some(cap_project::AspectRatio::Tall), "Tall ⋅3:4"),
                ];
                OPTIONS
                    .iter()
                    .map(|(value, label)| {
                        ui::MenuItem::new(
                            *label,
                            aspect_ratio_eq(value, &self.project.aspect_ratio),
                        )
                    })
                    .collect()
            }
            ToolbarMenu::PreviewQuality => crate::store::EditorPreviewQuality::ALL
                .iter()
                .rev()
                .map(|quality| ui::MenuItem::new(quality.label(), *quality == self.preview_quality))
                .collect(),
        }
    }

    fn open_toolbar_menu(
        &mut self,
        kind: ToolbarMenu,
        origin: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        self.add_track = None;
        let items = self.toolbar_menu_items(kind);
        self.toolbar_menu = Some(OpenToolbarMenu {
            kind,
            state: ui::MenuState::new(origin, &items),
        });
        cx.notify();
    }

    fn toolbar_menu_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(menu) = self.toolbar_menu.as_mut() else {
            return false;
        };
        let kind = menu.kind;
        match menu.state.on_key(key) {
            ui::MenuKey::Moved => {
                cx.notify();
                true
            }
            ui::MenuKey::Commit(index) => {
                self.choose_toolbar_menu(kind, index, window, cx);
                true
            }
            ui::MenuKey::Dismiss => {
                self.toolbar_menu = None;
                cx.notify();
                true
            }
            ui::MenuKey::Ignored => false,
        }
    }

    fn choose_toolbar_menu(
        &mut self,
        kind: ToolbarMenu,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toolbar_menu = None;
        match kind {
            ToolbarMenu::AspectRatio => {
                const OPTIONS: [Option<cap_project::AspectRatio>; 6] = [
                    None,
                    Some(cap_project::AspectRatio::Wide),
                    Some(cap_project::AspectRatio::Vertical),
                    Some(cap_project::AspectRatio::Square),
                    Some(cap_project::AspectRatio::Classic),
                    Some(cap_project::AspectRatio::Tall),
                ];
                let Some(next) = OPTIONS.get(index).cloned() else {
                    return;
                };
                self.edit_project("aspect-ratio", window, cx, move |project| {
                    if aspect_ratio_eq(&project.aspect_ratio, &next) {
                        return false;
                    }
                    project.aspect_ratio = next;
                    true
                });
            }
            ToolbarMenu::PreviewQuality => {
                let Some(quality) = crate::store::EditorPreviewQuality::ALL
                    .iter()
                    .rev()
                    .nth(index)
                    .copied()
                else {
                    return;
                };
                self.set_preview_quality(quality, cx);
            }
        }
        cx.notify();
        window.refresh();
    }

    fn render_toolbar_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let menu = self.toolbar_menu.as_ref()?;
        let kind = menu.kind;
        let items = self.toolbar_menu_items(kind);
        Some(
            ui::Menu::plain(&self.theme, "toolbar-menu", items, &menu.state)
                .min_width(px(200.))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    this.choose_toolbar_menu(kind, *index, window, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _window, cx| {
                    this.toolbar_menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    fn set_preview_quality(
        &mut self,
        quality: crate::store::EditorPreviewQuality,
        cx: &mut Context<Self>,
    ) {
        if quality == self.preview_quality {
            return;
        }
        let was_playing = self.playing;
        let from = self.playhead;
        self.preview_quality = quality;
        let resolution = self.preview_resolution();
        if let Some(transport) = &self.transport {
            transport.set_resolution(resolution);
        }
        let value = serde_json::Value::String(quality.as_json().to_string());
        if !crate::store::set_store_setting(
            crate::store::GENERAL_SETTINGS,
            "editorPreviewQuality",
            value,
        ) {
            tracing::warn!("failed to persist preview quality");
        }
        if was_playing {
            self.stop_playback(cx);
            self.start_playback(from, cx);
        } else {
            self.publish_project();
        }
        cx.notify();
    }

    fn open_recording_bundle(&mut self, cx: &mut Context<Self>) {
        self.set_selection(None, cx);
        crate::library::open_recording_folder(
            &self.project_path,
            crate::library::RecordingMode::Studio,
        );
    }

    fn delete_recording(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_selection(None, cx);
        let path = self.project_path.clone();
        cx.spawn_in(window, async move |_this, cx| {
            let confirmed = crate::platform::confirm_dialog(
                "Cap",
                "Are you sure you want to delete this recording?",
                "Yes",
                "No",
                false,
            );
            if !confirmed {
                return;
            }
            _this
                .update_in(cx, |_this, window, _cx| {
                    window.remove_window();
                })
                .ok();
            cx.background_executor()
                .timer(Duration::from_millis(20))
                .await;
            let deleted = cx
                .background_executor()
                .spawn({
                    let path = path.clone();
                    async move { crate::library::delete_recording_directory(&path) }
                })
                .await;
            if let Err(error) = deleted {
                tracing::error!(path = %path.display(), "deleting the recording failed: {error}");
                return;
            }
            let _ = cx.update(|_window, cx| {
                crate::app_windows::refresh_library_after_delete(cx);
            });
        })
        .detach();
    }

    fn open_add_track(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.add_track.is_some() {
            self.add_track = None;
            cx.notify();
            return;
        }
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        self.toolbar_menu = None;
        let viewport = window.viewport_size();
        // The trigger is `absolute bottom-0 left-0` in the 32px timeline
        // header, itself under the slot's fixed geometry, so its top edge is a
        // constant offset from the window's bottom-left corner.
        let button_top = f32::from(viewport.height) - self.timeline_height + TIMELINE_TOP_PADDING;
        let bottom = f32::from(viewport.height) - (button_top - 8.);
        // `overflowPadding: 64` -- stay clear of the titlebar.
        let max_height = (button_top - 8. - 64.).max(160.);
        self.add_track = Some(AddTrackMenu {
            left: px(TIMELINE_SLOT_PADDING + TIMELINE_PADDING),
            bottom: px(bottom),
            max_height: px(max_height),
        });
        cx.notify();
    }

    fn open_presets_menu(
        &mut self,
        anchor: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.presets_menu.is_some() {
            self.presets_menu = None;
            cx.notify();
            return;
        }
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        self.toolbar_menu = None;
        let viewport = window.viewport_size();
        // `gutter={8}`, opening downward from the header trigger; `w-72`.
        let x = f32::from(anchor.x)
            .min(f32::from(viewport.width) - 288. - 12.)
            .max(12.);
        let y = f32::from(anchor.y) + 8.;
        self.presets_menu = Some(PresetsMenu {
            origin: point(px(x), px(y)),
            store: crate::presets::PresetsStore::load(),
            submenu: None,
            scroll: gpui::ScrollHandle::new(),
        });
        cx.notify();
    }

    /// Apply row `index`: the preset's config with the current timeline and
    /// clips kept -- one undo entry, like any other config edit.
    fn apply_preset_at(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.presets_menu.as_ref() else {
            return;
        };
        let Some(entry) = menu.store.presets.get(index) else {
            return;
        };
        let Some(next) = crate::presets::apply_preset(&entry.config, &self.project) else {
            tracing::warn!("preset {index} no longer deserializes; not applied");
            return;
        };
        self.presets_menu = None;
        self.refresh_animated_gradient_library();
        let previous_animated_gradient = self.animated_gradient_config().cloned();
        self.edit_project("apply-preset", window, cx, move |project| {
            *project = next.clone();
            true
        });
        self.sidebar.source_tab = crate::editor_sidebar::initial_source_tab(&self.project);
        self.close_color_picker(cx);
        self.remember_animated_gradient_selection(previous_animated_gradient, window, cx);
    }

    /// The submenu's store mutations: everything but Apply and the two
    /// dialog-opening rows.
    fn mutate_presets(
        &mut self,
        cx: &mut Context<Self>,
        mutate: impl FnOnce(&mut crate::presets::PresetsStore),
    ) {
        let Some(menu) = self.presets_menu.as_mut() else {
            return;
        };
        mutate(&mut menu.store);
        if !menu.store.save() {
            tracing::warn!("the presets store could not be written");
        }
        menu.submenu = None;
        cx.notify();
    }

    fn open_preset_dialog(
        &mut self,
        dialog: PresetDialog,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let prefill = match dialog {
            PresetDialog::Rename { index } => self
                .presets_menu
                .as_ref()
                .and_then(|menu| menu.store.presets.get(index))
                .map(|entry| entry.name.clone())
                .unwrap_or_default(),
            _ => String::new(),
        };
        // The dropdown closes when its dialog opens, as Kobalte's does.
        self.presets_menu = None;
        self.preset_dialog = Some(dialog);
        if !matches!(dialog, PresetDialog::Delete { .. }) {
            self.preset_name_input.update(cx, |input, cx| {
                input.set_text(prefill, cx);
                input.focus_and_select_all(window, cx);
            });
        }
        cx.notify();
    }

    fn commit_preset_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dialog) = self.preset_dialog else {
            return;
        };
        let name = self.preset_name_input.read(cx).text().trim().to_string();
        match dialog {
            PresetDialog::Create { default } => {
                if name.is_empty() {
                    return;
                }
                let config = crate::presets::preset_config(&self.project);
                let mut store = crate::presets::PresetsStore::load();
                store.create(name, config, default);
                if !store.save() {
                    tracing::warn!("the presets store could not be written");
                }
            }
            PresetDialog::Rename { index } => {
                if name.is_empty() {
                    return;
                }
                let mut store = crate::presets::PresetsStore::load();
                store.rename(index, name);
                if !store.save() {
                    tracing::warn!("the presets store could not be written");
                }
            }
            PresetDialog::Delete { index } => {
                let mut store = crate::presets::PresetsStore::load();
                store.delete(index);
                if !store.save() {
                    tracing::warn!("the presets store could not be written");
                }
            }
        }
        self.preset_dialog = None;
        let focus = self.focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    fn scene_available(&self) -> bool {
        self.has_camera && !self.project.camera.hide
    }

    fn toggle_track(
        &mut self,
        kind: TrackKind,
        next: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match kind {
            TrackKind::Caption => {
                self.edit_project("caption-enabled", window, cx, move |project| {
                    let captions = project
                        .captions
                        .get_or_insert_with(cap_project::CaptionsData::default);
                    if captions.settings.enabled == next {
                        return false;
                    }
                    captions.settings.enabled = next;
                    true
                });
                self.tracks.caption = next;
            }
            TrackKind::Keyboard => {
                self.edit_project("keyboard-enabled", window, cx, move |project| {
                    let keyboard = project
                        .keyboard
                        .get_or_insert_with(cap_project::KeyboardData::default);
                    if keyboard.settings.enabled == next {
                        return false;
                    }
                    keyboard.settings.enabled = next;
                    true
                });
                self.tracks.keyboard = next;
            }
            TrackKind::Scene => self.tracks.scene = next,
            TrackKind::ThreeD => {
                self.tracks.three_d = next;
                if next
                    && self
                        .project
                        .timeline
                        .as_ref()
                        .is_none_or(|timeline| timeline.camera3d_segments.is_empty())
                {
                    self.start_camera3d_setup(cx);
                    return;
                }
                if !next {
                    self.camera3d_setup = None;
                }
            }
            _ => return,
        }
        if !next
            && self
                .selection
                .as_ref()
                .is_some_and(|selection| selection.track == kind)
        {
            self.set_selection(None, cx);
        }
        self.rebuild_timeline();
        cx.notify();
        window.refresh();
    }

    fn add_track_kind(&mut self, kind: TrackKind, window: &mut Window, cx: &mut Context<Self>) {
        match kind {
            TrackKind::Audio => {
                let segments = self
                    .project
                    .timeline
                    .as_ref()
                    .map(|timeline| timeline.audio_segments.as_slice())
                    .unwrap_or(&[]);
                let lane_count = self.tracks.audio.max(edits::used_lane_count(segments));
                let lane = (0..lane_count)
                    .find(|lane| !segments.iter().any(|segment| segment.track == *lane))
                    .unwrap_or(lane_count);
                self.tracks.audio = lane_count.max(lane + 1);
                self.rebuild_timeline();
                self.open_audio_picker(lane, cx);
            }
            TrackKind::Text | TrackKind::Mask => {
                self.add_overlay_segment(kind, window, cx);
            }
            _ => {}
        }
        cx.notify();
        window.refresh();
    }

    fn add_overlay_segment(
        &mut self,
        kind: TrackKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !edits::ensure_timeline(&mut self.project, &self.clip_display_durations) {
            return;
        }
        let Some(timeline) = self.project.timeline.as_ref() else {
            return;
        };
        let viewport_width: f32 = window.viewport_size().width.into();
        let secs_per_pixel = self.secs_per_pixel(viewport_width);
        let total = self.total_duration();
        let length = (1.0_f64).max(secs_per_pixel * 80.).min(total);
        let time = self.playhead.max(0.0);
        let lane_count = match kind {
            TrackKind::Text => self
                .tracks
                .text
                .max(edits::used_lane_count(&timeline.text_segments)),
            TrackKind::Mask => self
                .tracks
                .mask
                .max(edits::used_lane_count(&timeline.mask_segments)),
            _ => return,
        };

        let mut lane = lane_count;
        let mut placement = None;
        for index in 0..lane_count {
            let candidate = match kind {
                TrackKind::Text => {
                    let lane_segments: Vec<_> = timeline
                        .text_segments
                        .iter()
                        .filter(|segment| segment.track == index)
                        .cloned()
                        .collect();
                    edits::place_segment_at_time(&lane_segments, time, length, total)
                }
                TrackKind::Mask => {
                    let lane_segments: Vec<_> = timeline
                        .mask_segments
                        .iter()
                        .filter(|segment| segment.track == index)
                        .cloned()
                        .collect();
                    edits::place_segment_at_time(&lane_segments, time, length, total)
                }
                _ => None,
            };
            if let Some(found) = candidate {
                lane = index;
                placement = Some(found);
                break;
            }
        }
        if placement.is_none() {
            placement = edits::place_segment_at_time(
                &[] as &[cap_project::TextSegment],
                time,
                length,
                total,
            );
        }
        let Some((start, end)) = placement else {
            match kind {
                TrackKind::Text => self.tracks.text += 1,
                TrackKind::Mask => self.tracks.mask += 1,
                _ => {}
            }
            self.rebuild_timeline();
            return;
        };

        self.tracks.text = if kind == TrackKind::Text {
            lane_count.max(lane + 1)
        } else {
            self.tracks.text
        };
        self.tracks.mask = if kind == TrackKind::Mask {
            lane_count.max(lane + 1)
        } else {
            self.tracks.mask
        };

        let inserted = self.edit(
            |timeline| {
                let index = match kind {
                    TrackKind::Text => edits::insert_text_segment(
                        timeline,
                        edits::default_text_segment(start, end, lane),
                    ),
                    TrackKind::Mask => edits::insert_mask_segment(
                        timeline,
                        edits::default_mask_segment(start, end, lane),
                    ),
                    _ => return false,
                };
                let _ = index;
                true
            },
            window,
            cx,
        );
        if !inserted {
            return;
        }
        let index = match kind {
            TrackKind::Text => self
                .project
                .timeline
                .as_ref()
                .and_then(|timeline| {
                    timeline
                        .text_segments
                        .iter()
                        .rposition(|segment| segment.start == start && segment.track == lane)
                })
                .unwrap_or(0),
            TrackKind::Mask => self
                .project
                .timeline
                .as_ref()
                .and_then(|timeline| {
                    timeline
                        .mask_segments
                        .iter()
                        .rposition(|segment| segment.start == start && segment.track == lane)
                })
                .unwrap_or(0),
            _ => 0,
        };
        self.set_selection(Some(Selection::single(kind, index)), cx);
        let pad = 0.15_f64.min(length / 4.0);
        let target = time.max(start + pad).min(end - pad);
        if (target - time).abs() > f64::EPSILON {
            self.seek_to_time(target, cx);
        }
        self.view.preview_time = None;
        self.note_edit("add-track", Some(kind));
    }

    fn import_audio_for_lane(&mut self, lane: u32, window: &mut Window, cx: &mut Context<Self>) {
        let project_path = self.project_path.clone();
        cx.spawn_in(window, async move |this, cx| {
            let Some(source) = crate::platform::open_audio_panel() else {
                return;
            };
            let imported = cx
                .background_executor()
                .spawn(async move { import_audio_file(&project_path, &source) })
                .await;
            match imported {
                Ok(imported) => {
                    this.update_in(cx, |this, window, cx| {
                        this.commit_audio_import(lane, imported, window, cx);
                        this.audio_picker = None;
                    })
                    .ok();
                }
                Err(error) => {
                    tracing::error!("importing audio failed: {error}");
                }
            }
        })
        .detach();
    }

    fn commit_audio_import(
        &mut self,
        lane: u32,
        imported: ImportedAudio,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let total = self.total_duration();
        let has_source = imported.duration > 0.0;
        let source_duration = if has_source { imported.duration } else { total };
        let length = edits::MIN_AUDIO_SEGMENT_DURATION.max(source_duration.min(if total > 0.0 {
            total
        } else {
            source_duration
        }));
        let max_start = (total - length).max(0.0);
        let start = self.playhead.max(0.0).min(max_start);
        let end = start + length;
        let path = imported.path.clone();
        let inserted = self.edit(
            |timeline| {
                edits::insert_audio_segment(
                    timeline,
                    edits::default_audio_segment(
                        start,
                        end,
                        lane,
                        imported.path,
                        imported.name,
                        has_source.then_some(imported.duration),
                    ),
                );
                true
            },
            window,
            cx,
        );
        if !inserted {
            return;
        }
        let segments = self
            .project
            .timeline
            .as_ref()
            .map(|timeline| timeline.audio_segments.as_slice())
            .unwrap_or(&[]);
        self.tracks.audio = edits::used_lane_count(segments).max(lane + 1);
        if let Some(index) = segments.iter().rposition(|segment| {
            segment.track == lane && segment.start == start && segment.path == path
        }) {
            self.set_selection(Some(Selection::single(TrackKind::Audio, index)), cx);
        }
        self.rebuild_timeline();
        self.note_edit("add-audio", Some(TrackKind::Audio));
        cx.notify();
        window.refresh();
    }

    fn open_clip_speed(
        &mut self,
        index: usize,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .clip_speed
            .as_ref()
            .is_some_and(|menu| menu.index == index)
        {
            self.clip_speed = None;
            cx.notify();
            return;
        }
        let focus = self.focus_handle_for_menu();
        window.focus(&focus, cx);
        self.clip_speed = Some(ClipSpeedMenu { index, origin });
        cx.notify();
    }

    fn set_clip_timescale(
        &mut self,
        index: usize,
        timescale: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(timeline) = self.project.timeline.as_mut() else {
            return;
        };
        if !edits::set_clip_segment_timescale(timeline, index, timescale) {
            return;
        }
        self.project_changed(window, cx);
        self.note_edit("clip-speed", Some(TrackKind::Clip));
    }

    fn set_clip_muted(
        &mut self,
        index: usize,
        muted: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(timeline) = self.project.timeline.as_mut() else {
            return;
        };
        if !edits::set_clip_muted(timeline, index, muted) {
            return;
        }
        self.project_changed(window, cx);
        self.note_edit("clip-mute", Some(TrackKind::Clip));
    }

    fn set_clip_speed_audio_mode(
        &mut self,
        index: usize,
        mode: ClipSpeedAudioMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(timeline) = self.project.timeline.as_mut() else {
            return;
        };
        if !edits::set_clip_segment_speed_audio_mode(timeline, index, mode) {
            return;
        }
        self.project_changed(window, cx);
        self.note_edit("clip-speed-audio", Some(TrackKind::Clip));
    }

    fn render_clip_speed_overlays(
        &self,
        model: &timeline::TimelineModel,
        viewport_width: f32,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let secs_per_pixel = self
            .view
            .transform
            .secs_per_pixel(timeline::content_width(viewport_width));
        let open = self.clip_speed.as_ref().map(|menu| menu.index);
        let hovered = match self.hovered_segment {
            Some((TrackKind::Clip, _, index)) => Some(index),
            _ => None,
        };
        let mut layer = div()
            .absolute()
            .left(px(timeline::TRACK_GUTTER))
            .right_0()
            .top_0()
            .bottom_0()
            .overflow_hidden();
        for (index, segment) in model.clips.iter().enumerate() {
            if !self
                .view
                .transform
                .segment_visible(segment.start, segment.end)
            {
                continue;
            }
            let active = open == Some(index);
            if !active && hovered != Some(index) {
                continue;
            }
            let x = ((segment.start - self.view.transform.position) / secs_per_pixel) as f32;
            let width = ((segment.end - segment.start) / secs_per_pixel) as f32;
            if width < 28. {
                continue;
            }
            layer = layer.child(
                div()
                    .id(gpui::ElementId::NamedInteger(
                        "clip-settings".into(),
                        index as u64,
                    ))
                    .absolute()
                    .left(px(x + 6.))
                    .bottom(px(6.))
                    .size(px(22.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .bg(gpui::hsla(0., 0., 0., if active { 0.5 } else { 0.3 }))
                    .hover(|this| this.bg(gpui::hsla(0., 0., 0., 0.5)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            this.open_clip_speed(index, event.position, window, cx);
                        }),
                    )
                    .child(
                        svg()
                            .path("icons/settings.svg")
                            .size(px(12.))
                            .text_color(gpui::white()),
                    ),
            );
        }
        layer.into_any_element()
    }

    fn render_clip_speed_popover(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let menu = self.clip_speed?;
        let theme = self.theme;
        let segment = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.segments.get(menu.index))?;
        let timescale = segment.timescale;
        let muted = segment.audio_muted;
        let audio_mode = segment.speed_audio_mode.unwrap_or_default();
        let speeds = [0.25, 0.5, 1.0, 1.5, 2.0, 4.0, 8.0];
        let audio_modes = [
            (ClipSpeedAudioMode::Mute, "Mute"),
            (ClipSpeedAudioMode::MaintainPitch, "Maintain pitch"),
            (ClipSpeedAudioMode::MatchSpeed, "Match speed"),
        ];
        let normal_speed = (timescale - 1.0).abs() < f64::EPSILON;
        let index = menu.index;
        let origin = menu.origin;
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("clip-speed-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.clip_speed = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .id("clip-speed-popover")
                        .absolute()
                        .left(px((f32::from(origin.x) - 8.).max(12.)))
                        .top(px((f32::from(origin.y) - 8. - 86.).max(12.)))
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_1))
                        .p(px(8.))
                        .shadow_lg()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|_, _, _, cx| cx.stop_propagation()),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(4.))
                                .rounded(px(8.))
                                .bg(Hsla::from(theme.gray_2))
                                .p(px(4.))
                                .children(speeds.into_iter().map(|speed| {
                                    let selected = (timescale - speed).abs() < 1e-6;
                                    let label = if (speed - speed.round()).abs() < 1e-6 {
                                        format!("{}x", speed.round() as i32)
                                    } else {
                                        format!("{speed}x")
                                    };
                                    div()
                                        .id(SharedString::from(format!("clip-speed-{speed}")))
                                        .rounded(px(6.))
                                        .px(px(8.))
                                        .py(px(4.))
                                        .text_size(px(12.))
                                        .cursor_pointer()
                                        .bg(if selected {
                                            Hsla::from(theme.gray_4)
                                        } else {
                                            gpui::transparent_black()
                                        })
                                        .text_color(Hsla::from(if selected {
                                            theme.gray_12
                                        } else {
                                            theme.gray_10
                                        }))
                                        .hover(|this| this.text_color(Hsla::from(theme.gray_12)))
                                        .child(label)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.set_clip_timescale(index, speed, window, cx);
                                        }))
                                })),
                        )
                        .when(!normal_speed, |popover| {
                            popover.child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(4.))
                                    .rounded(px(8.))
                                    .bg(Hsla::from(theme.gray_2))
                                    .p(px(4.))
                                    .children(audio_modes.into_iter().map(|(mode, label)| {
                                        let selected = audio_mode == mode;
                                        div()
                                            .id(SharedString::from(format!(
                                                "clip-speed-audio-{label}"
                                            )))
                                            .rounded(px(6.))
                                            .px(px(8.))
                                            .py(px(4.))
                                            .text_size(px(12.))
                                            .cursor_pointer()
                                            .bg(if selected {
                                                Hsla::from(theme.gray_4)
                                            } else {
                                                gpui::transparent_black()
                                            })
                                            .text_color(Hsla::from(if selected {
                                                theme.gray_12
                                            } else {
                                                theme.gray_10
                                            }))
                                            .hover(|this| {
                                                this.text_color(Hsla::from(theme.gray_12))
                                            })
                                            .child(label)
                                            .on_click(cx.listener(
                                                move |this, _, window, cx| {
                                                    this.set_clip_speed_audio_mode(
                                                        index, mode, window, cx,
                                                    );
                                                },
                                            ))
                                    })),
                            )
                        })
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(4.))
                                .rounded(px(8.))
                                .bg(Hsla::from(theme.gray_2))
                                .p(px(4.))
                                .child(
                                    div()
                                        .id("clip-speed-mute")
                                        .rounded(px(6.))
                                        .px(px(8.))
                                        .py(px(4.))
                                        .text_size(px(12.))
                                        .cursor_pointer()
                                        .bg(if muted {
                                            Hsla::from(theme.gray_4)
                                        } else {
                                            gpui::transparent_black()
                                        })
                                        .text_color(Hsla::from(if muted {
                                            theme.gray_12
                                        } else {
                                            theme.gray_10
                                        }))
                                        .hover(|this| this.text_color(Hsla::from(theme.gray_12)))
                                        .child(if muted { "Unmute clip" } else { "Mute clip" })
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.set_clip_muted(index, !muted, window, cx);
                                        })),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    fn render_add_track_popover(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let menu = self.add_track?;
        let theme = self.theme;
        let scene_available = self.scene_available();
        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("add-track-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.add_track = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .id("add-track-popover")
                        .absolute()
                        .left(menu.left)
                        .bottom(menu.bottom)
                        .w(px(336.))
                        .max_h(menu.max_height)
                        .flex()
                        .flex_col()
                        .overflow_hidden()
                        .rounded(px(16.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_1))
                        .shadow_lg()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_none()
                                .gap(px(2.))
                                .px(px(16.))
                                .pt(px(14.))
                                .pb(px(12.))
                                .border_b_1()
                                .border_color(Hsla::from(theme.gray_3))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(Hsla::from(theme.gray_12))
                                        .child("Add a track"),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(Hsla::from(theme.gray_10))
                                        .child("Layer captions, audio, zooms and more onto your timeline."),
                                ),
                        )
                        .child(
                            div()
                                .id("add-track-list")
                                .flex()
                                .flex_col()
                                .flex_1()
                                .gap(px(2.))
                                .p(px(6.))
                                .min_h_0()
                                .overflow_y_scroll()
                                .children(ADD_TRACK_OPTIONS.iter().copied().map(|kind| {
                                    let available = kind != TrackKind::Scene || scene_available;
                                    let active = self.tracks.is_active(kind);
                                    let count = self.tracks.count(kind);
                                    let description = if available {
                                        kind.picker_description()
                                    } else {
                                        kind.picker_unavailable()
                                    };
                                    let color = kind.color();
                                    div()
                                        .id(SharedString::from(format!("add-track-{kind:?}")))
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .gap(px(12.))
                                        .p(px(8.))
                                        .rounded(px(12.))
                                        .when(!available, |this| this.opacity(0.55))
                                        .when(available, |this| {
                                            this.cursor_pointer().hover(|this| this.bg(Hsla::from(theme.gray_3)))
                                        })
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .size(px(36.))
                                                .rounded(px(10.))
                                                .flex_none()
                                                .bg(if available {
                                                    color
                                                } else {
                                                    Hsla::from(theme.gray_3)
                                                })
                                                .child(
                                                    svg()
                                                        .path(kind.icon())
                                                        .size(px(16.))
                                                        .text_color(if available {
                                                            gpui::white()
                                                        } else {
                                                            Hsla::from(theme.gray_10)
                                                        }),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .flex()
                                                .flex_col()
                                                .flex_1()
                                                .min_w_0()
                                                .child(
                                                    div()
                                                        .flex()
                                                        .flex_row()
                                                        .items_center()
                                                        .gap(px(6.))
                                                        .text_size(px(13.))
                                                        .font_weight(FontWeight::MEDIUM)
                                                        .text_color(Hsla::from(theme.gray_12))
                                                        .child(kind.picker_label())
                                                        .when(kind.supports_multiple() && count > 0, |this| {
                                                            this.child(
                                                                div()
                                                                    .rounded_full()
                                                                    .min_w(px(16.))
                                                                    .px(px(6.))
                                                                    .text_size(px(10.))
                                                                    .font_weight(FontWeight::SEMIBOLD)
                                                                    .text_color(gpui::white())
                                                                    .bg(color)
                                                                    .child(format!("{count}")),
                                                            )
                                                        }),
                                                )
                                                .child(
                                                    div()
                                                        .text_size(px(11.))
                                                        .text_color(Hsla::from(theme.gray_10))
                                                        .child(description),
                                                ),
                                        )
                                        .child(if !kind.supports_multiple() && active {
                                            div()
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .size(px(24.))
                                                .rounded_full()
                                                .flex_none()
                                                .bg(color)
                                                .child(
                                                    svg()
                                                        .path("icons/check.svg")
                                                        .size(px(14.))
                                                        .text_color(gpui::white()),
                                                )
                                                .into_any_element()
                                        } else {
                                            div()
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .size(px(24.))
                                                .rounded_full()
                                                .flex_none()
                                                .border_1()
                                                .border_color(Hsla::from(theme.gray_5))
                                                .child(
                                                    svg()
                                                        .path("icons/plus.svg")
                                                        .size(px(14.))
                                                        .text_color(Hsla::from(theme.gray_10)),
                                                )
                                                .into_any_element()
                                        })
                                        .when(available, |this| {
                                            this.on_click(cx.listener(move |this, _, window, cx| {
                                                this.add_track = None;
                                                if kind.supports_multiple() {
                                                    this.add_track_kind(kind, window, cx);
                                                } else {
                                                    this.toggle_track(
                                                        kind,
                                                        !this.tracks.is_active(kind),
                                                        window,
                                                        cx,
                                                    );
                                                }
                                            }))
                                        })
                                })),
                        )
                        .child(
                            div()
                                .p(px(6.))
                                .flex_none()
                                .border_t_1()
                                .border_color(Hsla::from(theme.gray_3))
                                .child(
                                    div()
                                        .id("add-track-close")
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .justify_center()
                                        .gap(px(6.))
                                        .w_full()
                                        .h(px(36.))
                                        .rounded(px(8.))
                                        .border_1()
                                        .border_color(Hsla::from(theme.gray_4))
                                        .bg(Hsla::from(theme.gray_2))
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(Hsla::from(theme.gray_12))
                                        .cursor_pointer()
                                        .hover(|this| this.bg(Hsla::from(theme.gray_3)))
                                        .child(
                                            svg()
                                                .path("icons/x.svg")
                                                .size(px(14.))
                                                .text_color(Hsla::from(theme.gray_12)),
                                        )
                                        .child("Close")
                                        .on_click(cx.listener(|this, _, _window, cx| {
                                            this.add_track = None;
                                            cx.notify();
                                        })),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    /// `PresetsDropdown.tsx`'s menu: `w-72 max-h-56` on the dropdown palette
    /// (`rounded-xl border-gray-3 bg-gray-1 shadow-s`), a scrollable row list,
    /// and a bordered footer with "Create new preset". Each row applies on
    /// click; its gear opens the five-item submenu.
    fn render_presets_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let menu = self.presets_menu.as_ref()?;
        let theme = self.theme;
        let store = menu.store.clone();
        let submenu = menu.submenu;

        let rows: Vec<gpui::AnyElement> = if store.presets.is_empty() {
            vec![
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .h(px(40.))
                    .text_size(px(14.))
                    .text_color(Hsla::from(theme.gray_11))
                    .child("No Presets")
                    .into_any_element(),
            ]
        } else {
            store
                .presets
                .iter()
                .enumerate()
                .map(|(index, entry)| {
                    let is_default = store.default == Some(index);
                    div()
                        .id(SharedString::from(format!("preset-{index}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .flex_none()
                        .gap(px(8.))
                        .h(px(40.))
                        .px(px(8.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .hover(|this| this.bg(Hsla::from(theme.gray_3)))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(14.))
                                .text_color(Hsla::from(theme.gray_12))
                                .child(entry.name.clone()),
                        )
                        .when(is_default, |this| {
                            this.child(
                                div()
                                    .px(px(8.))
                                    .py(px(4.))
                                    .rounded_full()
                                    .flex_none()
                                    .text_size(px(11.))
                                    .bg(Hsla::from(theme.gray_2))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child("Default"),
                            )
                        })
                        .child(
                            div()
                                .id(SharedString::from(format!("preset-gear-{index}")))
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(24.))
                                .rounded(px(6.))
                                .flex_none()
                                .cursor_pointer()
                                .hover(|this| this.bg(Hsla::from(theme.gray_4)))
                                .child(
                                    svg()
                                        .path("icons/gear.svg")
                                        .size(px(16.))
                                        .text_color(Hsla::from(theme.gray_11)),
                                )
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .on_click(cx.listener(
                                    move |this, event: &gpui::ClickEvent, _window, cx| {
                                        cx.stop_propagation();
                                        if let Some(menu) = this.presets_menu.as_mut() {
                                            menu.submenu = match menu.submenu {
                                                Some((open, _)) if open == index => None,
                                                _ => Some((index, event.position())),
                                            };
                                        }
                                        cx.notify();
                                    },
                                )),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.apply_preset_at(index, window, cx);
                        }))
                        .into_any_element()
                })
                .collect()
        };

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("presets-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.presets_menu = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .absolute()
                        .left(menu.origin.x)
                        .top(menu.origin.y)
                        .w(px(288.))
                        .flex()
                        .flex_col()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_1))
                        .shadow_md()
                        .overflow_hidden()
                        .child(
                            div()
                                .id("presets-list")
                                .flex()
                                .flex_col()
                                .max_h(px(224.))
                                .min_h_0()
                                .p(px(6.))
                                .gap(px(2.))
                                .overflow_y_scroll()
                                .track_scroll(&menu.scroll)
                                .children(rows),
                        )
                        .child(
                            div()
                                .p(px(6.))
                                .border_t_1()
                                .border_color(Hsla::from(theme.gray_3))
                                .child(
                                    div()
                                        .id("preset-create")
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .gap(px(8.))
                                        .h(px(40.))
                                        .px(px(8.))
                                        .rounded(px(8.))
                                        .cursor_pointer()
                                        .hover(|this| this.bg(Hsla::from(theme.gray_3)))
                                        .text_size(px(14.))
                                        .text_color(Hsla::from(theme.gray_12))
                                        .child(div().flex_1().child("Create new preset"))
                                        .child(
                                            svg()
                                                .path("icons/circle-plus.svg")
                                                .size(px(16.))
                                                .text_color(Hsla::from(theme.gray_11)),
                                        )
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.open_preset_dialog(
                                                PresetDialog::Create { default: false },
                                                window,
                                                cx,
                                            );
                                        })),
                                ),
                        ),
                )
                .children(submenu.map(|(index, at)| self.render_preset_submenu(index, at, cx)))
                .into_any_element(),
        )
    }

    /// The per-preset submenu (`w-52`): Apply, Save settings to preset, Set
    /// as default, Rename, Delete.
    fn render_preset_submenu(
        &self,
        index: usize,
        at: gpui::Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let row = |id: SharedString, label: &'static str, danger: bool| {
            div()
                .id(id)
                .flex()
                .flex_row()
                .items_center()
                .h(px(32.))
                .px(px(8.))
                .rounded(px(6.))
                .cursor_pointer()
                .hover(move |this| this.bg(Hsla::from(theme.gray_3)))
                .text_size(px(13.))
                .text_color(if danger {
                    Hsla::from(theme.red_9)
                } else {
                    Hsla::from(theme.gray_12)
                })
                .child(label)
        };

        div()
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(208.))
            .flex()
            .flex_col()
            .p(px(4.))
            .gap(px(2.))
            .rounded(px(10.))
            .border_1()
            .border_color(Hsla::from(theme.gray_3))
            .bg(Hsla::from(theme.gray_1))
            .shadow_md()
            .child(
                row("preset-apply".into(), "Apply", false).on_click(cx.listener(
                    move |this, _, window, cx| {
                        this.apply_preset_at(index, window, cx);
                    },
                )),
            )
            .child(
                row("preset-save".into(), "Save settings to preset", false).on_click(cx.listener(
                    move |this, _, _window, cx| {
                        let config = crate::presets::preset_config(&this.project);
                        this.mutate_presets(cx, |store| store.save_to(index, config));
                    },
                )),
            )
            .child(
                row("preset-default".into(), "Set as default", false).on_click(cx.listener(
                    move |this, _, _window, cx| {
                        this.mutate_presets(cx, |store| store.set_default(index));
                    },
                )),
            )
            .child(
                row("preset-rename".into(), "Rename", false).on_click(cx.listener(
                    move |this, _, window, cx| {
                        this.open_preset_dialog(PresetDialog::Rename { index }, window, cx);
                    },
                )),
            )
            .child(
                row("preset-delete".into(), "Delete", true).on_click(cx.listener(
                    move |this, _, window, cx| {
                        this.open_preset_dialog(PresetDialog::Delete { index }, window, cx);
                    },
                )),
            )
            .into_any_element()
    }

    /// The three preset dialogs, centred over a dimmed backdrop like the
    /// Solid `Dialog.Root`s in `Editor.tsx`.
    fn render_preset_dialog(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let dialog = self.preset_dialog?;
        let theme = self.theme;

        let (title, primary, danger) = match dialog {
            PresetDialog::Create { .. } => ("Create Preset", "Create", false),
            PresetDialog::Rename { .. } => ("Rename Preset", "Rename", false),
            PresetDialog::Delete { .. } => ("Delete Preset", "Delete", true),
        };

        let body: gpui::AnyElement = match dialog {
            PresetDialog::Delete { index } => div()
                .text_size(px(14.))
                .text_color(Hsla::from(theme.gray_11))
                .child(SharedString::from(format!(
                    "Are you sure you want to delete \"{}\"?",
                    crate::presets::PresetsStore::load()
                        .presets
                        .get(index)
                        .map(|entry| entry.name.clone())
                        .unwrap_or_default()
                )))
                .into_any_element(),
            PresetDialog::Create { default } => div()
                .flex()
                .flex_col()
                .gap(px(16.))
                .child(
                    ui::TextInput::plain(&theme, "preset-name", &self.preset_name_input)
                        .padding_x(px(12.))
                        .height(px(36.))
                        .radius(px(8.))
                        .text_size(px(14.)),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(14.))
                                .text_color(Hsla::from(theme.gray_12))
                                .child("Set as default"),
                        )
                        .child(
                            ui::Toggle::plain(&theme, "preset-default", default)
                                .on_click(cx.listener(move |this, _, _window, cx| {
                                    this.preset_dialog =
                                        Some(PresetDialog::Create { default: !default });
                                    cx.notify();
                                }))
                                .into_any_element(),
                        ),
                )
                .into_any_element(),
            PresetDialog::Rename { .. } => div()
                .child(
                    ui::TextInput::plain(&theme, "preset-name", &self.preset_name_input)
                        .padding_x(px(12.))
                        .height(px(36.))
                        .radius(px(8.))
                        .text_size(px(14.)),
                )
                .into_any_element(),
        };

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .id("preset-dialog-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .bg(gpui::hsla(0., 0., 0., 0.5))
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.preset_dialog = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .w(px(400.))
                        .flex()
                        .flex_col()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_1))
                        .shadow_lg()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            div()
                                .px(px(16.))
                                .py(px(12.))
                                .border_b_1()
                                .border_color(Hsla::from(theme.gray_3))
                                .text_size(px(14.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(Hsla::from(theme.gray_12))
                                .child(title),
                        )
                        .child(div().p(px(16.)).child(body))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .justify_end()
                                .gap(px(8.))
                                .px(px(16.))
                                .pb(px(16.))
                                .child(
                                    ui::Button::plain(
                                        &theme,
                                        "preset-cancel",
                                        ui::ButtonVariant::Gray,
                                        ui::ButtonSize::Md,
                                    )
                                    .label("Cancel")
                                    .on_click(cx.listener(
                                        |this, _, _window, cx| {
                                            this.preset_dialog = None;
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(
                                    ui::Button::plain(
                                        &theme,
                                        "preset-confirm",
                                        if danger {
                                            ui::ButtonVariant::Destructive
                                        } else {
                                            ui::ButtonVariant::Blue
                                        },
                                        ui::ButtonSize::Md,
                                    )
                                    .label(primary)
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            this.commit_preset_dialog(window, cx);
                                        },
                                    )),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }

    /// The colour picker popover: backdrop for click-away, the panel itself,
    /// and -- while a thumb is being dragged -- a window-wide capture layer,
    /// because gpui has no pointer capture and the drag would die the moment
    /// the pointer left the 240px field.
    fn render_color_picker_popover(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let snapshot = self.sidebar.color_picker?;
        let theme = self.theme;
        let dragging = self.sidebar.color_drag.is_some();

        let hex_field = ui::TextInput::plain(&theme, "picker-hex", &self.picker_hex)
            .width(px(96.))
            .padding_x(px(6.))
            .padding_y(px(6.))
            .height(px(30.))
            .radius(px(8.))
            .bg(Hsla::from(theme.gray_1))
            .border(Hsla::from(theme.gray_12))
            .text_size(px(13.))
            .text_color(Hsla::from(theme.gray_12))
            .into_any_element();

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("color-picker-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.close_color_picker(cx);
                        })),
                )
                .child(
                    ui::ColorPicker::new(&theme, snapshot)
                        .hex_field(hex_field)
                        .on_sv_down(cx.listener(
                            |this, event: &gpui::MouseDownEvent, window, cx| {
                                this.sidebar.color_drag =
                                    Some(crate::editor_sidebar::ColorPickerDrag::Field);
                                this.picker_pointer(event.position, window, cx);
                            },
                        ))
                        .on_hue_down(cx.listener(
                            |this, event: &gpui::MouseDownEvent, window, cx| {
                                this.sidebar.color_drag =
                                    Some(crate::editor_sidebar::ColorPickerDrag::Hue);
                                this.picker_pointer(event.position, window, cx);
                            },
                        )),
                )
                .children(dragging.then(|| {
                    ui::Slider::drag_layer(
                        "color-picker-drag",
                        cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                            this.picker_pointer(event.position, window, cx);
                        }),
                        cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                            this.sidebar.color_drag = None;
                            cx.notify();
                        }),
                    )
                }))
                .into_any_element(),
        )
    }

    /// `Header.tsx:89-235` -- `h-14`, three groups, the middle one bracketed by
    /// `border-x border-black-transparent-10`.
    fn render_header(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let name_focused = self.name_input.read(cx).focus_handle().is_focused(window);

        let header = div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .flex_none()
            .when(cfg!(target_os = "windows"), |header| {
                header.window_control_area(gpui::WindowControlArea::Drag)
            })
            // Left group: `flex flex-row flex-1 gap-2 items-center px-4 h-full`.
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_w_0()
                    .gap(px(8.))
                    .items_center()
                    .px(px(16.))
                    .h_full()
                    .when(cfg!(target_os = "windows"), |group| group.occlude())
                    // The macOS spacer for the inset traffic lights: `h-full w-16`.
                    .when(!cfg!(target_os = "windows"), |group| {
                        group.child(div().h_full().w(px(64.)).flex_none())
                    })
                    .child(
                        ui::EditorButton::plain(&theme, "delete-recording")
                            .left_icon("icons/trash.svg")
                            .tooltip(&theme, "Delete recording")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.delete_recording(window, cx);
                            })),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "open-recording-bundle")
                            .left_icon("icons/folder.svg")
                            .tooltip(&theme, "Open recording bundle")
                            .on_click(cx.listener(|this, _, _window, cx| {
                                this.open_recording_bundle(cx);
                            })),
                    )
                    // `NameEditor` + the literal `.cap` suffix
                    // (`Header.tsx:123-126`), editable. The Solid version is an
                    // `<input>` overlaying a measuring `<span>`; here the field
                    // paints its own text, so the span is not needed and the
                    // `max-w-[200px]` sits on the field itself.
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .min_w_0()
                            .child(
                                // `px-px m-0 bg-transparent border-b
                                //  border-transparent focus:border-gray-7`
                                div()
                                    .max_w(px(200.))
                                    .border_b_1()
                                    .border_color(if name_focused {
                                        Hsla::from(theme.gray_7)
                                    } else {
                                        gpui::transparent_black()
                                    })
                                    .child(
                                        ui::TextInput::bare(
                                            &theme,
                                            "editor-name",
                                            &self.name_input,
                                        )
                                        // The measuring span's job: the field
                                        // is as wide as its value, capped by
                                        // the wrapper's `max-w-[200px]`.
                                        .fit_content()
                                        .padding_x(px(1.))
                                        .text_size(px(14.))
                                        .text_color(Hsla::from(theme.gray_12)),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child(".cap"),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .h_full()
                            .when(cfg!(target_os = "windows"), |area| {
                                area.occlude()
                                    .window_control_area(gpui::WindowControlArea::Drag)
                            }),
                    ),
            )
            // Centre group: `flex flex-row items-center justify-center gap-2
            // px-4 border-x border-black-transparent-10`.
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .px(px(16.))
                    .h_full()
                    .border_l_1()
                    .border_r_1()
                    .border_color(gpui::hsla(0., 0., 0., 0.1))
                    .when(cfg!(target_os = "windows"), |group| group.occlude())
                    .child(
                        ui::EditorButton::plain(&theme, "presets")
                            .left_icon("icons/presets.svg")
                            .label("Presets")
                            .right_icon("icons/chevron-down.svg")
                            .pressed(self.presets_menu.is_some())
                            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                                this.open_presets_menu(event.position(), window, cx);
                            })),
                    )
                    .child(self.editor_button(
                        "icons/building-2.svg",
                        Some("Sign in"),
                        Some("icons/chevron-down.svg"),
                        None,
                    )),
            )
            // Right group: `flex-1 h-full flex flex-row items-center gap-2
            // pl-2 pr-2`.
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(8.))
                    .pl(px(8.))
                    .pr(px(8.))
                    .h_full()
                    .when(cfg!(target_os = "windows"), |group| group.occlude())
                    .child(self.history_button("editor-undo", "icons/undo.svg", true, cx))
                    .child(self.history_button("editor-redo", "icons/redo.svg", false, cx))
                    .child(
                        div()
                            .flex_1()
                            .h_full()
                            .when(cfg!(target_os = "windows"), |area| {
                                area.occlude()
                                    .window_control_area(gpui::WindowControlArea::Drag)
                            }),
                    )
                    // `Button` (gray), `flex gap-1.5 justify-center h-[40px]`.
                    .child(self.render_clips_pill(cx))
                    // `<Show when={hasTranscript()}>` (`Header.tsx:74-77,
                    // 188`): the pill only exists once a transcript with words
                    // does.
                    .children(
                        self.project
                            .captions
                            .as_ref()
                            .is_some_and(|captions| {
                                captions
                                    .segments
                                    .iter()
                                    .any(|segment| !segment.words.is_empty())
                            })
                            .then(|| self.header_pill("icons/captions.svg", "Captions")),
                    )
                    .child(self.render_export_button(cx)),
            );

        #[cfg(target_os = "windows")]
        let header = header.child(ui::windows_caption_controls(
            theme,
            window.is_window_active(),
            window.is_maximized(),
            true,
            true,
        ));

        header
    }

    /// The Captions toggle: `Button variant="gray"` at
    /// `class="flex gap-1.5 justify-center h-[40px]"` (`Header.tsx:188-209`).
    /// Inert -- the transcript layout mode does not exist yet. Clips has its
    /// own live pill (`crate::editor_clips`).
    fn header_pill(&self, icon: &'static str, label: &'static str) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .h(px(40.))
            .px(px(12.))
            .rounded(px(12.))
            .flex_shrink_0()
            .bg(Hsla::from(theme.gray_3))
            .opacity(0.5)
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(Hsla::from(theme.gray_12))
            .child(
                svg()
                    .path(icon)
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_12)),
            )
            .child(label)
    }

    /// The Export button (`Header.tsx:210-231`): `h-[40px] max-w-[100px]
    /// text-[0.8125rem] font-medium text-white rounded-xl`, gradient
    /// `bg-linear-to-b from-[#3b82f6] to-[#2563eb]`.
    fn render_export_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("editor-export")
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .px(px(16.))
            .w(px(100.))
            .h(px(40.))
            .flex_none()
            .rounded(px(12.))
            .cursor_pointer()
            .bg(gpui::linear_gradient(
                180.,
                gpui::linear_color_stop(gpui::rgb(0x3b82f6), 0.),
                gpui::linear_color_stop(gpui::rgb(0x2563eb), 1.),
            ))
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(gpui::white())
            .child(
                svg()
                    .path("icons/upload-arrow.svg")
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(gpui::white()),
            )
            .child("Export")
            .on_click(cx.listener(|this, _, window, cx| this.open_export(window, cx)))
    }

    // -- Player --------------------------------------------------------------

    /// `PlayerContent` (`Player.tsx:288-483`): toolbar, canvas, transport.
    fn render_player(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                self.toolbar
                    .clone()
                    .cached(StyleRefinement::default().w_full().h(px(64.))),
            )
            .child(self.render_preview_canvas(cx))
            .child(
                self.transport_controls
                    .clone()
                    .cached(StyleRefinement::default().w_full().h(px(76.))),
            )
    }

    /// `flex items-center justify-between gap-3 p-3` (`Player.tsx:290`).
    fn render_player_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .p(px(12.))
            .flex_none()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        ui::EditorButton::plain(&theme, "aspect-ratio")
                            .left_icon("icons/layout.svg")
                            .label(Self::aspect_ratio_label(self.project.aspect_ratio.as_ref()))
                            .tooltip(&theme, "Aspect Ratio")
                            .pressed(
                                self.toolbar_menu
                                    .as_ref()
                                    .is_some_and(|menu| menu.kind == ToolbarMenu::AspectRatio),
                            )
                            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                                this.open_toolbar_menu(
                                    ToolbarMenu::AspectRatio,
                                    event.position(),
                                    window,
                                    cx,
                                );
                            })),
                    )
                    // `EditorButton tooltipText="Crop Video"`
                    // (`Player.tsx:293-299`) -> `cropDialogHandler`.
                    .child(
                        ui::EditorButton::plain(&theme, "crop")
                            .left_icon("icons/crop.svg")
                            .label("Crop")
                            .pressed(self.crop.is_some())
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_crop(window, cx);
                            })),
                    )
                    .child(self.render_frame_button(cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        // `text-xs font-medium text-gray-11`.
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_11))
                            .child("Preview quality"),
                    )
                    .child(
                        ui::Select::plain(&theme, "preview-quality", self.preview_quality.label())
                            .stretch_label()
                            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                                this.open_toolbar_menu(
                                    ToolbarMenu::PreviewQuality,
                                    event.position(),
                                    window,
                                    cx,
                                );
                            })),
                    ),
            )
    }

    /// `PreviewCanvas` (`Player.tsx:605-648`): a `relative flex-1` container
    /// with the frame centred inside it at its letterboxed size, over the
    /// canvas's `background-color: #000000`.
    ///
    /// On macOS the frame stays on the GPU end to end: the renderer blits into
    /// a BGRA IOSurface-backed CVPixelBuffer and gpui paints it directly via
    /// `paint_surface` -- the camera preview does the same through
    /// `paint_surface_fitted`. Elsewhere the picture arrives as a CPU
    /// `RenderedFrame`, gets un-padded and BGRA-swapped once, and goes through
    /// the sprite atlas.
    fn render_preview_canvas(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let body = match (&self.state, self.latest_frame.is_some()) {
            (LoadState::Failed(message), _) => self.render_error_state(message).into_any_element(),
            (_, true) => self
                .preview
                .clone()
                .cached(StyleRefinement::default().size_full())
                .into_any_element(),
            (state, false) => {
                if let Some(poster) = self.poster.clone() {
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            gpui::img(poster)
                                .size_full()
                                .object_fit(gpui::ObjectFit::Contain),
                        )
                        .into_any_element()
                } else {
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(14.))
                        .text_color(Hsla::from(theme.gray_11))
                        .child(if matches!(state, LoadState::Loading) {
                            "Loading project..."
                        } else {
                            "Rendering first frame..."
                        })
                        .into_any_element()
                }
            }
        };

        // `relative flex-1 justify-center items-center` -- no background of
        // its own; the player card's shows through the letterbox bars.
        div()
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(body)
            // `CanvasElementsOverlay` + `SnapGuidesOverlay`
            // (`Player.tsx:636-643`), both mounted inside the letterbox
            // wrapper and only while a frame exists.
            .children(self.render_canvas_overlay(cx))
    }

    /// `EditorErrorScreen` -- what a bundle that will not open shows instead of
    /// the canvas.
    fn render_error_state(&self, message: &str) -> impl IntoElement {
        let theme = self.theme;
        div()
            .absolute()
            .inset_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .p(px(32.))
            .child(
                svg()
                    .path("icons/triangle-alert.svg")
                    .size(px(32.))
                    .text_color(Hsla::from(theme.red_9)),
            )
            .child(
                div()
                    .text_size(px(16.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(gpui::white())
                    .child("This recording could not be opened"),
            )
            .child(
                div()
                    .max_w(px(520.))
                    .text_size(px(13.))
                    .text_color(Hsla::from(theme.gray_11))
                    .child(SharedString::from(message.to_string())),
            )
            .child(
                div()
                    .max_w(px(520.))
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child(SharedString::from(self.project_path.display().to_string())),
            )
    }

    /// One of the transport's two zoom glyphs. `factor` is the multiplier the
    /// source applies to `transform.zoom`, anchored on `playbackTime`.
    fn zoom_button(
        &self,
        id: &'static str,
        icon: &'static str,
        factor: f64,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(|this| this.opacity(0.7))
            .child(
                svg()
                    .path(icon)
                    .size(px(20.))
                    .text_color(Hsla::from(theme.gray_12)),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                let origin = this.playhead;
                this.zoom_by(factor, origin, cx);
                window.refresh();
            }))
    }

    /// The zoom slider's pointer maths, shared by the press and the drag.
    fn apply_zoom_slider(
        &mut self,
        position: Point<Pixels>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(fraction) = ui::slider_value_at(&self.zoom_slider_track, position, 0., 1., 0.001)
        else {
            return;
        };
        let total = self.total_duration();
        let origin = self.playhead;
        self.view.transform.apply_slider(fraction, origin, total);
        self.note_transform("slider", Some(origin));
        cx.notify();
    }

    /// The transport row (`Player.tsx:357-481`): `relative flex overflow-hidden
    /// z-10 flex-row gap-3 justify-between items-center p-5`.
    fn render_transport(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let total = self.total_duration();
        // `Math.max(editorState.previewTime ?? editorState.playbackTime, 0)`
        // (`Player.tsx:359-365`) -- the clock reads the *hover* time when there
        // is one, which is what makes it a readout for the ghost playhead.
        let current = self.view.preview_time.unwrap_or(self.playhead).max(0.0);
        let live = self.transport.is_some();
        // `{!editorState.playing || isAtEnd() ? <IconCapPlay/> :
        // <IconCapPause/>}` (`Player.tsx:388-392`).
        let icon = if !self.playing || self.is_at_end() {
            "icons/play.svg"
        } else {
            "icons/pause.svg"
        };

        div()
            .relative()
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .p(px(20.))
            .flex_none()
            .overflow_hidden()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(14.))
                    .child(
                        div()
                            .text_color(Hsla::from(theme.gray_12))
                            .child(timeline::format_time(current)),
                    )
                    .child(div().text_color(Hsla::from(theme.gray_11)).child(" / "))
                    .child(
                        div()
                            .text_color(Hsla::from(theme.gray_11))
                            .child(timeline::format_time(total)),
                    ),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_center()
                            .gap(px(32.))
                            .when(!live, |this| this.opacity(0.5))
                            .child(
                                div()
                                    .id("transport-prev")
                                    .tab_index(0)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .when(live, |this| this.cursor_pointer())
                                    .child(
                                        svg()
                                            .path("icons/prev.svg")
                                            .size(px(12.))
                                            .text_color(Hsla::from(theme.gray_12)),
                                    )
                                    .on_click(
                                        cx.listener(|this, _, _window, cx| this.jump_to_start(cx)),
                                    ),
                            )
                            // `rounded-full border border-gray-300 bg-gray-3 size-9`
                            // with `hover:bg-gray-4` -- [`ui::IconButton`].
                            .child(
                                ui::IconButton::new("transport-play", icon)
                                    .size(px(36.))
                                    .icon_size(px(12.))
                                    .color(Hsla::from(theme.gray_12))
                                    .filled(
                                        Hsla::from(theme.gray_3),
                                        Some(Hsla::from(theme.gray_5)),
                                    )
                                    .hover_bg(Hsla::from(theme.gray_4))
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.toggle_play(window, cx);
                                    })),
                            )
                            .child(
                                div()
                                    .id("transport-next")
                                    .tab_index(0)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .when(live, |this| this.cursor_pointer())
                                    .child(
                                        svg()
                                            .path("icons/next.svg")
                                            .size(px(12.))
                                            .text_color(Hsla::from(theme.gray_12)),
                                    )
                                    .on_click(
                                        cx.listener(|this, _, _window, cx| this.jump_to_end(cx)),
                                    ),
                            ),
                    ),
            )
            // `flex flex-row flex-1 gap-4 justify-end items-center`.
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .gap(px(16.))
                    .justify_end()
                    .items_center()
                    // The split toggle (`Player.tsx:409-427`): an
                    // `EditorButton variant="danger"` whose pressed state is
                    // `data-pressed:bg-red-300 data-pressed:text-gray-1`.
                    .child(
                        div()
                            .id("transport-split")
                            .tab_index(0)
                            .flex()
                            .flex_row()
                            .items_center()
                            .px(px(6.))
                            .h(px(32.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .when(self.split_mode, |this| this.bg(Hsla::from(theme.red_300)))
                            .when(!self.split_mode, |this| {
                                this.hover(|this| this.bg(Hsla::from(theme.gray_3)))
                            })
                            .child(svg().path("icons/scissors.svg").size(px(20.)).text_color(
                                if self.split_mode {
                                    Hsla::from(theme.gray_1)
                                } else {
                                    Hsla::from(theme.gray_12)
                                },
                            ))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.toggle_split_mode(cx);
                                window.refresh();
                            })),
                    )
                    // `w-px h-8 rounded-full bg-gray-4`.
                    .child(
                        div()
                            .w(px(1.))
                            .h(px(32.))
                            .rounded_full()
                            .bg(Hsla::from(theme.gray_4)),
                    )
                    // `IconCapZoomOut` -> `updateZoom(zoom * 1.1,
                    // playbackTime)`; `IconCapZoomIn` -> `zoom / 1.1`
                    // (`Player.tsx:432-449`). `will-change-[opacity]
                    // transition-opacity hover:opacity-70`.
                    .child(self.zoom_button("transport-zoom-out", "icons/zoom-out.svg", 1.1, cx))
                    .child(self.zoom_button("transport-zoom-in", "icons/zoom-in.svg", 1. / 1.1, cx))
                    // `Slider class="w-24" minValue={0} maxValue={1}
                    // step={0.001}`: the 32px row with its 5px track. Fully
                    // left is fully zoomed *out* -- the value is
                    // `1 - zoom / zoomOutLimit()` (`Player.tsx:444-465`).
                    .child(
                        ui::Slider::new(
                            "timeline-zoom",
                            self.view.transform.slider_fraction(total),
                            self.zoom_slider_track.clone(),
                        )
                        .row_width(px(96.))
                        // `class="relative px-1 h-8"` with the track at
                        // `h-[0.3rem]` = 4.8px (`ui.tsx:93, 107`).
                        .row_height(px(32.))
                        .track(px(4.8), Hsla::from(theme.gray_4))
                        // `KSlider.Fill class="bg-blue-9"` and
                        // `KSlider.Thumb class="bg-gray-1 dark:bg-gray-12
                        // border border-gray-6 size-4 -top-[6.3px]"`
                        // (`ui.tsx:118, 147`).
                        .fill(Hsla::from(theme.blue_9))
                        .thumb(
                            px(16.),
                            if theme.is_dark() {
                                Hsla::from(theme.gray_12)
                            } else {
                                Hsla::from(theme.gray_1)
                            },
                            Some(Hsla::from(theme.gray_6)),
                        )
                        .thumb_top(px(-6.3))
                        .on_drag_start(cx.listener(
                            |this, event: &MouseDownEvent, window, cx| {
                                this.zoom_slider_drag = true;
                                this.apply_zoom_slider(event.position, window, cx);
                            },
                        )),
                    ),
            )
    }

    // -- Timeline ------------------------------------------------------------

    /// The timeline strip at its default 260px, 1:1 and read-only.
    ///
    /// Source order top to bottom (`TL/index.tsx:1141-1500`): the minimap
    /// floating at `top: 2px`, the 32px ruler strip with the "Add track"
    /// trigger in its bottom-left and the scrub surface over the rest of it,
    /// the hover ghost, the playhead, and then the scroll body carrying one row
    /// per visible track behind the edge fade.
    ///
    /// Editing is live: the rows carry the press and hover handlers, and the
    /// root carries the window-wide move/up pair while a drag or a scrub is
    /// running. What is still absent is the track manager's popover and the
    /// minimap's own drag.
    fn render_timeline(&self, viewport_width: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let content_width = timeline::content_width(viewport_width);
        let live = self.transport.is_some();

        // While playing, the drawn line runs ahead by the wall-clock elapsed
        // since the last applied sample so the 60Hz ticker's redraws land
        // between events instead of on them -- but only once this play epoch
        // has actually produced a sample (`playhead_extrapolation`).
        let playhead_view = {
            let mut view = self.view;
            let ahead = playhead_extrapolation(
                self.playing,
                self.playhead_epoch_live,
                self.last_playhead_redraw.elapsed().as_secs_f64(),
            );
            if ahead > 0.0 {
                view.playhead = (view.playhead + ahead).min(self.total_duration());
            }
            view
        };
        let playhead_x = timeline::playhead_offset(playhead_view, content_width);
        let ghost_x = timeline::ghost_offset(self.view, content_width);

        let minimap_width = (viewport_width
            - TIMELINE_SLOT_PADDING * 2.
            - TIMELINE_PADDING
            - TRACK_GUTTER
            - TIMELINE_PADDING)
            .max(1.);

        div()
            .flex_none()
            .min_h_0()
            .px(px(TIMELINE_SLOT_PADDING))
            .overflow_hidden()
            .relative()
            // The persisted height, clamped to `[MIN_TIMELINE_HEIGHT,
            // layoutHeight - MIN_PLAYER_HEIGHT]` (`Editor.tsx:421-435`).
            // Nothing writes it yet -- the drag handle is inert -- so it sits
            // at the default with the floor still expressed.
            .h(px(self.timeline_height))
            .min_h(px(MIN_TIMELINE_HEIGHT))
            .child(
                div().h_full().child(
                    // `pt-8 relative overflow-hidden flex flex-col gap-2
                    // h-full`, `padding-left/right: 16px`.
                    div()
                        .id("timeline-container")
                        .relative()
                        .flex()
                        .flex_col()
                        .gap(px(TRACK_ROW_GAP))
                        .h_full()
                        .overflow_hidden()
                        .pt(px(TIMELINE_TOP_PADDING))
                        .pl(px(TIMELINE_PADDING))
                        .pr(px(TIMELINE_PADDING))
                        // The container's own `onMouseDown` -- a press
                        // anywhere in the timeline seeks to that point when it
                        // is released (`TL/index.tsx:1155-1169`). The ruler's
                        // dedicated surface below sits on top of it and takes
                        // precedence, exactly as its `z-40` does.
                        .when(live, |this| {
                            this.on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                                    this.timeline_mouse_down(event, false, window, cx);
                                }),
                            )
                            .on_mouse_up(
                                MouseButton::Left,
                                cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                                    this.timeline_mouse_up(cx)
                                }),
                            )
                        })
                        // `onMouseMove` -> `previewTime` (`:1170-1184`).
                        .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                            this.timeline_hover(f32::from(event.position.x), window, cx);
                        }))
                        .on_hover(cx.listener(|this, hovered: &bool, window, cx| {
                            if !*hovered {
                                this.timeline_hover_leave(window, cx);
                            }
                        }))
                        // `onWheel` (`:1189-1207`) and the pinch the webview
                        // would have delivered as `ctrl+wheel`.
                        .on_scroll_wheel(cx.listener(
                            |this, event: &gpui::ScrollWheelEvent, window, cx| {
                                this.timeline_wheel(event, window, cx);
                            },
                        ))
                        .on_pinch(cx.listener(|this, event: &gpui::PinchEvent, window, cx| {
                            this.timeline_pinch(event, window, cx);
                        }))
                        // The minimap: `absolute z-30` at `top: 2px`,
                        // `left: 128px`, `right: 16px`, `height: 12px`
                        // (`TL/index.tsx:1209-1219`). Read-only -- its drag,
                        // its two 8px resize handles and its click-to-centre
                        // are E4's.
                        .child(
                            div()
                                .absolute()
                                .top(px(MINIMAP_TOP))
                                .left(px(TIMELINE_PADDING + TRACK_GUTTER))
                                .right(px(TIMELINE_PADDING))
                                .h(px(MINIMAP_HEIGHT))
                                .child(timeline::render_minimap(
                                    &theme,
                                    &self.timeline,
                                    self.view,
                                    minimap_width,
                                )),
                        )
                        .child(self.render_timeline_header(viewport_width, live, cx))
                        .child(self.render_timeline_body(viewport_width, cx))
                        // The hover ghost (`TL/index.tsx:1246-1278`):
                        // `from-gray-400` with a `bg-gray-10` knob. Drawn only
                        // while paused and while the pointer is over the
                        // content column.
                        .children(ghost_x.map(|x| {
                            timeline::render_playhead(
                                Hsla::from(theme.gray_9),
                                x,
                                Hsla::from(theme.gray_10),
                            )
                        }))
                        // The playhead (`:1279-1295`). It dims to 50 % in
                        // split mode, where the cut line is the thing to
                        // watch (`TL/index.tsx:1281`).
                        .child(timeline::render_playhead_with_opacity(
                            timeline::playhead_color(),
                            playhead_x,
                            timeline::playhead_color(),
                            if self.split_mode { 0.5 } else { 1. },
                        ))
                        // The split preview (`TL/index.tsx:1296-1316`): a 1px
                        // column at the cut, blue with a rotated 8px diamond
                        // when it snapped to a boundary and grey otherwise.
                        .children(self.split_mode.then_some(()).and_then(|()| {
                            let (time, snapped) = self.split_preview?;
                            let x = ((time - self.view.transform.position)
                                / self.view.transform.secs_per_pixel(content_width))
                                as f32;
                            Some(render_split_preview(&theme, x, snapped))
                        }))
                        // The drag-snap guide: while a trim, move or create is
                        // magnetised onto an edge, a 1px blue column marks it.
                        .children(self.drag_snap_time.and_then(|time| {
                            let x = ((time - self.view.transform.position)
                                / self.view.transform.secs_per_pixel(content_width))
                                as f32;
                            x.is_finite().then(|| render_split_preview(&theme, x, true))
                        })),
                ),
            )
    }

    /// The 32px header strip (`TL/index.tsx:1220-1245`): the ruler, the "Add
    /// track" trigger over the gutter, and the scrub surface over everything
    /// right of `TRACK_GUTTER - START_SNAP_PX`.
    fn render_timeline_header(
        &self,
        viewport_width: f32,
        live: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .relative()
            .h(px(TIMELINE_HEADER_HEIGHT))
            .flex_none()
            .child(timeline::render_ruler(
                &self.theme,
                self.view,
                viewport_width,
            ))
            // `TrackManager`'s trigger (`TL/TrackManager.tsx:174-188`):
            // `h-8 w-full rounded-lg` with the app's blue gradient, at `z-30`
            // over the ruler. Its popover -- nine rows with descriptions,
            // toggles and lane counts -- is E4's, so the trigger is inert; it
            // is drawn **opaque** rather than at the 50 % wash the header's
            // other unbuilt affordances carry, because the ruler's leftmost
            // label sits underneath it (`TL/index.tsx:1227-1236` puts the
            // trigger above the markings for exactly that reason) and a
            // translucent button would let it bleed through.
            .child(
                div()
                    .id("add-track")
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .w(px(TRACK_ICON_WIDTH))
                    .h(px(32.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(4.))
                    .px(px(8.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .bg(gpui::linear_gradient(
                        180.,
                        gpui::linear_color_stop(gpui::rgb(0x3b82f6), 0.),
                        gpui::linear_color_stop(gpui::rgb(0x2563eb), 1.),
                    ))
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(gpui::white())
                    .child(
                        svg()
                            .path("icons/plus.svg")
                            .size(px(14.))
                            .flex_none()
                            .text_color(gpui::white()),
                    )
                    .child("Add track")
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(10.))
                            .flex_none()
                            .text_color(gpui::white()),
                    )
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|this, _: &gpui::ClickEvent, window, cx| {
                        this.open_add_track(window, cx);
                    })),
            )
            // `absolute inset-y-0 right-0 z-40` at
            // `left: TRACK_GUTTER - START_SNAP_PX` -- the ruler's scrub
            // surface, which reaches into the snap-to-zero zone so hitting
            // 0:00 is not a battle (`TL/index.tsx:1237-1244`).
            .when(live, |this| {
                this.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(TRACK_GUTTER - START_SNAP_PX as f32))
                        .right_0()
                        .cursor(gpui::CursorStyle::ResizeLeftRight)
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                                cx.stop_propagation();
                                this.timeline_mouse_down(event, true, window, cx);
                            }),
                        ),
                )
            })
    }

    /// The scroll body (`TL/index.tsx:1317-1499`): `relative flex-1 min-h-0`
    /// carrying the edge-fade mask, with `absolute inset-0 overflow-y-auto
    /// overflow-x-hidden pr-1` inside it and the rows in a `flex flex-col
    /// gap-2 min-h-full`.
    fn render_timeline_body(
        &self,
        viewport_width: f32,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let ui = timeline::SegmentUi {
            selection: self.selection.as_ref(),
            split_mode: self.split_mode,
            hovered: self.hovered_segment,
            dragging: self.drag.is_some(),
            audio_picker_lane: match self.audio_picker {
                Some(crate::editor_audio::AudioPicker::Add { lane }) => Some(lane),
                _ => None,
            },
            hovering_generate_zoom: self.hovering_generate_zoom,
        };
        // The ghost trim and its release animation draw from a patched copy
        // of the model; everything else draws the real one.
        let display = self.display_timeline_model();
        let model = display.as_ref().unwrap_or(&self.timeline);
        let mut rows = div()
            .flex()
            .flex_col()
            .gap(px(TRACK_ROW_GAP))
            .min_h_full()
            .w_full();

        let zoom_prompt = !self.zoom_prompt_dismissed
            && model.segments(TrackKind::Zoom).is_empty()
            && self
                .summary()
                .is_some_and(|summary| summary.has_cursor_data)
            && self.transport.is_some();
        for row in &model.rows {
            let kind = row.kind;
            let lane = row.lane;
            // `TrackRow`'s hover-reveal delete (`TL/index.tsx:1505-1546`):
            // caption/keyboard delete themselves, the multi-lane tracks delete
            // one lane, and zoom/3D/scene offer "Clear all" once they have
            // segments. The clip row has none.
            let delete_label = match kind {
                TrackKind::Clip => None,
                TrackKind::Caption | TrackKind::Keyboard => Some("Delete"),
                TrackKind::Text | TrackKind::Mask | TrackKind::Audio => Some("Delete"),
                TrackKind::Zoom | TrackKind::ThreeD | TrackKind::Scene => {
                    (!model.segments(kind).is_empty()).then_some("Clear all")
                }
            };
            rows = rows.child(
                div()
                    .id(gpui::ElementId::NamedInteger(
                        "timeline-row".into(),
                        (kind as usize as u64) << 16 | row.lane as u64,
                    ))
                    .relative()
                    // Every track sets `hoveredTrack` on enter and clears it
                    // on leave (`TL/ZoomTrack.tsx:170-171` and its eight
                    // siblings); the zoom and 3D tracks read it to decide
                    // whether to draw their new-segment ghost.
                    .on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
                        this.set_hovered_track(hovered.then_some(kind), window, cx);
                        if !*hovered
                            && this.hovered_segment.map(|(kind, lane, _)| (kind, lane))
                                == Some((kind, lane))
                        {
                            this.hovered_segment = None;
                            this.split_preview = None;
                            cx.notify();
                            let _ = window;
                        }
                    }))
                    // The per-segment hover the trim handles' reveal reads,
                    // and split mode's cut preview.
                    .on_mouse_move(
                        cx.listener(move |this, event: &MouseMoveEvent, window, cx| {
                            this.track_hover(kind, lane, f32::from(event.position.x), window, cx);
                        }),
                    )
                    // The press: a handle, a body or bare track, resolved by
                    // the same geometry the row was drawn from.
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            this.track_mouse_down(kind, lane, event, window, cx);
                        }),
                    )
                    .child(timeline::render_row(
                        &theme,
                        model,
                        *row,
                        self.view,
                        viewport_width,
                        ui,
                    ))
                    // The empty zoom track's generate prompt
                    // (`TL/ZoomTrack.tsx:297-336`): a centered button plus a
                    // session-dismiss X, shown while cursor data exists.
                    .children(
                        (kind == TrackKind::Clip)
                            .then(|| self.render_clip_speed_overlays(model, viewport_width, cx)),
                    )
                    .children((kind == TrackKind::Zoom && zoom_prompt).then(|| {
                        let generating = self.generating_auto_zoom;
                        div()
                            .id("zoom-generate-prompt")
                            .absolute()
                            .left(px(timeline::TRACK_GUTTER))
                            .right_0()
                            .top_0()
                            .bottom_0()
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_center()
                            .gap(px(4.))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|_, _, _, cx| cx.stop_propagation()),
                            )
                            .child(
                                div()
                                    .id("zoom-generate-hit")
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(4.))
                                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                        if this.hovering_generate_zoom != *hovered {
                                            this.hovering_generate_zoom = *hovered;
                                            cx.notify();
                                        }
                                    }))
                                    .child(
                                        ui::Button::plain(
                                            &theme,
                                            "zoom-generate",
                                            ui::ButtonVariant::Gray,
                                            ui::ButtonSize::Md,
                                        )
                                        .label(if generating {
                                            "Generating..."
                                        } else {
                                            "Click to generate zoom segments"
                                        })
                                        .disabled(generating)
                                        .on_click(
                                            cx.listener(|this, _, window, cx| {
                                                this.generate_auto_zoom(window, cx);
                                            }),
                                        ),
                                    )
                                    .child(
                                        ui::IconButton::new("zoom-generate-dismiss", "icons/x.svg")
                                            .size(px(32.))
                                            .icon_size(px(16.))
                                            .color(Hsla::from(theme.gray_11))
                                            .hover_bg(Hsla::from(theme.gray_5))
                                            .disabled(generating)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.zoom_prompt_dismissed = true;
                                                this.hovering_generate_zoom = false;
                                                cx.notify();
                                            })),
                                    ),
                            )
                    }))
                    .children(delete_label.map(|label| {
                        let hovered = self.hovered_gutter == Some((kind, lane));
                        div()
                            .id(gpui::ElementId::NamedInteger(
                                "track-gutter".into(),
                                (kind as usize as u64) << 16 | lane as u64,
                            ))
                            .absolute()
                            .left_0()
                            .top_0()
                            .w(px(timeline::TRACK_ICON_WIDTH))
                            .h(px(52.))
                            .on_hover(cx.listener(move |this, entered: &bool, _, cx| {
                                let next = if *entered {
                                    Some((kind, lane))
                                } else if this.hovered_gutter == Some((kind, lane)) {
                                    None
                                } else {
                                    this.hovered_gutter
                                };
                                if this.hovered_gutter != next {
                                    this.hovered_gutter = next;
                                    cx.notify();
                                }
                            }))
                            .when(hovered, |this| {
                                this.cursor_pointer()
                                    .tab_index(0)
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .justify_center()
                                    .gap(px(2.))
                                    .rounded(px(12.))
                                    .bg(gpui::linear_gradient(
                                        180.,
                                        gpui::linear_color_stop(gpui::rgb(0xef4444), 0.),
                                        gpui::linear_color_stop(gpui::rgb(0xdc2626), 1.),
                                    ))
                                    .text_color(gpui::white())
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(move |this, _, window, cx| {
                                            cx.stop_propagation();
                                            match kind {
                                                TrackKind::Caption | TrackKind::Keyboard => {
                                                    this.delete_single_track(kind, window, cx);
                                                }
                                                TrackKind::Text
                                                | TrackKind::Mask
                                                | TrackKind::Audio => {
                                                    this.delete_track_lane(kind, lane, window, cx);
                                                }
                                                TrackKind::Zoom
                                                | TrackKind::ThreeD
                                                | TrackKind::Scene => {
                                                    this.clear_track_segments(kind, window, cx);
                                                }
                                                TrackKind::Clip => {}
                                            }
                                        }),
                                    )
                                    .child(
                                        svg()
                                            .path("icons/trash.svg")
                                            .size(px(16.))
                                            .text_color(gpui::white()),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(10.))
                                            .line_height(px(10.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(label),
                                    )
                            })
                    })),
            );
        }

        div()
            .relative()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .id("timeline-scroll")
                    .absolute()
                    .inset_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.timeline_scroll)
                    .pr(px(SCROLL_BODY_PADDING_RIGHT))
                    .on_scroll_wheel(cx.listener(
                        |_this, event: &gpui::ScrollWheelEvent, window, cx| {
                            let pixels = event.delta.pixel_delta(window.line_height());
                            let delta_x = f32::from(pixels.x).abs();
                            let delta_y = f32::from(pixels.y).abs();
                            if !event.modifiers.control
                                && !event.modifiers.shift
                                && delta_x <= delta_y * 0.5
                            {
                                cx.stop_propagation();
                            }
                        },
                    ))
                    .child(rows),
            )
            // The `mask-image` edge fade (`TL/index.tsx:1097-1139`) as two
            // painted gradients; see `edge_fade_strengths` for why.
            .child(timeline::render_edge_fade(
                self.root_bg(),
                timeline::edge_fade_strengths(&self.timeline, self.view, viewport_width),
            ))
    }
}

/// The split-mode cut line (`TL/index.tsx:1296-1316`): `absolute bottom-0 z-20
/// w-px` from `PLAYHEAD_TOP_OFFSET`, `bg-blue-9` when it snapped to a boundary
/// and `bg-gray-10/70` when it did not, with a 8px `rotate-45` diamond on the
/// snapped one. gpui has no rotation, so the marker is a small square -- the
/// same missing transform hook the carousel's hover lift ran into.
fn render_split_preview(theme: &Theme, x: f32, snapped: bool) -> impl IntoElement {
    let color = if snapped {
        Hsla::from(theme.blue_9)
    } else {
        with_alpha(theme.gray_10, 0.7)
    };
    div()
        .absolute()
        .left(px(TIMELINE_PADDING + TRACK_GUTTER + x))
        .top(px(timeline::PLAYHEAD_TOP_OFFSET))
        .bottom_0()
        .w(px(1.))
        .bg(color)
        .when(snapped, |this| {
            this.child(
                div()
                    .absolute()
                    .top(px(-4.))
                    .left(px(-3.5))
                    .size(px(8.))
                    .rounded(px(1.))
                    .bg(color),
            )
        })
}

/// `isAtEnd()` (`Player.tsx:156-159`).
fn is_at_end(total: f64, playhead: f64) -> bool {
    total > 0.0 && total - playhead <= 0.1
}

/// The most the drawn playhead may run ahead of the last applied engine
/// sample. Big enough to bridge a render stall, small enough that a wrongly
/// anchored extrapolation cannot wander far.
const MAX_PLAYHEAD_EXTRAPOLATION: f64 = 0.25;

/// How far ahead of the last applied playhead sample the *drawn* line may
/// extrapolate, in seconds.
///
/// The Tauri editor draws `editorState.playbackTime` exactly where the last
/// engine event put it (`TL/index.tsx:1288`); this port extrapolates by the
/// wall clock between events so the 60Hz ticker's repaints land between them.
/// That extrapolation is only honest once the *current* play epoch has
/// produced a sample: pressing play flips `playing` immediately, but the
/// engine takes hundreds of milliseconds to come up (`start_playback` decodes
/// music tracks and warms the decoders), and the anchor instant still dates
/// from the previous epoch -- a seek echo or the last run's final frame. Off
/// a stale anchor the first paint after play drew the playhead up to 0.25s
/// ahead of where it stood, and the engine's first real sample snapped it
/// back: the "playhead jumps on play, then goes back" glitch. So: no epoch
/// sample yet, no extrapolation -- the line holds still, which is exactly
/// what the engine is doing.
fn playhead_extrapolation(playing: bool, epoch_has_sample: bool, since_last_sample: f64) -> f64 {
    if !playing || !epoch_has_sample {
        return 0.0;
    }
    since_last_sample.clamp(0.0, MAX_PLAYHEAD_EXTRAPOLATION)
}

fn is_playback_shortcut(keystroke: &gpui::Keystroke, text_input_focused: bool) -> bool {
    keystroke.key == "space" && !keystroke.modifiers.modified() && !text_input_focused
}

impl Render for EditorWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        // Fields first: a field created this frame has no text yet, and gpui
        // only renders on invalidation, so syncing before creating would leave
        // a brand-new box empty until something else asked for a frame.
        self.prepare_sidebar_fields(window, cx);
        self.prepare_animated_gradient_fields(window, cx);
        self.prepare_cursor_fields(window, cx);
        self.sync_hex_inputs(window, cx);
        self.sync_picker_hex(window, cx);
        self.prepare_frame_fields(window, cx);
        self.sync_crop_container(window);
        let theme = self.theme;
        // The timeline's own bounds are what `secsPerPixel` divides by, and
        // this window is resizable, so read them off the viewport rather than
        // assuming the default width.
        let viewport_width: f32 = window.viewport_size().width.into();
        let scrubbing = self.scrub.is_some() || self.drag.is_some();

        // `onMount`'s `checkBounds` (`TL/index.tsx:689-703`): once the
        // timeline has a width, zoom in until a segment would be at least
        // 80px. The source retries every 10ms until the bounds exist; here the
        // first render that knows both the width and a duration is that
        // moment, and `fitted` makes it once-only exactly as the mount hook is.
        if !self.fitted && self.total_duration() > 0.0 {
            self.fitted = true;
            let total = self.total_duration();
            self.view
                .transform
                .fit_on_mount(timeline::content_width(viewport_width), total);
        }

        if self.export.is_some() {
            return div()
                .size_full()
                .flex()
                .flex_col()
                .font_family("Geist")
                .bg(self.root_bg())
                .text_color(Hsla::from(theme.gray_12))
                .track_focus(&self.focus)
                .child(self.render_export_page(cx));
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            .bg(self.root_bg())
            .text_color(Hsla::from(theme.gray_12))
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::capture_playback_key))
            .on_key_down(cx.listener(Self::on_key))
            // Only the cropper needs key-*up*: its nudge loop runs until every
            // arrow is released (`Cropper.tsx:1025-1051`).
            .on_key_up(cx.listener(|this, event: &gpui::KeyUpEvent, _window, cx| {
                this.crop_key_up(event, cx);
            }))
            // A drag continues while the pointer is anywhere -- including
            // *outside the window*, which is what `createEventListenerMap(
            // window, {mousemove, mouseup})` gives the source
            // (`TL/index.tsx:938-955`). gpui element listeners are
            // hitbox-gated, so a release past the window edge would never
            // land and the drag would stay armed; window-level listeners are
            // not gated, and macOS keeps routing drag events to the mouse-down
            // window wherever the pointer is.
            .when(scrubbing, |this| {
                let move_editor = cx.entity().downgrade();
                let up_editor = cx.entity().downgrade();
                this.child(gpui::canvas(
                    |_bounds, _window, _cx| (),
                    move |_bounds, (), window, _cx| {
                        let editor = move_editor.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                            if phase != gpui::DispatchPhase::Bubble {
                                return;
                            }
                            let event = event.clone();
                            editor
                                .update(cx, |this, cx| {
                                    if !event.dragging() {
                                        // The release happened somewhere the
                                        // window never heard about (another
                                        // app, a system gesture): settle the
                                        // drag at its last state.
                                        this.window_mouse_up(cx);
                                        this.drag_mouse_up(window, cx);
                                        return;
                                    }
                                    this.timeline_mouse_move(&event, window, cx);
                                    this.drag_mouse_move(
                                        f32::from(event.position.x),
                                        event.modifiers.shift,
                                        window,
                                        cx,
                                    );
                                })
                                .ok();
                        });
                        let editor = up_editor.clone();
                        window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                            if phase != gpui::DispatchPhase::Bubble
                                || event.button != MouseButton::Left
                            {
                                return;
                            }
                            editor
                                .update(cx, |this, cx| {
                                    this.window_mouse_up(cx);
                                    this.drag_mouse_up(window, cx);
                                })
                                .ok();
                        });
                    },
                ))
            })
            .child(
                self.header
                    .clone()
                    .cached(StyleRefinement::default().w_full().h(px(HEADER_HEIGHT))),
            )
            // `flex overflow-y-hidden flex-col flex-1 gap-2 w-full min-h-0
            // leading-5` (`Editor.tsx:676`).
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .gap(px(8.))
                    .overflow_hidden()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_h_0()
                            .overflow_hidden()
                            // The split container: `flex overflow-hidden
                            // flex-row flex-1 min-h-0 px-2`, `min-height:
                            // MIN_PLAYER_HEIGHT`.
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .flex_1()
                                    .min_h_0()
                                    .px(px(8.))
                                    .overflow_hidden()
                                    .min_h(px(MIN_PLAYER_HEIGHT))
                                    // The player card: `flex flex-col
                                    // rounded-xl border bg-gray-1
                                    // dark:bg-gray-2 border-gray-3
                                    // overflow-hidden`, `flex: 1 1 0%`.
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .flex_1()
                                            .min_w_0()
                                            .min_h_0()
                                            .rounded(px(12.))
                                            .border_1()
                                            .border_color(Hsla::from(theme.gray_3))
                                            .bg(self.panel_bg())
                                            .overflow_hidden()
                                            .child(self.render_player(cx))
                                            // The 16px horizontal resize
                                            // handle with its three grip bars
                                            // (`Editor.tsx:700-725`). Inert:
                                            // resizing the timeline is E3.
                                            .child(
                                                div()
                                                    .id("timeline-resize-handle")
                                                    .h(px(RESIZE_HANDLE_HEIGHT))
                                                    .flex_none()
                                                    .flex()
                                                    .flex_col()
                                                    .gap(px(2.))
                                                    .items_center()
                                                    .justify_center()
                                                    .cursor(gpui::CursorStyle::ResizeRow)
                                                    .tab_index(0)
                                                    .border_t_1()
                                                    .border_color(if theme.is_dark() {
                                                        Hsla::from(theme.gray_5)
                                                    } else {
                                                        Hsla::from(theme.gray_4)
                                                    })
                                                    .bg(if theme.is_dark() {
                                                        with_alpha(theme.gray_3, 0.55)
                                                    } else {
                                                        with_alpha(theme.gray_2, 0.95)
                                                    })
                                                    .on_mouse_down(
                                                        MouseButton::Left,
                                                        cx.listener(
                                                            |this, event: &MouseDownEvent, _, cx| {
                                                                this.timeline_resize = Some((
                                                                    f32::from(event.position.y),
                                                                    this.timeline_height,
                                                                ));
                                                                cx.notify();
                                                            },
                                                        ),
                                                    )
                                                    .children((0..3).map(|_| {
                                                        div()
                                                            .h(px(2.))
                                                            .w(px(80.))
                                                            .rounded_full()
                                                            .bg(if theme.is_dark() {
                                                                Hsla::from(theme.gray_7)
                                                            } else {
                                                                Hsla::from(theme.gray_6)
                                                            })
                                                    })),
                                            ),
                                    )
                                    .child(
                                        self.sidebar_view.clone().cached(
                                            StyleRefinement::default()
                                                .w(px(SIDEBAR_WIDTH + 8.))
                                                .h_full(),
                                        ),
                                    ),
                            )
                            .child(
                                self.timeline_view.clone().cached(
                                    StyleRefinement::default()
                                        .w_full()
                                        .h(px(self.timeline_height)),
                                ),
                            ),
                    ),
            )
            // The zoom slider's window-wide drag layer, painted last so it is
            // over everything -- the same shape the settings window's sliders
            // use, because gpui has no pointer capture and a 96px row would
            // otherwise lose the drag the moment the pointer left it.
            .children(self.timeline_resize.is_some().then(|| {
                ui::Slider::drag_layer(
                    "timeline-height-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        let Some((start_y, start_height)) = this.timeline_resize else {
                            return;
                        };
                        let viewport_height: f32 = window.viewport_size().height.into();
                        let delta = f32::from(event.position.y) - start_y;
                        this.timeline_height =
                            this.clamp_timeline_height(start_height - delta, viewport_height);
                        cx.notify();
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                        this.timeline_resize = None;
                        cx.notify();
                    }),
                )
            }))
            .children(self.zoom_slider_drag.then(|| {
                ui::Slider::drag_layer(
                    "timeline-zoom-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.apply_zoom_slider(event.position, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                        this.zoom_slider_drag = false;
                        cx.notify();
                    }),
                )
            }))
            // The config sidebar's sliders take the same layer, for the same
            // reason -- and its release is what closes the undo bracket, so a
            // drag that ends outside the 32px row still records exactly one
            // history entry.
            .children(self.sidebar_dragging().then(|| {
                ui::Slider::drag_layer(
                    "sidebar-slider-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.sidebar_drag_move(event, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                        this.sidebar_mouse_up(cx);
                    }),
                )
            }))
            // The `PositionPad`s use it too: `createEventListenerMap(window,
            // {mousemove, mouseup})` is exactly what the pad's own press
            // installs (`ConfigSidebar.tsx:6264-6271`), and its release is
            // what closes the pad's undo bracket.
            .children(self.pad_dragging().then(|| {
                ui::Slider::drag_layer(
                    "sidebar-pad-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.pad_mouse_move(event.position, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                        this.pad_mouse_up(cx);
                    }),
                )
            }))
            // The canvas display drag: the source installs `mousemove` /
            // `mouseup` on `window` for the duration (`CEO.tsx:611-618`), so
            // a drag that leaves the letterboxed rect keeps tracking and the
            // release closes the undo bracket wherever it happens.
            .children(self.canvas_drag.is_some().then(|| {
                ui::Slider::drag_layer(
                    "canvas-display-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.canvas_mouse_move(event, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.canvas_mouse_up(window, cx);
                    }),
                )
            }))
            // The open `KSelect` menu, painted last of all so it is over the
            // sidebar and the drag layers alike.
            .children(self.render_sidebar_menu(cx))
            .children(self.render_toolbar_menu(cx))
            .children(self.render_frame_controls(window, cx))
            .children(self.render_add_track_popover(cx))
            .children(self.render_clip_speed_popover(cx))
            .children(self.render_color_picker_popover(cx))
            .children(self.render_presets_menu(cx))
            .children(self.render_preset_dialog(cx))
            // The clips overlays: import menu, record modal, and the card
            // drag's window-wide layer with its floating ghost.
            .children(self.render_clips_overlays(cx))
            // Crop mode is a modal: it goes over everything, including the
            // menu above.
            .children(self.render_crop_dialog(cx))
            // ...and its own pointer-capture stand-in over that, which is
            // `trackPointerSession`'s `setPointerCapture` + window listeners
            // (`Cropper.tsx:686-733`).
            .children(
                self.crop
                    .as_ref()
                    .is_some_and(|state| state.drag.is_some())
                    .then(|| {
                        ui::Slider::drag_layer(
                            "crop-drag",
                            cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                                this.crop_mouse_move(event, window, cx);
                            }),
                            cx.listener(|this, _: &MouseUpEvent, window, cx| {
                                this.crop_mouse_up(window, cx);
                            }),
                        )
                    }),
            )
    }
}

struct ImportedAudio {
    path: String,
    name: String,
    duration: f64,
}

fn import_audio_file(
    project_path: &std::path::Path,
    source: &std::path::Path,
) -> Result<ImportedAudio, String> {
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "Audio file has no extension".to_string())?;
    const EXTENSIONS: &[&str] = &["mp3", "wav", "m4a", "ogg", "flac", "aac"];
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("Unsupported audio format: .{extension}"));
    }
    if !source.exists() {
        return Err(format!("Audio file not found: {}", source.display()));
    }
    let display_name = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Audio")
        .to_string();
    let audio_dir = project_path.join("assets").join("audio");
    std::fs::create_dir_all(&audio_dir)
        .map_err(|error| format!("Failed to create audio directory: {error}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dest_name = format!("{stamp}.{extension}");
    let dest = audio_dir.join(&dest_name);
    std::fs::copy(source, &dest).map_err(|error| format!("Failed to copy audio file: {error}"))?;
    Ok(ImportedAudio {
        path: format!("assets/audio/{dest_name}"),
        name: display_name,
        duration: probe_audio_duration(&dest),
    })
}

fn probe_audio_duration(_path: &std::path::Path) -> f64 {
    0.0
}

fn aspect_ratio_eq(
    left: &Option<cap_project::AspectRatio>,
    right: &Option<cap_project::AspectRatio>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => std::mem::discriminant(left) == std::mem::discriminant(right),
        _ => false,
    }
}

fn split_camera3d_segment(timeline: &mut TimelineConfiguration, index: usize, at: f64) -> bool {
    let Some(segment) = timeline.camera3d_segments.get(index).cloned() else {
        return false;
    };
    let duration = segment.end - segment.start;
    if at < 1.0 || duration - at < 1.0 {
        return false;
    }
    let start_pose = crate::editor_panels::start_pose(&segment);
    let mid_pose = crate::editor_panels::evaluate_pose(&segment, at);
    let end_pose = crate::editor_panels::end_pose(&segment);
    let easing =
        crate::editor_panels::MOTION_EASINGS[crate::editor_panels::motion_easing(&segment)];
    let cut = segment.start + at;

    let mut right = segment.clone();
    right.start = cut;
    right.end = segment.end;
    right.tracks = Default::default();
    crate::editor_panels::set_motion(&mut right, &mid_pose, &end_pose, (easing.2, easing.3));

    let Some(left) = timeline.camera3d_segments.get_mut(index) else {
        return false;
    };
    left.end = cut;
    left.tracks = Default::default();
    crate::editor_panels::set_motion(left, &start_pose, &mid_pose, (easing.2, easing.3));
    timeline.camera3d_segments.insert(index + 1, right);
    true
}

fn with_alpha(color: gpui::Rgba, alpha: f32) -> Hsla {
    let mut hsla = Hsla::from(color);
    hsla.a = alpha;
    hsla
}

/// The instruction that actually produces a picture. `seek_to` and
/// `set_playhead_position` would move the playhead and render nothing --
/// the classic "the editor opened but the canvas is black" bug.
pub fn request_frame(instance: &EditorInstance, frame_number: u32, resolution: XY<u32>) {
    instance
        .preview_tx
        .send_modify(|value| *value = Some((frame_number, EDITOR_PREVIEW_FPS, resolution)));
}

/// Wrap the flume sender the pump drains into an `EditorFrameCallback`.
///
/// The renderer is already latest-wins (it drains its mpsc with `try_recv` and
/// discards all but the newest, `editor.rs:242-312`), so a small bounded
/// channel that drops on a full queue is the right backpressure here.
pub fn make_frame_callback(
    tx: flume::Sender<(EditorFrameOutput, FrameLayout)>,
    stats: Arc<PumpStats>,
) -> cap_editor::EditorFrameCallback {
    Box::new(move |output, layout| {
        stats.rendered.fetch_add(1, Ordering::Relaxed);
        #[cfg(target_os = "windows")]
        let sent = tx
            .send_timeout((output, layout), Duration::from_millis(100))
            .is_ok();
        #[cfg(not(target_os = "windows"))]
        let sent = tx.try_send((output, layout)).is_ok();

        if !sent {
            stats.dropped.fetch_add(1, Ordering::Relaxed);
        }
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn surface_preview_frame(frame: cap_rendering::SurfaceFrame) -> EditorPreviewFrame {
    let raw = frame.pixel_buffer.as_ref() as *const cidre::cv::PixelBuf as CVPixelBufferRef;
    let pixel_buffer = unsafe { CVPixelBuffer::wrap_under_get_rule(raw) };
    EditorPreviewFrame::Surface(pixel_buffer)
}

/// [`frame_image`], timed. The pump calls this so the CPU conversion's cost is
/// a number rather than a hunch.
pub fn frame_image_timed(frame: &RenderedFrame, stats: &PumpStats) -> Option<Arc<RenderImage>> {
    let started = Instant::now();
    let image = frame_image(frame);
    stats
        .convert_nanos
        .fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
    stats.convert_samples.fetch_add(1, Ordering::Relaxed);
    image
}

/// `hexToRgb` hands back RGBA bytes; `cap_project::Color` is `[u16; 3]` and
/// the alpha lives on the background source, not on the swatch.
fn hex_to_color(rgba: [u8; 4]) -> cap_project::Color {
    [rgba[0] as u16, rgba[1] as u16, rgba[2] as u16]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_shortcut_is_reserved_for_bare_space_outside_text_fields() {
        let space = gpui::Keystroke::parse("space").unwrap();
        assert!(is_playback_shortcut(&space, false));
        assert!(!is_playback_shortcut(&space, true));
        for key in [
            "enter",
            "s",
            "shift-space",
            "cmd-space",
            "ctrl-space",
            "alt-space",
        ] {
            let keystroke = gpui::Keystroke::parse(key).unwrap();
            assert!(!is_playback_shortcut(&keystroke, false), "{key}");
        }
    }

    /// `default_editor_preview_resolution()` is asserted to be 1248x702 in the
    /// Tauri app itself (`lib.rs:192-194`); the render size of a display
    /// recording follows from it.
    #[test]
    fn preview_resolution_matches_the_tauri_editor() {
        let base = default_preview_resolution();
        assert_eq!((base.x, base.y), (1248, 702));
        assert_eq!(
            preview_resolution(crate::store::EditorPreviewQuality::Full),
            XY::new(1920, 1080)
        );
        assert_eq!(
            preview_resolution(crate::store::EditorPreviewQuality::Quarter),
            XY::new(480, 270)
        );
    }

    #[test]
    fn letterbox_fits_a_wide_frame_by_width() {
        // A 1080x702 frame (aspect 1.538) in a 1000x900 container (aspect
        // 1.117 after padding): the frame is wider, so width wins.
        let (width, height) = letterbox((1000., 900.), (1080., 702.));
        assert_eq!(width, 992.);
        assert!((height - 992. / (1080. / 702.)).abs() < 0.001);
        assert!(height <= 892.);
    }

    #[test]
    fn letterbox_fits_a_tall_frame_by_height() {
        // A 720x1280 frame in a wide container: height wins.
        let (width, height) = letterbox((1000., 400.), (720., 1280.));
        assert_eq!(height, 392.);
        assert!((width - 392. * (720. / 1280.)).abs() < 0.001);
        assert!(width <= 992.);
    }

    #[test]
    fn letterbox_never_goes_negative() {
        // A container smaller than its own padding.
        let (width, height) = letterbox((4., 2.), (1920., 1080.));
        assert_eq!((width, height), (0., 0.));
    }

    #[test]
    fn letterbox_falls_back_to_the_container_aspect_for_a_degenerate_frame() {
        let (width, height) = letterbox((1000., 500.), (0., 0.));
        assert_eq!(width, 992.);
        assert!((width / height - 992. / 492.).abs() < 0.001);
    }

    #[test]
    fn animated_frame_layout_does_not_invalidate_editor_during_playback() {
        assert!(!frame_layout_requires_editor_invalidation(
            false, true, true, false
        ));
        assert!(!frame_layout_requires_editor_invalidation(
            false, true, false, false
        ));
        assert!(!frame_layout_requires_editor_invalidation(
            false, false, false, false
        ));
        assert!(frame_layout_requires_editor_invalidation(
            false, false, true, false
        ));
        assert!(frame_layout_requires_editor_invalidation(
            true, true, true, false
        ));
        assert!(frame_layout_requires_editor_invalidation(
            false, true, false, true
        ));
        assert!(frame_layout_requires_editor_invalidation(
            false, true, true, true
        ));
    }

    /// Every failure `EditorInstance::new` would return, plus the one it would
    /// panic on, has to come back as a message.
    #[test]
    fn preflight_rejects_a_missing_bundle() {
        let error = preflight(std::path::Path::new("/nonexistent/nope.cap")).unwrap_err();
        assert!(error.contains("not found"), "{error}");
    }

    #[test]
    fn preflight_rejects_a_bundle_with_no_meta() {
        let dir =
            std::env::temp_dir().join(format!("cap-gpui-preflight-{}.cap", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let error = preflight(&dir).unwrap_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(error.contains("recording meta"), "{error}");
    }

    // -- Playback ------------------------------------------------------------

    /// `isAtEnd()` is `total > 0 && total - playbackTime <= 0.1`
    /// (`Player.tsx:156-159`) -- the 0.1s slack is what stops the button from
    /// showing Pause over a playhead that has nowhere left to go, and it is
    /// what auto-stops playback before the engine's own end.
    #[test]
    fn end_of_media_uses_the_sources_tenth_of_a_second() {
        assert!(!is_at_end(0.0, 0.0), "an empty project is never at the end");
        assert!(!is_at_end(10.0, 9.89));
        assert!(is_at_end(10.0, 9.9));
        assert!(is_at_end(10.0, 10.0));
        // Overshoot -- the engine can report a frame past the timeline end.
        assert!(is_at_end(10.0, 10.4));
    }

    /// The play-press glitch: `playing` flips immediately, but the anchor
    /// instant still dates from the *previous* epoch (a seek echo, or the last
    /// run's final frame -- measured at 206ms and 1081ms in the probe run).
    /// Extrapolating from it drew the playhead up to 0.25s ahead and the
    /// engine's first sample snapped it back. A sample from a previous epoch
    /// must never anchor the drawn line.
    #[test]
    fn playhead_never_extrapolates_before_the_epochs_first_sample() {
        // Freshly pressed play, stale anchor: hold the line still.
        assert_eq!(playhead_extrapolation(true, false, 0.206), 0.0);
        assert_eq!(playhead_extrapolation(true, false, 1.081), 0.0);
        // Paused, no matter what the anchor says.
        assert_eq!(playhead_extrapolation(false, true, 0.5), 0.0);
        assert_eq!(playhead_extrapolation(false, false, 0.5), 0.0);
    }

    /// Once the epoch is live the line glides by the wall clock between
    /// samples, capped so a render stall cannot run it far ahead.
    #[test]
    fn playhead_extrapolation_tracks_the_wall_clock_and_caps() {
        assert_eq!(playhead_extrapolation(true, true, 0.016), 0.016);
        assert_eq!(
            playhead_extrapolation(true, true, 3.0),
            MAX_PLAYHEAD_EXTRAPOLATION
        );
        // A clock hiccup must not pull the playhead backwards.
        assert_eq!(playhead_extrapolation(true, true, -0.01), 0.0);
    }

    /// The perf gate's line. `frames` is what reached the window, `dropped`
    /// what the pump refused, and the rate is measured on *painted* frames.
    #[test]
    fn stats_report_is_a_rate_over_the_run() {
        let before = StatsSnapshot::default();
        let after = StatsSnapshot {
            rendered: 620,
            dropped: 20,
            presented: 600,
            painted: 600,
            convert_nanos: 600 * 1_500_000,
            convert_samples: 600,
        };
        let delta = after.since(before);
        assert_eq!(delta.convert_micros(), 1500.0);
        let report = delta.report(10.0);
        assert!(
            report.starts_with("playback fps=60.0 frames=600 dropped=20"),
            "{report}"
        );
        // The rate is delivered frames, never paints -- the window repaints
        // for the clock and the playhead too.
        let noisy_paints = StatsSnapshot {
            painted: 5_000,
            ..after
        }
        .since(before);
        assert!(
            noisy_paints.report(10.0).starts_with("playback fps=60.0 "),
            "paints must not inflate the frame rate"
        );
    }

    /// Playhead seconds come from the engine's frame number over the app's
    /// FPS -- `payload.playhead_position / FPS` (`Editor.tsx:485`).
    #[test]
    fn playhead_seconds_are_frames_over_fps() {
        assert_eq!(90.0 / EDITOR_PREVIEW_FPS as f64, 1.5);
        // And a seek rounds to the nearest frame, as `seekPlayheadTo` does.
        assert_eq!((1.5051 * EDITOR_PREVIEW_FPS as f64).round() as u32, 90);
    }

    /// The desired-state transport: a play is always a seek plus a start, a
    /// seek always bumps the generation (so seeking to the frame you are on
    /// still re-renders), and a pause moves nothing else.
    #[test]
    fn transport_desired_state_tracks_the_sources_call_order() {
        let (handle, driver, _engine_stopped_rx) = transport();
        let read = || {
            *driver
                .desired
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        };
        assert_eq!(read(), Desired::default());

        handle.play_from(120);
        let after_play = read();
        assert!(after_play.playing);
        assert_eq!(after_play.seek, Some(120));
        assert_eq!(after_play.seek_gen, 1);

        handle.pause();
        let after_pause = read();
        assert!(!after_pause.playing);
        assert_eq!(
            after_pause.seek,
            Some(120),
            "pause does not move the playhead"
        );
        assert_eq!(after_pause.seek_gen, 1);

        handle.seek(120);
        assert_eq!(read().seek_gen, 2, "a repeat seek still re-applies");
        assert!(!read().playing);
    }

    /// The row-padding + BGRA conversion, on a frame shaped like a real one:
    /// wgpu pads 1080 * 4 = 4320 up to 4352.
    #[test]
    fn frame_image_unpads_and_swaps_channels() {
        let width = 3u32;
        let height = 2u32;
        let padded = 16u32; // > width * 4, as wgpu's 256-byte alignment gives
        let mut data = vec![0u8; padded as usize * height as usize];
        for row in 0..height as usize {
            for column in 0..width as usize {
                let base = row * padded as usize + column * 4;
                // RGBA in, distinct per channel.
                data[base] = 10;
                data[base + 1] = 20;
                data[base + 2] = 30;
                data[base + 3] = 255;
            }
            // Padding bytes that must not survive.
            for byte in data
                .iter_mut()
                .skip(row * padded as usize + width as usize * 4)
                .take(padded as usize - width as usize * 4)
            {
                *byte = 99;
            }
        }

        let frame = RenderedFrame {
            data: Arc::new(data),
            width,
            height,
            padded_bytes_per_row: padded,
            frame_number: 0,
            target_time_ns: 0,
        };
        let image = frame_image(&frame).expect("frame converts");
        assert_eq!(image.size(0).width.0 as u32, width);
        assert_eq!(image.size(0).height.0 as u32, height);
        let bytes = image.as_bytes(0).expect("single frame");
        assert_eq!(bytes.len(), (width * height * 4) as usize);
        // BGRA out: the red and blue channels are swapped, no 99 anywhere.
        assert_eq!(&bytes[0..4], &[30, 20, 10, 255]);
        assert!(!bytes.contains(&99));
    }
}
