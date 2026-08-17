//! The editor window -- `routes/editor/` shell, project load, and a real
//! rendered frame.
//!
//! Unit E1's scope is deliberately narrow: the 1275x800 window, the three
//! regions at their exact dimensions, and frame 0 of a real project on screen.
//! Playback (E2), timeline interaction (E3) and the config sidebar's controls
//! come later, so every affordance those units own renders **in place and
//! disabled** rather than being left out -- the layout is the deliverable, and
//! a header missing half its buttons would not be one.
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

use std::{path::PathBuf, sync::Arc};

use cap_editor::{EditorFrameOutput, EditorInstance};
use cap_project::{RecordingMeta, RecordingMetaInner, StudioRecordingMeta, XY};
use cap_rendering::{FrameLayout, ProjectRecordingsMeta, RenderedFrame};
use gpui::{
    Context, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    Point, Render, RenderImage, SharedString, Styled, Window, div, point, prelude::FluentBuilder,
    px, svg,
};

use crate::theme::{Appearance, Theme};

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
// Timeline metrics (`routes/editor/Timeline/index.tsx:62-68`)
// ---------------------------------------------------------------------------

const TIMELINE_PADDING: f32 = 16.;
const TRACK_GUTTER_GAP: f32 = 8.;
const TRACK_GUTTER: f32 = 112.;
const TRACK_ICON_WIDTH: f32 = TRACK_GUTTER - TRACK_GUTTER_GAP;
const TIMELINE_HEADER_HEIGHT: f32 = 32.;
const PLAYHEAD_TOP_OFFSET: f32 = 24.;
/// `pt-8` on the timeline container (`TL/index.tsx:1149`).
const TIMELINE_TOP_PADDING: f32 = 32.;
/// `visibleTrackCount() > 2 ? "3rem" : "3.25rem"` (`TL/index.tsx:268-270`).
/// E1 draws the two locked tracks (clip + zoom), so 52.
const TRACK_HEIGHT: f32 = 52.;

/// `theme.css:24-34` -- the timeline's colours are CSS custom properties with
/// one definition each, not per-appearance values, so these are literal in
/// both themes exactly as they are there.
fn track_clip_color() -> Hsla {
    gpui::rgb(0x3f8ae0).into()
}
fn track_zoom_color() -> Hsla {
    gpui::rgb(0x4a4f5c).into()
}

/// `.cap-track-fill { border: 1px solid color-mix(in srgb, var(--seg-color)
/// 58%, black) }` (`TL/styles.css:23-26`).
fn track_fill_border(color: Hsla) -> Hsla {
    let rgba = gpui::Rgba::from(color);
    gpui::Rgba {
        r: rgba.r * 0.58,
        g: rgba.g * 0.58,
        b: rgba.b * 0.58,
        a: rgba.a,
    }
    .into()
}

/// The playhead's `from-[rgb(226,64,64)]` (`TL/index.tsx:1281`).
fn playhead_color() -> Hsla {
    gpui::rgb(0xe24040).into()
}

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
    /// `timeline.segments`, as `(start, end)` seconds plus the recording clip
    /// index the label is built from.
    pub clips: Vec<(f64, f64, u32)>,
    /// `timeline.duration()`, the transport's total.
    pub duration: f64,
    /// The camera tab is disabled when every segment has `camera === null`
    /// (`ConfigSidebar.tsx:602-604`).
    pub has_camera: bool,
    /// The cursor tab is disabled on `!meta().hasRecordedCursorData`
    /// (`ConfigSidebar.tsx:610`).
    pub has_cursor_data: bool,
    /// `hasMultipleRecordingSegments()` -- decides `"Clip"` vs `"Clip N"`
    /// (`TL/ClipTrack.tsx:620-622`).
    pub multiple_recording_segments: bool,
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
    let config = meta.project_config();
    let clips = config.timeline.as_ref().map_or_else(Vec::new, |timeline| {
        timeline
            .segments
            .iter()
            .map(|segment| (segment.start, segment.end, segment.recording_clip))
            .collect()
    });
    // With no persisted timeline `EditorInstance::new` synthesises one from
    // the per-segment display durations; fall back to those so the strip is
    // not empty on a raw un-edited bundle.
    let clips = if clips.is_empty() {
        let mut offset = 0.0;
        recordings
            .segments
            .iter()
            .enumerate()
            .map(|(index, segment)| {
                let start = offset;
                offset += segment.duration();
                (start, offset, index as u32)
            })
            .collect()
    } else {
        clips
    };
    let duration = clips.last().map_or(0.0, |(_, end, _)| *end)
        - clips.first().map_or(0.0, |(start, _, _)| *start);

    Ok(ProjectSummary {
        pretty_name: meta.pretty_name.clone(),
        clips,
        duration: duration.max(0.0),
        has_camera,
        has_cursor_data: has_recorded_cursor_data(&meta, studio.as_ref()),
        multiple_recording_segments,
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
        }
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    pub fn set_summary(&mut self, summary: ProjectSummary, window: &mut Window, cx: &mut Context<Self>) {
        self.state = LoadState::Ready(Box::new(summary));
        cx.notify();
        window.refresh();
    }

    pub fn set_error(&mut self, message: String, window: &mut Window, cx: &mut Context<Self>) {
        tracing::error!(path = %self.project_path.display(), "editor project failed to open: {message}");
        self.state = LoadState::Failed(message);
        cx.notify();
        window.refresh();
    }

    pub fn set_instance(&mut self, instance: Arc<EditorInstance>) {
        self.instance = Some(instance);
    }

    pub fn take_instance(&mut self) -> Option<Arc<EditorInstance>> {
        self.instance.take()
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
        self.frame_layout = Some(frame.layout);
        // Freed explicitly: nothing else evicts per-frame images from the
        // sprite atlas, and a 3MB 1080x702 frame per scrub would fill it.
        if let Some(previous) = self.latest_frame.replace(frame.image) {
            let _ = window.drop_image(previous);
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

    /// `Header.tsx:89-235` -- `h-14`, three groups, the middle one bracketed by
    /// `border-x border-black-transparent-10`.
    fn render_header(&self) -> impl IntoElement {
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
                    .child(self.editor_button("icons/undo.svg", None, None, None))
                    .child(self.editor_button("icons/redo.svg", None, None, None))
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
    fn render_player(&self) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(self.render_player_toolbar())
            .child(self.render_preview_canvas())
            .child(self.render_transport())
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
                    .child(
                        // `KSelect.Trigger`: `flex items-center gap-2 h-9 px-3
                        // rounded-lg border border-gray-3 bg-gray-2
                        // dark:bg-gray-3 text-sm text-gray-12`.
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .h(px(36.))
                            .px(px(12.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(Hsla::from(theme.gray_3))
                            .bg(if theme.is_dark() {
                                Hsla::from(theme.gray_3)
                            } else {
                                Hsla::from(theme.gray_2)
                            })
                            .opacity(0.5)
                            .text_size(px(14.))
                            .text_color(Hsla::from(theme.gray_12))
                            .child(div().flex_1().child("Half"))
                            .child(
                                svg()
                                    .path("icons/chevron-down.svg")
                                    .size(px(16.))
                                    .text_color(Hsla::from(theme.gray_11)),
                            ),
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

    /// The transport row (`Player.tsx:357-481`): `relative flex overflow-hidden
    /// z-10 flex-row gap-3 justify-between items-center p-5`.
    fn render_transport(&self) -> impl IntoElement {
        let theme = self.theme;
        let (current, total) = match self.summary() {
            Some(summary) => (0.0, summary.duration),
            None => (0.0, 0.0),
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
                    .child(format!("{} / {}", format_time(current), format_time(total))),
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
                    .opacity(0.5)
                    .child(
                        svg()
                            .path("icons/prev.svg")
                            .size(px(12.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    // `rounded-full border border-gray-300 bg-gray-3 size-9`.
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(36.))
                            .rounded_full()
                            .border_1()
                            .border_color(Hsla::from(theme.gray_5))
                            .bg(Hsla::from(theme.gray_3))
                            .child(
                                svg()
                                    .path("icons/play.svg")
                                    .size(px(12.))
                                    .text_color(Hsla::from(theme.gray_12)),
                            ),
                    )
                    .child(
                        svg()
                            .path("icons/next.svg")
                            .size(px(12.))
                            .text_color(Hsla::from(theme.gray_12)),
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
                    .opacity(0.5)
                    .child(
                        svg()
                            .path("icons/scissors.svg")
                            .size(px(20.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    // `w-px h-8 rounded-full bg-gray-4`.
                    .child(
                        div()
                            .w(px(1.))
                            .h(px(32.))
                            .rounded_full()
                            .bg(Hsla::from(theme.gray_4)),
                    )
                    .child(
                        svg()
                            .path("icons/zoom-out.svg")
                            .size(px(20.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    .child(
                        svg()
                            .path("icons/zoom-in.svg")
                            .size(px(20.))
                            .text_color(Hsla::from(theme.gray_12)),
                    )
                    // `Slider class="w-24"`: the 32px row with its 4.8px track.
                    .child(
                        div()
                            .w(px(96.))
                            .h(px(32.))
                            .flex()
                            .items_center()
                            .child(
                                div()
                                    .w_full()
                                    .h(px(5.))
                                    .rounded_full()
                                    .bg(Hsla::from(theme.gray_4)),
                            ),
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

        let mut rail = div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .h(px(SIDEBAR_TAB_BAR_HEIGHT))
            .flex_none()
            .overflow_hidden()
            .border_b_1()
            .border_color(Hsla::from(theme.gray_3))
            .bg(self.panel_bg());

        for (index, (icon, disabled)) in tabs.into_iter().enumerate() {
            let selected = index == 0;
            rail = rail.child(
                // Trigger: `flex relative z-10 flex-1 justify-center
                // items-center px-4 py-2`.
                div()
                    .relative()
                    .flex()
                    .flex_1()
                    .justify_center()
                    .items_center()
                    .px(px(16.))
                    .py(px(8.))
                    .when(disabled, |this| this.opacity(0.5))
                    .child(
                        // The icon box and, under it, the selection pill: both
                        // `size-9`, the pill `rounded-lg bg-gray-3`.
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(36.))
                            .rounded(px(8.))
                            .when(selected, |this| this.bg(Hsla::from(theme.gray_3)))
                            .child(
                                svg()
                                    .path(icon)
                                    // The rail is `text-lg`, and the icons
                                    // carry no size class -- 1em of 18px.
                                    .size(px(18.))
                                    .text_color(if selected {
                                        Hsla::from(theme.gray_12)
                                    } else {
                                        Hsla::from(theme.gray_11)
                                    }),
                            ),
                    ),
            );
        }

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

    /// The timeline strip at its default 260px. E1 draws the two **locked**
    /// tracks -- Clip and Zoom, the only ones `trackDefinitions` marks
    /// `locked: true` (`TL/index.tsx:89-144`) -- with their real gutter chips,
    /// the ruler above them and the playhead at 0. No interactions: scrub,
    /// drag, trim, split and zoom are E3.
    fn render_timeline(&self, viewport_width: f32) -> impl IntoElement {
        let summary = self.summary();
        // `transform.zoom` is visible seconds and starts at `zoomOutLimit()` =
        // `min(totalDuration, 600)` (`ED/context.ts:1387, 1455`), position 0.
        let duration = summary.map_or(0.0, |summary| summary.duration).max(0.001);
        let zoom = duration.min(600.0);

        div()
            .flex_none()
            .min_h_0()
            .px(px(8.))
            .overflow_hidden()
            .relative()
            // The persisted height, clamped to `[MIN_TIMELINE_HEIGHT,
            // layoutHeight - MIN_PLAYER_HEIGHT]` (`Editor.tsx:421-435`).
            // Nothing writes it yet -- the drag handle is inert this unit --
            // so it sits at the default with the floor still expressed.
            .h(px(DEFAULT_TIMELINE_HEIGHT))
            .min_h(px(MIN_TIMELINE_HEIGHT))
            .child(
                div().h_full().child(
                    // `pt-8 relative overflow-hidden flex flex-col gap-2
                    // h-full`, `padding-left/right: 16px`.
                    div()
                        .relative()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .h_full()
                        .overflow_hidden()
                        .pt(px(TIMELINE_TOP_PADDING))
                        .pl(px(TIMELINE_PADDING))
                        .pr(px(TIMELINE_PADDING))
                        .child(self.render_timeline_ruler(zoom, viewport_width))
                        .child(self.render_clip_track(zoom, viewport_width))
                        .child(self.render_zoom_track())
                        // The playhead: `absolute bottom-0 rounded-full z-20
                        // w-px`, `left: 128px` (16 + 112), `top: 24px`
                        // (`TL/index.tsx:1279-1295`).
                        .child(
                            div()
                                .absolute()
                                .left(px(TIMELINE_PADDING + TRACK_GUTTER))
                                .top(px(PLAYHEAD_TOP_OFFSET))
                                .bottom_0()
                                .w(px(1.))
                                .rounded_full()
                                .bg(playhead_color())
                                .child(
                                    // The knob: `size-3 rounded-full -mt-2`.
                                    div()
                                        .absolute()
                                        .top(px(-8.))
                                        .left(px(-5.5))
                                        .size(px(12.))
                                        .rounded_full()
                                        .bg(playhead_color()),
                                ),
                        ),
                ),
            )
    }

    /// `TimelineMarkings` (`TL/index.tsx:1554-1600`): a 32px header strip whose
    /// body is `relative flex-1 h-4 text-xs text-gray-9` with `margin-left:
    /// 112px`, dotted every `markingResolution()` seconds and labelled on the
    /// whole ones.
    fn render_timeline_ruler(&self, zoom: f64, viewport_width: f32) -> impl IntoElement {
        let theme = self.theme;
        let resolution = marking_resolution(zoom);
        // The strip's own width is not known until layout, so the tick count
        // uses the source formula: `ceil(2 + (zoom + 5) / resolution)`.
        let count = (2.0 + (zoom + 5.0) / resolution).ceil().max(0.) as usize;
        // `secsPerPixel = zoom / timelineBounds.width`.
        let content_width = timeline_content_width(viewport_width);
        let secs_per_pixel = zoom / content_width as f64;

        let mut body = div()
            .relative()
            .flex_1()
            .h(px(16.))
            .ml(px(TRACK_GUTTER))
            .text_size(px(12.))
            .text_color(Hsla::from(theme.gray_9));

        for index in 0..count.min(256) {
            let second = index as f64 * resolution;
            let x = second / secs_per_pixel - 1.;
            if x > content_width as f64 {
                break;
            }
            body = body.child(
                div()
                    .absolute()
                    .left(px(x as f32))
                    .bottom(px(4.))
                    .size(px(4.))
                    .rounded_full()
                    .bg(Hsla::from(theme.gray_9))
                    .when(second.fract() == 0., |this| {
                        this.child(
                            div()
                                .absolute()
                                .top(px(-18.))
                                .when(second != 0., |this| this.left(px(-12.)))
                                .w(px(28.))
                                .text_size(px(12.))
                                .text_color(Hsla::from(theme.gray_9))
                                .child(format_time(second)),
                        )
                    }),
            );
        }

        div()
            .relative()
            .h(px(TIMELINE_HEADER_HEIGHT))
            .flex_none()
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_end()
                    .child(body),
            )
            // The `TrackManager` "Add track" trigger sits at the gutter's
            // width in the header's bottom-left (`TL/index.tsx:1226-1233`).
            .child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .w(px(TRACK_ICON_WIDTH))
                    .h(px(TIMELINE_HEADER_HEIGHT / 2.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .opacity(0.5)
                    .text_size(px(11.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child("Add track"),
            )
    }

    /// The row shell every track shares: `flex items-stretch gap-2`, a 104px
    /// gutter cell and a `flex-1 relative overflow-hidden min-w-0` content
    /// cell (`TL/index.tsx:1516-1547`).
    fn track_row(
        &self,
        color: Hsla,
        icon: &'static str,
        label: &'static str,
        content: impl IntoElement,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .items_stretch()
            .gap(px(TRACK_GUTTER_GAP))
            .h(px(TRACK_HEIGHT))
            .flex_none()
            .child(
                div()
                    .w(px(TRACK_ICON_WIDTH))
                    .flex_none()
                    .relative()
                    .child(
                        // The chip: `cap-track-fill` + `relative z-10 w-full
                        // h-13 flex flex-col items-center justify-center
                        // gap-0.5 rounded-xl ... text-white`. `h-13` is 52 and
                        // deliberately does *not* follow `--track-height` --
                        // the source's own gotcha, kept.
                        div()
                            .w_full()
                            .h(px(52.))
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .gap(px(2.))
                            .rounded(px(12.))
                            .bg(color)
                            .border_1()
                            .border_color(track_fill_border(color))
                            .text_color(gpui::white())
                            .child(
                                svg()
                                    .path(icon)
                                    .size(px(16.))
                                    .text_color(gpui::white()),
                            )
                            .child(
                                div()
                                    .text_size(px(10.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(label),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .relative()
                    .overflow_hidden()
                    .min_w_0()
                    .child(content),
            )
    }

    fn render_clip_track(&self, zoom: f64, viewport_width: f32) -> impl IntoElement {
        let color = track_clip_color();
        let summary = self.summary();
        let content_width = timeline_content_width(viewport_width);
        let secs_per_pixel = zoom / content_width as f64;

        let mut content = div().relative().size_full();
        if let Some(summary) = summary {
            for (start, end, recording_clip) in &summary.clips {
                let x = start / secs_per_pixel;
                let width = (end - start) / secs_per_pixel;
                let name = if summary.multiple_recording_segments {
                    format!("Clip {recording_clip}")
                } else {
                    "Clip".to_string()
                };
                content = content.child(
                    // `SegmentRoot`: `absolute overflow-visible border
                    // rounded-xl inset-y-0`, inner fill `cap-track-fill`.
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(x as f32))
                        .w(px(width as f32))
                        .rounded(px(12.))
                        .border_1()
                        .border_color(gpui::transparent_black())
                        .child(
                            div()
                                .relative()
                                .size_full()
                                .flex()
                                .flex_col()
                                .items_center()
                                .justify_center()
                                .gap(px(4.))
                                .rounded(px(12.))
                                .overflow_hidden()
                                .bg(color)
                                .border_1()
                                .border_color(track_fill_border(color))
                                // `SegmentLabel`'s full tier: the clip name
                                // over the duration.
                                .when(width > 100., |this| {
                                    this.child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(gpui::hsla(0., 0., 1., 0.7))
                                            .child(SharedString::from(name.clone())),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            .text_color(gpui::white())
                                            .child(format_clip_time(end - start)),
                                    )
                                })
                                .when(width <= 100. && width > 48., |this| {
                                    this.child(
                                        div()
                                            .text_size(px(10.))
                                            .text_color(gpui::white())
                                            .child(format_clip_time(end - start)),
                                    )
                                }),
                        ),
                );
            }
        }

        // `IconLucideClapperboard` in the gutter; the app's own clapperboard
        // glyph stands in for the Lucide one (the Recents pill already uses it
        // for `IconCapClapperboard`).
        self.track_row(color, "icons/clapperboard.svg", "Clip", content)
    }

    fn render_zoom_track(&self) -> impl IntoElement {
        // A raw recording has no zoom segments, and creating them is E3's job,
        // so the row is the empty lane its own track renders.
        self.track_row(
            track_zoom_color(),
            "icons/search.svg",
            "Zoom",
            div().size_full(),
        )
    }
}

/// The width of a track's content column: the window, less the timeline
/// slot's `px-2`, less the container's own 16px padding on each side, less
/// the 112px icon gutter. This is `timelineBounds.width`, which every
/// `secsPerPixel` in the timeline divides by.
fn timeline_content_width(viewport_width: f32) -> f32 {
    (viewport_width - 16. - TIMELINE_PADDING * 2. - TRACK_GUTTER).max(1.)
}

/// `markingResolution` (`TL/context.ts:11-12, 50-55`): the first of
/// `[0.5, 1, 2.5, 5, 10, 30]` whose `zoom / r <= MAX_TIMELINE_MARKINGS (20)`,
/// else 30.
fn marking_resolution(zoom: f64) -> f64 {
    const MAX_TIMELINE_MARKINGS: f64 = 20.;
    for candidate in [0.5, 1.0, 2.5, 5.0, 10.0, 30.0] {
        if zoom / candidate <= MAX_TIMELINE_MARKINGS {
            return candidate;
        }
    }
    30.0
}

/// `formatTime` (`routes/editor/utils.ts:1-13`) -- the transport's `M:SS`.
fn format_time(seconds: f64) -> String {
    let seconds = seconds.max(0.0);
    let minutes = (seconds / 60.0).floor() as u64;
    let secs = (seconds % 60.0).floor() as u64;
    format!("{minutes}:{secs:02}")
}

/// The *other* `formatTime`, the timeline's (`TL/ClipTrack.tsx:128-140`):
/// `Nh Nm Ns` / `Nm Ns` / `Ns`.
fn format_clip_time(seconds: f64) -> String {
    let seconds = seconds.max(0.0);
    let hours = (seconds / 3600.0).floor() as u64;
    let minutes = ((seconds % 3600.0) / 60.0).floor() as u64;
    let secs = (seconds % 60.0).floor() as u64;
    if hours > 0 {
        format!("{hours}h {minutes}m {secs}s")
    } else if minutes > 0 {
        format!("{minutes}m {secs}s")
    } else {
        format!("{secs}s")
    }
}

impl Render for EditorWindow {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window);
        let theme = self.theme;
        // The timeline's own bounds are what `secsPerPixel` divides by, and
        // this window is resizable, so read them off the viewport rather than
        // assuming the default width.
        let viewport_width: f32 = window.viewport_size().width.into();

        div()
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            .bg(self.root_bg())
            .text_color(Hsla::from(theme.gray_12))
            .track_focus(&self.focus)
            .child(self.render_header())
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
                                            .child(self.render_player())
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
                            .child(self.render_timeline(viewport_width)),
                    ),
            )
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
) -> cap_editor::EditorFrameCallback {
    Box::new(move |output, layout| {
        // The editor renderer always emits `Rgba` -- `editor.rs:371-373`
        // hardcodes `PlaybackRenderOutputFormat::Rgba`. NV12 is the export
        // path's.
        if let EditorFrameOutput::Rgba(frame) = output {
            let _ = tx.try_send((frame, layout));
        }
    })
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

    #[test]
    fn marking_resolution_walks_the_ladder() {
        // `MAX_TIMELINE_MARKINGS = 20`.
        assert_eq!(marking_resolution(5.0), 0.5);
        assert_eq!(marking_resolution(15.0), 1.0);
        assert_eq!(marking_resolution(40.0), 2.5);
        assert_eq!(marking_resolution(90.0), 5.0);
        assert_eq!(marking_resolution(150.0), 10.0);
        assert_eq!(marking_resolution(5000.0), 30.0);
    }

    #[test]
    fn transport_time_is_m_ss() {
        assert_eq!(format_time(0.0), "0:00");
        assert_eq!(format_time(9.4), "0:09");
        assert_eq!(format_time(61.0), "1:01");
        assert_eq!(format_time(3661.0), "61:01");
    }

    #[test]
    fn clip_time_is_the_timelines_own_format() {
        assert_eq!(format_clip_time(9.4), "9s");
        assert_eq!(format_clip_time(61.0), "1m 1s");
        assert_eq!(format_clip_time(3661.0), "1h 1m 1s");
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
