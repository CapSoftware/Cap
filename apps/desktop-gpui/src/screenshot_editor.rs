//! The screenshot editor window -- `screenshot_editor.rs` +
//! `routes/screenshot-editor/` in the Tauri app, natively.
//!
//! The Tauri editor styles a still PNG through the same GPU renderer the
//! video editor uses: one `DecodedFrame`, `preserve_screen_alpha: true`, no
//! camera, re-rendered whenever `ProjectConfiguration` changes and pushed to
//! the webview over a websocket (`screenshot_editor.rs:316-476` over there).
//! Here the loop is the same -- `FrameRenderer::render_immediate` on a
//! `tokio::sync::watch` of config revisions -- and the frame skips the
//! websocket: it is un-padded by the pump, kept once as tight RGBA (which is
//! what the Phase 2 mask overlay resamples) and once BGRA-swapped for gpui's
//! atlas.
//!
//! The chrome is `Editor.tsx`'s: a 56px `Header.tsx` whose centre cluster
//! carries the aspect select, the crop button, `AnnotationTools.tsx` and the
//! five styling popovers; `LayersPanel.tsx` on the left; `Preview.tsx` filling
//! the rest with its checkerboard, its zoom HUD and its pan/zoom maths. The
//! annotation engine itself lives behind the seam in
//! [`crate::screenshot_annotations`]; sharing and the crop dialog are Phase 3.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use cap_project::{
    BackgroundSource, BorderConfiguration, CornerStyle, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, ShadowConfiguration, StudioRecordingMeta,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RenderedFrame, RendererLayers, ZoomTransformTimeline,
};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement as _, Pixels, Point, Render, RenderImage,
    StatefulInteractiveElement as _, Styled, StyledImage as _, Window, WindowHandle, canvas, div,
    img, linear_color_stop, linear_gradient, prelude::FluentBuilder as _, px, svg,
};

use crate::editor_edits::ProjectHistory;
use crate::editor_sidebar::{
    self, BACKGROUND_COLORS, BACKGROUND_IMAGE_EXTENSIONS, BACKGROUND_THEMES, DEFAULT_GRADIENT_FROM,
    DEFAULT_GRADIENT_TO, GRADIENT_PRESETS, color_to_hsla, hex_to_rgb,
};
use crate::screenshot_annotations::{self as annotations, AnnotationState, Tool};
use crate::theme::Theme;
use crate::ui;

/// `ShowCapWindow::ScreenshotEditor`: 1240x800, min 800x600, resizable.
pub const SCREENSHOT_EDITOR_WIDTH: f32 = 1240.;
pub const SCREENSHOT_EDITOR_HEIGHT: f32 = 800.;
pub const SCREENSHOT_EDITOR_MIN_WIDTH: f32 = 800.;
pub const SCREENSHOT_EDITOR_MIN_HEIGHT: f32 = 600.;

/// `MAX_DIMENSION` (`screenshot_editor.rs:38` over there).
const MAX_DIMENSION: u32 = 16_384;

/// `saveConfig`'s debounce (`context.tsx:427-438`) -- 1000ms, not the video
/// editor's 250.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(1000);

/// `Header.tsx:112` -- `h-14`.
const HEADER_HEIGHT: f32 = 56.;
/// `AnnotationConfig.tsx:44` -- `h-11`.
const CONFIG_BAR_HEIGHT: f32 = 44.;
/// `LayersPanel.tsx:203` -- `w-56`.
const LAYERS_PANEL_WIDTH: f32 = 224.;
/// `Preview.tsx:52`.
const PREVIEW_PADDING: f32 = 20.;
/// `clampZoom` (`Preview.tsx:193`).
const MIN_ZOOM: f32 = 0.1;
const MAX_ZOOM: f32 = 3.;
/// `DEFAULT_BACKGROUND_SHADOW` (`BackgroundSettingsPopover.tsx:29`).
const DEFAULT_BACKGROUND_SHADOW: f32 = 73.6;
/// `solid-toast`'s default duration.
const TOAST_DURATION: Duration = Duration::from_millis(3500);

struct LoadedScreenshot {
    config: ProjectConfiguration,
    image_size: (u32, u32),
    config_tx: tokio::sync::watch::Sender<ConfigUpdate>,
    export_tx: tokio::sync::mpsc::Sender<ExportRequest>,
}
/// The checkerboard tile: 24 cells of 10px, so it repeats seamlessly.
const CHECKER_TILE: u32 = 240;
const CHECKER_CELL: u32 = 10;

/// The `.cap` bundle a screenshot path belongs to: the directory itself, or
/// the parent of `original.png` -- `create_standalone_instance`'s cap_dir
/// resolution (`screenshot_editor.rs:205-215` over there).
pub fn resolve_bundle(path: &Path) -> Option<PathBuf> {
    if path.extension().and_then(|ext| ext.to_str()) == Some("cap") {
        return Some(path.to_path_buf());
    }
    let parent = path.parent()?;
    (parent.extension().and_then(|ext| ext.to_str()) == Some("cap")).then(|| parent.to_path_buf())
}

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

/// Everything the window and the renderer need off disk.
pub struct LoadedSource {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub pretty_name: String,
    pub config: ProjectConfiguration,
    pub meta: RecordingMeta,
    pub studio_meta: StudioRecordingMeta,
}

/// The bundle's source PNG: `original.png`, or the first PNG the directory
/// scan finds -- `create_standalone_instance`'s resolution. Shared with the
/// crop dialog, whose cropper draws this exact file.
pub(crate) fn bundle_image_path(bundle: &Path) -> Option<PathBuf> {
    let original = bundle.join("original.png");
    if original.exists() {
        return Some(original);
    }
    std::fs::read_dir(bundle).ok().and_then(|dir| {
        dir.flatten()
            .find(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("png"))
            .map(|entry| entry.path())
    })
}

/// Read `original.png` (or the first PNG in the bundle), the recording meta
/// and the project config -- the disk half of `create_standalone_instance`.
pub fn load_source(bundle: &Path) -> Result<LoadedSource, String> {
    let image_path =
        bundle_image_path(bundle).ok_or_else(|| format!("No PNG found in {}", bundle.display()))?;

    let image = image::open(&image_path).map_err(|e| format!("Failed to open image: {e}"))?;
    let (width, height) = (image.width(), image.height());
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!("Image dimensions exceed maximum: {width}x{height}"));
    }

    let meta = RecordingMeta::load_for_project(bundle)
        .map_err(|e| format!("Failed to load screenshot meta: {e}"))?;
    let studio_meta = match &meta.inner {
        RecordingMetaInner::Studio(inner) => (**inner).clone(),
        RecordingMetaInner::Instant(_) => {
            return Err("Not a screenshot bundle".to_string());
        }
    };
    let config = ProjectConfiguration::load(bundle).unwrap_or_default();

    Ok(LoadedSource {
        rgba: image.to_rgba8().into_raw(),
        width,
        height,
        pretty_name: meta.pretty_name.clone(),
        config,
        meta,
        studio_meta,
    })
}

// ---------------------------------------------------------------------------
// The still renderer
// ---------------------------------------------------------------------------

/// One config revision for the render loop. The revision rides along so a
/// frame can be matched back to the edit that produced it.
#[derive(Clone)]
pub struct ConfigUpdate {
    pub revision: u64,
    pub config: ProjectConfiguration,
}

/// A one-off render on the loop's GPU device -- `render_screenshot_png` in
/// the Tauri app, which rebuilds the whole device per export because it is a
/// stateless command; here the loop already owns one. The reply is the raw
/// styled frame; the annotation composite (`crate::screenshot_export`) runs on
/// the caller's background executor, the way the webview's canvas pass runs
/// outside the Tauri command.
pub enum ExportRequest {
    Render {
        config: ProjectConfiguration,
        reply: tokio::sync::oneshot::Sender<Result<crate::screenshot_export::RawFrame, String>>,
    },
}

/// The render loop, on the tokio runtime: build the GPU constants, then
/// re-render the still whenever the config changes and serve export requests
/// on the same device. Ends when the window goes away (both senders drop).
pub async fn run_still_renderer(
    source: LoadedSource,
    mut config_rx: tokio::sync::watch::Receiver<ConfigUpdate>,
    mut export_rx: tokio::sync::mpsc::Receiver<ExportRequest>,
    frame_tx: flume::Sender<(RenderedFrame, u64)>,
    setup_tx: flume::Sender<Result<(), String>>,
) {
    let options = RenderOptions {
        screen_size: cap_project::XY::new(source.width, source.height),
        camera_size: None,
        preserve_screen_alpha: true,
    };

    let constants = match RenderVideoConstants::new_with_options(
        options,
        source.meta,
        source.studio_meta,
    )
    .await
    {
        Ok(constants) => constants,
        Err(error) => {
            let _ = setup_tx.send(Err(format!("The GPU renderer failed to start: {error}")));
            return;
        }
    };
    let _ = setup_tx.send(Ok(()));

    let decoded = DecodedFrame::new_with_arc(Arc::new(source.rgba), source.width, source.height);

    let mut frame_renderer = FrameRenderer::new(&constants);
    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );

    let mut dirty = true;
    loop {
        if dirty {
            dirty = false;
            let update = config_rx.borrow_and_update().clone();
            match render_still(
                &constants,
                &mut frame_renderer,
                &mut layers,
                &decoded,
                &update.config,
                None,
            )
            .await
            {
                Ok(frame) => {
                    if frame_tx.send_async((frame, update.revision)).await.is_err() {
                        break;
                    }
                }
                Err(error) => tracing::error!("screenshot render failed: {error}"),
            }
        }

        tokio::select! {
            changed = config_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                dirty = true;
            }
            request = export_rx.recv() => {
                let Some(ExportRequest::Render { config, reply }) = request else {
                    break;
                };
                let result = render_export_rgba(
                    &constants,
                    &mut frame_renderer,
                    &mut layers,
                    &decoded,
                    &config,
                )
                .await;
                let _ = reply.send(result);
            }
        }
    }
}

/// One `render_immediate` of the still -- the body of the Tauri loop
/// (`screenshot_editor.rs:385-430` over there): frame 0 at 30fps, empty
/// cursor events, a zoom timeline precomputed to one frame. The preview
/// renders at the config's base size; an export passes the upscaled
/// `resolution_base`.
async fn render_still(
    constants: &RenderVideoConstants,
    frame_renderer: &mut FrameRenderer<'_>,
    layers: &mut RendererLayers,
    source: &DecodedFrame,
    config: &ProjectConfiguration,
    resolution_base: Option<cap_project::XY<u32>>,
) -> Result<RenderedFrame, String> {
    let segment_frames = DecodedSegmentFrames {
        screen_frame: Some(source.clone()),
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };

    let resolution_base = resolution_base.unwrap_or_else(|| {
        let (base_w, base_h) = ProjectUniforms::get_base_size(&constants.options, config);
        cap_project::XY::new(base_w, base_h)
    });
    let cursor_events = cap_project::CursorEvents::default();
    let mut zoom_timeline = ZoomTransformTimeline::from_project(
        config,
        &cursor_events,
        0.0,
        constants.options.screen_size,
    );
    zoom_timeline.ensure_precomputed_until(1.0 / 30.0);

    let uniforms = ProjectUniforms::new(
        constants,
        config,
        0,
        30,
        resolution_base,
        &cursor_events,
        &segment_frames,
        0.0,
        &zoom_timeline,
    );

    frame_renderer
        .render_immediate(segment_frames, uniforms, &cursor_events, true, layers)
        .await
        .map_err(|e| e.to_string())
}

/// The export render -- `render_screenshot_png`'s upscale + unpad
/// (`screenshot_editor.rs:1618-1742` over there): scale the output so a crop
/// is not downsampled, align the dimensions the way the exporter does, and
/// strip the wgpu row padding into tight straight-alpha RGBA. The preview's
/// own dimensions for the same config ride along, because that is the space
/// the annotations live in and the compositor's scale denominator.
async fn render_export_rgba(
    constants: &RenderVideoConstants,
    frame_renderer: &mut FrameRenderer<'_>,
    layers: &mut RendererLayers,
    source: &DecodedFrame,
    config: &ProjectConfiguration,
) -> Result<crate::screenshot_export::RawFrame, String> {
    let (base_width, base_height) = ProjectUniforms::get_base_size(&constants.options, config);
    let display_size = ProjectUniforms::display_size(
        &constants.options,
        config,
        cap_project::XY::new(base_width, base_height),
    )
    .coord;
    let crop = ProjectUniforms::get_crop(&constants.options, config);
    let export_scale = f64::max(
        f64::max(
            crop.size.x as f64 / f64::max(display_size.x, 1.0),
            crop.size.y as f64 / f64::max(display_size.y, 1.0),
        ),
        1.0,
    );

    let resolution_base = cap_project::XY::new(
        (((base_width as f64 * export_scale).ceil() as u32) + 3) & !3,
        (((base_height as f64 * export_scale).ceil() as u32) + 1) & !1,
    );
    if resolution_base.x > MAX_DIMENSION || resolution_base.y > MAX_DIMENSION {
        return Err(format!(
            "Export dimensions exceed maximum: {}x{}",
            resolution_base.x, resolution_base.y
        ));
    }

    let frame = render_still(
        constants,
        frame_renderer,
        layers,
        source,
        config,
        Some(resolution_base),
    )
    .await?;

    let row_bytes = frame.width as usize * 4;
    let padded = frame.padded_bytes_per_row as usize;
    if padded < row_bytes || frame.data.len() < padded * frame.height as usize {
        return Err(format!(
            "Invalid export buffer: {} bytes, stride {} for {}x{}",
            frame.data.len(),
            padded,
            frame.width,
            frame.height
        ));
    }
    let rgba: Vec<u8> = frame
        .data
        .chunks(padded)
        .take(frame.height as usize)
        .flat_map(|row| row[..row_bytes].iter().copied())
        .collect();

    // What the preview renders this config at: `get_base_size`, then the
    // uniforms' own alignment -- `get_output_size` at scale 1. That is what
    // `latestFrame()`'s width/height would be after `waitForSyncedPreview`,
    // and the compositor's `canvas.width / frame.width` denominator.
    let preview = ProjectUniforms::get_output_size(
        &constants.options,
        config,
        cap_project::XY::new(base_width, base_height),
    );

    Ok(crate::screenshot_export::RawFrame {
        rgba,
        width: frame.width,
        height: frame.height,
        base_width: preview.0,
        base_height: preview.1,
    })
}

/// The Phase 1/2 export shape -- the styled frame straight to PNG, no
/// annotation composite. Nothing in the shipping window calls it any more
/// (every destination composites first), but the seam stays callable for
/// probes that want the renderer's own output, hence the allow.
#[allow(dead_code)]
async fn render_export_png(
    constants: &RenderVideoConstants,
    frame_renderer: &mut FrameRenderer<'_>,
    layers: &mut RendererLayers,
    source: &DecodedFrame,
    config: &ProjectConfiguration,
) -> Result<Vec<u8>, String> {
    let raw = render_export_rgba(constants, frame_renderer, layers, source, config).await?;
    crate::screenshot_export::encode_rgba_png(&raw.rgba, raw.width, raw.height)
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/// The debounced `project-config.json` write -- the same shape the video
/// editor's `PendingProjectSave` has, kept separate because that one lives on
/// `EditorWindow` and this window has no reason to share its cell.
#[derive(Default)]
pub struct PendingConfigSave {
    path: Option<PathBuf>,
    config: Option<ProjectConfiguration>,
}

impl PendingConfigSave {
    /// Drop a scheduled write without performing it -- the delete path, where
    /// the bundle the write would land in is already gone.
    pub fn discard(&mut self) {
        self.config = None;
    }

    pub fn flush(&mut self) {
        let (Some(path), Some(config)) = (self.path.clone(), self.config.take()) else {
            return;
        };
        match config.write(&path) {
            Ok(()) => tracing::debug!(path = %path.display(), "screenshot config written"),
            Err(error) => {
                tracing::error!(path = %path.display(), "failed to persist screenshot config: {error}")
            }
        }
    }
}

/// The background popover's source tabs, in `BACKGROUND_SOURCES_LIST` order
/// (`BackgroundSettingsPopover.tsx:48-53`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum BgTab {
    Wallpaper,
    Image,
    Color,
    Gradient,
}

impl BgTab {
    const ALL: [(Self, &'static str); 4] = [
        (Self::Wallpaper, "Wallpaper"),
        (Self::Image, "Image"),
        (Self::Color, "Color"),
        (Self::Gradient, "Gradient"),
    ];

    fn for_source(source: &BackgroundSource) -> Self {
        match source {
            BackgroundSource::Color { .. } => Self::Color,
            BackgroundSource::Gradient { .. } | BackgroundSource::AnimatedGradient { .. } => {
                Self::Gradient
            }
            BackgroundSource::Wallpaper { .. } => Self::Wallpaper,
            BackgroundSource::Image { .. } => Self::Image,
        }
    }
}

/// `activePopover` (`context.tsx:198-200`) -- the five styling popovers on the
/// header's right-hand cluster. One at a time, by construction.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Popover {
    Background,
    Padding,
    Rounding,
    Shadow,
    Border,
}

impl Popover {
    fn anchor(self) -> Anchor {
        match self {
            Self::Background => Anchor::Background,
            Self::Padding => Anchor::Padding,
            Self::Rounding => Anchor::Rounding,
            Self::Shadow => Anchor::Shadow,
            Self::Border => Anchor::Border,
        }
    }

    /// `Popover.Content`'s `w-[...]` per popover.
    fn width(self) -> f32 {
        match self {
            Self::Background => 400.,
            Self::Padding => 200.,
            Self::Rounding => 240.,
            Self::Shadow | Self::Border => 280.,
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Background => "icons/image.svg",
            Self::Padding => "icons/padding.svg",
            Self::Rounding => "icons/corners.svg",
            Self::Shadow => "icons/shadow.svg",
            Self::Border => "icons/square.svg",
        }
    }

    fn tooltip(self) -> &'static str {
        match self {
            Self::Background => "Background",
            Self::Padding => "Padding",
            Self::Rounding => "Corner Rounding",
            Self::Shadow => "Shadow",
            Self::Border => "Border",
        }
    }

    /// The `kbd` chips on the trigger's tooltip -- and the bare key
    /// `Editor.tsx:153-169` binds. `RoundingPopover` passes no `kbd`.
    fn keys(self) -> &'static [&'static str] {
        match self {
            Self::Background => &["B"],
            Self::Padding => &["P"],
            Self::Rounding => &[],
            Self::Shadow => &["H"],
            Self::Border => &["E"],
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Background => "screenshot-popover-background",
            Self::Padding => "screenshot-popover-padding",
            Self::Rounding => "screenshot-popover-rounding",
            Self::Shadow => "screenshot-popover-shadow",
            Self::Border => "screenshot-popover-border",
        }
    }
}

/// Every element whose painted rect a popover or menu is positioned against.
/// gpui has no `getBoundingClientRect`; each one writes its prepaint bounds
/// into a shared cell, the way `ui::Slider` does with its track.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Anchor {
    Aspect,
    Background,
    Padding,
    Rounding,
    Shadow,
    Border,
    More,
    CornerStyle,
}

impl Anchor {
    const ALL: [Anchor; 8] = [
        Anchor::Aspect,
        Anchor::Background,
        Anchor::Padding,
        Anchor::Rounding,
        Anchor::Shadow,
        Anchor::Border,
        Anchor::More,
        Anchor::CornerStyle,
    ];
}

/// The three `KSelect` / `KDropdownMenu` popups on the chrome.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MenuKind {
    Aspect,
    More,
    CornerStyle,
}

/// The screenshot editor's border fallback -- `BorderPopover.tsx:42-45`,
/// black at 50%, not `BorderConfiguration::default()`'s white at 80%.
const BORDER_FALLBACK: BorderConfiguration = BorderConfiguration {
    enabled: false,
    width: 5.0,
    color: [0, 0, 0],
    opacity: 50.0,
};

/// `{ size: 50, opacity: 18, blur: 50 }` -- what `ShadowPopover.tsx:41-45`
/// seeds the advanced block with, and what its three sliders read through when
/// the block is absent.
const ADVANCED_SHADOW_FALLBACK: ShadowConfiguration = ShadowConfiguration {
    size: 50.,
    opacity: 18.,
    blur: 50.,
};

/// Every slider in the chrome, with the popovers' exact ranges.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum StyleSlider {
    Blur,
    Padding,
    Rounding,
    Shadow,
    ShadowSize,
    ShadowOpacity,
    ShadowBlur,
    BorderWidth,
    BorderOpacity,
    /// The preview's zoom HUD. Window state only -- it never touches the
    /// project, so `apply` is never called for it.
    Zoom,
}

impl StyleSlider {
    const ALL: [StyleSlider; 10] = [
        StyleSlider::Blur,
        StyleSlider::Padding,
        StyleSlider::Rounding,
        StyleSlider::Shadow,
        StyleSlider::ShadowSize,
        StyleSlider::ShadowOpacity,
        StyleSlider::ShadowBlur,
        StyleSlider::BorderWidth,
        StyleSlider::BorderOpacity,
        StyleSlider::Zoom,
    ];

    /// `(min, max, step)` -- `BackgroundSettingsPopover` blur,
    /// `PaddingPopover`, `RoundingPopover`, `ShadowPopover` + `ShadowSettings`,
    /// `BorderPopover`, and `Preview.tsx`'s HUD.
    fn range(self) -> (f32, f32, f32) {
        match self {
            Self::Padding | Self::Rounding | Self::Shadow => (0., 100., 1.),
            Self::Blur | Self::ShadowSize | Self::ShadowOpacity | Self::ShadowBlur => {
                (0., 100., 0.1)
            }
            Self::BorderWidth => (1., 20., 0.1),
            Self::BorderOpacity => (0., 100., 0.1),
            Self::Zoom => (MIN_ZOOM, MAX_ZOOM, 0.1),
        }
    }

    fn value(self, project: &ProjectConfiguration) -> f32 {
        let background = &project.background;
        let advanced = background
            .advanced_shadow
            .as_ref()
            .unwrap_or(&ADVANCED_SHADOW_FALLBACK);
        match self {
            Self::Blur => background.blur as f32,
            Self::Padding => background.padding as f32,
            Self::Rounding => background.rounding as f32,
            Self::Shadow => background.shadow,
            Self::ShadowSize => advanced.size,
            Self::ShadowOpacity => advanced.opacity,
            Self::ShadowBlur => advanced.blur,
            Self::BorderWidth => background
                .border
                .as_ref()
                .map_or(BORDER_FALLBACK.width, |border| border.width),
            Self::BorderOpacity => background
                .border
                .as_ref()
                .map_or(BORDER_FALLBACK.opacity, |border| border.opacity),
            // Never read: the HUD reads `self.zoom` directly.
            Self::Zoom => 1.,
        }
    }

    fn apply(self, project: &mut ProjectConfiguration, value: f32) -> bool {
        let background = &mut project.background;
        match self {
            Self::Blur => {
                if background.blur == value as f64 {
                    return false;
                }
                background.blur = value as f64;
            }
            Self::Padding => {
                if background.padding == value as f64 {
                    return false;
                }
                // `handlePaddingChange` (`PaddingPopover.tsx:25-46`): padding
                // over an invisible background would render as nothing, so the
                // first non-zero value also lights the background up.
                if value > 0. && has_no_visible_background(&background.source) {
                    background.source = BackgroundSource::Color {
                        value: [255, 255, 255],
                        alpha: 255,
                    };
                }
                background.padding = value as f64;
            }
            Self::Rounding => {
                if background.rounding == value as f64 {
                    return false;
                }
                background.rounding = value as f64;
            }
            Self::Shadow => {
                if background.shadow == value {
                    return false;
                }
                background.shadow = value;
                // `ShadowPopover.tsx:37-48` seeds the advanced block in the
                // same batch, so the first drag off zero has something to
                // shape the shadow with.
                if value > 0. && background.advanced_shadow.is_none() {
                    background.advanced_shadow = Some(ADVANCED_SHADOW_FALLBACK);
                }
            }
            Self::ShadowSize | Self::ShadowOpacity | Self::ShadowBlur => {
                let shadow = background
                    .advanced_shadow
                    .get_or_insert(ADVANCED_SHADOW_FALLBACK);
                let field = match self {
                    Self::ShadowSize => &mut shadow.size,
                    Self::ShadowOpacity => &mut shadow.opacity,
                    _ => &mut shadow.blur,
                };
                if *field == value {
                    return false;
                }
                *field = value;
            }
            Self::BorderWidth => {
                let border = background.border.get_or_insert(BorderConfiguration {
                    enabled: true,
                    ..BORDER_FALLBACK
                });
                if border.width == value {
                    return false;
                }
                border.width = value;
            }
            Self::BorderOpacity => {
                let border = background.border.get_or_insert(BorderConfiguration {
                    enabled: true,
                    ..BORDER_FALLBACK
                });
                if border.opacity == value {
                    return false;
                }
                border.opacity = value;
            }
            Self::Zoom => return false,
        }
        true
    }
}

/// `hasNoVisibleBackground` (`context.tsx:30-42`) -- also what the export
/// compositor's white fill and transparency scan key off
/// (`screenshotExport.ts:15-27`).
pub(crate) fn has_no_visible_background(source: &BackgroundSource) -> bool {
    match source {
        BackgroundSource::Color { alpha, .. } => *alpha == 0,
        BackgroundSource::Wallpaper { path } | BackgroundSource::Image { path } => path.is_none(),
        BackgroundSource::Gradient { .. } | BackgroundSource::AnimatedGradient { .. } => false,
    }
}

/// The four `RgbInput`s the popovers carry (`ColorPicker.tsx:27-103`).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum HexTarget {
    BackgroundColor,
    GradientFrom,
    GradientTo,
    BorderColor,
}

impl HexTarget {
    const ALL: [HexTarget; 4] = [
        HexTarget::BackgroundColor,
        HexTarget::GradientFrom,
        HexTarget::GradientTo,
        HexTarget::BorderColor,
    ];

    fn id(self) -> &'static str {
        match self {
            Self::BackgroundColor => "screenshot-hex-background",
            Self::GradientFrom => "screenshot-hex-gradient-from",
            Self::GradientTo => "screenshot-hex-gradient-to",
            Self::BorderColor => "screenshot-hex-border",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
enum ExportDestination {
    Clipboard,
    File,
    /// `CAP_GPUI_AUTO_SCREENSHOT_EXPORT=<path>`: the harness destination --
    /// the same GPU export, written straight to the path (a save panel
    /// cannot be driven without Accessibility).
    Harness(PathBuf),
}

/// `exportStatus` (`useScreenshotExport.ts`), which is what the Share button's
/// tooltip reads. Copy and Save walk Rendering -> Encoding; only the share
/// flow reaches Uploading.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ExportStatus {
    Idle,
    Rendering,
    Encoding,
    Uploading,
}

/// One `solid-toast` bubble. `Loading` is the share flow's
/// (`useScreenshotExport.ts:153-239` posts one and updates it in place);
/// copy and save go straight to a success bubble.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ToastKind {
    Loading,
    Success,
    Error,
}

struct Toast {
    id: u64,
    kind: ToastKind,
    message: String,
}

/// A live pan drag on the preview (`Preview.tsx:402-442`).
#[derive(Clone, Copy)]
struct PanDrag {
    start: Point<Pixels>,
    origin: (f32, f32),
}

/// The measured geometry `Preview.tsx` derives from the container's bounds.
/// Recomputed each frame from last frame's prepaint, which is the same
/// one-frame lag `createElementBounds` has on a resize.
#[derive(Clone, Copy)]
struct PreviewGeometry {
    /// The letterboxed viewport, centred in the area.
    size: (f32, f32),
    fit_scale: f32,
    scaled: (f32, f32),
    content: (f32, f32),
}

/// `handleWheel`'s pan arm (`Preview.tsx:317-320`), in gpui's sign convention.
/// The webview's `deltaY` is AppKit's `scrollingDeltaY` negated, so the
/// source's `pan - delta` is `pan + delta` here: an AppKit-positive delta --
/// fingers sweeping down/right on a natural-scroll trackpad -- carries the
/// content down/right with them.
fn wheel_pan(pan: (f32, f32), delta: (f32, f32)) -> (f32, f32) {
    (pan.0 + delta.0, pan.1 + delta.1)
}

/// The ctrl+wheel arm's zoom step (`Preview.tsx:303-315`), sign-flipped for
/// the same reason: wheel-up is DOM-negative but AppKit-positive, and either
/// way it zooms in. The 8px floor keeps a gentle tick moving, and 0.005 is
/// the source's `zoomStep`.
fn ctrl_wheel_zoom_step(delta_y: f32) -> f32 {
    delta_y.signum() * delta_y.abs().max(8.) * 0.005
}

type BoundsCell = Rc<Cell<Option<Bounds<Pixels>>>>;

pub struct ScreenshotEditorWindow {
    pub(crate) theme: Theme,
    pub(crate) bundle: PathBuf,
    pretty_name: String,
    error: Option<String>,
    /// The live config, published to the render loop on every edit.
    pub(crate) project: ProjectConfiguration,
    /// `projectHistory` (`context.tsx:549-659`), reusing the video editor's.
    pub(crate) history: ProjectHistory,
    revision: u64,
    config_tx: Option<tokio::sync::watch::Sender<ConfigUpdate>>,
    export_tx: Option<tokio::sync::mpsc::Sender<ExportRequest>>,
    /// One export at a time: the copy/save buttons grey out while the GPU
    /// renders.
    exporting: bool,
    export_status: ExportStatus,
    /// The latest GPU frame, already BGRA in gpui's atlas format.
    frame: Option<Arc<RenderImage>>,
    /// The same frame as tight RGBA. `Preview.tsx` reads the preview canvas
    /// back to blur/pixelate mask regions (`:537-687`); the mask overlay
    /// resamples this instead of the atlas image.
    pub(crate) frame_rgba: Option<Arc<Vec<u8>>>,
    pub(crate) frame_size: (f32, f32),
    /// `originalImageSize` -- the source PNG's dimensions, which the crop
    /// button gates on and the frame-space transform needs.
    pub(crate) image_size: Option<(u32, u32)>,
    /// `prevState` in the resize effect (`context.tsx:465-472`).
    previous_transform: Option<((f32, f32), annotations::ImageTransform)>,
    /// `isRenderReady`: the skeleton stands in until the first frame lands.
    ready: bool,
    pending_save: Rc<RefCell<PendingConfigSave>>,
    save_task: Option<gpui::Task<()>>,

    // -- Chrome state --------------------------------------------------------
    pub(crate) tool: Tool,
    pub(crate) selected_annotation: Option<String>,
    /// Everything the annotation engine keeps ([`crate::screenshot_annotations`]).
    pub(crate) annotation_state: AnnotationState,
    layers_panel_open: bool,
    /// The crop dialog ([`crate::screenshot_crop`]). `None` means closed.
    pub(crate) crop: Option<crate::screenshot_crop::ScreenshotCropDialog>,
    active_popover: Option<Popover>,
    menu: Option<(MenuKind, ui::MenuState)>,
    anchors: HashMap<Anchor, BoundsCell>,
    bg_tab: BgTab,
    wallpaper_theme: usize,
    wallpapers: HashMap<&'static str, Arc<RenderImage>>,
    wallpaper_task: Option<gpui::Task<()>>,
    /// The Image tab's `h-48` preview, decoded off-thread and keyed by path.
    bg_image: Option<(String, Arc<RenderImage>)>,
    bg_image_task: Option<gpui::Task<()>>,
    shadow_advanced: ui::CollapsibleState,
    border_body: ui::CollapsibleState,
    hex_inputs: HashMap<HexTarget, Entity<ui::TextInputState>>,
    pub(crate) text_subscriptions: Vec<gpui::Subscription>,
    slider_tracks: HashMap<StyleSlider, ui::SliderTrack>,
    active_slider: Option<StyleSlider>,

    // -- Preview state -------------------------------------------------------
    zoom: f32,
    pan: (f32, f32),
    preview_area: BoundsCell,
    viewport: BoundsCell,
    panning: Option<PanDrag>,
    /// The one cached checkerboard tile the preview paints under everything.
    checker: Option<Arc<RenderImage>>,

    toasts: Vec<Toast>,
    next_toast: u64,
    toast_tasks: HashMap<u64, gpui::Task<()>>,
    pub(crate) focus: gpui::FocusHandle,
}

impl ScreenshotEditorWindow {
    pub(crate) fn export_in_flight(&self) -> bool {
        self.exporting
    }

    pub fn new(bundle: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let close_bundle = bundle.clone();
        window.on_window_should_close(cx, move |_window, cx| {
            let bundle = close_bundle.clone();
            cx.defer(move |cx| crate::app_windows::screenshot_editor_closed(&bundle, cx));
            true
        });

        let pretty_name = bundle
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Screenshot")
            .to_string();

        let mut this = Self {
            theme: Theme::for_window(window, cx, false),
            bundle,
            pretty_name,
            error: None,
            project: ProjectConfiguration::default(),
            history: ProjectHistory::new(ProjectConfiguration::default()),
            revision: 0,
            config_tx: None,
            export_tx: None,
            exporting: false,
            export_status: ExportStatus::Idle,
            frame: None,
            frame_rgba: None,
            frame_size: (1., 1.),
            image_size: None,
            previous_transform: None,
            ready: false,
            pending_save: Rc::new(RefCell::new(PendingConfigSave::default())),
            save_task: None,

            tool: Tool::Select,
            selected_annotation: None,
            annotation_state: AnnotationState::default(),
            // `makePersisted(createSignal(false), { name:
            // "screenshotEditorLayersPanelOpen" })` -- localStorage over
            // there, `store.rs` here.
            layers_panel_open: crate::store::load()
                .screenshot_layers_panel_open
                .unwrap_or(false),
            crop: None,
            active_popover: None,
            menu: None,
            anchors: Anchor::ALL
                .into_iter()
                .map(|anchor| (anchor, BoundsCell::default()))
                .collect(),
            bg_tab: BgTab::Color,
            wallpaper_theme: 0,
            wallpapers: HashMap::new(),
            wallpaper_task: None,
            bg_image: None,
            bg_image_task: None,
            shadow_advanced: ui::CollapsibleState::new(false),
            border_body: ui::CollapsibleState::new(false),
            hex_inputs: HashMap::new(),
            text_subscriptions: Vec::new(),
            slider_tracks: StyleSlider::ALL
                .into_iter()
                .map(|slider| (slider, ui::SliderTrack::default()))
                .collect(),
            active_slider: None,

            zoom: 1.,
            pan: (0., 0.),
            preview_area: BoundsCell::default(),
            viewport: BoundsCell::default(),
            panning: None,
            checker: Some(checkerboard_tile()),

            toasts: Vec::new(),
            next_toast: 0,
            toast_tasks: HashMap::new(),
            focus: cx.focus_handle(),
        };

        for target in HexTarget::ALL {
            let input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
            let subscription = cx.subscribe_in(
                &input,
                window,
                move |this: &mut Self, _input, event: &ui::TextInputEvent, window, cx| {
                    this.on_hex_event(target, event, window, cx);
                },
            );
            this.text_subscriptions.push(subscription);
            this.hex_inputs.insert(target, input);
        }
        this.init_annotation_inputs(window, cx);

        this
    }

    pub fn set_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.error = Some(message);
        self.ready = true;
        cx.notify();
    }

    fn set_loaded(
        &mut self,
        pretty_name: String,
        loaded: LoadedScreenshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let LoadedScreenshot {
            config,
            image_size,
            config_tx,
            export_tx,
        } = loaded;
        self.pretty_name = pretty_name;
        self.bg_tab = BgTab::for_source(&config.background.source);
        self.border_body
            .set_open(config.background.border.as_ref().is_some_and(|b| b.enabled));
        self.history = ProjectHistory::new(config.clone());
        self.project = config;
        self.image_size = Some(image_size);
        self.config_tx = Some(config_tx);
        self.export_tx = Some(export_tx);
        self.pending_save.borrow_mut().path = Some(self.bundle.clone());
        if self.bg_tab == BgTab::Wallpaper {
            self.ensure_wallpapers(cx);
        }
        self.ensure_background_image(cx);
        if let Ok(dest) = std::env::var("CAP_GPUI_AUTO_SCREENSHOT_EXPORT")
            && !dest.trim().is_empty()
        {
            self.export_image(ExportDestination::Harness(PathBuf::from(dest)), window, cx);
        }
        // `CAP_GPUI_AUTO_SCREENSHOT_CROP=1`: open the crop dialog once the
        // image size is known -- the same reason as `CAP_GPUI_AUTO_CROP` on
        // the video editor: unprivileged synthetic clicks are dropped, and the
        // dialog has to be up before a real drag inside it can be posted.
        if std::env::var("CAP_GPUI_AUTO_SCREENSHOT_CROP").is_ok_and(|value| value == "1") {
            self.open_crop_dialog(window, cx);
        }
        cx.notify();
    }

    pub fn frame_arrived(
        &mut self,
        image: Arc<RenderImage>,
        rgba: Arc<Vec<u8>>,
        size: (u32, u32),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let next = (size.0.max(1) as f32, size.1.max(1) as f32);
        self.rescale_annotations_for(next);
        self.frame_size = next;
        self.frame_rgba = Some(rgba);
        self.ready = true;
        if let Some(previous) = self.frame.replace(image) {
            let _ = window.drop_image(previous);
        }
        // The content rect moves with the frame, so every mask is re-clipped
        // into it (`AnnotationLayer.tsx:88-141`) before the overlays resample.
        if self.clamp_masks() {
            self.publish();
            self.schedule_save(window, cx);
        }
        self.refresh_mask_overlays(window, cx);
        cx.notify();
    }

    pub fn pending_save(&self) -> Rc<RefCell<PendingConfigSave>> {
        self.pending_save.clone()
    }

    /// The context's resize effect (`context.tsx:474-547`): a frame that has
    /// changed size by more than a pixel moves every annotation across from
    /// the old content rect to the new one.
    fn rescale_annotations_for(&mut self, frame_size: (f32, f32)) {
        let Some(image_size) = self.image_size else {
            return;
        };
        let changed = self
            .previous_transform
            .as_ref()
            .is_none_or(|(previous, _)| {
                (frame_size.0 - previous.0).abs() > 1. || (frame_size.1 - previous.1).abs() > 1.
            });
        if !changed {
            return;
        }

        let current = annotations::calculate_image_transform(
            (frame_size.0 as f64, frame_size.1 as f64),
            (image_size.0 as f64, image_size.1 as f64),
            self.project.background.padding,
            self.project.background.crop.as_ref(),
            self.project.aspect_ratio.as_ref(),
        );
        if let Some((_, previous)) = self.previous_transform {
            annotations::rescale_annotations(&mut self.project.annotations, &previous, &current);
        }
        self.previous_transform = Some((frame_size, current));
    }

    /// Every project edit funnels through here: mutate, record one history
    /// entry, publish to the renderer, schedule the debounced write --
    /// `updateScreenshotConfig`'s throttled-render + debounced-save pair.
    /// `ProjectHistory::record` is a no-op while a drag holds the pause, so a
    /// slider's sixty intermediate values still collapse into one entry.
    pub(crate) fn edit_project(
        &mut self,
        change: impl FnOnce(&mut ProjectConfiguration) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !change(&mut self.project) {
            return;
        }
        // Padding, crop and aspect all move the content rect underneath the
        // masks; the clamp rides along in the same history entry.
        self.clamp_masks();
        self.history.record(&self.project);
        self.publish();
        self.schedule_save(window, cx);
        self.refresh_mask_overlays(window, cx);
        cx.notify();
    }

    pub(crate) fn publish(&mut self) {
        let Some(config_tx) = &self.config_tx else {
            return;
        };
        self.revision += 1;
        let _ = config_tx.send(ConfigUpdate {
            revision: self.revision,
            config: self.project.clone(),
        });
    }

    pub(crate) fn schedule_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pending_save.borrow_mut().config = Some(self.project.clone());
        let pending = self.pending_save.clone();
        self.save_task = Some(cx.spawn_in(window, async move |_, cx| {
            cx.background_executor().timer(SAVE_DEBOUNCE).await;
            pending.borrow_mut().flush();
        }));
    }

    fn sync_appearance(&mut self, window: &Window, cx: &gpui::App) {
        self.theme.refresh(window, cx, false);
    }

    // -- History ---------------------------------------------------------------

    fn undo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(config) = self.history.undo().cloned() else {
            return;
        };
        self.apply_history(config, window, cx);
    }

    fn redo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(config) = self.history.redo().cloned() else {
            return;
        };
        self.apply_history(config, window, cx);
    }

    fn apply_history(
        &mut self,
        config: ProjectConfiguration,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.project = config;
        self.bg_tab = BgTab::for_source(&self.project.background.source);
        if let Some(id) = &self.selected_annotation
            && !self
                .project
                .annotations
                .iter()
                .any(|annotation| &annotation.id == id)
        {
            self.selected_annotation = None;
        }
        self.ensure_background_image(cx);
        self.publish();
        self.schedule_save(window, cx);
        self.refresh_mask_overlays(window, cx);
        cx.notify();
    }

    // -- Toasts -----------------------------------------------------------------

    /// `toast.loading(..)` -- the bubble the share flow posts before it starts
    /// rendering and updates in place as the upload progresses.
    #[allow(dead_code)]
    fn toast_loading(&mut self, message: impl Into<String>, cx: &mut Context<Self>) -> u64 {
        let id = self.next_toast;
        self.next_toast += 1;
        self.toasts.push(Toast {
            id,
            kind: ToastKind::Loading,
            message: message.into(),
        });
        cx.notify();
        id
    }

    /// `toast.success(msg, { id })` -- replace a loading bubble in place.
    /// Success and error bubbles then time out; the loading one persists until
    /// it is updated.
    #[allow(dead_code)]
    fn toast_update(
        &mut self,
        id: u64,
        kind: ToastKind,
        message: impl Into<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let message = message.into();
        match self.toasts.iter_mut().find(|toast| toast.id == id) {
            Some(toast) => {
                toast.kind = kind;
                toast.message = message;
            }
            None => self.toasts.push(Toast { id, kind, message }),
        }
        if kind != ToastKind::Loading {
            self.dismiss_after(id, window, cx);
        }
        cx.notify();
    }

    fn toast_success(
        &mut self,
        message: impl Into<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = self.next_toast;
        self.next_toast += 1;
        self.toasts.push(Toast {
            id,
            kind: ToastKind::Success,
            message: message.into(),
        });
        self.dismiss_after(id, window, cx);
        cx.notify();
    }

    fn toast_error(
        &mut self,
        message: impl Into<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = self.next_toast;
        self.next_toast += 1;
        self.toasts.push(Toast {
            id,
            kind: ToastKind::Error,
            message: message.into(),
        });
        self.dismiss_after(id, window, cx);
        cx.notify();
    }

    fn dismiss_after(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let task = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(TOAST_DURATION).await;
            this.update(cx, |this, cx| {
                this.toasts.retain(|toast| toast.id != id);
                this.toast_tasks.remove(&id);
                cx.notify();
            })
            .ok();
        });
        self.toast_tasks.insert(id, task);
    }

    // -- Styling ----------------------------------------------------------------

    fn anchor(&self, anchor: Anchor) -> BoundsCell {
        self.anchors.get(&anchor).cloned().unwrap_or_default()
    }

    fn track(&self, slider: StyleSlider) -> ui::SliderTrack {
        self.slider_tracks.get(&slider).cloned().unwrap_or_default()
    }

    /// A slider press or drag move: map the pointer to the slider's value and
    /// apply it.
    fn apply_slider(
        &mut self,
        slider: StyleSlider,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let track = self.track(slider);
        let (min, max, step) = slider.range();
        let Some(value) = ui::slider_value_at(&track, position, min, max, step) else {
            return;
        };
        if slider == StyleSlider::Zoom {
            // The HUD's slider sets zoom outright and leaves the pan alone
            // (`Preview.tsx:484-492`).
            if self.zoom != value {
                self.zoom = value;
                cx.notify();
            }
            return;
        }
        self.edit_project(move |project| slider.apply(project, value), window, cx);
    }

    fn begin_slider(
        &mut self,
        slider: StyleSlider,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.active_slider.is_none() {
            self.history.pause();
        }
        self.active_slider = Some(slider);
        self.apply_slider(slider, position, window, cx);
        cx.notify();
    }

    fn end_slider(&mut self, cx: &mut Context<Self>) {
        if self.active_slider.take().is_some() {
            self.history.resume(&self.project);
        }
        cx.notify();
    }

    /// A collapsible's height animation has no frame loop of its own -- gpui
    /// only repaints on demand -- so a toggle pumps the ~220ms transition, the
    /// same way `editor_sidebar::animate_collapsibles` does.
    fn animate_collapsibles(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.notify();
        window.refresh();
        cx.spawn_in(window, async move |this, cx| {
            for _ in 0..14 {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                if this
                    .update_in(cx, |_, window, cx| {
                        cx.notify();
                        window.refresh();
                    })
                    .is_err()
                {
                    return;
                }
            }
        })
        .detach();
    }

    /// `ensurePaddingForBackground` (`BackgroundSettingsPopover.tsx:205-223`):
    /// picking a visible background with everything at zero would render as a
    /// bare screenshot, so the first pick also gives it padding, a corner
    /// radius and a shadow -- as one history entry.
    fn ensure_padding_for_background(project: &mut ProjectConfiguration) {
        let background = &mut project.background;
        let padding_zero = background.padding == 0.;
        let rounding_zero = background.rounding == 0.;
        if padding_zero {
            background.padding = 10.;
        }
        if padding_zero && rounding_zero {
            background.rounding = 8.;
        }
        if background.shadow == 0. {
            background.shadow = DEFAULT_BACKGROUND_SHADOW;
        }
    }

    /// Decode the current theme's wallpaper tiles that are not cached yet --
    /// `ensure_wallpapers` on the video editor, against this window's own map.
    fn ensure_wallpapers(&mut self, cx: &mut Context<Self>) {
        let theme_name = BACKGROUND_THEMES[self.wallpaper_theme].0;
        let wanted: Vec<&'static str> = editor_sidebar::wallpapers_for_theme(theme_name)
            .into_iter()
            .filter(|id| !self.wallpapers.contains_key(id))
            .collect();
        if wanted.is_empty() {
            return;
        }
        self.wallpaper_task = Some(cx.spawn(async move |this, cx| {
            let decoded = cx
                .background_executor()
                .spawn(async move {
                    wanted
                        .into_iter()
                        .filter_map(|id| {
                            editor_sidebar::decode_wallpaper_thumbnail(id).map(|image| (id, image))
                        })
                        .collect::<Vec<_>>()
                })
                .await;
            this.update(cx, |this, cx| {
                for (id, image) in decoded {
                    this.wallpapers.insert(id, image);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// The Image tab's `h-48` preview. Decoded off-thread and cached by path,
    /// so switching tabs does not re-read the file.
    fn ensure_background_image(&mut self, cx: &mut Context<Self>) {
        let BackgroundSource::Image { path: Some(path) } = &self.project.background.source else {
            self.bg_image = None;
            return;
        };
        if self
            .bg_image
            .as_ref()
            .is_some_and(|(cached, _)| cached == path)
        {
            return;
        }
        let path = path.clone();
        self.bg_image_task = Some(cx.spawn(async move |this, cx| {
            let decoded = cx
                .background_executor()
                .spawn({
                    let path = path.clone();
                    async move { decode_preview_image(Path::new(&path)) }
                })
                .await;
            this.update(cx, |this, cx| {
                this.bg_image = decoded.map(|image| (path, image));
                cx.notify();
            })
            .ok();
        }));
    }

    fn pick_background_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let Some(path) = crate::platform::open_image_panel(&BACKGROUND_IMAGE_EXTENSIONS) else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                let path = path.to_string_lossy().to_string();
                this.edit_project(
                    move |project| {
                        project.background.source = BackgroundSource::Image { path: Some(path) };
                        Self::ensure_padding_for_background(project);
                        true
                    },
                    window,
                    cx,
                );
                this.ensure_background_image(cx);
            })
            .ok();
        })
        .detach();
    }

    // -- Hex fields -------------------------------------------------------------

    fn hex_color(&self, target: HexTarget) -> Option<cap_project::Color> {
        match (target, &self.project.background.source) {
            (HexTarget::BackgroundColor, BackgroundSource::Color { value, .. }) => Some(*value),
            (HexTarget::GradientFrom, BackgroundSource::Gradient { from, .. }) => Some(*from),
            (HexTarget::GradientTo, BackgroundSource::Gradient { to, .. }) => Some(*to),
            (HexTarget::BorderColor, _) => Some(
                self.project
                    .background
                    .border
                    .as_ref()
                    .map_or(BORDER_FALLBACK.color, |border| border.color),
            ),
            _ => None,
        }
    }

    fn set_hex_color(
        &mut self,
        target: HexTarget,
        color: cap_project::Color,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_project(
            move |project| {
                match (target, &mut project.background.source) {
                    (HexTarget::BackgroundColor, source) => {
                        let alpha = match source {
                            BackgroundSource::Color { alpha, .. } => *alpha,
                            _ => 255,
                        };
                        *source = BackgroundSource::Color {
                            value: color,
                            alpha,
                        };
                    }
                    (HexTarget::GradientFrom, BackgroundSource::Gradient { from, .. }) => {
                        *from = color;
                    }
                    (HexTarget::GradientTo, BackgroundSource::Gradient { to, .. }) => *to = color,
                    (HexTarget::BorderColor, _) => {
                        let border = project
                            .background
                            .border
                            .get_or_insert(BorderConfiguration {
                                enabled: true,
                                ..BORDER_FALLBACK
                            });
                        border.color = color;
                    }
                    _ => return false,
                }
                true
            },
            window,
            cx,
        );
    }

    /// `createWritableMemo(() => rgbToHex(props.value))`: the field re-derives
    /// from the colour whenever it moves underneath -- a preset, an undo -- but
    /// never while it has focus, or it would fight what is being typed. Runs
    /// from `render`, where the focus is knowable.
    fn sync_hex_inputs(&mut self, window: &Window, cx: &mut Context<Self>) {
        for target in HexTarget::ALL {
            let Some(value) = self.hex_color(target) else {
                continue;
            };
            let Some(input) = self.hex_inputs.get(&target).cloned() else {
                continue;
            };
            if input.read(cx).focus_handle().is_focused(window) {
                continue;
            }
            let hex = editor_sidebar::rgb_to_hex(value);
            if input.read(cx).text() != hex {
                input.update(cx, |input, cx| input.set_text(hex, cx));
            }
        }
    }

    /// `RgbInput`'s three handlers (`ColorPicker.tsx:35-100`): a complete 6- or
    /// 8-digit value commits live, Enter and blur commit whatever is in the
    /// box, and anything that does not parse snaps back.
    fn on_hex_event(
        &mut self,
        target: HexTarget,
        event: &ui::TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                let Some(input) = self.hex_inputs.get(&target) else {
                    return;
                };
                let text = input.read(cx).text().to_string();
                let digits = editor_sidebar::hex_digit_count(&text);
                if digits != 6 && digits != 8 {
                    return;
                }
                let Some(rgba) = hex_to_rgb(text.trim()) else {
                    return;
                };
                let color = [rgba[0] as u16, rgba[1] as u16, rgba[2] as u16];
                if self.hex_color(target) != Some(color) {
                    self.set_hex_color(target, color, window, cx);
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

    fn commit_hex(&mut self, target: HexTarget, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = self.hex_inputs.get(&target).cloned() else {
            return;
        };
        let text = input.read(cx).text().to_string();
        match hex_to_rgb(text.trim()) {
            Some(rgba) => {
                let color = [rgba[0] as u16, rgba[1] as u16, rgba[2] as u16];
                if self.hex_color(target) != Some(color) {
                    self.set_hex_color(target, color, window, cx);
                }
                input.update(cx, |input, cx| {
                    input.set_text(editor_sidebar::rgb_to_hex(color), cx)
                });
            }
            None => {
                if let Some(value) = self.hex_color(target) {
                    input.update(cx, |input, cx| {
                        input.set_text(editor_sidebar::rgb_to_hex(value), cx)
                    });
                }
            }
        }
    }

    // -- Preview geometry -------------------------------------------------------

    /// `Preview.tsx:88-139`: letterbox the frame into the padded area, cap it
    /// at the frame's native size (no upscale past 100%), then place the
    /// content wrapper inside the centred viewport.
    fn preview_geometry(&self) -> Option<PreviewGeometry> {
        let area = self.preview_area.get()?;
        let available_width = (f32::from(area.size.width) - PREVIEW_PADDING * 2.).max(0.);
        let available_height = (f32::from(area.size.height) - PREVIEW_PADDING * 2.).max(0.);
        if available_width <= 0. || available_height <= 0. {
            return None;
        }
        let container_aspect = available_width / available_height;
        let (frame_width, frame_height) = self.frame_size;
        let content_aspect = if frame_width == 0. || frame_height == 0. {
            container_aspect
        } else {
            frame_width / frame_height
        };

        let (mut width, mut height) = if content_aspect < container_aspect {
            (available_height * content_aspect, available_height)
        } else {
            (available_width, available_width / content_aspect)
        };
        width = width.min(frame_width);
        height = height.min(frame_height);

        let fit_scale = if frame_width == 0. {
            1.
        } else {
            width / frame_width
        };
        // `cssScale` (`Preview.tsx:129-131`).
        let css_scale = fit_scale * self.zoom;
        let scaled = (frame_width * css_scale, frame_height * css_scale);
        Some(PreviewGeometry {
            size: (width, height),
            fit_scale,
            scaled,
            content: (
                (width - scaled.0) / 2. + self.pan.0,
                (height - scaled.1) / 2. + self.pan.1,
            ),
        })
    }

    fn clamp_zoom(zoom: f32) -> f32 {
        zoom.clamp(MIN_ZOOM, MAX_ZOOM)
    }

    /// `zoomAtPoint` (`Preview.tsx:221-264`), with `bounds.x`/`bounds.y` zero
    /// because the preview's content bounds are always the whole frame here.
    /// `pointer` is relative to the viewport's top-left.
    fn zoom_at_point(&mut self, pointer: (f32, f32), new_zoom: f32, cx: &mut Context<Self>) {
        let Some(geometry) = self.preview_geometry() else {
            self.zoom = new_zoom;
            cx.notify();
            return;
        };
        let current_scale = geometry.fit_scale * self.zoom;
        let next_scale = geometry.fit_scale * new_zoom;
        if current_scale > 0. && next_scale > 0. && geometry.size.0 > 0. && geometry.size.1 > 0. {
            let content_x =
                (pointer.0 - (geometry.size.0 - geometry.size.0 * self.zoom) / 2. - self.pan.0)
                    / current_scale;
            let content_y =
                (pointer.1 - (geometry.size.1 - geometry.size.1 * self.zoom) / 2. - self.pan.1)
                    / current_scale;
            self.pan = (
                pointer.0
                    - (geometry.size.0 - geometry.size.0 * new_zoom) / 2.
                    - content_x * next_scale,
                pointer.1
                    - (geometry.size.1 - geometry.size.1 * new_zoom) / 2.
                    - content_y * next_scale,
            );
        }
        self.zoom = new_zoom;
        cx.notify();
    }

    /// `zoomIn` / `zoomOut` (`Preview.tsx:183-191`): a tenth either way, and
    /// the pan resets.
    fn nudge_zoom(&mut self, delta: f32, cx: &mut Context<Self>) {
        self.zoom = Self::clamp_zoom(self.zoom + delta);
        self.pan = (0., 0.);
        cx.notify();
    }

    /// `handleWheel` (`Preview.tsx:300-322`): a plain scroll pans, ctrl+scroll
    /// zooms at the pointer. gpui's `Lines` delta is the browser's
    /// `deltaMode === 1`, so it takes the same x16 -- but gpui hands AppKit's
    /// `scrollingDelta` through unchanged, and AppKit's sign convention is the
    /// DOM's negated, so both of the source's uses of `delta` flip sign here
    /// ([`wheel_pan`], [`ctrl_wheel_zoom_step`]).
    fn preview_wheel(
        &mut self,
        event: &gpui::ScrollWheelEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (delta_x, delta_y) = match event.delta {
            gpui::ScrollDelta::Pixels(delta) => (f32::from(delta.x), f32::from(delta.y)),
            gpui::ScrollDelta::Lines(delta) => (delta.x * 16., delta.y * 16.),
        };
        if event.modifiers.control {
            if delta_y == 0. {
                return;
            }
            let zoom = Self::clamp_zoom(self.zoom + ctrl_wheel_zoom_step(delta_y));
            let pointer = self.viewport_pointer(event.position);
            self.zoom_at_point(pointer, zoom, cx);
            return;
        }
        self.pan = wheel_pan(self.pan, (delta_x, delta_y));
        cx.notify();
    }

    /// The trackpad pinch the webview would have delivered as `gesturechange`
    /// (`Preview.tsx:341-350`): `delta` is already the fractional scale change.
    fn preview_pinch(
        &mut self,
        event: &gpui::PinchEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let zoom = Self::clamp_zoom(self.zoom * (1. + event.delta));
        let pointer = self.viewport_pointer(event.position);
        self.zoom_at_point(pointer, zoom, cx);
    }

    /// A window-space pointer, made viewport-local -- `getBoundingClientRect`'s
    /// job over there.
    fn viewport_pointer(&self, position: Point<Pixels>) -> (f32, f32) {
        match self.viewport.get() {
            Some(bounds) => (
                f32::from(position.x - bounds.origin.x),
                f32::from(position.y - bounds.origin.y),
            ),
            None => (f32::from(position.x), f32::from(position.y)),
        }
    }

    fn preview_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The image surface hands the press to the annotation layer first; a
        // press it does not want falls through to the pan, which is what
        // `onBackgroundMouseDown` does over there.
        if event.button == MouseButton::Left && self.annotation_mouse_down(event, window, cx) {
            // `onMouseDown={dismissActivePopover}` sits on the viewport itself
            // (`Preview.tsx:711`), so a press that draws still closes whatever
            // styling popover was open.
            if self.active_popover.take().is_some() {
                cx.notify();
            }
            return;
        }
        if event.button != MouseButton::Left && event.button != MouseButton::Middle {
            return;
        }
        self.active_popover = None;
        self.panning = Some(PanDrag {
            start: event.position,
            origin: self.pan,
        });
        cx.notify();
    }

    fn preview_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.annotation_mouse_move(event.position, window, cx) {
            return;
        }
        let Some(drag) = self.panning else {
            return;
        };
        self.pan = (
            drag.origin.0 + f32::from(event.position.x - drag.start.x),
            drag.origin.1 + f32::from(event.position.y - drag.start.y),
        );
        cx.notify();
    }

    fn preview_mouse_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.annotation_mouse_up(window, cx);
        if self.panning.take().is_some() {
            cx.notify();
        }
    }

    // -- Export actions -------------------------------------------------------

    /// Render at export resolution, bake the annotations in
    /// (`renderScreenshotExportCanvas` -- `crate::screenshot_export`), and hand
    /// the encoded bytes to their destination -- `exportImage`'s Copy and Save
    /// arms (`useScreenshotExport.ts:139-253`). The composite and the encode
    /// both run on the background executor.
    fn export_image(
        &mut self,
        destination: ExportDestination,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.exporting {
            return;
        }
        let Some(export_tx) = self.export_tx.clone() else {
            return;
        };
        self.exporting = true;
        self.export_status = ExportStatus::Rendering;
        cx.notify();

        let config = self.project.clone();
        let name = self.pretty_name.clone();
        cx.spawn_in(window, async move |this, cx| {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let request = ExportRequest::Render {
                config: config.clone(),
                reply: reply_tx,
            };
            let rendered = if export_tx.send(request).await.is_ok() {
                match reply_rx.await {
                    Ok(result) => result,
                    Err(_) => Err("The renderer stopped before the export finished".into()),
                }
            } else {
                Err("The screenshot renderer is not running".into())
            };

            // The canvas pass counts as "rendering" over there too
            // (`setExportStatus("encoding")` only lands after
            // `renderExportCanvas` returns).
            let composited = match rendered {
                Ok(raw) => {
                    let composite_config = config.clone();
                    Ok(cx
                        .background_executor()
                        .spawn(async move {
                            crate::screenshot_export::composite(&raw, &composite_config)
                        })
                        .await)
                }
                Err(error) => Err(error),
            };

            let result = match composited {
                Ok(out) => {
                    this.update_in(cx, |this, _window, cx| {
                        this.export_status = ExportStatus::Encoding;
                        cx.notify();
                    })
                    .ok();
                    let encode_config = config.clone();
                    let for_clipboard = destination == ExportDestination::Clipboard;
                    cx.background_executor()
                        .spawn(async move {
                            if for_clipboard {
                                crate::screenshot_export::encode_for_copy(&out, &encode_config)
                            } else {
                                crate::screenshot_export::encode_for_save(&out)
                            }
                        })
                        .await
                }
                Err(error) => Err(error),
            };

            match result {
                Ok(bytes) => match destination {
                    ExportDestination::Clipboard => {
                        this.update_in(cx, |this, window, cx| {
                            match crate::platform::copy_image_bytes_to_clipboard(&bytes, cx) {
                                Ok(()) => {
                                    this.toast_success(
                                        "Screenshot copied to clipboard!",
                                        window,
                                        cx,
                                    );
                                }
                                Err(error) => {
                                    tracing::error!("copying the screenshot failed: {error}");
                                    this.toast_error(error, window, cx);
                                }
                            }
                        })
                        .ok();
                    }
                    ExportDestination::File => {
                        let dest =
                            crate::platform::save_file_panel(&format!("{name}.png"), &["png"]);
                        if let Some(dest) = dest {
                            let written = cx
                                .background_executor()
                                .spawn(async move { std::fs::write(&dest, &bytes) })
                                .await;
                            match written {
                                Ok(()) => {
                                    this.update_in(cx, |this, window, cx| {
                                        this.toast_success("Screenshot saved!", window, cx)
                                    })
                                    .ok();
                                }
                                Err(error) => {
                                    tracing::error!("saving the screenshot failed: {error}");
                                    this.update_in(cx, |this, window, cx| {
                                        this.toast_error(error.to_string(), window, cx)
                                    })
                                    .ok();
                                }
                            }
                        }
                    }
                    ExportDestination::Harness(dest) => match std::fs::write(&dest, &bytes) {
                        Ok(()) => {
                            tracing::info!(path = %dest.display(), "harness export written")
                        }
                        Err(error) => tracing::error!("harness export failed: {error}"),
                    },
                },
                Err(error) => {
                    tracing::error!("screenshot export failed: {error}");
                    this.update_in(cx, |this, window, cx| this.toast_error(error, window, cx))
                        .ok();
                }
            }

            this.update_in(cx, |this, _window, cx| {
                this.exporting = false;
                this.export_status = ExportStatus::Idle;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// One step of the share flow's status ladder: the header tooltip's
    /// `exportStatus` and the one loading toast, updated in place.
    fn share_progress(
        &mut self,
        toast: u64,
        status: ExportStatus,
        message: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.export_status = status;
        self.toast_update(toast, ToastKind::Loading, message, window, cx);
    }

    fn finish_share_error(
        &mut self,
        toast: u64,
        message: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        tracing::error!("screenshot share failed: {message}");
        self.toast_update(toast, ToastKind::Error, message, window, cx);
        self.exporting = false;
        self.export_status = ExportStatus::Idle;
        cx.notify();
    }

    /// `copy_screenshot_share_link`: the link onto the clipboard, the loading
    /// toast flipped to "Share link copied to clipboard".
    fn finish_share_success(
        &mut self,
        toast: u64,
        link: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
        self.toast_update(
            toast,
            ToastKind::Success,
            "Share link copied to clipboard",
            window,
            cx,
        );
        self.exporting = false;
        self.export_status = ExportStatus::Idle;
        cx.notify();
    }

    /// `exportImage("share")` (`useScreenshotExport.ts:139-253`) end to end:
    /// fingerprint the config; an unchanged one just re-copies the stored link
    /// (`copy_current_screenshot_share_link`, no upload). Otherwise render +
    /// composite, encode JPEG-0.9-or-PNG per transparency, create-or-get the
    /// screenshot video record (reusing `sharing.id` so the link stays
    /// stable), presigned-PUT the bytes, and persist
    /// `SharingMeta { id, link, content_hash }` into the bundle's meta --
    /// `upload_rendered_screenshot` + `save_screenshot_sharing` over there.
    ///
    /// Failure modes, deliberately Tauri's: a failed upload (or a failed meta
    /// write after a successful upload) leaves the existing sharing meta
    /// untouched and toasts the error; the next attempt re-runs create-or-get,
    /// which also heals a sharing id deleted server-side by minting a fresh
    /// record.
    fn share_screenshot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.exporting {
            return;
        }
        let Some(export_tx) = self.export_tx.clone() else {
            return;
        };
        self.exporting = true;
        self.export_status = ExportStatus::Encoding;
        let toast = self.toast_loading("Preparing upload", cx);
        cx.notify();

        let config = self.project.clone();
        let bundle = self.bundle.clone();
        cx.spawn_in(window, async move |this, cx| {
            // 1. The fingerprint, and the sharing meta it is compared against.
            let hash_config = config.clone();
            let content_hash = match cx
                .background_executor()
                .spawn(async move { crate::screenshot_export::content_hash(&hash_config) })
                .await
            {
                Ok(hash) => hash,
                Err(error) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_share_error(toast, error, window, cx)
                    })
                    .ok();
                    return;
                }
            };

            let meta_bundle = bundle.clone();
            let meta = cx
                .background_executor()
                .spawn(async move {
                    RecordingMeta::load_for_project(&meta_bundle)
                        .map_err(|error| format!("Failed to load screenshot metadata: {error}"))
                })
                .await;
            let mut meta = match meta {
                Ok(meta) => meta,
                Err(error) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_share_error(toast, error, window, cx)
                    })
                    .ok();
                    return;
                }
            };

            // 2. An unchanged config short-circuits to the stored link --
            //    `screenshot_share_link_for_hash`.
            if let Some(sharing) = meta.sharing.as_ref()
                && sharing.content_hash.as_deref() == Some(content_hash.as_str())
            {
                let link = sharing.link.clone();
                this.update_in(cx, |this, window, cx| {
                    this.finish_share_success(toast, link, window, cx)
                })
                .ok();
                return;
            }

            // 3. Render + composite.
            this.update_in(cx, |this, window, cx| {
                this.share_progress(
                    toast,
                    ExportStatus::Rendering,
                    "Rendering screenshot",
                    window,
                    cx,
                );
            })
            .ok();
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let request = ExportRequest::Render {
                config: config.clone(),
                reply: reply_tx,
            };
            let rendered = if export_tx.send(request).await.is_ok() {
                match reply_rx.await {
                    Ok(result) => result,
                    Err(_) => Err("The renderer stopped before the export finished".into()),
                }
            } else {
                Err("The screenshot renderer is not running".into())
            };
            let raw = match rendered {
                Ok(raw) => raw,
                Err(error) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_share_error(toast, error, window, cx)
                    })
                    .ok();
                    return;
                }
            };
            let composite_config = config.clone();
            let out = cx
                .background_executor()
                .spawn(async move { crate::screenshot_export::composite(&raw, &composite_config) })
                .await;

            // 4. Encode -- JPEG at 0.9 unless the output needs its alpha.
            this.update_in(cx, |this, window, cx| {
                this.share_progress(
                    toast,
                    ExportStatus::Encoding,
                    "Preparing upload",
                    window,
                    cx,
                );
            })
            .ok();
            let encode_config = config.clone();
            let encoded = match cx
                .background_executor()
                .spawn(
                    async move { crate::screenshot_export::encode_for_share(&out, &encode_config) },
                )
                .await
            {
                Ok(encoded) => encoded,
                Err(error) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_share_error(toast, error, window, cx)
                    })
                    .ok();
                    return;
                }
            };

            // 5. Upload, on the tokio runtime the network stack lives on.
            this.update_in(cx, |this, window, cx| {
                this.share_progress(
                    toast,
                    ExportStatus::Uploading,
                    "Uploading screenshot",
                    window,
                    cx,
                );
            })
            .ok();
            let existing_id = meta.sharing.as_ref().map(|sharing| sharing.id.clone());
            let content_type = encoded.content_type();
            let bytes = encoded.into_bytes();
            let upload = gpui_tokio::Tokio::spawn(cx, async move {
                crate::upload::upload_rendered_screenshot(bytes, content_type, existing_id).await
            });
            let outcome = match upload.await {
                Ok(outcome) => outcome,
                Err(error) => Err(format!("The upload task failed: {error}")),
            };

            let uploaded = match outcome {
                Ok(crate::upload::ScreenshotShareOutcome::Uploaded(item)) => item,
                Ok(crate::upload::ScreenshotShareOutcome::NotAuthenticated) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_share_error(
                            toast,
                            "You need to sign in to create shareable links".into(),
                            window,
                            cx,
                        )
                    })
                    .ok();
                    return;
                }
                Ok(crate::upload::ScreenshotShareOutcome::UpgradeRequired) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_share_error(
                            toast,
                            "This feature requires an upgraded plan".into(),
                            window,
                            cx,
                        )
                    })
                    .ok();
                    return;
                }
                Err(error) => {
                    this.update_in(cx, |this, window, cx| {
                        this.finish_share_error(toast, error, window, cx)
                    })
                    .ok();
                    return;
                }
            };

            // 6. `save_screenshot_sharing`: the meta write is part of the
            //    flow's success -- a failure here surfaces as the error, and
            //    the sharing meta on disk stays what it was.
            let link = uploaded.link.clone();
            meta.sharing = Some(cap_project::SharingMeta {
                id: uploaded.id,
                link: uploaded.link,
                content_hash: Some(content_hash),
            });
            let saved = cx
                .background_executor()
                .spawn(async move {
                    meta.save_for_project()
                        .map_err(|error| format!("Error saving project: {error}"))
                })
                .await;

            this.update_in(cx, |this, window, cx| match saved {
                Ok(()) => this.finish_share_success(toast, link, window, cx),
                Err(error) => this.finish_share_error(toast, error, window, cx),
            })
            .ok();
        })
        .detach();
    }

    /// The header's Delete: confirm, remove the bundle, close this window --
    /// `Header.tsx`'s delete (`remove(path)` then close).
    fn delete_screenshot(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let bundle = self.bundle.clone();
        cx.spawn_in(window, async move |_this, cx| {
            if !crate::platform::confirm_dialog(
                "Cap",
                "Are you sure you want to delete this screenshot?",
                "Yes",
                "No",
                false,
            ) {
                return;
            }
            let deleted = cx
                .background_executor()
                .spawn({
                    let bundle = bundle.clone();
                    async move { crate::library::delete_screenshot(&bundle) }
                })
                .await;
            if let Err(error) = deleted {
                tracing::error!(path = %bundle.display(), "deleting the screenshot failed: {error}");
                return;
            }
            cx.update(|_, cx| crate::app_windows::close_screenshot_editor_after_delete(&bundle, cx))
                .ok();
        })
        .detach();
    }

    // -- Aspect ratio -------------------------------------------------------

    const ASPECT_OPTIONS: [(Option<cap_project::AspectRatio>, &'static str); 6] = [
        (None, "Auto"),
        (Some(cap_project::AspectRatio::Wide), "Wide ⋅16:9"),
        (Some(cap_project::AspectRatio::Vertical), "Vertical ⋅9:16"),
        (Some(cap_project::AspectRatio::Square), "Square ⋅1:1"),
        (Some(cap_project::AspectRatio::Classic), "Classic ⋅4:3"),
        (Some(cap_project::AspectRatio::Tall), "Tall ⋅3:4"),
    ];

    /// `KSelect.Value` (`AspectRatioSelect.tsx:78-88`) -- the trigger shows the
    /// bare ratio, not the option's name.
    fn aspect_label(&self) -> &'static str {
        match &self.project.aspect_ratio {
            None => "Auto",
            Some(cap_project::AspectRatio::Wide) => "16:9",
            Some(cap_project::AspectRatio::Vertical) => "9:16",
            Some(cap_project::AspectRatio::Square) => "1:1",
            Some(cap_project::AspectRatio::Classic) => "4:3",
            Some(cap_project::AspectRatio::Tall) => "3:4",
        }
    }

    fn aspect_menu_items(&self) -> Vec<ui::MenuItem> {
        Self::ASPECT_OPTIONS
            .iter()
            .map(|(value, label)| {
                ui::MenuItem::new(*label, aspect_eq(value, &self.project.aspect_ratio))
            })
            .collect()
    }

    fn choose_aspect(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        let Some((next, _)) = Self::ASPECT_OPTIONS.get(index) else {
            return;
        };
        let next = next.clone();
        self.edit_project(
            move |project| {
                if aspect_eq(&project.aspect_ratio, &next) {
                    return false;
                }
                project.aspect_ratio = next;
                true
            },
            window,
            cx,
        );
    }

    const CORNER_STYLES: [(CornerStyle, &'static str); 2] = [
        (CornerStyle::Squircle, "Squircle"),
        (CornerStyle::Rounded, "Rounded"),
    ];

    fn corner_style_label(&self) -> &'static str {
        match self.project.background.rounding_type {
            CornerStyle::Squircle => "Squircle",
            CornerStyle::Rounded => "Rounded",
        }
    }

    fn menu_items(&self, kind: MenuKind) -> Vec<ui::MenuItem> {
        match kind {
            MenuKind::Aspect => self.aspect_menu_items(),
            MenuKind::More => vec![
                ui::MenuItem::new("Open Folder", false),
                ui::MenuItem::new("Delete", false),
            ],
            MenuKind::CornerStyle => Self::CORNER_STYLES
                .iter()
                .map(|(style, label)| {
                    ui::MenuItem::new(*label, *style == self.project.background.rounding_type)
                })
                .collect(),
        }
    }

    fn commit_menu(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some((kind, _)) = self.menu else {
            return;
        };
        match kind {
            MenuKind::Aspect => self.choose_aspect(index, window, cx),
            MenuKind::More => {
                self.menu = None;
                match index {
                    0 => crate::library::reveal_in_folder(&self.bundle.join("original.png")),
                    1 => self.delete_screenshot(window, cx),
                    _ => {}
                }
                cx.notify();
            }
            MenuKind::CornerStyle => {
                self.menu = None;
                let Some((style, _)) = Self::CORNER_STYLES.get(index) else {
                    return;
                };
                let style = *style;
                self.edit_project(
                    move |project| {
                        if project.background.rounding_type == style {
                            return false;
                        }
                        project.background.rounding_type = style;
                        true
                    },
                    window,
                    cx,
                );
            }
        }
    }

    /// Open a menu under `anchor`, or close it if it is already the open one.
    fn toggle_menu(
        &mut self,
        kind: MenuKind,
        anchor: Anchor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.menu.as_ref().is_some_and(|(open, _)| *open == kind) {
            self.menu = None;
            cx.notify();
            return;
        }
        let items = self.menu_items(kind);
        let origin = self
            .anchor(anchor)
            .get()
            .map(|bounds| {
                let x = match kind {
                    // `placement="bottom-end"` (`Header.tsx:168`).
                    MenuKind::More => bounds.origin.x + bounds.size.width - px(200.),
                    _ => bounds.origin.x,
                };
                gpui::point(x.max(px(8.)), bounds.origin.y + bounds.size.height + px(4.))
            })
            .unwrap_or_else(|| gpui::point(px(16.), px(HEADER_HEIGHT)));
        self.menu = Some((kind, ui::MenuState::new(origin, &items)));
        // The corner-style select lives *inside* the rounding popover, so it
        // is the one menu that must not close what it is standing on.
        if kind != MenuKind::CornerStyle {
            self.active_popover = None;
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Close the styling popover and any chrome menu -- what opening a modal
    /// (the crop dialog) does to the layers beneath it.
    pub(crate) fn dismiss_chrome_popups(&mut self) {
        self.active_popover = None;
        self.menu = None;
    }

    fn toggle_popover(&mut self, popover: Popover, window: &mut Window, cx: &mut Context<Self>) {
        self.active_popover = if self.active_popover == Some(popover) {
            None
        } else {
            self.menu = None;
            window.focus(&self.focus, cx);
            Some(popover)
        };
        cx.notify();
    }

    fn set_tool(&mut self, tool: Tool, cx: &mut Context<Self>) {
        self.tool = tool;
        if tool != Tool::Select {
            self.selected_annotation = None;
        }
        cx.notify();
    }

    fn toggle_layers_panel(&mut self, cx: &mut Context<Self>) {
        self.layers_panel_open = !self.layers_panel_open;
        let open = self.layers_panel_open;
        cx.background_executor()
            .spawn(async move {
                crate::store::update(|state| state.screenshot_layers_panel_open = Some(open));
            })
            .detach();
        cx.notify();
    }

    // -- Keyboard ---------------------------------------------------------------

    /// `Editor.tsx:56-176` plus `Header.tsx:49-82` and `Preview.tsx:195-219`,
    /// which are three `window` listeners over there and one handler here.
    fn on_key(&mut self, event: &gpui::KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.is_held {
            return;
        }
        // Every one of the three listeners bails on a focused input first.
        if ui::text_input_has_focus(window, cx) {
            return;
        }

        // The crop dialog is modal: it takes its own keys (the options menu,
        // Escape, the arrow nudge) and everything else stops at it -- no tool
        // switching or popover toggling under the overlay.
        if self.crop.is_some() {
            if self.crop_dialog_key_down(event, window, cx) {
                cx.stop_propagation();
            }
            return;
        }

        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        let modified = modifiers.platform || modifiers.control;

        // An open menu takes its own keys -- arrows, Home/End, Enter, Escape.
        if self.menu.is_some() {
            let action = self
                .menu
                .as_mut()
                .map(|(_, state)| state.on_key(key))
                .unwrap_or(ui::MenuKey::Ignored);
            match action {
                ui::MenuKey::Moved => {
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                ui::MenuKey::Commit(index) => {
                    cx.stop_propagation();
                    self.commit_menu(index, window, cx);
                    return;
                }
                ui::MenuKey::Dismiss => {
                    cx.stop_propagation();
                    self.menu = None;
                    cx.notify();
                    return;
                }
                ui::MenuKey::Ignored => {}
            }
        }

        if modified {
            match key {
                "z" => {
                    cx.stop_propagation();
                    if modifiers.shift {
                        self.redo(window, cx);
                    } else {
                        self.undo(window, cx);
                    }
                }
                "y" => {
                    cx.stop_propagation();
                    self.redo(window, cx);
                }
                "c" => {
                    cx.stop_propagation();
                    if !self.copy_selected_annotation(cx) {
                        self.export_image(ExportDestination::Clipboard, window, cx);
                    }
                }
                "v" => {
                    cx.stop_propagation();
                    self.paste_annotation(window, cx);
                }
                "s" => {
                    cx.stop_propagation();
                    self.export_image(ExportDestination::File, window, cx);
                }
                "-" => {
                    cx.stop_propagation();
                    self.nudge_zoom(-0.1, cx);
                }
                "=" | "+" => {
                    cx.stop_propagation();
                    self.nudge_zoom(0.1, cx);
                }
                _ => {}
            }
            return;
        }
        if modifiers.shift || modifiers.alt {
            return;
        }

        match key {
            "a" => self.set_tool(Tool::Arrow, cx),
            "r" => self.set_tool(Tool::Rectangle, cx),
            "m" => self.set_tool(Tool::Mask, cx),
            // 'o' for oval, the same alias `Editor.tsx:134-138` carries.
            "c" | "o" => self.set_tool(Tool::Circle, cx),
            "d" => self.set_tool(Tool::Draw, cx),
            "t" => self.set_tool(Tool::Text, cx),
            "v" | "s" => {
                self.set_tool(Tool::Select, cx);
                self.selected_annotation = None;
                cx.notify();
            }
            "escape" => {
                if self.active_popover.take().is_some() || self.menu.take().is_some() {
                    cx.notify();
                    return;
                }
                self.set_tool(Tool::Select, cx);
                self.selected_annotation = None;
                cx.notify();
            }
            "p" => self.toggle_popover(Popover::Padding, window, cx),
            "b" => self.toggle_popover(Popover::Background, window, cx),
            "h" => self.toggle_popover(Popover::Shadow, window, cx),
            "e" => self.toggle_popover(Popover::Border, window, cx),
            "l" => self.toggle_layers_panel(cx),
            "backspace" | "delete" => self.delete_selected_annotation(window, cx),
            _ => {}
        }
    }

    // -- Header -----------------------------------------------------------------

    /// The shared-cell capture every anchored trigger wraps itself in. gpui has
    /// no `getBoundingClientRect`; this is the same shape `ui::Slider` uses for
    /// its track and `editor_crop` for its crop box.
    fn anchored(&self, anchor: Anchor, child: impl IntoElement) -> impl IntoElement {
        let cell = self.anchor(anchor);
        div()
            .relative()
            .flex_shrink_0()
            .child(
                canvas(
                    move |bounds, _window, _cx| cell.set(Some(bounds)),
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(child)
    }

    /// `AnnotationTools.tsx:20-75`: the layers toggle, a divider, then the
    /// seven tool buttons.
    fn render_annotation_tools(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let layers_open = self.layers_panel_open;

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .child(tool_button(
                &theme,
                "screenshot-layers-toggle",
                "icons/layers.svg",
                "Layers",
                "L",
                layers_open,
                cx.listener(|this, _, _window, cx| {
                    cx.stop_propagation();
                    this.toggle_layers_panel(cx);
                }),
            ))
            .child(divider(&theme, 16.))
            .children(Tool::ALL.map(|tool| {
                tool_button(
                    &theme,
                    gpui::SharedString::from(format!("screenshot-tool-{}", tool.label())),
                    tool.icon(),
                    tool.label(),
                    tool.shortcut(),
                    self.tool == tool,
                    cx.listener(move |this, _, _window, cx| {
                        cx.stop_propagation();
                        this.set_tool(tool, cx);
                    }),
                )
            }))
    }

    /// `Header.tsx:109-216`.
    fn render_header(&self, _window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let crop_enabled = self.image_size.is_some();
        let exporting = self.exporting;
        let share_tooltip = match self.export_status {
            ExportStatus::Rendering => "Rendering screenshot",
            ExportStatus::Encoding => "Preparing upload",
            ExportStatus::Uploading => "Uploading screenshot",
            ExportStatus::Idle => "Create shareable link",
        };

        let tools = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .child(
                self.anchored(
                    Anchor::Aspect,
                    ui::EditorButton::plain(&theme, "screenshot-aspect")
                        .width(px(80.))
                        .left_icon("icons/layout.svg")
                        .icon_size(px(16.))
                        .label(self.aspect_label())
                        .right_icon("icons/chevron-down.svg")
                        .right_icon_end(true)
                        .pressed(
                            self.menu
                                .as_ref()
                                .is_some_and(|(kind, _)| *kind == MenuKind::Aspect),
                        )
                        .tooltip(&theme, "Aspect Ratio")
                        .on_click(cx.listener(|this, _, window, cx| {
                            cx.stop_propagation();
                            this.toggle_menu(MenuKind::Aspect, Anchor::Aspect, window, cx);
                        })),
                ),
            )
            .child(
                ui::EditorButton::plain(&theme, "screenshot-crop")
                    .left_icon("icons/crop.svg")
                    .icon_size(px(16.))
                    .disabled(!crop_enabled)
                    .tooltip(&theme, "Crop Image")
                    .on_click(cx.listener(|this, _, window, cx| {
                        cx.stop_propagation();
                        this.open_crop_dialog(window, cx);
                    })),
            )
            .child(divider(&theme, 24.))
            .child(self.render_annotation_tools(cx))
            .child(divider(&theme, 24.))
            .children(
                [
                    Popover::Background,
                    Popover::Padding,
                    Popover::Rounding,
                    Popover::Shadow,
                    Popover::Border,
                ]
                .map(|popover| {
                    let button = ui::EditorButton::plain(&theme, popover.id())
                        .left_icon(popover.icon())
                        .icon_size(px(16.))
                        .pressed(self.active_popover == Some(popover))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.toggle_popover(popover, window, cx);
                        }));
                    // The `kbd` prop rides the tooltip, which
                    // `ui::EditorButton` does not carry, so the wrapper the
                    // popover anchors against owns it instead.
                    self.anchored(
                        popover.anchor(),
                        kbd_tooltip(&theme, popover.tooltip(), popover.keys(), button),
                    )
                    .into_any_element()
                }),
            );
        #[cfg(not(target_os = "windows"))]
        let tools = tools.absolute().top_0().left_0().size_full();
        #[cfg(target_os = "windows")]
        let tools = div()
            .id("screenshot-header-tools")
            .flex()
            .flex_1()
            .min_w_0()
            .h(px(32.))
            .overflow_x_scroll()
            .occlude()
            .child(tools.flex_shrink_0().mx_auto());

        let header = div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .px(px(16.))
            .when(cfg!(target_os = "windows"), |header| {
                header
                    .pr_0()
                    .gap(px(8.))
                    .window_control_area(gpui::WindowControlArea::Drag)
            })
            .flex_shrink_0()
            .border_b_1()
            .border_color(theme.gray_3)
            .bg(if theme.is_dark() {
                theme.gray_2
            } else {
                theme.gray_1
            })
            // The inset traffic lights' spacer (`Header.tsx:115`).
            .when(!cfg!(target_os = "windows"), |header| {
                header.child(div().flex().items_center().child(div().w(px(56.))))
            })
            // `absolute left-1/2 -translate-x-1/2` -- a full-width centred row
            // is the same placement without a transform, and it is not
            // interactive itself, so the right cluster painted after it still
            // takes its own clicks.
            .child(tools)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .h_full()
                    .pr(px(8.))
                    .when(cfg!(target_os = "windows"), |actions| {
                        actions.h(px(32.)).flex_shrink_0().occlude()
                    })
                    .child(divider(&theme, 24.))
                    .child(
                        ui::EditorButton::plain(&theme, "screenshot-copy")
                            .left_icon("icons/copy.svg")
                            .icon_size(px(16.))
                            .disabled(exporting)
                            .tooltip(&theme, "Copy to Clipboard")
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.export_image(ExportDestination::Clipboard, window, cx);
                            })),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "screenshot-save")
                            .left_icon("icons/save.svg")
                            .icon_size(px(16.))
                            .disabled(exporting)
                            .tooltip(&theme, "Save")
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.export_image(ExportDestination::File, window, cx);
                            })),
                    )
                    .child(
                        ui::EditorButton::plain(&theme, "screenshot-share")
                            .left_icon("icons/link.svg")
                            .icon_size(px(16.))
                            .disabled(exporting)
                            .tooltip(&theme, share_tooltip)
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.share_screenshot(window, cx);
                            })),
                    )
                    .child(
                        self.anchored(
                            Anchor::More,
                            ui::EditorButton::plain(&theme, "screenshot-more")
                                .left_icon("icons/more-horizontal.svg")
                                .icon_size(px(16.))
                                .disabled(exporting)
                                .pressed(
                                    self.menu
                                        .as_ref()
                                        .is_some_and(|(kind, _)| *kind == MenuKind::More),
                                )
                                .tooltip(&theme, "More Actions")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.toggle_menu(MenuKind::More, Anchor::More, window, cx);
                                })),
                        ),
                    ),
            );

        #[cfg(target_os = "windows")]
        let header = header.child(ui::windows_caption_controls(
            theme,
            _window.is_window_active(),
            _window.is_maximized(),
            true,
            true,
        ));

        header
    }

    // -- Layers panel -----------------------------------------------------------

    /// `LayersPanel.tsx:202-325`.
    fn render_layers_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .h_full()
            .w(px(LAYERS_PANEL_WIDTH))
            .flex_shrink_0()
            .border_r_1()
            .border_color(theme.gray_3)
            .bg(if theme.is_dark() {
                theme.gray_2
            } else {
                theme.gray_1
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .px(px(12.))
                    .h(px(40.))
                    .flex_shrink_0()
                    .border_b_1()
                    .border_color(theme.gray_3)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.gray_12)
                            .child(
                                svg()
                                    .path("icons/layers.svg")
                                    .size(px(16.))
                                    .text_color(theme.gray_12),
                            )
                            .child("Layers"),
                    )
                    .child(
                        div()
                            .id("screenshot-layers-close")
                            .flex()
                            .items_center()
                            .justify_center()
                            .p(px(4.))
                            .rounded(px(4.))
                            .cursor_pointer()
                            .hover(|style| style.bg(theme.gray_3))
                            .child(
                                svg()
                                    .path("icons/x.svg")
                                    .size(px(16.))
                                    .text_color(theme.gray_11),
                            )
                            .on_click(cx.listener(|this, _, _window, cx| {
                                cx.stop_propagation();
                                this.toggle_layers_panel(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .id("screenshot-layers-list")
                    .flex_1()
                    .min_h_0()
                    .py(px(4.))
                    .overflow_y_scroll()
                    .child(self.render_layer_rows(cx)),
            )
            .child(
                div()
                    .px(px(12.))
                    .py(px(8.))
                    .flex_shrink_0()
                    .border_t_1()
                    .border_color(theme.gray_3)
                    .text_size(px(10.))
                    .text_color(theme.gray_9)
                    .child("Drag to reorder • Top = front"),
            )
    }

    /// `AnnotationConfig.tsx:38-168` -- Phase 1 draws the bar and its Done
    /// button; the per-type controls come with the engine.
    fn render_annotation_config_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.selected_annotation.as_ref()?;
        let theme = self.theme;
        Some(
            div()
                // The bar floats over the preview, and gpui hitboxes do not
                // occlude by default: without this a press on a swatch would
                // also land on the annotation underneath it.
                .occlude()
                .absolute()
                .top(px(HEADER_HEIGHT))
                .left(px(if self.layers_panel_open {
                    LAYERS_PANEL_WIDTH
                } else {
                    0.
                }))
                .right_0()
                .h(px(CONFIG_BAR_HEIGHT))
                .border_b_1()
                .border_color(theme.gray_3)
                .bg(if theme.is_dark() {
                    theme.gray_2
                } else {
                    theme.gray_1
                })
                .flex()
                .flex_row()
                .items_center()
                .justify_center()
                .gap(px(24.))
                .px(px(16.))
                .children(self.render_annotation_config_controls(cx))
                .child(divider(&theme, 20.))
                .child(
                    div()
                        .id("screenshot-annotation-done")
                        .cursor_pointer()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.blue_11)
                        .hover(|style| style.text_color(theme.blue_9))
                        .child("Done")
                        .on_click(cx.listener(|this, _, _window, cx| {
                            cx.stop_propagation();
                            this.selected_annotation = None;
                            cx.notify();
                        })),
                )
                .into_any_element(),
        )
    }

    // -- Popovers ---------------------------------------------------------------

    fn slider(
        &self,
        slider: StyleSlider,
        width: Option<Pixels>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let (min, max, _) = slider.range();
        let value = if slider == StyleSlider::Zoom {
            self.zoom
        } else {
            slider.value(&self.project)
        };
        let fraction = ((value - min) / (max - min)).clamp(0., 1.);
        let track = self.track(slider);

        ui::Slider::new(
            gpui::SharedString::from(format!("screenshot-slider-{}", slider_id(slider))),
            fraction,
            track,
        )
        .when(width.is_none(), |this| this.flex())
        .when_some(width, |this, width| this.row_width(width))
        .track(px(4.), theme.gray_4.into())
        .fill(theme.blue_9.into())
        .thumb(px(14.), gpui::white(), Some(theme.gray_6.into()))
        .on_drag_start(
            cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                cx.stop_propagation();
                this.begin_slider(slider, event.position, window, cx);
            }),
        )
    }

    /// The `text-xs font-medium text-gray-11` caption every popover slider
    /// carries, with the live value on the right -- gpui's tooltip is
    /// hover-driven only, so the readout is a label rather than a bubble
    /// (the same substitution `ui::Tooltip` documents).
    fn slider_row(
        &self,
        label: &'static str,
        slider: StyleSlider,
        suffix: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let value = slider.value(&self.project);
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.gray_11)
                    .child(label)
                    .child(format!("{}{suffix}", value.round() as i64)),
            )
            .child(self.slider(slider, None, cx))
    }

    /// `RgbInput` (`ColorPicker.tsx:47-102`): a `size-8 rounded-lg` swatch
    /// beside a hex field. The swatch opens `<input type="color">` over there;
    /// there is no native colour panel wired to this window yet, so it is inert
    /// here (README deviation).
    fn render_rgb_input(&self, target: HexTarget, value: cap_project::Color) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .size(px(32.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme.gray_4)
                    .bg(color_to_hsla(value)),
            )
            .children(self.hex_inputs.get(&target).map(|input| {
                ui::TextInput::plain(&theme, target.id(), input)
                    .width(px(73.6))
                    .padding_x(px(6.))
                    .padding_y(px(6.))
                    .height(px(30.))
                    .radius(px(8.))
                    .bg(Hsla::from(theme.gray_1))
                    .border(Hsla::from(theme.gray_12))
                    .text_size(px(13.))
                    .text_color(Hsla::from(theme.gray_12))
            }))
    }

    /// `KTabs.List` (`BackgroundSettingsPopover.tsx:296-309`).
    fn render_bg_tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let current = self.bg_tab;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .children(BgTab::ALL.map(|(tab, label)| {
                let selected = tab == current;
                div()
                    .id(gpui::SharedString::from(format!(
                        "screenshot-bg-tab-{label}"
                    )))
                    .flex_1()
                    .flex()
                    .justify_center()
                    .py(px(10.))
                    .px(px(8.))
                    .rounded(px(10.))
                    .border_1()
                    .cursor_pointer()
                    .text_size(px(12.))
                    .when(selected, |this| {
                        this.bg(theme.gray_3)
                            .border_color(theme.gray_3)
                            .text_color(theme.gray_12)
                    })
                    .when(!selected, |this| {
                        this.border_color(gpui::transparent_black())
                            .text_color(theme.gray_11)
                            .hover(|style| style.border_color(theme.gray_7))
                    })
                    .child(label)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.choose_bg_tab(tab, window, cx);
                    }))
            }))
    }

    /// `KTabs`' `onChange` (`BackgroundSettingsPopover.tsx:256-294`): a tab
    /// switch installs a default source of that type unless the current source
    /// already is one, and the three visible kinds also light the frame up.
    fn choose_bg_tab(&mut self, tab: BgTab, window: &mut Window, cx: &mut Context<Self>) {
        // `KTabs.onChange` does not fire for the tab already in force, so
        // re-clicking it must not seed padding or push a history entry.
        if self.bg_tab == tab {
            return;
        }
        self.bg_tab = tab;
        if tab == BgTab::Wallpaper {
            self.ensure_wallpapers(cx);
        }
        self.edit_project(
            move |project| {
                if BgTab::for_source(&project.background.source) != tab {
                    project.background.source = match tab {
                        BgTab::Wallpaper => BackgroundSource::Wallpaper { path: None },
                        BgTab::Image => BackgroundSource::Image { path: None },
                        BgTab::Color => BackgroundSource::Color {
                            value: DEFAULT_GRADIENT_FROM,
                            alpha: 255,
                        },
                        BgTab::Gradient => BackgroundSource::Gradient {
                            from: DEFAULT_GRADIENT_FROM,
                            to: DEFAULT_GRADIENT_TO,
                            angle: 90,
                            noise_intensity: None,
                            noise_scale: None,
                            animated: None,
                            animation_speed: None,
                        },
                    };
                }
                if matches!(tab, BgTab::Wallpaper | BgTab::Image | BgTab::Gradient) {
                    Self::ensure_padding_for_background(project);
                }
                true
            },
            window,
            cx,
        );
        self.ensure_background_image(cx);
    }

    fn render_wallpaper_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let current = match &self.project.background.source {
            BackgroundSource::Wallpaper { path: Some(path) } => {
                editor_sidebar::wallpaper_id_for_path(path)
            }
            _ => None,
        };
        let theme_name = BACKGROUND_THEMES[self.wallpaper_theme].0;

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap(px(8.))
                    .text_size(px(12.))
                    .children(
                        BACKGROUND_THEMES
                            .iter()
                            .enumerate()
                            .map(|(index, (_, label))| {
                                let selected = index == self.wallpaper_theme;
                                div()
                                    .id(("screenshot-wallpaper-theme", index))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .px(px(16.))
                                    .py(px(8.))
                                    .rounded(px(8.))
                                    .border_1()
                                    .cursor_pointer()
                                    .when(selected, |this| {
                                        this.bg(theme.gray_3)
                                            .border_color(theme.gray_3)
                                            .text_color(theme.gray_12)
                                    })
                                    .when(!selected, |this| {
                                        this.border_color(gpui::transparent_black())
                                            .text_color(theme.gray_11)
                                            .hover(|style| style.border_color(theme.gray_7))
                                    })
                                    .child(*label)
                                    .on_click(cx.listener(move |this, _, _window, cx| {
                                        cx.stop_propagation();
                                        this.wallpaper_theme = index;
                                        this.ensure_wallpapers(cx);
                                        cx.notify();
                                    }))
                            }),
                    ),
            )
            .child(
                // `grid grid-cols-7 gap-2` over the first 21 tiles
                // (`BackgroundSettingsPopover.tsx:356-358`).
                div().flex().flex_row().flex_wrap().gap(px(8.)).children(
                    editor_sidebar::wallpapers_for_theme(theme_name)
                        .into_iter()
                        .take(21)
                        .enumerate()
                        .map(|(index, id)| {
                            let selected = current == Some(id);
                            div()
                                .id(("screenshot-wallpaper", index))
                                .size(px(44.))
                                .rounded(px(8.))
                                .overflow_hidden()
                                .cursor_pointer()
                                .bg(theme.gray_3)
                                .when(selected, |this| {
                                    this.border_2().border_color(theme.gray_500_legacy)
                                })
                                .when(!selected, |this| {
                                    this.border_2()
                                        .border_color(gpui::transparent_black())
                                        .hover(|style| style.border_color(theme.gray_8))
                                })
                                .when_some(self.wallpapers.get(id).cloned(), |this, image| {
                                    this.child(
                                        img(image).size_full().object_fit(gpui::ObjectFit::Cover),
                                    )
                                })
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    let Some(path) = editor_sidebar::wallpaper_path(id) else {
                                        tracing::error!(id, "wallpaper asset not found");
                                        return;
                                    };
                                    let path = path.to_string_lossy().into_owned();
                                    this.edit_project(
                                        move |project| {
                                            project.background.source =
                                                BackgroundSource::Wallpaper { path: Some(path) };
                                            Self::ensure_padding_for_background(project);
                                            true
                                        },
                                        window,
                                        cx,
                                    );
                                }))
                        }),
                ),
            )
            .into_any_element()
    }

    fn render_image_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let path = match &self.project.background.source {
            BackgroundSource::Image { path } => path.clone(),
            _ => None,
        };

        let Some(_) = path else {
            return div()
                .id("screenshot-bg-image-pick")
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .w_full()
                .p(px(24.))
                .rounded(px(8.))
                .border_1()
                .border_dashed()
                .border_color(theme.gray_5)
                .bg(theme.gray_2)
                .cursor_pointer()
                .hover(|style| style.bg(theme.gray_3))
                .child(
                    svg()
                        .path("icons/image.svg")
                        .size(px(24.))
                        .text_color(theme.gray_11),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(theme.gray_12)
                        .child("Click to select or drag and drop image"),
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    cx.stop_propagation();
                    this.pick_background_image(window, cx);
                }))
                .into_any_element();
        };

        div()
            .relative()
            .w_full()
            .h(px(192.))
            .rounded(px(6.))
            .overflow_hidden()
            .border_1()
            .border_color(theme.gray_3)
            .bg(theme.gray_2)
            .when_some(
                self.bg_image.as_ref().map(|(_, image)| image.clone()),
                |this, image| this.child(img(image).size_full().object_fit(gpui::ObjectFit::Cover)),
            )
            .child(
                div()
                    .id("screenshot-bg-image-clear")
                    .absolute()
                    .top(px(8.))
                    .right(px(8.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(32.))
                    .rounded_full()
                    .cursor_pointer()
                    .bg(Theme::with_alpha(gpui::rgb(0x000000), 0.5))
                    .hover(|style| style.bg(Theme::with_alpha(gpui::rgb(0x000000), 0.7)))
                    .child(
                        svg()
                            .path("icons/circle-x.svg")
                            .size(px(16.))
                            .text_color(gpui::white()),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        cx.stop_propagation();
                        this.edit_project(
                            |project| {
                                project.background.source = BackgroundSource::Image { path: None };
                                true
                            },
                            window,
                            cx,
                        );
                        this.ensure_background_image(cx);
                    })),
            )
            .into_any_element()
    }

    fn render_color_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let current = match &self.project.background.source {
            BackgroundSource::Color { value, alpha } => Some((*value, *alpha)),
            _ => None,
        };

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(self.render_rgb_input(
                HexTarget::BackgroundColor,
                current.map_or(DEFAULT_GRADIENT_FROM, |(value, _)| value),
            ))
            .child(
                div().flex().flex_row().flex_wrap().gap(px(8.)).children(
                    BACKGROUND_COLORS
                        .iter()
                        .enumerate()
                        .filter_map(|(index, hex)| {
                            let rgba = hex_to_rgb(hex)?;
                            let value = [rgba[0] as u16, rgba[1] as u16, rgba[2] as u16];
                            let alpha = rgba[3];
                            let selected = current == Some((value, alpha));
                            Some(
                                div()
                                    .id(("screenshot-bg-color", index))
                                    .size(px(32.))
                                    .rounded(px(8.))
                                    .overflow_hidden()
                                    .cursor_pointer()
                                    .when(selected, |this| {
                                        this.border_2().border_color(theme.gray_500_legacy)
                                    })
                                    .when(!selected, |this| {
                                        this.border_2().border_color(gpui::transparent_black())
                                    })
                                    // The transparent swatch reads as a
                                    // checkerboard, not as nothing.
                                    .when(alpha == 0, |this| this.children(mini_checker()))
                                    .when(alpha != 0, |this| this.bg(color_to_hsla(value)))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        this.edit_project(
                                            move |project| {
                                                project.background.source =
                                                    BackgroundSource::Color { value, alpha };
                                                true
                                            },
                                            window,
                                            cx,
                                        );
                                    })),
                            )
                        }),
                ),
            )
            .into_any_element()
    }

    fn render_gradient_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        if matches!(
            self.project.background.source,
            BackgroundSource::AnimatedGradient { .. }
        ) {
            return div()
                .text_size(px(12.))
                .text_color(theme.gray_11)
                .child("Animated Gradient is rendered as a still image for screenshots. Choose another background to replace it.")
                .into_any_element();
        }
        let (from, to, angle) = match &self.project.background.source {
            BackgroundSource::Gradient {
                from, to, angle, ..
            } => (*from, *to, *angle),
            _ => (DEFAULT_GRADIENT_FROM, DEFAULT_GRADIENT_TO, 90),
        };

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(20.))
                    .child(self.render_rgb_input(HexTarget::GradientFrom, from))
                    .child(self.render_rgb_input(HexTarget::GradientTo, to)),
            )
            .child(
                div().flex().flex_row().flex_wrap().gap(px(8.)).children(
                    GRADIENT_PRESETS
                        .iter()
                        .enumerate()
                        .map(|(index, (preset_from, preset_to))| {
                            let (preset_from, preset_to) = (*preset_from, *preset_to);
                            let selected = (from, to) == (preset_from, preset_to);
                            div()
                                .id(("screenshot-bg-gradient", index))
                                .size(px(32.))
                                .rounded(px(8.))
                                .cursor_pointer()
                                .when(selected, |this| {
                                    this.border_2().border_color(theme.gray_500_legacy)
                                })
                                .when(!selected, |this| {
                                    this.border_2().border_color(gpui::transparent_black())
                                })
                                .bg(linear_gradient(
                                    f32::from(angle),
                                    linear_color_stop(color_to_hsla(preset_from), 0.),
                                    linear_color_stop(color_to_hsla(preset_to), 1.),
                                ))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.edit_project(
                                        move |project| {
                                            project.background.source =
                                                BackgroundSource::Gradient {
                                                    from: preset_from,
                                                    to: preset_to,
                                                    angle,
                                                    noise_intensity: None,
                                                    noise_scale: None,
                                                    animated: None,
                                                    animation_speed: None,
                                                };
                                            Self::ensure_padding_for_background(project);
                                            true
                                        },
                                        window,
                                        cx,
                                    );
                                }))
                        }),
                ),
            )
            .into_any_element()
    }

    /// `BackgroundSettingsPopover.tsx:245-570`.
    fn render_background_popover(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let tab_content = match self.bg_tab {
            BgTab::Wallpaper => self.render_wallpaper_tab(cx),
            BgTab::Image => self.render_image_tab(cx),
            BgTab::Color => self.render_color_tab(cx),
            BgTab::Gradient => self.render_gradient_tab(cx),
        };

        div()
            .id("screenshot-background-scroll")
            .max_h(px(600.))
            .overflow_y_scroll()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                ui::Field::plain(&theme, "Background Image")
                    .icon("icons/image.svg")
                    .icon_size(px(16.))
                    .child(self.render_bg_tabs(cx))
                    .child(
                        div()
                            .my(px(20.))
                            .w_full()
                            .border_t_1()
                            .border_dashed()
                            .border_color(theme.gray_5),
                    )
                    .child(tab_content),
            )
            .child(
                ui::Field::plain(&theme, "Background Blur")
                    .icon("icons/bg-blur.svg")
                    .icon_size(px(16.))
                    .child(self.slider_row("Blur", StyleSlider::Blur, "%", cx)),
            )
            .into_any_element()
    }

    fn render_padding_popover(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .p(px(16.))
            .child(self.slider_row("Padding", StyleSlider::Padding, "px", cx))
            .into_any_element()
    }

    fn render_rounding_popover(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        div()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(self.slider_row("Rounding", StyleSlider::Rounding, "px", cx))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(10.4))
                            .text_color(theme.gray_11)
                            .child("CORNER STYLE"),
                    )
                    .child(
                        self.anchored(
                            Anchor::CornerStyle,
                            div()
                                .id("screenshot-corner-style")
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.))
                                .px(px(8.))
                                .w_full()
                                .h(px(32.))
                                .rounded(px(8.))
                                .cursor_pointer()
                                .bg(theme.gray_3)
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(14.))
                                        .text_color(theme.gray_500_legacy)
                                        .child(self.corner_style_label()),
                                )
                                .child(
                                    svg()
                                        .path("icons/chevron-down.svg")
                                        .size(px(16.))
                                        .flex_shrink_0()
                                        .text_color(theme.gray_500_legacy),
                                )
                                .on_click(cx.listener(|this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.toggle_menu(
                                        MenuKind::CornerStyle,
                                        Anchor::CornerStyle,
                                        window,
                                        cx,
                                    );
                                })),
                        ),
                    ),
            )
            .into_any_element()
    }

    fn render_shadow_popover(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let open = self.shadow_advanced.is_open();
        let body = div()
            .mt(px(16.))
            .flex()
            .flex_col()
            .gap(px(24.))
            .font_weight(FontWeight::MEDIUM)
            .child(ui::Field::plain(&theme, "Size").child(self.slider(
                StyleSlider::ShadowSize,
                None,
                cx,
            )))
            .child(ui::Field::plain(&theme, "Opacity").child(self.slider(
                StyleSlider::ShadowOpacity,
                None,
                cx,
            )))
            .child(ui::Field::plain(&theme, "Blur").child(self.slider(
                StyleSlider::ShadowBlur,
                None,
                cx,
            )))
            .into_any_element();

        div()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(self.slider_row("Shadow", StyleSlider::Shadow, "%", cx))
            .child(
                div()
                    .w_full()
                    .child(
                        div()
                            .id("screenshot-shadow-advanced")
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.))
                            .w_full()
                            .cursor_pointer()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.gray_12)
                            .hover(|style| style.text_color(theme.gray_10))
                            .child("Advanced shadow settings")
                            .child(
                                svg()
                                    .path("icons/chevron-down.svg")
                                    .size(px(20.))
                                    .text_color(theme.gray_12)
                                    .when(open, |this| {
                                        this.with_transformation(gpui::Transformation::rotate(
                                            gpui::radians(std::f32::consts::PI),
                                        ))
                                    }),
                            )
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.shadow_advanced.toggle();
                                this.animate_collapsibles(window, cx);
                            })),
                    )
                    .child(editor_sidebar::collapsible(&self.shadow_advanced, body)),
            )
            .into_any_element()
    }

    fn render_border_popover(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let enabled = self
            .project
            .background
            .border
            .as_ref()
            .is_some_and(|border| border.enabled);
        let color = self
            .project
            .background
            .border
            .as_ref()
            .map_or(BORDER_FALLBACK.color, |border| border.color);

        let body = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                ui::Field::plain(&theme, "Width")
                    .icon("icons/enlarge.svg")
                    .icon_size(px(16.))
                    .child(self.slider(StyleSlider::BorderWidth, None, cx)),
            )
            .child(
                ui::Field::plain(&theme, "Color")
                    .icon("icons/image.svg")
                    .icon_size(px(16.))
                    .child(self.render_rgb_input(HexTarget::BorderColor, color)),
            )
            .child(
                ui::Field::plain(&theme, "Opacity")
                    .icon("icons/shadow.svg")
                    .icon_size(px(16.))
                    .child(self.slider(StyleSlider::BorderOpacity, None, cx)),
            )
            .into_any_element();

        div()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.gray_11)
                            .child("Border"),
                    )
                    .child(
                        ui::Toggle::plain(&theme, "screenshot-border-toggle", enabled).on_click(
                            cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.border_body.set_open(!enabled);
                                this.animate_collapsibles(window, cx);
                                this.edit_project(
                                    move |project| {
                                        let border = project
                                            .background
                                            .border
                                            .get_or_insert(BORDER_FALLBACK);
                                        border.enabled = !enabled;
                                        true
                                    },
                                    window,
                                    cx,
                                );
                            }),
                        ),
                    ),
            )
            .child(editor_sidebar::collapsible(&self.border_body, body))
            .into_any_element()
    }

    /// The popover shell: a full-window click-away backdrop and the panel
    /// itself, anchored under its trigger and clamped inside the window.
    fn render_popover(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let popover = self.active_popover?;
        let theme = self.theme;
        let width = popover.width();
        let viewport = window.viewport_size();
        let anchor = self.anchor(popover.anchor()).get();
        let left = anchor
            .map(|bounds| f32::from(bounds.origin.x))
            .unwrap_or(16.)
            .clamp(8., (f32::from(viewport.width) - width - 8.).max(8.));
        let top = anchor
            .map(|bounds| f32::from(bounds.origin.y + bounds.size.height) + 8.)
            .unwrap_or(HEADER_HEIGHT + 8.);

        let body = match popover {
            Popover::Background => self.render_background_popover(cx),
            Popover::Padding => self.render_padding_popover(cx),
            Popover::Rounding => self.render_rounding_popover(cx),
            Popover::Shadow => self.render_shadow_popover(cx),
            Popover::Border => self.render_border_popover(cx),
        };

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .id("screenshot-popover-backdrop")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.active_popover = None;
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .absolute()
                        .left(px(left))
                        .top(px(top))
                        .w(px(width))
                        .overflow_hidden()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(theme.gray_3)
                        .bg(theme.gray_1)
                        .shadow(vec![gpui::BoxShadow {
                            color: Theme::with_alpha(gpui::rgb(0x000000), 0.18),
                            offset: gpui::point(px(0.), px(10.)),
                            blur_radius: px(30.),
                            spread_radius: px(0.),
                            inset: false,
                        }])
                        .child(body),
                )
                .into_any_element(),
        )
    }

    fn render_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (kind, state) = self.menu.as_ref()?;
        let items = self.menu_items(*kind);
        Some(
            ui::Menu::plain(&self.theme, "screenshot-menu", items, state)
                .min_width(px(200.))
                .on_select(cx.listener(|this, index: &usize, window, cx| {
                    this.commit_menu(*index, window, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _window, cx| {
                    this.menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    // -- Preview ----------------------------------------------------------------

    /// `Preview.tsx:467-794`.
    fn render_preview(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let geometry = self.preview_geometry();
        let frame = self.frame.clone();
        let checker = self.checker.clone();
        let area_cell = self.preview_area.clone();
        let viewport_cell = self.viewport.clone();
        let entity = cx.entity().downgrade();
        let zoom = self.zoom;
        let panning = self.panning.is_some();
        let image_rect = annotations::image_rect(
            (self.frame_size.0 as f64, self.frame_size.1 as f64),
            self.image_size
                .map(|(width, height)| (width as f64, height as f64)),
            self.project.background.padding,
            self.project.background.crop.as_ref(),
            self.project.aspect_ratio.as_ref(),
        );

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .bg(if theme.is_dark() {
                theme.gray_2
            } else {
                theme.gray_1
            })
            .child(
                div()
                    .id("screenshot-preview-area")
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .when(panning, |this| this.cursor(gpui::CursorStyle::ClosedHand))
                    .when(!panning, |this| this.cursor(gpui::CursorStyle::OpenHand))
                    // The checkerboard, and the area's own measurement. Both
                    // come off one canvas: prepaint writes the rect the layout
                    // maths reads next frame, paint tiles the cached tile.
                    .child(
                        canvas(
                            move |bounds, _window, cx| {
                                if area_cell.get() != Some(bounds) {
                                    area_cell.set(Some(bounds));
                                    if let Some(entity) = entity.upgrade() {
                                        cx.defer(move |cx| {
                                            entity.update(cx, |_, cx| cx.notify());
                                        });
                                    }
                                }
                                bounds
                            },
                            move |_, bounds, window, _cx| {
                                let Some(tile) = checker.clone() else {
                                    return;
                                };
                                paint_checkerboard(window, bounds, tile);
                            },
                        )
                        .absolute()
                        .size_full(),
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, window, cx| {
                            this.preview_mouse_down(event, window, cx);
                        }),
                    )
                    .on_mouse_down(
                        MouseButton::Middle,
                        cx.listener(|this, event: &MouseDownEvent, window, cx| {
                            this.preview_mouse_down(event, window, cx);
                        }),
                    )
                    .on_scroll_wheel(cx.listener(
                        |this, event: &gpui::ScrollWheelEvent, window, cx| {
                            this.preview_wheel(event, window, cx);
                        },
                    ))
                    .on_pinch(cx.listener(|this, event: &gpui::PinchEvent, window, cx| {
                        this.preview_pinch(event, window, cx);
                    }))
                    .children(match (&self.error, frame, geometry) {
                        (Some(message), _, _) => Some(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.gray_11)
                                .child(message.clone())
                                .into_any_element(),
                        ),
                        (None, Some(frame), Some(geometry)) => Some(
                            // The `size`d viewport, centred, with the content
                            // wrapper placed inside it (`Preview.tsx:700-788`).
                            div()
                                .relative()
                                .w(px(geometry.size.0))
                                .h(px(geometry.size.1))
                                .child(
                                    canvas(
                                        move |bounds, _window, _cx| viewport_cell.set(Some(bounds)),
                                        |_, _, _, _| {},
                                    )
                                    .absolute()
                                    .size_full(),
                                )
                                .child(
                                    div()
                                        .absolute()
                                        .left(px(geometry.content.0))
                                        .top(px(geometry.content.1))
                                        .w(px(geometry.scaled.0))
                                        .h(px(geometry.scaled.1))
                                        .overflow_hidden()
                                        .rounded(px(4.))
                                        // `imageShadow()` -- dropped past 100%,
                                        // where the picture is bigger than its
                                        // viewport and the shadow would smear.
                                        .when(zoom <= 1., |this| {
                                            this.shadow(vec![
                                                gpui::BoxShadow {
                                                    color: Theme::with_alpha(
                                                        gpui::rgb(0x000000),
                                                        0.15,
                                                    ),
                                                    offset: gpui::point(px(0.), px(4.)),
                                                    blur_radius: px(20.),
                                                    spread_radius: px(0.),
                                                    inset: false,
                                                },
                                                gpui::BoxShadow {
                                                    color: Theme::with_alpha(
                                                        gpui::rgb(0x000000),
                                                        0.10,
                                                    ),
                                                    offset: gpui::point(px(0.), px(2.)),
                                                    blur_radius: px(8.),
                                                    spread_radius: px(0.),
                                                    inset: false,
                                                },
                                            ])
                                        })
                                        .child(img(frame).size_full())
                                        .children(self.render_annotation_layer(
                                            geometry.scaled,
                                            image_rect,
                                            cx,
                                        )),
                                )
                                .into_any_element(),
                        ),
                        // `fallback={<div class="text-gray-11">Loading
                        // preview...</div>}` (`Preview.tsx:503`).
                        (None, _, _) => Some(
                            div()
                                .text_size(px(13.))
                                .text_color(theme.gray_11)
                                .child("Loading preview...")
                                .into_any_element(),
                        ),
                    })
                    .child(self.render_zoom_hud(cx)),
            )
    }

    /// `Preview.tsx:476-500` -- `absolute left-4 bottom-4`.
    fn render_zoom_hud(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .id("screenshot-zoom-hud")
            .absolute()
            .left(px(16.))
            .bottom(px(16.))
            // The pan surface is a *sibling* of the HUD over there
            // (`absolute inset-0 z-0`, `Preview.tsx:693-699`), so a press on
            // the HUD never starts a drag. Here the pan listener is on the
            // area itself, so the HUD has to stop the press reaching it.
            .on_mouse_down(MouseButton::Left, |_, _window, cx| cx.stop_propagation())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .p(px(4.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.gray_4)
            .bg(if theme.is_dark() {
                theme.gray_3
            } else {
                theme.gray_1
            })
            .shadow(vec![gpui::BoxShadow {
                color: Theme::with_alpha(gpui::rgb(0x000000), 0.05),
                offset: gpui::point(px(0.), px(1.)),
                blur_radius: px(2.),
                spread_radius: px(0.),
                inset: false,
            }])
            .child(kbd_tooltip(
                &theme,
                "Zoom Out",
                &["meta", "-"],
                ui::EditorButton::plain(&theme, "screenshot-zoom-out")
                    .left_icon("icons/zoom-out.svg")
                    .icon_size(px(16.))
                    .on_click(cx.listener(|this, _, _window, cx| {
                        cx.stop_propagation();
                        this.nudge_zoom(-0.1, cx);
                    })),
            ))
            .child(self.slider(StyleSlider::Zoom, Some(px(80.)), cx))
            .child(kbd_tooltip(
                &theme,
                "Zoom In",
                &["meta", "+"],
                ui::EditorButton::plain(&theme, "screenshot-zoom-in")
                    .left_icon("icons/zoom-in.svg")
                    .icon_size(px(16.))
                    .on_click(cx.listener(|this, _, _window, cx| {
                        cx.stop_propagation();
                        this.nudge_zoom(0.1, cx);
                    })),
            ))
    }

    // -- Toasts -----------------------------------------------------------------

    fn render_toasts(&self) -> Option<AnyElement> {
        if self.toasts.is_empty() {
            return None;
        }
        let theme = self.theme;
        Some(
            div()
                .absolute()
                .right(px(16.))
                .bottom(px(16.))
                .flex()
                .flex_col()
                .items_end()
                .gap(px(8.))
                .children(self.toasts.iter().map(|toast| {
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .px(px(12.))
                        .py(px(10.))
                        .rounded(px(15.))
                        .border_1()
                        .border_color(theme.gray_200_legacy)
                        .bg(theme.gray_1)
                        .shadow(vec![gpui::BoxShadow {
                            color: Theme::with_alpha(gpui::rgb(0x000000), 0.12),
                            offset: gpui::point(px(0.), px(4.)),
                            blur_radius: px(14.),
                            spread_radius: px(0.),
                            inset: false,
                        }])
                        .text_size(px(16.))
                        .text_color(match toast.kind {
                            ToastKind::Loading => theme.gray_11,
                            _ => theme.gray_12,
                        })
                        .child(match toast.kind {
                            ToastKind::Success => svg()
                                .path("icons/check.svg")
                                .size(px(16.))
                                .flex_shrink_0()
                                .text_color(gpui::rgb(0x22c55e))
                                .into_any_element(),
                            ToastKind::Error => svg()
                                .path("icons/x.svg")
                                .size(px(16.))
                                .flex_shrink_0()
                                .text_color(theme.red_11)
                                .into_any_element(),
                            ToastKind::Loading => div()
                                .size(px(10.))
                                .flex_shrink_0()
                                .rounded_full()
                                .bg(theme.gray_9)
                                .into_any_element(),
                        })
                        .child(toast.message.clone())
                }))
                .into_any_element(),
        )
    }

    /// `ScreenshotEditorSkeleton` (`screenshot-editor-skeleton.tsx`): the
    /// header's three clusters as `rounded-lg` placeholders, and the Cap logo
    /// spinning over a flat preview.
    fn render_skeleton(&self, _window: &Window) -> impl IntoElement {
        let theme = self.theme;
        let block = move |width: f32| {
            div()
                .h(px(36.))
                .w(px(width))
                .rounded(px(8.))
                .bg(if theme.is_dark() {
                    theme.gray_4
                } else {
                    theme.gray_3
                })
        };

        let tools = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .child(block(96.))
            .child(block(36.))
            .child(divider(&theme, 24.))
            .children((0..5).map(|_| block(36.)))
            .child(divider(&theme, 24.))
            .children((0..5).map(|_| block(36.)));
        #[cfg(not(target_os = "windows"))]
        let tools = tools.absolute().top_0().left_0().size_full();
        #[cfg(target_os = "windows")]
        let tools = div()
            .id("screenshot-skeleton-tools")
            .flex()
            .flex_1()
            .min_w_0()
            .h(px(36.))
            .overflow_x_scroll()
            .occlude()
            .child(tools.flex_shrink_0().mx_auto());

        let header = div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .px(px(16.))
            .when(cfg!(target_os = "windows"), |header| {
                header
                    .pr_0()
                    .gap(px(8.))
                    .window_control_area(gpui::WindowControlArea::Drag)
            })
            .flex_shrink_0()
            .border_b_1()
            .border_color(theme.gray_3)
            .bg(if theme.is_dark() {
                theme.gray_2
            } else {
                theme.gray_1
            })
            .when(!cfg!(target_os = "windows"), |header| {
                header.child(div().w(px(56.)))
            })
            .child(tools)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .pr(px(8.))
                    .when(cfg!(target_os = "windows"), |actions| {
                        actions.flex_shrink_0()
                    })
                    .child(divider(&theme, 24.))
                    .children((0..3).map(|_| block(36.))),
            );

        #[cfg(target_os = "windows")]
        let header = header.child(ui::windows_caption_controls(
            theme,
            _window.is_window_active(),
            _window.is_maximized(),
            true,
            true,
        ));

        div().size_full().flex().flex_col().child(header).child(
            div()
                .flex_1()
                .min_h_0()
                .relative()
                .flex()
                .items_center()
                .justify_center()
                .bg(if theme.is_dark() {
                    theme.gray_3
                } else {
                    theme.gray_2
                })
                .child(
                    div()
                        .absolute()
                        .left(px(16.))
                        .bottom(px(16.))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .p(px(4.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(theme.gray_4)
                        .bg(if theme.is_dark() {
                            theme.gray_3
                        } else {
                            theme.gray_1
                        })
                        .child(block(36.))
                        .child(div().w(px(80.)).h(px(8.)).rounded_full().bg(theme.gray_4))
                        .child(block(36.)),
                )
                .child(spinning_logo(&theme)),
        )
    }
}

impl Render for ScreenshotEditorWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        self.sync_hex_inputs(window, cx);
        self.sync_annotation_inputs(window, cx);
        self.sync_crop_dialog_container(window);
        self.sync_crop_field_inputs(window, cx);
        let theme = self.theme;

        let root = div()
            .id("screenshot-editor-root")
            .track_focus(&self.focus)
            .key_context("ScreenshotEditor")
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                this.on_key(event, window, cx);
            }))
            // Key-up only matters to the crop dialog's held-arrow nudge.
            .on_key_up(cx.listener(|this, event: &gpui::KeyUpEvent, _window, cx| {
                this.crop_dialog_key_up(event, cx);
            }))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            .font_weight(FontWeight::MEDIUM)
            .bg(if theme.is_dark() {
                theme.gray_1
            } else {
                theme.gray_2
            })
            .text_color(theme.gray_12);

        if !self.ready {
            return root.child(self.render_skeleton(window));
        }

        root.child(self.render_header(window, cx))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_hidden()
                    .when(self.layers_panel_open, |this| {
                        this.child(self.render_layers_panel(cx))
                    })
                    .child(self.render_preview(cx)),
            )
            .children(self.render_annotation_config_bar(cx))
            .children(self.render_annotation_overlays(window, cx))
            .children(self.render_popover(window, cx))
            .children(self.render_menu(cx))
            // The crop dialog is a modal over everything except the toasts
            // (`solid-toast` floats over Kobalte's dialog too).
            .children(self.render_crop_dialog_overlay(cx))
            .children(self.render_crop_dialog_drag_layer(cx))
            .children(self.render_toasts())
            .when_some(self.active_slider, |root, slider| {
                root.child(ui::Slider::drag_layer(
                    "screenshot-slider-drag",
                    cx.listener(move |this, event: &MouseMoveEvent, window, cx| {
                        this.apply_slider(slider, event.position, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                        this.end_slider(cx);
                    }),
                ))
            })
            .when(self.panning.is_some(), |root| {
                root.child(ui::Slider::drag_layer(
                    "screenshot-pan-drag",
                    cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.preview_mouse_move(event, window, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.preview_mouse_up(window, cx);
                    }),
                ))
            })
    }
}

// ---------------------------------------------------------------------------
// Chrome helpers
// ---------------------------------------------------------------------------

/// `<div class="w-px h-N bg-gray-4 mx-1" />`.
fn divider(theme: &Theme, height: f32) -> impl IntoElement {
    div()
        .w(px(1.))
        .h(px(height))
        .mx(px(4.))
        .flex_shrink_0()
        .bg(theme.gray_4)
}

/// `Tooltip`'s `kbd` prop (`components/Tooltip.tsx`). `ui::EditorButton`'s own
/// `tooltip` builder carries a label only, so a trigger that needs key chips
/// wears the tooltip on a wrapper instead.
fn kbd_tooltip(
    theme: &Theme,
    label: &'static str,
    keys: &'static [&'static str],
    child: impl IntoElement,
) -> impl IntoElement {
    let theme = *theme;
    div()
        // gpui hangs tooltips off `StatefulInteractiveElement`, so the wrapper
        // needs an id of its own; the label is unique across the chrome.
        .id(gpui::SharedString::from(format!("{label}-tooltip")))
        .flex_shrink_0()
        .child(child)
        .tooltip(move |_window, cx| ui::Tooltip::new(&theme, label).keys(keys).view(cx))
}

/// `AnnotationTools.tsx`'s `size-8 rounded-lg` button: `bg-blue-3 text-blue-11`
/// when it is the active tool, a `hover:bg-gray-3` wash otherwise.
fn tool_button(
    theme: &Theme,
    id: impl Into<gpui::ElementId>,
    icon: &'static str,
    label: &'static str,
    shortcut: &'static str,
    active: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let theme = *theme;
    let label: gpui::SharedString = label.into();
    let shortcut: gpui::SharedString = shortcut.into();
    div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .size(px(32.))
        .flex_shrink_0()
        .rounded(px(8.))
        .cursor_pointer()
        .when(active, |this| this.bg(theme.blue_3))
        .when(!active, |this| this.hover(|style| style.bg(theme.gray_3)))
        .child(svg().path(icon).size(px(16.)).text_color(if active {
            theme.blue_11
        } else {
            theme.gray_11
        }))
        .tooltip(move |_window, cx| {
            ui::Tooltip::new(&theme, label.clone())
                .keys([shortcut.clone()])
                .view(cx)
        })
        .on_click(on_click)
}

/// The transparent swatch's mini checkerboard -- four 16px quarters, which is
/// what the CSS pattern reduces to at `size-8`.
fn mini_checker() -> Vec<AnyElement> {
    let light: Hsla = gpui::white();
    let dark: Hsla = gpui::rgb(0xf0f0f0).into();
    [
        (0., 0., light),
        (16., 0., dark),
        (0., 16., dark),
        (16., 16., light),
    ]
    .into_iter()
    .map(|(x, y, fill)| {
        div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .size(px(16.))
            .bg(fill)
            .into_any_element()
    })
    .collect()
}

/// The skeleton's `<div class="animate-spin"><IconCapLogo /></div>`. The app
/// has no bare logo glyph -- only the full lockup -- so the wordmark would spin
/// with it; the lockup is drawn still instead, at the skeleton's opacity
/// (README deviation).
fn spinning_logo(theme: &Theme) -> impl IntoElement {
    div().flex().items_center().justify_center().child(
        svg()
            .path(if theme.is_dark() {
                "icons/logo-full-dark.svg"
            } else {
                "icons/logo-full.svg"
            })
            .w(px(103.))
            .h(px(40.))
            .opacity(0.5)
            .text_color(theme.gray_8),
    )
}

/// The preview's checkerboard: `background-color: white` under `#f0f0f0`
/// squares on a 20px period (`Preview.tsx:24-31`), identical in both
/// appearances because the Tauri style is hardcoded.
fn checkerboard_tile() -> Arc<RenderImage> {
    let mut tile = image::RgbaImage::new(CHECKER_TILE, CHECKER_TILE);
    for (x, y, pixel) in tile.enumerate_pixels_mut() {
        let dark = ((x / CHECKER_CELL) + (y / CHECKER_CELL)).is_multiple_of(2);
        *pixel = if dark {
            image::Rgba([240, 240, 240, 255])
        } else {
            image::Rgba([255, 255, 255, 255])
        };
    }
    crate::library::rgba_to_render_image(tile)
}

/// Tile the cached checkerboard across `bounds`. One `paint_image` per tile,
/// clipped by a content mask so the edges are cropped rather than squashed.
fn paint_checkerboard(window: &mut Window, bounds: Bounds<Pixels>, tile: Arc<RenderImage>) {
    let size = CHECKER_TILE as f32;
    let columns = (f32::from(bounds.size.width) / size).ceil() as i32;
    let rows = (f32::from(bounds.size.height) / size).ceil() as i32;
    if columns <= 0 || rows <= 0 {
        return;
    }
    window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
        for row in 0..rows {
            for column in 0..columns {
                let origin = gpui::point(
                    bounds.origin.x + px(column as f32 * size),
                    bounds.origin.y + px(row as f32 * size),
                );
                let cell = Bounds {
                    origin,
                    size: gpui::size(px(size), px(size)),
                };
                let _ = window.paint_image(cell, gpui::Corners::default(), tile.clone(), 0, false);
            }
        }
    });
}

/// A stable element-id fragment per slider.
fn slider_id(slider: StyleSlider) -> &'static str {
    match slider {
        StyleSlider::Blur => "blur",
        StyleSlider::Padding => "padding",
        StyleSlider::Rounding => "rounding",
        StyleSlider::Shadow => "shadow",
        StyleSlider::ShadowSize => "shadow-size",
        StyleSlider::ShadowOpacity => "shadow-opacity",
        StyleSlider::ShadowBlur => "shadow-blur",
        StyleSlider::BorderWidth => "border-width",
        StyleSlider::BorderOpacity => "border-opacity",
        StyleSlider::Zoom => "zoom",
    }
}

/// The Image tab's `h-48` preview, at 2x.
fn decode_preview_image(path: &Path) -> Option<Arc<RenderImage>> {
    let bytes = std::fs::read(path).ok()?;
    let format = image::guess_format(&bytes).ok()?;
    let decoded = image::load_from_memory_with_format(&bytes, format).ok()?;
    let (width, height) = (decoded.width().max(1), decoded.height().max(1));
    let scale = (768. / width.max(height) as f32).min(1.);
    let scaled = if scale < 1. {
        decoded
            .thumbnail(
                ((width as f32 * scale) as u32).max(1),
                ((height as f32 * scale) as u32).max(1),
            )
            .into_rgba8()
    } else {
        decoded.into_rgba8()
    };
    Some(crate::library::rgba_to_render_image(scaled))
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/// One rendered frame, in both the forms the window needs: tight RGBA (what a
/// mask overlay resamples) and the BGRA copy gpui's atlas takes. The rows are
/// copied once and the swap runs over a clone, so the padded GPU buffer is
/// walked a single time.
fn frame_buffers(frame: &RenderedFrame) -> Option<(Arc<Vec<u8>>, Arc<RenderImage>)> {
    let row_bytes = frame.width as usize * 4;
    let mut rgba = Vec::with_capacity(row_bytes * frame.height as usize);
    for row in frame
        .data
        .chunks(frame.padded_bytes_per_row as usize)
        .take(frame.height as usize)
    {
        if row.len() < row_bytes {
            return None;
        }
        rgba.extend_from_slice(&row[..row_bytes]);
    }
    let mut bgra = rgba.clone();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let buffer = image::RgbaImage::from_raw(frame.width, frame.height, bgra)?;
    Some((
        Arc::new(rgba),
        Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
            buffer
        )])),
    ))
}

/// Read the bundle, start the still renderer on tokio, pump frames back --
/// `load_editor_project`'s shape, without the playback half.
pub fn load_screenshot_project(
    bundle: PathBuf,
    handle: WindowHandle<ScreenshotEditorWindow>,
    cx: &mut App,
) {
    cx.spawn(async move |cx| {
        let load_bundle = bundle.clone();
        let source = cx
            .background_executor()
            .spawn(async move { load_source(&load_bundle) })
            .await;
        let source = match source {
            Ok(source) => source,
            Err(message) => {
                handle
                    .update(cx, |view, _window, cx| view.set_error(message, cx))
                    .ok();
                return;
            }
        };

        let (config_tx, config_rx) = tokio::sync::watch::channel(ConfigUpdate {
            revision: 0,
            config: source.config.clone(),
        });
        let (export_tx, export_rx) = tokio::sync::mpsc::channel(1);
        // Bounded and latest-wins like the video pump; stills only re-render
        // on edits, so it never actually fills.
        let (frame_tx, frame_rx) = flume::bounded(2);
        let (setup_tx, setup_rx) = flume::bounded(1);

        let image_size = (source.width, source.height);
        if handle
            .update(cx, |view, window, cx| {
                view.set_loaded(
                    source.pretty_name.clone(),
                    LoadedScreenshot {
                        config: source.config.clone(),
                        image_size,
                        config_tx,
                        export_tx,
                    },
                    window,
                    cx,
                )
            })
            .is_err()
        {
            return;
        }

        cx.update(|cx| {
            gpui_tokio::Tokio::spawn(
                cx,
                run_still_renderer(source, config_rx, export_rx, frame_tx, setup_tx),
            )
            .detach();
        });

        if let Ok(Err(message)) = setup_rx.recv_async().await {
            handle
                .update(cx, |view, _window, cx| view.set_error(message, cx))
                .ok();
            return;
        }

        while let Ok((frame, revision)) = frame_rx.recv_async().await {
            let size = (frame.width, frame.height);
            let buffers = cx
                .background_executor()
                .spawn(async move { frame_buffers(&frame) })
                .await;
            let Some((rgba, image)) = buffers else {
                tracing::warn!("a rendered screenshot frame could not be converted for display");
                continue;
            };
            tracing::debug!(
                revision,
                width = size.0,
                height = size.1,
                "screenshot frame"
            );
            if handle
                .update(cx, |view, window, cx| {
                    view.frame_arrived(image, rgba, size, window, cx)
                })
                .is_err()
            {
                return;
            }
        }
    })
    .detach();
}

/// `AspectRatio` derives no `PartialEq`; same discriminant comparison the
/// video editor's `aspect_ratio_eq` uses.
fn aspect_eq(a: &Option<cap_project::AspectRatio>, b: &Option<cap_project::AspectRatio>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => std::mem::discriminant(a) == std::mem::discriminant(b),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The checkerboard is one 240x240 tile of 10px cells -- an even number of
    /// cells per axis, so tiling it leaves no seam.
    #[test]
    fn the_checkerboard_tile_repeats_without_a_seam() {
        assert_eq!(CHECKER_TILE % (CHECKER_CELL * 2), 0);
    }

    /// `PaddingPopover`'s guard (`context.tsx:30-42`).
    #[test]
    fn an_invisible_background_is_one_with_nothing_to_show() {
        assert!(has_no_visible_background(&BackgroundSource::Color {
            value: [255, 255, 255],
            alpha: 0
        }));
        assert!(!has_no_visible_background(&BackgroundSource::Color {
            value: [255, 255, 255],
            alpha: 255
        }));
        assert!(has_no_visible_background(&BackgroundSource::Wallpaper {
            path: None
        }));
        assert!(!has_no_visible_background(&BackgroundSource::Image {
            path: Some("/tmp/a.png".into())
        }));
    }

    /// `ensurePaddingForBackground` only fills in what is still at zero, and
    /// leaves a rounding the user already chose alone.
    #[test]
    fn choosing_a_background_seeds_padding_rounding_and_shadow() {
        let mut project = ProjectConfiguration::default();
        project.background.padding = 0.;
        project.background.rounding = 0.;
        project.background.shadow = 0.;
        ScreenshotEditorWindow::ensure_padding_for_background(&mut project);
        assert_eq!(project.background.padding, 10.);
        assert_eq!(project.background.rounding, 8.);
        assert_eq!(project.background.shadow, DEFAULT_BACKGROUND_SHADOW);

        let mut kept = ProjectConfiguration::default();
        kept.background.padding = 0.;
        kept.background.rounding = 24.;
        kept.background.shadow = 5.;
        ScreenshotEditorWindow::ensure_padding_for_background(&mut kept);
        assert_eq!(kept.background.padding, 10.);
        assert_eq!(kept.background.rounding, 24.);
        assert_eq!(kept.background.shadow, 5.);
    }

    /// `ShadowPopover.tsx:37-48`: the first drag off zero seeds the advanced
    /// block in the same edit.
    #[test]
    fn the_first_shadow_seeds_the_advanced_block() {
        let mut project = ProjectConfiguration::default();
        project.background.shadow = 0.;
        project.background.advanced_shadow = None;
        assert!(StyleSlider::Shadow.apply(&mut project, 40.));
        assert_eq!(
            project.background.advanced_shadow.map(|shadow| (
                shadow.size,
                shadow.opacity,
                shadow.blur
            )),
            Some((50., 18., 50.))
        );
    }

    /// `handlePaddingChange`: padding over an invisible background lights it up
    /// first, and padding back to zero leaves the colour alone.
    #[test]
    fn padding_over_an_invisible_background_makes_it_white() {
        let mut project = ProjectConfiguration::default();
        project.background.source = BackgroundSource::Color {
            value: [0, 0, 0],
            alpha: 0,
        };
        project.background.padding = 0.;
        assert!(StyleSlider::Padding.apply(&mut project, 20.));
        assert!(matches!(
            project.background.source,
            BackgroundSource::Color {
                value: [255, 255, 255],
                alpha: 255
            }
        ));
    }

    #[test]
    fn the_zoom_slider_never_writes_the_project() {
        let mut project = ProjectConfiguration::default();
        assert!(!StyleSlider::Zoom.apply(&mut project, 2.));
    }

    /// gpui hands AppKit's `scrollingDelta` through unchanged, and AppKit's
    /// sign convention is the DOM's negated -- so the source's `pan - delta`
    /// has to be `pan + delta` here for the content to follow the fingers.
    #[test]
    fn a_wheel_pan_carries_the_content_with_the_fingers() {
        // Fingers sweep down-right on a natural-scroll trackpad: AppKit
        // reports positive deltas, and the content moves down-right too.
        assert_eq!(wheel_pan((0., 0.), (12., 7.)), (12., 7.));
        assert_eq!(wheel_pan((100., -20.), (-4., -6.)), (96., -26.));
    }

    /// The same flip on the ctrl+wheel arm: wheel-up is DOM-negative but
    /// AppKit-positive, and either way it zooms in.
    #[test]
    fn ctrl_wheel_up_zooms_in() {
        assert!(ctrl_wheel_zoom_step(10.) > 0.);
        assert!(ctrl_wheel_zoom_step(-10.) < 0.);
        // The 8px floor keeps a gentle tick moving (`Preview.tsx:306`).
        assert_eq!(ctrl_wheel_zoom_step(1.), 8. * 0.005);
        assert_eq!(ctrl_wheel_zoom_step(-1.), -8. * 0.005);
    }
}
