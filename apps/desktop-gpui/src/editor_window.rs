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
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use cap_editor::{EditorFrameOutput, EditorInstance, EditorState};
use cap_project::{
    ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    TimelineConfiguration, XY,
};
use cap_rendering::{FrameLayout, ProjectRecordingsMeta, RenderedFrame};
use gpui::{
    Context, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Render, RenderImage,
    SharedString, StatefulInteractiveElement as _, Styled, Window, div, point,
    prelude::FluentBuilder, px, svg,
};

use crate::{
    editor_edits::{
        self as edits, DragBounds, Hit, ProjectHistory, SPLIT_SNAP_PX, Selection,
    },
    theme::{Appearance, Theme},
    ui,
};

// ---------------------------------------------------------------------------
// Window geometry
// ---------------------------------------------------------------------------

/// `.inner_size(1275.0, 800.0)` / `.min_inner_size(1275.0, 800.0)` on the
/// `ShowCapWindow::Editor` arm (`windows.rs:1934-1935`), and the same pair
/// again from `CapWindowId::Editor::min_size` (`windows.rs:1112`).
pub const EDITOR_WIDTH: f32 = 1275.;
pub const EDITOR_HEIGHT: f32 = 800.;

/// `CapWindowId::Editor::traffic_lights_position` is
/// `Some(Some(LogicalPosition::new(20.0, 32.0)))` (`windows.rs:1092-1094`):
/// the native buttons are kept and inset, the way the settings window's are.
pub const TRAFFIC_LIGHTS: Option<Point<Pixels>> = Some(point(px(20.), px(32.)));

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

/// Preview quality `half` -- the default of `full | half | quarter`
/// (`context.ts:155-161`), 65 % (`lib.rs:148-149`).
const EDITOR_PREVIEW_SCALE: f32 = 0.65;

/// `default_editor_preview_resolution()` (`lib.rs:151-157`): the output size
/// at the preview scale, width rounded up to a multiple of 4 and height to a
/// multiple of 2 -- encoder/format alignment, asserted to be 1248x702 at
/// `lib.rs:192-194`.
///
/// E1 renders at this fixed base rather than following the player area's size
/// the way the Tauri `previewQuality` select lets the user do; see the README
/// deviation.
pub fn default_preview_resolution() -> XY<u32> {
    let width = ((EDITOR_OUTPUT_SIZE.x as f32 * EDITOR_PREVIEW_SCALE).round() as u32).div_ceil(4) * 4;
    let height =
        ((EDITOR_OUTPUT_SIZE.y as f32 * EDITOR_PREVIEW_SCALE).round() as u32).div_ceil(2) * 2;
    XY::new(width, height)
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

/// `h-14` on the header row (`Header.tsx:92`).
const HEADER_HEIGHT: f32 = 56.;

/// `w-104 min-w-104` on the sidebar column (`Editor.tsx:728`). Tailwind v4
/// arbitrary spacing: 104 x 0.25rem = 26rem = 416px. The column also carries
/// `ml-2`, i.e. an 8px gutter.
const SIDEBAR_WIDTH: f32 = 416.;
/// `h-16` on the sidebar's tab bar (`ConfigSidebar.tsx:595`).
const SIDEBAR_TAB_BAR_HEIGHT: f32 = 64.;

/// `padding = 4` inside `PreviewCanvas` (`Player.tsx:566`).
const PLAYER_CANVAS_PADDING: f32 = 4.;

// ---------------------------------------------------------------------------
// Timeline metrics -- all of them now live in [`crate::editor_timeline`],
// which owns the strip itself (`routes/editor/Timeline/index.tsx:62-68`).
// ---------------------------------------------------------------------------

use crate::editor_timeline::{
    self as timeline, MINIMAP_HEIGHT, MINIMAP_TOP, SCROLL_BODY_PADDING_RIGHT, START_SNAP_PX,
    TIMELINE_HEADER_HEIGHT, TIMELINE_PADDING, TIMELINE_SLOT_PADDING, TIMELINE_TOP_PADDING,
    TRACK_GUTTER, TRACK_ICON_WIDTH, TRACK_ROW_GAP, TimelineModel, TimelineView, TrackKind,
    Transform,
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

// ---------------------------------------------------------------------------
// Loading a project
// ---------------------------------------------------------------------------

/// What the shell needs off the bundle before (and independently of) the
/// renderer: the header's name, the timeline's clips, and the two sidebar tabs
/// whose disabled state is data-driven.
#[derive(Debug, Clone)]
pub struct ProjectSummary {
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
    /// `editorInstance.recordings.segments[i].display.duration` -- the ceiling
    /// a clip's end handle trims out to (`TL/ClipTrack.tsx:1160-1162`).
    pub clip_display_durations: Vec<f64>,
    /// `editorInstance.recordingDuration` (`lib.rs:3114` =
    /// `recordings.duration()`), the other half of that clamp.
    pub recording_duration: f64,
    /// Whether the bundle has more than one recording clip, which decides
    /// `"Clip"` vs `"Clip N"`. Kept so the model can be rebuilt after an edit.
    pub multiple_clips: bool,
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
///   into a message. `EditorInstance::new` then repeats the same construction
///   with input already known to be good.
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
        pretty_name: meta.pretty_name.clone(),
        timeline,
        duration: duration.max(0.0),
        has_camera,
        has_cursor_data: has_recorded_cursor_data(&meta, studio.as_ref()),
        clip_display_durations: recordings
            .segments
            .iter()
            .map(|segment| segment.display.duration)
            .collect(),
        recording_duration: recordings.duration(),
        multiple_clips: multiple_recording_segments,
    })
}

/// `meta().hasRecordedCursorData` -- any segment with a cursor file on disk.
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

/// What the frame pump hands the window.
pub struct EditorFrame {
    pub image: Arc<RenderImage>,
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
/// difference between it and what the engine is actually doing. That is what
/// makes scrubbing during playback survivable: each seek is a
/// stop/seek/restart round trip (`Timeline/index.tsx:829-853`), and the source
/// coalesces them to one in-flight seek with the newest position applied
/// afterwards (`beginRulerScrub`'s `seekInFlight`/`seekQueued`,
/// `Timeline/index.tsx:890-909`). Latest-wins state gives that for free and
/// cannot queue up a backlog of stale positions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Desired {
    pub playing: bool,
    /// The frame the *last* seek asked for, with a generation so that seeking
    /// to the frame you are already on still re-applies.
    pub seek: Option<u32>,
    pub seek_gen: u64,
}

/// The UI half. Cheap to clone, safe to call from the main thread: writing it
/// takes an uncontended `Mutex` and a `try_send` on a one-slot channel.
#[derive(Clone)]
pub struct TransportHandle {
    desired: Arc<Mutex<Desired>>,
    wake: flume::Sender<()>,
}

/// The driver half, handed to [`run_transport`] on the tokio runtime.
pub struct TransportDriver {
    desired: Arc<Mutex<Desired>>,
    wake: flume::Receiver<()>,
}

pub fn transport() -> (TransportHandle, TransportDriver) {
    let desired = Arc::new(Mutex::new(Desired::default()));
    let (tx, rx) = flume::bounded(1);
    (
        TransportHandle {
            desired: desired.clone(),
            wake: tx,
        },
        TransportDriver { desired, wake: rx },
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
    let resolution_base = default_preview_resolution();
    let mut applied_playing = false;
    let mut applied_gen = 0u64;

    while driver.wake.recv_async().await.is_ok() {
        let want = *driver
            .desired
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let seeking = want.seek_gen != applied_gen;

        // `stopPlayback` first, always: the source stops before it seeks
        // (`seekPlayheadTo`, `Timeline/index.tsx:829-845`) and before it
        // restarts at the end (`handlePlayPauseClick`'s at-end arm).
        if applied_playing && (!want.playing || seeking) {
            let handle = {
                let mut state = instance.state.lock().await;
                state.playback_task.take()
            };
            if let Some(handle) = handle {
                handle.stop();
            }
            applied_playing = false;
        }

        if seeking {
            applied_gen = want.seek_gen;
            if let Some(frame) = want.seek {
                // `seek_to` (`lib.rs:4230`) -- moves the playhead the next
                // `start_playback` will begin from, and renders nothing.
                instance
                    .modify_and_emit_state(|state| state.playhead_position = frame)
                    .await;
                if !want.playing {
                    // The repaint half, which `seek_to` does not do: the
                    // frontend emits `RenderFrameEvent` and Rust forwards it
                    // into `preview_tx` (`lib.rs:3009-3014, 6603-6614`).
                    request_frame(&instance, frame);
                }
            }
        }

        if want.playing && !applied_playing {
            instance.start_playback(fps, resolution_base).await;
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
    Move { start: f64, end: f64, bounds: DragBounds },
    /// `SegmentHandle position="start"`.
    TrimStart { start: f64, bounds: DragBounds },
    /// `SegmentHandle position="end"`.
    TrimEnd { end: f64, bounds: DragBounds },
    /// The clip track's own handles, which move a *recording*-domain edge
    /// scaled by the clip's timescale (`TL/ClipTrack.tsx:1134-1230`).
    ClipTrimStart { start: f64 },
    ClipTrimEnd { end: f64 },
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

pub struct EditorWindow {
    theme: Theme,
    project_path: PathBuf,
    state: LoadState,
    latest_frame: Option<Arc<RenderImage>>,
    frame_layout: Option<FrameLayout>,
    /// Kept alive for the window's lifetime: dropping the last `Arc` is what
    /// tears the decoders down, and `dispose()` on close does it explicitly.
    instance: Option<Arc<EditorInstance>>,
    focus: FocusHandle,

    // -- Transport ----------------------------------------------------------
    /// `editorState.playing`.
    playing: bool,
    /// `editorState.playbackTime`, in seconds.
    playhead: f64,
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
    project: ProjectConfiguration,
    /// `projectHistory` (`ED/context.ts:1724`).
    history: ProjectHistory,
    /// `editorState.timeline.selection`.
    selection: Option<Selection>,
    /// `editorState.timeline.interactMode === "split"`.
    split_mode: bool,
    /// `editorState.timeline.splitPreview` -- `(time, snapped)`.
    split_preview: Option<(f64, bool)>,
    /// The segment under the pointer: `(track, lane, index)`. This is the
    /// `group-hover` the trim handles' reveal hangs off.
    hovered_segment: Option<(TrackKind, u32, usize)>,
    /// The live segment drag, if any.
    drag: Option<Drag>,
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
    /// The debounced `project-config.json` write, and the task driving it.
    pending_save: Rc<RefCell<PendingProjectSave>>,
    save_task: Option<gpui::Task<()>>,
}

impl EditorWindow {
    pub fn new(project_path: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
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

        Self {
            // No material and no transparency: `applyMacOSWindowMaterial` runs
            // in the `(window-chrome)` layout and `/editor` is not one of its
            // routes, and `is_transparent()` (`windows.rs:1069-1082`) does not
            // list Editor. The root paints `bg-gray-2 dark:bg-gray-1`.
            theme: Theme::new(Appearance::from_window(window.appearance())),
            project_path,
            state: LoadState::Loading,
            latest_frame: None,
            frame_layout: None,
            instance: None,
            focus: cx.focus_handle(),
            playing: false,
            playhead: 0.0,
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
            drag: None,
            clip_display_durations: Vec::new(),
            recording_duration: 0.0,
            has_camera: false,
            multiple_clips: false,
            pending_save: Rc::new(RefCell::new(PendingProjectSave::default())),
            save_task: None,
        }
    }

    /// Hand the close path the pending write, so a `.cap` closed inside the
    /// 250ms debounce still lands on disk -- `onCleanup(() => { ...
    /// flushProjectConfig() })` (`ED/context.ts:1246-1252`).
    pub fn pending_save(&self) -> Rc<RefCell<PendingProjectSave>> {
        self.pending_save.clone()
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    pub fn set_summary(&mut self, summary: ProjectSummary, window: &mut Window, cx: &mut Context<Self>) {
        self.timeline = summary.timeline.clone();
        self.clip_display_durations = summary.clip_display_durations.clone();
        self.recording_duration = summary.recording_duration;
        self.has_camera = summary.has_camera;
        self.multiple_clips = summary.multiple_clips;
        self.pending_save.borrow_mut().path = Some(self.project_path.clone());
        // `zoom: zoomOutLimit()` is the store's *initial* value
        // (`ED/context.ts:1455`), so it is set the moment a duration exists --
        // the on-mount 80px fit then narrows it on the first render that knows
        // the timeline's width.
        self.view.transform = Transform::initial(summary.duration);
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
        self.rebuild_timeline();
        cx.notify();
        window.refresh();
    }

    /// Re-derive the drawn model from the live config. Runs after every edit;
    /// the waveforms arrive separately and later, so whatever has landed is
    /// carried across.
    fn rebuild_timeline(&mut self) {
        let mic = std::mem::take(&mut self.timeline.mic_waveforms);
        let system = std::mem::take(&mut self.timeline.system_waveforms);
        self.timeline = TimelineModel::build(&self.project, self.has_camera, self.multiple_clips);
        self.timeline.mic_waveforms = mic;
        self.timeline.system_waveforms = system;
        // `totalDuration()` is derived from the store, so a trim, split or
        // delete moves it -- and it is what the transport clamps and the
        // engine stops at.
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

    fn project_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.history.record(&self.project);
        self.rebuild_timeline();
        self.publish_project();
        self.schedule_save(window, cx);
        cx.notify();
        window.refresh();
    }

    /// The renderer half. `frameNumberToRender` is `previewTime ??
    /// playbackTime` (`Editor.tsx:515-519`), floored into a frame number, and
    /// the re-render is skipped while playing exactly as `emitRenderFrame`'s
    /// `if (!editorState.playing)` gate does (`:493`).
    fn publish_project(&self) {
        let Some(instance) = &self.instance else {
            return;
        };
        instance.project_config.0.send(self.project.clone()).ok();
        if !self.playing {
            let time = self.view.preview_time.unwrap_or(self.playhead).max(0.0);
            request_frame(instance, (time * EDITOR_PREVIEW_FPS as f64).floor() as u32);
        }
    }

    /// The disk half: restart the 250ms timer, then write on the background
    /// executor. A later edit drops this task, which is `clearTimeout` plus a
    /// fresh `setTimeout`.
    fn schedule_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
        self.project = config;
        self.rebuild_timeline();
        self.publish_project();
        self.schedule_save(window, cx);
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
        self.transport = Some(transport);
        self.stats = Some(stats);
        if total > 0.0 {
            self.total = total;
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

    fn total_duration(&self) -> f64 {
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

        // `createEffect(() => { if (isAtEnd() && editorState.playing) {
        // commands.stopPlayback(); setEditorState("playing", false); } })`
        // (`Player.tsx:205-210`). The playhead is *not* rewound -- it stays at
        // the end, which is what makes the button show Play again and the next
        // press restart from 0.
        if self.playing && self.is_at_end() {
            self.stop_playback(cx);
        }

        cx.notify();
        window.refresh();
    }

    /// The pause half of `handlePlayPauseClick`, also used by the end-of-media
    /// effect and by prev/next.
    fn stop_playback(&mut self, cx: &mut Context<Self>) {
        if let Some(transport) = &self.transport {
            transport.pause();
        }
        if self.playing {
            self.playing = false;
            self.report_playback();
        }
        cx.notify();
    }

    fn start_playback(&mut self, from: f64, cx: &mut Context<Self>) {
        let Some(transport) = &self.transport else {
            return;
        };
        // `Math.floor(editorState.playbackTime * FPS)`.
        let frame = (from.max(0.0) * EDITOR_PREVIEW_FPS as f64).floor() as u32;
        transport.play_from(frame);
        self.playhead = from.max(0.0);
        self.playing = true;
        self.play_mark = self
            .stats
            .as_ref()
            .map(|stats| (Instant::now(), stats.snapshot()));
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

    /// `seekPlayheadTo` (`Timeline/index.tsx:829-853`). Seeking while playing
    /// is a stop/seek/restart round trip in the source too -- expressed here
    /// as one desired-state write, which the driver applies in that order.
    pub fn seek_to_time(&mut self, time: f64, cx: &mut Context<Self>) {
        let Some(transport) = &self.transport else {
            return;
        };
        let time = time.clamp(0.0, self.total_duration());
        // `Math.round(newTime * FPS)` -- "round to nearest frame to prevent
        // off-by-one drift".
        let frame = (time * EDITOR_PREVIEW_FPS as f64).round() as u32;
        if self.playing {
            transport.play_from(frame);
        } else {
            transport.seek(frame);
        }
        self.playhead = time;
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

    /// The editor's key bindings live in `useEditorShortcuts`
    /// (`Player.tsx:236-286`): `Space` play/pause, `S` split (E4's) and
    /// `Mod+=` / `Mod+-` zoom. `Mod` is Cmd-or-Ctrl
    /// (`useEditorShortcuts.ts:10`) and `e.repeat` is ignored there
    /// (`:42`) as `is_held` is here.
    fn on_key(&mut self, event: &gpui::KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.is_held {
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
            "space" => {
                cx.stop_propagation();
                self.toggle_play(window, cx);
            }
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
        self.view.transform.update_zoom(zoom * factor, origin, total);
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

        if event.modifiers.control {
            let origin = self.view.preview_time.unwrap_or(self.playhead);
            let delta = timeline::wheel_zoom_delta(delta_y, self.view.transform.zoom);
            let zoom = self.view.transform.zoom;
            self.view.transform.update_zoom(zoom + delta, origin, total);
        } else {
            // Horizontal wins when it dominates; otherwise macOS reads the
            // shift key, which is what turns a vertical trackpad swipe into a
            // pan (`TL/index.tsx:1197-1203`).
            let delta = if delta_x.abs() > delta_y.abs() * 0.5 {
                delta_x
            } else if event.modifiers.shift {
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
        }
        self.note_transform("wheel", None);
        cx.notify();
        window.refresh();
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
        window: &mut Window,
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
        window.refresh();
    }

    /// `onMouseMove` on the timeline container (`TL/index.tsx:1170-1188`):
    /// while paused, the pointer's time becomes `previewTime`; outside the
    /// content column, and at all times while playing, it is cleared.
    fn timeline_hover(&mut self, x: f32, window: &mut Window, cx: &mut Context<Self>) {
        // `if (editorState.playing) return;` -- the handler bails *before* it
        // writes, so a preview time set while paused survives a play rather
        // than being cleared. The ghost is hidden by the render's own
        // `!editorState.playing` gate instead (`TL/index.tsx:1246-1253`).
        if self.playing {
            return;
        }
        let viewport_width: f32 = window.viewport_size().width.into();
        let next = timeline::preview_time_from_x(x, viewport_width, self.view.transform);
        if next != self.view.preview_time {
            self.view.preview_time = next;
            cx.notify();
            window.refresh();
        }
    }

    fn set_hovered_track(
        &mut self,
        track: Option<TrackKind>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.view.hovered_track != track {
            self.view.hovered_track = track;
            cx.notify();
            window.refresh();
        }
    }

    // -- Timeline seeking ----------------------------------------------------

    fn time_at(&self, x: f32, viewport_width: f32) -> f64 {
        timeline::time_from_x(x, viewport_width, self.view.transform, self.total_duration())
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
    }

    /// `setEditorState("timeline", "selection", ...)`.
    fn set_selection(&mut self, selection: Option<Selection>, cx: &mut Context<Self>) {
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
        let viewport_width: f32 = window.viewport_size().width.into();
        let secs_per_pixel = self.secs_per_pixel(viewport_width);
        let x = self.content_x(f32::from(event.position.x));
        let position = self.view.transform.position;
        let total = self.total_duration();
        let hit = edits::hit_test(self.timeline.segments(kind), lane, x, position, secs_per_pixel);
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
                // `TL/ZoomTrack.tsx:188-295`. The press deliberately does *not*
                // stop propagating: the container arms its own press behind it,
                // which is why a click-create ends with the playhead moved.
                if kind == TrackKind::Zoom {
                    self.begin_zoom_create(secs_per_pixel, f32::from(event.position.x), cx);
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
            self.split_at_pointer(kind, index, x, secs_per_pixel, event.modifiers.alt, window, cx);
            return;
        }

        let modifiers = (event.modifiers.shift, event.modifiers.platform || event.modifiers.control);
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
    fn begin_zoom_create(&mut self, secs_per_pixel: f64, down_x: f32, cx: &mut Context<Self>) {
        let ghost = (self.view.hovered_track == Some(TrackKind::Zoom))
            .then_some(self.view.preview_time)
            .flatten()
            .and_then(|preview| {
                timeline::new_zoom_segment(&self.timeline, preview, secs_per_pixel)
                    .map(|ghost| (preview, ghost))
            });
        tracing::debug!(
            hovered = ?self.view.hovered_track,
            preview = ?self.view.preview_time,
            ghost = ?ghost,
            "zoom create"
        );
        let Some((preview, (start, end))) = ghost else {
            return;
        };
        // `max`: the next segment's start, or the timeline's end.
        let max = self
            .timeline
            .zoom
            .iter()
            .find(|segment| preview <= segment.start)
            .map_or(self.total_duration(), |segment| segment.start);
        let min_duration = timeline::new_segment_min_duration(secs_per_pixel);

        self.history.pause();
        self.drag = Some(Drag {
            track: TrackKind::Zoom,
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

    /// A pointer move with a segment drag live. Runs off the root's handler, so
    /// a drag that leaves its own row keeps tracking -- which is what
    /// `createEventListenerMap(window, ...)` gives the source.
    fn drag_mouse_move(&mut self, x: f32, window: &mut Window, cx: &mut Context<Self>) {
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
                let shift = bounds.clamp(delta);
                let (track, index) = (drag.track, drag.index);
                self.edit(
                    |timeline| edits::move_segment(timeline, track, index, start + shift, end + shift),
                    window,
                    cx,
                );
            }
            DragKind::TrimStart { start, bounds } => {
                let next = bounds.clamp(start + delta);
                let (track, index) = (drag.track, drag.index);
                if self.edit(
                    |timeline| edits::set_segment_start(timeline, track, index, next),
                    window,
                    cx,
                ) {
                    self.set_preview_time(next);
                }
            }
            DragKind::TrimEnd { end, bounds } => {
                let next = bounds.clamp(end + delta);
                let (track, index) = (drag.track, drag.index);
                if self.edit(
                    |timeline| edits::set_segment_end(timeline, track, index, next),
                    window,
                    cx,
                ) {
                    self.set_preview_time(next);
                }
            }
            DragKind::ClipTrimStart { start } => {
                self.clip_trim(drag.index, start, delta, true, secs_per_pixel, window, cx);
            }
            DragKind::ClipTrimEnd { end } => {
                self.clip_trim(drag.index, end, delta, false, secs_per_pixel, window, cx);
            }
            DragKind::CreateZoom {
                base_start,
                base_end,
                max,
                min_duration,
                created,
            } => {
                // `deltaTime = deltaX * secsPerPixel - (base.end - base.start)`
                // over `initialEndTime = base.end`, i.e. the end tracks the
                // pointer measured from the segment's own start.
                let delta_time = delta - (base_end - base_start);
                let new_end = base_end + delta_time;
                let min_end = base_start + min_duration;
                let clamped = new_end.max(min_end).min(max.max(min_end));
                match created {
                    None => {
                        let index = self.create_zoom_segment(base_start, clamped, window, cx);
                        if let Some(drag) = self.drag.as_mut()
                            && let DragKind::CreateZoom { created, .. } = &mut drag.kind
                        {
                            *created = Some(index);
                        }
                    }
                    Some(index) => {
                        // `if (deltaTime < 0) return;` -- dragging back left
                        // never shrinks the segment below its created size.
                        if delta_time < 0. {
                            return;
                        }
                        self.edit(
                            |timeline| edits::set_segment_end(timeline, TrackKind::Zoom, index, clamped),
                            window,
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(timeline) = self.project.timeline.as_ref() else {
            return;
        };
        let Some(segment) = timeline.segments.get(index) else {
            return;
        };
        let timescale = segment.timescale;
        let requested = anchor + delta * timescale;
        let displays = self.clip_display_durations.clone();
        let recording = self.recording_duration;

        let clamped = if start_edge {
            edits::clip_trim_start(timeline, index, requested, secs_per_pixel, &displays, recording)
        } else {
            edits::clip_trim_end(timeline, index, requested, secs_per_pixel, &displays, recording)
        };
        let Some(clamped) = clamped else { return };

        let applied = self.edit(
            |timeline| {
                let Some(segment) = timeline.segments.get_mut(index) else {
                    return false;
                };
                let edge = if start_edge {
                    &mut segment.start
                } else {
                    &mut segment.end
                };
                if *edge == clamped {
                    return false;
                }
                *edge = clamped;
                true
            },
            window,
            cx,
        );
        if !applied {
            return;
        }
        // `setPreviewTime(prevDuration())` on the start handle and
        // `prevDuration() + (clampedEnd - seg.start) / timescale` on the end.
        let box_start = self
            .timeline
            .clips
            .get(index)
            .map_or(0., |clip| clip.start);
        if start_edge {
            self.set_preview_time(box_start);
        } else {
            let source_start = self
                .project
                .timeline
                .as_ref()
                .and_then(|timeline| timeline.segments.get(index))
                .map_or(0., |segment| segment.start);
            self.set_preview_time(box_start + (clamped - source_start) / timescale);
        }
    }

    /// `createSegment`'s insert, plus the selection it leaves behind.
    fn create_zoom_segment(
        &mut self,
        start: f64,
        end: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> usize {
        let mut index = 0;
        self.edit(
            |timeline| {
                index = edits::insert_zoom_segment(timeline, start, end, edits::DEFAULT_ZOOM_AMOUNT);
                true
            },
            window,
            cx,
        );
        self.set_selection(Some(Selection::single(TrackKind::Zoom, index)), cx);
        index
    }

    /// `finish(e)`: resume the history, and -- if the drag never promoted --
    /// select instead, which also moves the playhead
    /// (`props.handleUpdatePlayhead(e)`).
    fn drag_mouse_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.drag.take() else {
            return;
        };

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
                self.create_zoom_segment(base_start, base_end, window, cx);
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
        window.refresh();
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
        let hit = edits::hit_test(self.timeline.segments(kind), lane, x, position, secs_per_pixel);

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
            window.refresh();
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
                // `if (didSplit) setEditorState("timeline", "selection", null)`.
                self.set_selection(None, cx);
                self.note_edit("split", Some(TrackKind::Clip));
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
    fn delete_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
    pub fn frame_arrived(&mut self, frame: EditorFrame, window: &mut Window, cx: &mut Context<Self>) {
        if self.frame_layout.map(|layout| layout.output_size) != Some(frame.layout.output_size) {
            tracing::info!(
                output_size = ?frame.layout.output_size,
                display = ?frame.layout.display,
                camera = ?frame.layout.camera,
                "editor frame size"
            );
        }
        tracing::debug!(number = frame.number, "editor frame");
        self.frame_layout = Some(frame.layout);
        // Freed explicitly: nothing else evicts per-frame images from the
        // sprite atlas, and a 3MB 1080x702 frame per scrub would fill it.
        if let Some(previous) = self.latest_frame.replace(frame.image) {
            let _ = window.drop_image(previous);
        }
        if let Some(stats) = &self.stats {
            stats.presented.fetch_add(1, Ordering::Relaxed);
        }
        cx.notify();
        window.refresh();
    }

    fn sync_appearance(&mut self, window: &Window) {
        let appearance = Appearance::from_window(window.appearance());
        if appearance != self.theme.appearance {
            self.theme = Theme::new(appearance);
        }
    }

    fn summary(&self) -> Option<&ProjectSummary> {
        match &self.state {
            LoadState::Ready(summary) => Some(summary),
            _ => None,
        }
    }

    /// `bg-gray-1 dark:bg-gray-2` -- the card/sidebar/panel surface. The
    /// editor takes the plain Radix values, not the material remaps: it is not
    /// a chrome route, so none of the `--macos-settings-*` overrides apply.
    fn panel_bg(&self) -> Hsla {
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
    fn editor_button(
        &self,
        icon: &'static str,
        label: Option<&'static str>,
        right_icon: Option<&'static str>,
        width: Option<f32>,
    ) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .px(px(6.))
            .gap(px(6.))
            .h(px(32.))
            .rounded(px(8.))
            .flex_shrink_0()
            .when_some(width, |this, width| this.w(px(width)))
            // `disabled:opacity-50 disabled:text-gray-11`.
            .opacity(0.5)
            .text_color(Hsla::from(theme.gray_11))
            .text_size(px(14.))
            .child(
                svg()
                    .path(icon)
                    .size(px(20.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(theme.gray_11)),
            )
            .when_some(label, |this, label| {
                this.child(div().flex_1().truncate().child(label))
            })
            .when_some(right_icon, |this, icon| {
                this.child(
                    svg()
                        .path(icon)
                        .size(px(12.))
                        .flex_shrink_0()
                        .text_color(Hsla::from(theme.gray_11)),
                )
            })
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
        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .px(px(6.))
            .gap(px(6.))
            .h(px(32.))
            .rounded(px(8.))
            .flex_shrink_0()
            .when(!enabled, |this| this.opacity(0.5))
            .when(enabled, |this| {
                this.cursor_pointer()
                    .hover(|this| this.bg(Hsla::from(theme.gray_3)))
            })
            .child(
                svg()
                    .path(icon)
                    .size(px(20.))
                    .flex_shrink_0()
                    .text_color(Hsla::from(if enabled { theme.gray_12 } else { theme.gray_11 })),
            )
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

    /// `Header.tsx:89-235` -- `h-14`, three groups, the middle one bracketed by
    /// `border-x border-black-transparent-10`.
    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let name = self
            .summary()
            .map(|summary| summary.pretty_name.clone())
            .unwrap_or_default();

        div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .flex_none()
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
                    // The macOS spacer for the inset traffic lights: `h-full w-16`.
                    .child(div().h_full().w(px(64.)).flex_none())
                    .child(self.editor_button("icons/trash.svg", None, None, None))
                    .child(self.editor_button("icons/folder.svg", None, None, None))
                    // `NameEditor` + the literal `.cap` suffix
                    // (`Header.tsx:123-126`). Read-only here: gpui ships no
                    // text input, the same gap the main window's search field
                    // and the teleprompter's script editor have.
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .min_w_0()
                            .child(
                                div()
                                    .max_w(px(200.))
                                    .truncate()
                                    .text_size(px(14.))
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(name),
                            )
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child(".cap"),
                            ),
                    )
                    .child(div().flex_1().h_full()),
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
                    .child(self.editor_button(
                        "icons/presets.svg",
                        Some("Presets"),
                        Some("icons/chevron-down.svg"),
                        None,
                    ))
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
                    .child(self.history_button("editor-undo", "icons/undo.svg", true, cx))
                    .child(self.history_button("editor-redo", "icons/redo.svg", false, cx))
                    .child(div().flex_1().h_full())
                    // `Button` (gray), `flex gap-1.5 justify-center h-[40px]`.
                    .child(self.header_pill("icons/clapperboard.svg", "Clips"))
                    .child(self.header_pill("icons/captions.svg", "Captions"))
                    .child(self.render_export_button()),
            )
    }

    /// The Clips / Captions toggles: `Button variant="gray"` at
    /// `class="flex gap-1.5 justify-center h-[40px]"` (`Header.tsx:173-209`).
    /// Inert -- neither layout mode exists yet.
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
    /// `bg-linear-to-b from-[#3b82f6] to-[#2563eb]`. Disabled here -- export
    /// is its own unit -- so it carries the same 50 % wash the other inert
    /// affordances do.
    fn render_export_button(&self) -> impl IntoElement {
        div()
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
            .opacity(0.5)
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
    }

    // -- Player --------------------------------------------------------------

    /// `PlayerContent` (`Player.tsx:288-483`): toolbar, canvas, transport.
    fn render_player(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(self.render_player_toolbar())
            .child(self.render_preview_canvas())
            .child(self.render_transport(cx))
    }

    /// `flex items-center justify-between gap-3 p-3` (`Player.tsx:290`).
    fn render_player_toolbar(&self) -> impl IntoElement {
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
                    // `AspectRatioSelect`: EditorButton at `class="w-28"`.
                    .child(self.editor_button(
                        "icons/layout.svg",
                        Some("Auto"),
                        Some("icons/chevron-down.svg"),
                        Some(112.),
                    ))
                    .child(self.editor_button("icons/crop.svg", Some("Crop"), None, None))
                    // `FrameButton`, whose idle label is "Frame".
                    .child(self.editor_button(
                        "icons/app-window-mac.svg",
                        Some("Frame"),
                        None,
                        None,
                    )),
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
                    // `KSelect.Trigger` -- [`ui::Select::plain`]. Inert this
                    // unit (preview quality is pinned to `half`), so it draws
                    // in its disabled state.
                    .child(
                        ui::Select::plain(&theme, "preview-quality", "Half")
                            .stretch_label()
                            .disabled(true),
                    ),
            )
    }

    /// `PreviewCanvas` (`Player.tsx:605-648`): a `relative flex-1` container
    /// with the frame centred inside it at its letterboxed size, over the
    /// canvas's `background-color: #000000`.
    ///
    /// The frame is a gpui `img()` rather than a canvas: the picture arrives as
    /// a CPU `RenderedFrame`, gets un-padded and BGRA-swapped once, and goes
    /// through the sprite atlas -- the same path the camera preview uses.
    fn render_preview_canvas(&self) -> impl IntoElement {
        let theme = self.theme;
        let image = self.latest_frame.clone();
        let frame_size = self
            .frame_layout
            .map(|layout| (layout.output_size[0] as f32, layout.output_size[1] as f32))
            // `latestFrame()?.width ?? 1920` / `?? 1080` (`Player.tsx:567-568`).
            .unwrap_or((1920., 1080.));

        let painted = self.stats.clone();
        let body = match (&self.state, image) {
            (LoadState::Failed(message), _) => self.render_error_state(message).into_any_element(),
            (_, Some(image)) => {
                // gpui has no `createElementBounds`, so the container's own
                // painted bounds come back through a `canvas` element and the
                // frame is painted into the rect [`letterbox`] computes --
                // the same explicit-px sizing the TSX applies to its
                // `<canvas>`, with the 4px padding folded in. Centring is
                // `justify-center items-center` on the wrapper.
                gpui::canvas(
                    |bounds, _window, _cx| bounds,
                    move |_, bounds, window, _cx| {
                        let container_width: f32 = bounds.size.width.into();
                        let container_height: f32 = bounds.size.height.into();
                        let (width, height) =
                            letterbox((container_width, container_height), frame_size);
                        let fitted = gpui::Bounds {
                            origin: gpui::point(
                                bounds.origin.x + px((container_width - width) / 2.),
                                bounds.origin.y + px((container_height - height) / 2.),
                            ),
                            size: gpui::size(px(width), px(height)),
                        };
                        // `background-color: #000000` is on the `<canvas>`
                        // itself, not its container: what shows outside the
                        // fitted rect is the player card, not black.
                        window.paint_quad(gpui::fill(fitted, gpui::black()));
                        let _ = window.paint_image(
                            fitted,
                            gpui::Corners::default(),
                            image,
                            0,
                            false,
                        );
                        // Paints, not frames -- the clock and the playhead
                        // invalidate too. It is the other end of the pump:
                        // fewer paints than delivered frames would mean gpui
                        // was coalescing pictures away before they were drawn.
                        if let Some(stats) = &painted {
                            stats.painted.fetch_add(1, Ordering::Relaxed);
                        }
                    },
                )
                .absolute()
                .size_full()
                .into_any_element()
            }
            (LoadState::Loading, None) => div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(14.))
                .text_color(Hsla::from(theme.gray_11))
                .child("Loading project...")
                .into_any_element(),
            (LoadState::Ready(_), None) => div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(14.))
                .text_color(Hsla::from(theme.gray_11))
                .child("Rendering first frame...")
                .into_any_element(),
        };

        // `relative flex-1 justify-center items-center` -- no background of
        // its own; the player card's shows through the letterbox bars.
        div()
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(body)
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
                    .child(SharedString::from(
                        self.project_path.display().to_string(),
                    )),
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
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(fraction) =
            ui::slider_value_at(&self.zoom_slider_track, position, 0., 1., 0.001)
        else {
            return;
        };
        let total = self.total_duration();
        let origin = self.playhead;
        self.view.transform.apply_slider(fraction, origin, total);
        self.note_transform("slider", Some(origin));
        cx.notify();
        window.refresh();
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
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .p(px(20.))
            .flex_none()
            .overflow_hidden()
            .child(
                div()
                    .flex_1()
                    .text_size(px(14.))
                    .text_color(Hsla::from(theme.gray_11))
                    .child(format!(
                        "{} / {}",
                        timeline::format_time(current),
                        timeline::format_time(total)
                    )),
            )
            // `flex flex-row items-center justify-center text-gray-11 gap-8
            // text-[0.875rem]`.
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
                            .on_click(cx.listener(|this, _, _window, cx| this.jump_to_start(cx))),
                    )
                    // `rounded-full border border-gray-300 bg-gray-3 size-9`
                    // with `hover:bg-gray-4` -- [`ui::IconButton`].
                    .child(
                        ui::IconButton::new("transport-play", icon)
                            .size(px(36.))
                            .icon_size(px(12.))
                            .color(Hsla::from(theme.gray_12))
                            .filled(Hsla::from(theme.gray_3), Some(Hsla::from(theme.gray_5)))
                            .hover_bg(Hsla::from(theme.gray_4))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.toggle_play(window, cx);
                            })),
                    )
                    .child(
                        div()
                            .id("transport-next")
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
                            .on_click(cx.listener(|this, _, _window, cx| this.jump_to_end(cx))),
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
                            .child(
                                svg()
                                    .path("icons/scissors.svg")
                                    .size(px(20.))
                                    .text_color(if self.split_mode {
                                        Hsla::from(theme.gray_1)
                                    } else {
                                        Hsla::from(theme.gray_12)
                                    }),
                            )
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
                        .on_drag_start(cx.listener(|this, event: &MouseDownEvent, window, cx| {
                            this.zoom_slider_drag = true;
                            this.apply_zoom_slider(event.position, window, cx);
                        })),
                    ),
            )
    }

    // -- Config sidebar ------------------------------------------------------

    /// `ConfigSidebar`'s shell (`ConfigSidebar.tsx:593-692`) with its six-tab
    /// icon rail. The rail is transcribed; the bodies are not (that is a later
    /// unit), so the scroll region shows the same "not built yet" card the
    /// settings window's placeholder pages use.
    fn render_sidebar(&self) -> impl IntoElement {
        let theme = self.theme;
        let summary = self.summary();
        // The two data-driven disabled states (`CS:602-604`, `CS:610`).
        let tabs: [(&'static str, bool); 6] = [
            ("icons/image.svg", false),
            (
                "icons/camera.svg",
                !summary.is_some_and(|summary| summary.has_camera),
            ),
            ("icons/audio-on.svg", false),
            (
                "icons/cursor.svg",
                !summary.is_some_and(|summary| summary.has_cursor_data),
            ),
            ("icons/keyboard.svg", false),
            ("icons/message-bubble.svg", false),
        ];

        let rail = ui::TabRail::editor(
            &theme,
            "sidebar-tabs",
            self.panel_bg(),
            tabs.into_iter()
                .enumerate()
                .map(|(index, (icon, disabled))| {
                    ui::TabRailItem::new(icon, index == 0, disabled)
                })
                .collect(),
        )
        .height(px(SIDEBAR_TAB_BAR_HEIGHT));

        div()
            // The column: `ml-2 flex min-h-0 w-104 min-w-104 flex-none
            // overflow-hidden` (`Editor.tsx:728`).
            .ml(px(8.))
            .w(px(SIDEBAR_WIDTH))
            .flex_none()
            .flex()
            .min_h_0()
            .overflow_hidden()
            .child(
                // The card: `flex flex-col min-h-0 shrink-0 flex-1 max-w-104
                // overflow-hidden rounded-xl z-10 bg-gray-1 dark:bg-gray-2
                // border border-gray-3`.
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .rounded(px(12.))
                    .bg(self.panel_bg())
                    .border_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .child(rail)
                    .child(
                        // The scroll region: `text-[0.875rem] flex-1 min-h-0`,
                        // with the tab panels' own `flex flex-col flex-1
                        // gap-6 p-4`.
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_h_0()
                            .gap(px(24.))
                            .p(px(16.))
                            .text_size(px(14.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .p(px(16.))
                                    .rounded(px(12.))
                                    .bg(Hsla::from(theme.gray_3))
                                    .child(
                                        div()
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(Hsla::from(theme.gray_12))
                                            .child("Background"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(Hsla::from(theme.gray_11))
                                            .child(
                                                "The sidebar's controls are not part of this \
                                                 unit yet. The tab rail above is the real one.",
                                            ),
                                    ),
                            ),
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

        let playhead_x = timeline::playhead_offset(self.view, content_width);
        let ghost_x = timeline::ghost_offset(self.view, content_width);

        let minimap_width =
            (viewport_width - TIMELINE_SLOT_PADDING * 2. - TIMELINE_PADDING - TRACK_GUTTER
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
            .h(px(DEFAULT_TIMELINE_HEIGHT))
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
                        .child(
                            div()
                                .when(self.split_mode, |this| this.opacity(0.5))
                                .child(timeline::render_playhead(
                                    timeline::playhead_color(),
                                    playhead_x,
                                    timeline::playhead_color(),
                                )),
                        )
                        // The split preview (`TL/index.tsx:1296-1316`): a 1px
                        // column at the cut, blue with a rotated 8px diamond
                        // when it snapped to a boundary and grey otherwise.
                        .children(self.split_mode.then_some(()).and_then(|()| {
                            let (time, snapped) = self.split_preview?;
                            let x = ((time - self.view.transform.position)
                                / self.view.transform.secs_per_pixel(content_width))
                                as f32;
                            Some(render_split_preview(&theme, x, snapped))
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
            .child(timeline::render_ruler(&self.theme, self.view, viewport_width))
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
                    ),
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
    fn render_timeline_body(&self, viewport_width: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let ui = timeline::SegmentUi {
            selection: self.selection.as_ref(),
            split_mode: self.split_mode,
            hovered: self.hovered_segment,
            dragging: self.drag.is_some(),
        };
        let mut rows = div()
            .flex()
            .flex_col()
            .gap(px(TRACK_ROW_GAP))
            .min_h_full()
            .w_full();

        for row in &self.timeline.rows {
            let kind = row.kind;
            let lane = row.lane;
            rows = rows.child(
                div()
                    .id(gpui::ElementId::NamedInteger(
                        "timeline-row".into(),
                        (kind as usize as u64) << 16 | row.lane as u64,
                    ))
                    // Every track sets `hoveredTrack` on enter and clears it
                    // on leave (`TL/ZoomTrack.tsx:170-171` and its eight
                    // siblings); the zoom and 3D tracks read it to decide
                    // whether to draw their new-segment ghost.
                    .on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
                        this.set_hovered_track(hovered.then_some(kind), window, cx);
                        if !*hovered && this.hovered_segment.map(|(kind, lane, _)| (kind, lane))
                            == Some((kind, lane))
                        {
                            this.hovered_segment = None;
                            this.split_preview = None;
                            cx.notify();
                            window.refresh();
                        }
                    }))
                    // The per-segment hover the trim handles' reveal reads,
                    // and split mode's cut preview.
                    .on_mouse_move(cx.listener(
                        move |this, event: &MouseMoveEvent, window, cx| {
                            this.track_hover(kind, lane, f32::from(event.position.x), window, cx);
                        },
                    ))
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
                        &self.timeline,
                        *row,
                        self.view,
                        viewport_width,
                        ui,
                    )),
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
                    .pr(px(SCROLL_BODY_PADDING_RIGHT))
                    // `if (!e.ctrlKey && |deltaY| > |deltaX|) e.stopPropagation()`
                    // (`TL/index.tsx:1327-1331`): a vertical wheel inside the
                    // body scrolls the track list instead of panning the
                    // timeline. gpui dispatches innermost-first, so stopping
                    // here is what keeps it off the container's pan handler.
                    .on_scroll_wheel(cx.listener(
                        |_this, event: &gpui::ScrollWheelEvent, window, cx| {
                            let pixels = event.delta.pixel_delta(window.line_height());
                            if !event.modifiers.control
                                && f32::from(pixels.y).abs() > f32::from(pixels.x).abs()
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

impl Render for EditorWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window);
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

        div()
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            .bg(self.root_bg())
            .text_color(Hsla::from(theme.gray_12))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::on_key))
            // A drag continues while the pointer is anywhere in the window,
            // which is what `createEventListenerMap(window, {mousemove,
            // mouseup})` gives the source (`TL/index.tsx:938-955`); a gpui
            // element only sees moves over its own hitbox, so the handlers go
            // on the root while a scrub is live -- the camera bubble's resize
            // pattern.
            .when(scrubbing, |this| {
                this.on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                    this.timeline_mouse_move(event, window, cx);
                    this.drag_mouse_move(f32::from(event.position.x), window, cx);
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.window_mouse_up(cx);
                        // After the container's own mouseup, which is the
                        // order the DOM's bubbling gives the source.
                        this.drag_mouse_up(window, cx);
                    }),
                )
            })
            .child(self.render_header(cx))
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
                                                    .h(px(RESIZE_HANDLE_HEIGHT))
                                                    .flex_none()
                                                    .flex()
                                                    .flex_col()
                                                    .gap(px(2.))
                                                    .items_center()
                                                    .justify_center()
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
                                    .child(self.render_sidebar()),
                            )
                            .child(self.render_timeline(viewport_width, cx)),
                    ),
            )
            // The zoom slider's window-wide drag layer, painted last so it is
            // over everything -- the same shape the settings window's sliders
            // use, because gpui has no pointer capture and a 96px row would
            // otherwise lose the drag the moment the pointer left it.
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
    }
}

fn with_alpha(color: gpui::Rgba, alpha: f32) -> Hsla {
    let mut hsla = Hsla::from(color);
    hsla.a = alpha;
    hsla
}

/// The instruction that actually produces a picture. `seek_to` and
/// `set_playhead_position` would move the playhead and render nothing --
/// the classic "the editor opened but the canvas is black" bug.
pub fn request_frame(instance: &EditorInstance, frame_number: u32) {
    instance
        .preview_tx
        .send_modify(|value| *value = Some((frame_number, EDITOR_PREVIEW_FPS, default_preview_resolution())));
}

/// Wrap the flume sender the pump drains into an `EditorFrameCallback`.
///
/// The renderer is already latest-wins (it drains its mpsc with `try_recv` and
/// discards all but the newest, `editor.rs:242-312`), so a small bounded
/// channel that drops on a full queue is the right backpressure here.
pub fn make_frame_callback(
    tx: flume::Sender<(RenderedFrame, FrameLayout)>,
    stats: Arc<PumpStats>,
) -> cap_editor::EditorFrameCallback {
    Box::new(move |output, layout| {
        // The editor renderer always emits `Rgba` -- `editor.rs:371-373`
        // hardcodes `PlaybackRenderOutputFormat::Rgba`. NV12 is the export
        // path's.
        if let EditorFrameOutput::Rgba(frame) = output {
            stats.rendered.fetch_add(1, Ordering::Relaxed);
            if tx.try_send((frame, layout)).is_err() {
                stats.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `default_editor_preview_resolution()` is asserted to be 1248x702 in the
    /// Tauri app itself (`lib.rs:192-194`); the render size of a display
    /// recording follows from it.
    #[test]
    fn preview_resolution_matches_the_tauri_editor() {
        let base = default_preview_resolution();
        assert_eq!((base.x, base.y), (1248, 702));
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

    /// Every failure `EditorInstance::new` would return, plus the one it would
    /// panic on, has to come back as a message.
    #[test]
    fn preflight_rejects_a_missing_bundle() {
        let error = preflight(std::path::Path::new("/nonexistent/nope.cap")).unwrap_err();
        assert!(error.contains("not found"), "{error}");
    }

    #[test]
    fn preflight_rejects_a_bundle_with_no_meta() {
        let dir = std::env::temp_dir().join(format!(
            "cap-gpui-preflight-{}.cap",
            std::process::id()
        ));
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
        let (handle, driver) = transport();
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
        assert_eq!(after_pause.seek, Some(120), "pause does not move the playhead");
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
