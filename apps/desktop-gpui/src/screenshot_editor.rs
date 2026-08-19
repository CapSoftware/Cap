//! The screenshot editor window -- `screenshot_editor.rs` +
//! `routes/screenshot-editor/` in the Tauri app, natively.
//!
//! The Tauri editor styles a still PNG through the same GPU renderer the
//! video editor uses: one `DecodedFrame`, `preserve_screen_alpha: true`, no
//! camera, re-rendered whenever `ProjectConfiguration` changes and pushed to
//! the webview over a websocket (`screenshot_editor.rs:316-476` over there).
//! Here the loop is the same -- `FrameRenderer::render_immediate` on a
//! `tokio::sync::watch` of config revisions -- and the frame skips the
//! websocket: it is un-padded and BGRA-swapped by `editor_window::frame_image`
//! and painted with `paint_image`, exactly like the video editor's CPU path.
//!
//! Annotations, OCR and the share flow are not here yet; styling and export
//! grow on this seam.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use cap_project::{
    BackgroundSource, BorderConfiguration, CornerStyle, ProjectConfiguration, RecordingMeta,
    RecordingMetaInner, StudioRecordingMeta,
};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RenderedFrame, RendererLayers, ZoomTransformTimeline,
};
use gpui::{
    App, Context, FontWeight, Hsla, InteractiveElement as _, IntoElement, MouseDownEvent,
    MouseMoveEvent, ParentElement as _, Point, Render, RenderImage,
    StatefulInteractiveElement as _, Styled, StyledImage as _, Window, WindowHandle, div, img,
    linear_color_stop, linear_gradient, prelude::FluentBuilder as _, px,
};

use crate::editor_sidebar::{
    self, BACKGROUND_COLORS, BACKGROUND_IMAGE_EXTENSIONS, BACKGROUND_THEMES, GRADIENT_PRESETS,
    color_to_hsla, hex_to_rgb,
};
use crate::theme::Theme;
use crate::ui;

/// `ShowCapWindow::ScreenshotEditor`: 1240x800, min 800x600, resizable.
pub const SCREENSHOT_EDITOR_WIDTH: f32 = 1240.;
pub const SCREENSHOT_EDITOR_HEIGHT: f32 = 800.;
pub const SCREENSHOT_EDITOR_MIN_WIDTH: f32 = 800.;
pub const SCREENSHOT_EDITOR_MIN_HEIGHT: f32 = 600.;

/// `MAX_DIMENSION` (`screenshot_editor.rs:38` over there).
const MAX_DIMENSION: u32 = 16_384;

/// `PROJECT_SAVE_DEBOUNCE_MS`, the same 250ms the video editor debounces.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

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

/// Read `original.png` (or the first PNG in the bundle), the recording meta
/// and the project config -- the disk half of `create_standalone_instance`.
pub fn load_source(bundle: &Path) -> Result<LoadedSource, String> {
    let image_path = {
        let original = bundle.join("original.png");
        if original.exists() {
            original
        } else {
            std::fs::read_dir(bundle)
                .ok()
                .and_then(|dir| {
                    dir.flatten()
                        .find(|entry| {
                            entry.path().extension().and_then(|ext| ext.to_str()) == Some("png")
                        })
                        .map(|entry| entry.path())
                })
                .ok_or_else(|| format!("No PNG found in {}", bundle.display()))?
        }
    };

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
/// stateless command; here the loop already owns one.
pub enum ExportRequest {
    Png {
        config: ProjectConfiguration,
        reply: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
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
                let Some(ExportRequest::Png { config, reply }) = request else {
                    break;
                };
                let result = render_export_png(
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

/// The export render -- `render_screenshot_png`'s upscale + unpad + encode
/// (`screenshot_editor.rs:1618-1742` over there): scale the output so a crop
/// is not downsampled, align the dimensions the way the exporter does, strip
/// the wgpu row padding and encode an RGBA PNG.
async fn render_export_png(
    constants: &RenderVideoConstants,
    frame_renderer: &mut FrameRenderer<'_>,
    layers: &mut RendererLayers,
    source: &DecodedFrame,
    config: &ProjectConfiguration,
) -> Result<Vec<u8>, String> {
    use image::ImageEncoder as _;

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

    let mut png = std::io::Cursor::new(Vec::new());
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &rgba,
            frame.width,
            frame.height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Failed to encode screenshot export: {e}"))?;
    Ok(png.into_inner())
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

/// The background popover's source tabs (`BackgroundSettingsPopover.tsx`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum BgTab {
    Color,
    Gradient,
    Wallpaper,
    Image,
}

impl BgTab {
    const ALL: [(Self, &'static str); 4] = [
        (Self::Color, "Color"),
        (Self::Gradient, "Gradient"),
        (Self::Wallpaper, "Wallpaper"),
        (Self::Image, "Image"),
    ];

    fn for_source(source: &BackgroundSource) -> Self {
        match source {
            BackgroundSource::Color { .. } => Self::Color,
            BackgroundSource::Gradient { .. } => Self::Gradient,
            BackgroundSource::Wallpaper { .. } => Self::Wallpaper,
            BackgroundSource::Image { .. } => Self::Image,
        }
    }
}

/// The screenshot editor's border fallback -- `BorderPopover.tsx:42-45`,
/// black at 50%, not `BorderConfiguration::default()`'s white at 80%.
const BORDER_FALLBACK: BorderConfiguration = BorderConfiguration {
    enabled: false,
    width: 5.0,
    color: [0, 0, 0],
    opacity: 50.0,
};

/// Every slider in the styling panel, with the popovers' exact ranges.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum StyleSlider {
    Blur,
    Padding,
    Rounding,
    Shadow,
    BorderWidth,
    BorderOpacity,
}

impl StyleSlider {
    /// `(min, max, step)` -- `BackgroundSettingsPopover` blur,
    /// `PaddingPopover`, `RoundingPopover`, `ShadowPopover`, `BorderPopover`.
    fn range(self) -> (f32, f32, f32) {
        match self {
            Self::Blur | Self::Padding | Self::Rounding | Self::Shadow => (0., 100., 1.),
            Self::BorderWidth => (1., 20., 0.1),
            Self::BorderOpacity => (0., 100., 0.1),
        }
    }

    fn value(self, project: &ProjectConfiguration) -> f32 {
        let background = &project.background;
        match self {
            Self::Blur => background.blur as f32,
            Self::Padding => background.padding as f32,
            Self::Rounding => background.rounding as f32,
            Self::Shadow => background.shadow,
            Self::BorderWidth => background
                .border
                .as_ref()
                .map_or(BORDER_FALLBACK.width, |border| border.width),
            Self::BorderOpacity => background
                .border
                .as_ref()
                .map_or(BORDER_FALLBACK.opacity, |border| border.opacity),
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
        }
        true
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

pub struct ScreenshotEditorWindow {
    theme: Theme,
    bundle: PathBuf,
    pretty_name: String,
    error: Option<String>,
    /// The live config, published to the render loop on every edit.
    project: ProjectConfiguration,
    revision: u64,
    config_tx: Option<tokio::sync::watch::Sender<ConfigUpdate>>,
    export_tx: Option<tokio::sync::mpsc::Sender<ExportRequest>>,
    /// One export at a time: the copy/save buttons grey out while the GPU
    /// renders and the panel is up.
    exporting: bool,
    /// The latest GPU frame, already BGRA in gpui's atlas format.
    frame: Option<Arc<RenderImage>>,
    frame_size: (f32, f32),
    pending_save: Rc<RefCell<PendingConfigSave>>,
    save_task: Option<gpui::Task<()>>,
    aspect_menu: Option<ui::MenuState>,
    bg_tab: BgTab,
    wallpaper_theme: usize,
    wallpapers: HashMap<&'static str, Arc<RenderImage>>,
    wallpaper_task: Option<gpui::Task<()>>,
    slider_tracks: HashMap<StyleSlider, ui::SliderTrack>,
    active_slider: Option<StyleSlider>,
    focus: gpui::FocusHandle,
}

impl ScreenshotEditorWindow {
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

        Self {
            theme: Theme::for_window(window, cx, false),
            bundle,
            pretty_name,
            error: None,
            project: ProjectConfiguration::default(),
            revision: 0,
            config_tx: None,
            export_tx: None,
            exporting: false,
            frame: None,
            frame_size: (1., 1.),
            pending_save: Rc::new(RefCell::new(PendingConfigSave::default())),
            save_task: None,
            aspect_menu: None,
            bg_tab: BgTab::Color,
            wallpaper_theme: 0,
            wallpapers: HashMap::new(),
            wallpaper_task: None,
            slider_tracks: HashMap::new(),
            active_slider: None,
            focus: cx.focus_handle(),
        }
    }

    pub fn set_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.error = Some(message);
        cx.notify();
    }

    pub fn set_loaded(
        &mut self,
        pretty_name: String,
        config: ProjectConfiguration,
        config_tx: tokio::sync::watch::Sender<ConfigUpdate>,
        export_tx: tokio::sync::mpsc::Sender<ExportRequest>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pretty_name = pretty_name;
        self.bg_tab = BgTab::for_source(&config.background.source);
        self.project = config;
        self.config_tx = Some(config_tx);
        self.export_tx = Some(export_tx);
        self.pending_save.borrow_mut().path = Some(self.bundle.clone());
        if self.bg_tab == BgTab::Wallpaper {
            self.ensure_wallpapers(cx);
        }
        if let Ok(dest) = std::env::var("CAP_GPUI_AUTO_SCREENSHOT_EXPORT")
            && !dest.trim().is_empty()
        {
            self.export_png(ExportDestination::Harness(PathBuf::from(dest)), window, cx);
        }
        cx.notify();
    }

    pub fn frame_arrived(
        &mut self,
        image: Arc<RenderImage>,
        size: (u32, u32),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.frame_size = (size.0.max(1) as f32, size.1.max(1) as f32);
        if let Some(previous) = self.frame.replace(image) {
            let _ = window.drop_image(previous);
        }
        cx.notify();
    }

    pub fn pending_save(&self) -> Rc<RefCell<PendingConfigSave>> {
        self.pending_save.clone()
    }

    /// Every styling edit funnels through here: mutate, publish to the
    /// renderer, schedule the debounced write -- `updateScreenshotConfig`'s
    /// throttled-render + debounced-save pair, minus history (deviation: no
    /// undo stack yet).
    fn edit_project(
        &mut self,
        change: impl FnOnce(&mut ProjectConfiguration) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !change(&mut self.project) {
            return;
        }
        self.publish();
        self.schedule_save(window, cx);
        cx.notify();
    }

    fn publish(&mut self) {
        let Some(config_tx) = &self.config_tx else {
            return;
        };
        self.revision += 1;
        let _ = config_tx.send(ConfigUpdate {
            revision: self.revision,
            config: self.project.clone(),
        });
    }

    fn schedule_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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

    // -- Styling ----------------------------------------------------------------

    /// A slider press or drag move: map the pointer to the slider's value and
    /// apply it.
    fn apply_slider(
        &mut self,
        slider: StyleSlider,
        position: Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(track) = self.slider_tracks.get(&slider) else {
            return;
        };
        let (min, max, step) = slider.range();
        let Some(value) = ui::slider_value_at(track, position, min, max, step) else {
            return;
        };
        self.edit_project(move |project| slider.apply(project, value), window, cx);
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
                        true
                    },
                    window,
                    cx,
                );
            })
            .ok();
        })
        .detach();
    }

    // -- Export actions -------------------------------------------------------

    /// Render at export resolution and hand the PNG to its destination --
    /// `useScreenshotExport`'s Copy and Save destinations (the canvas
    /// composite is annotation work, which does not exist here yet).
    fn export_png(
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
        cx.notify();

        let config = self.project.clone();
        let name = self.pretty_name.clone();
        cx.spawn_in(window, async move |this, cx| {
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            let request = ExportRequest::Png {
                config,
                reply: reply_tx,
            };
            let result = if export_tx.send(request).await.is_ok() {
                match reply_rx.await {
                    Ok(result) => result,
                    Err(_) => Err("The renderer stopped before the export finished".into()),
                }
            } else {
                Err("The screenshot renderer is not running".into())
            };

            match result {
                Ok(bytes) => match destination {
                    ExportDestination::Clipboard => {
                        // The clipboard seam this app has is "NSImage from a
                        // path" (`platform::copy_image_to_clipboard`); a temp
                        // file bridges the rendered bytes to it.
                        let path = std::env::temp_dir()
                            .join(format!("cap-screenshot-copy-{}.png", std::process::id()));
                        let written =
                            cx.background_executor()
                                .spawn({
                                    let path = path.clone();
                                    async move {
                                        std::fs::write(&path, &bytes).map_err(|e| e.to_string())
                                    }
                                })
                                .await;
                        match written {
                            Ok(()) => {
                                let copied = this.update_in(cx, |_, _, _| {
                                    crate::platform::copy_image_to_clipboard(&path)
                                });
                                if let Ok(Err(error)) = copied {
                                    tracing::error!("copying the screenshot failed: {error}");
                                }
                                cx.background_executor()
                                    .spawn(async move {
                                        let _ = std::fs::remove_file(&path);
                                    })
                                    .detach();
                            }
                            Err(error) => {
                                tracing::error!("writing the clipboard temp file failed: {error}")
                            }
                        }
                    }
                    ExportDestination::File => {
                        let dest =
                            crate::platform::save_file_panel(&format!("{name}.png"), &["png"]);
                        if let Some(dest) = dest {
                            let written = cx
                                .background_executor()
                                .spawn(async move { std::fs::write(&dest, &bytes) })
                                .await;
                            if let Err(error) = written {
                                tracing::error!("saving the screenshot failed: {error}");
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
                Err(error) => tracing::error!("screenshot export failed: {error}"),
            }

            this.update_in(cx, |this, _window, cx| {
                this.exporting = false;
                cx.notify();
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

    fn aspect_label(&self) -> &'static str {
        match &self.project.aspect_ratio {
            None => "Auto",
            Some(cap_project::AspectRatio::Wide) => "Wide",
            Some(cap_project::AspectRatio::Vertical) => "Vertical",
            Some(cap_project::AspectRatio::Square) => "Square",
            Some(cap_project::AspectRatio::Classic) => "Classic",
            Some(cap_project::AspectRatio::Tall) => "Tall",
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
        self.aspect_menu = None;
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

    fn on_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.aspect_menu.as_mut() else {
            return;
        };
        match menu.on_key(key) {
            ui::MenuKey::Moved => cx.notify(),
            ui::MenuKey::Commit(index) => self.choose_aspect(index, window, cx),
            ui::MenuKey::Dismiss => {
                self.aspect_menu = None;
                cx.notify();
            }
            ui::MenuKey::Ignored => {}
        }
    }

    // -- Rendering ----------------------------------------------------------

    /// A small bordered icon button, the aspect button's palette.
    fn header_action(
        &self,
        id: &'static str,
        icon: &'static str,
        enabled: bool,
        handler: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .size(px(30.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.gray_4)
            .bg(theme.gray_2)
            .when(enabled, |this| {
                this.hover(|style| style.bg(theme.gray_3))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        handler(this, window, cx);
                    }))
            })
            .when(!enabled, |this| this.opacity(0.5))
            .child(
                gpui::svg()
                    .path(icon)
                    .size(px(14.))
                    .text_color(theme.gray_11),
            )
    }

    /// Traffic-light spacer + name on the left; copy, save, reveal, delete
    /// and the aspect menu on the right -- the skeleton of the Tauri editor's
    /// `Header.tsx`.
    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let ready = self.export_tx.is_some() && self.error.is_none();
        let exportable = ready && !self.exporting;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .h(px(52.))
            .px(px(14.))
            .flex_shrink_0()
            .child(div().w(px(72.)).flex_shrink_0())
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.gray_12)
                    .child(self.pretty_name.clone()),
            )
            .child(self.header_action(
                "screenshot-copy",
                "icons/copy.svg",
                exportable,
                |this, window, cx| this.export_png(ExportDestination::Clipboard, window, cx),
                cx,
            ))
            .child(self.header_action(
                "screenshot-save",
                "icons/download.svg",
                exportable,
                |this, window, cx| this.export_png(ExportDestination::File, window, cx),
                cx,
            ))
            .child(self.header_action(
                "screenshot-reveal",
                "icons/folder-open.svg",
                true,
                |this, _window, _cx| {
                    crate::library::reveal_in_folder(&this.bundle.join("original.png"));
                },
                cx,
            ))
            .child(self.header_action(
                "screenshot-delete",
                "icons/trash.svg",
                true,
                |this, window, cx| this.delete_screenshot(window, cx),
                cx,
            ))
            .child(
                div()
                    .id("aspect-button")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme.gray_4)
                    .bg(theme.gray_2)
                    .hover(|style| style.bg(theme.gray_3))
                    .text_size(px(12.))
                    .text_color(theme.gray_12)
                    .child(format!("Aspect: {}", self.aspect_label()))
                    .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                        cx.stop_propagation();
                        if this.aspect_menu.take().is_none() {
                            let items = this.aspect_menu_items();
                            this.aspect_menu = Some(ui::MenuState::new(event.position(), &items));
                            window.focus(&this.focus, cx);
                        }
                        cx.notify();
                    })),
            )
    }

    // -- Styling panel ----------------------------------------------------------

    fn section_label(&self, label: &'static str) -> impl IntoElement {
        div()
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(self.theme.gray_10)
            .child(label)
    }

    fn slider_row(
        &mut self,
        label: &'static str,
        slider: StyleSlider,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let (min, max, _) = slider.range();
        let value = slider.value(&self.project);
        let fraction = ((value - min) / (max - min)).clamp(0., 1.);
        let track = self.slider_tracks.entry(slider).or_default().clone();

        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .text_size(px(12.))
                    .text_color(theme.gray_11)
                    .child(label)
                    .child(format!("{}", value.round() as i64)),
            )
            .child(
                ui::Slider::new(
                    gpui::SharedString::from(format!("style-slider-{label}")),
                    fraction,
                    track,
                )
                .flex()
                .track(px(4.), theme.gray_4.into())
                .fill(theme.blue_9.into())
                .thumb(px(14.), gpui::white(), Some(theme.gray_6.into()))
                .on_drag_start(cx.listener(
                    move |this, event: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        this.active_slider = Some(slider);
                        this.apply_slider(slider, event.position, window, cx);
                        cx.notify();
                    },
                )),
            )
    }

    fn render_bg_tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let current = self.bg_tab;
        let mut row = div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .p(px(2.))
            .rounded(px(8.))
            .bg(theme.gray_3);
        for (tab, label) in BgTab::ALL {
            let selected = tab == current;
            row = row.child(
                div()
                    .id(gpui::SharedString::from(format!("bg-tab-{label}")))
                    .flex_1()
                    .flex()
                    .justify_center()
                    .py(px(4.))
                    .rounded(px(6.))
                    .text_size(px(11.))
                    .text_color(if selected {
                        theme.gray_12
                    } else {
                        theme.gray_10
                    })
                    .when(selected, |this| this.bg(theme.gray_1))
                    .when(!selected, |this| this.hover(|style| style.bg(theme.gray_4)))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        cx.stop_propagation();
                        this.bg_tab = tab;
                        if tab == BgTab::Wallpaper {
                            this.ensure_wallpapers(cx);
                        }
                        cx.notify();
                    })),
            );
        }
        row
    }

    fn render_color_pane(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let current = match &self.project.background.source {
            BackgroundSource::Color { value, alpha } => Some((*value, *alpha)),
            _ => None,
        };
        let mut grid = div().flex().flex_row().flex_wrap().gap(px(6.));
        for (index, hex) in BACKGROUND_COLORS.iter().enumerate() {
            let Some(rgba) = hex_to_rgb(hex) else {
                continue;
            };
            let value = [rgba[0] as u16, rgba[1] as u16, rgba[2] as u16];
            let alpha = rgba[3];
            let selected = current == Some((value, alpha));
            let mut fill: Hsla = color_to_hsla(value);
            fill.a = alpha as f32 / 255.;
            grid = grid.child(
                div()
                    .id(("bg-color", index))
                    .size(px(24.))
                    .rounded(px(6.))
                    .border_2()
                    .border_color(if selected { theme.blue_9 } else { theme.gray_4 })
                    .bg(fill)
                    .hover(|style| style.border_color(theme.gray_8))
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
            );
        }
        grid
    }

    fn render_gradient_pane(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let current = match &self.project.background.source {
            BackgroundSource::Gradient { from, to, .. } => Some((*from, *to)),
            _ => None,
        };
        let angle = match &self.project.background.source {
            BackgroundSource::Gradient { angle, .. } => *angle,
            _ => 90,
        };
        let mut grid = div().flex().flex_row().flex_wrap().gap(px(6.));
        for (index, (from, to)) in GRADIENT_PRESETS.iter().enumerate() {
            let (from, to) = (*from, *to);
            let selected = current == Some((from, to));
            grid = grid.child(
                div()
                    .id(("bg-gradient", index))
                    .size(px(24.))
                    .rounded(px(6.))
                    .border_2()
                    .border_color(if selected { theme.blue_9 } else { theme.gray_4 })
                    .bg(linear_gradient(
                        135.,
                        linear_color_stop(color_to_hsla(from), 0.),
                        linear_color_stop(color_to_hsla(to), 1.),
                    ))
                    .hover(|style| style.border_color(theme.gray_8))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.edit_project(
                            move |project| {
                                project.background.source = BackgroundSource::Gradient {
                                    from,
                                    to,
                                    angle,
                                    noise_intensity: None,
                                    noise_scale: None,
                                    animated: None,
                                    animation_speed: None,
                                };
                                true
                            },
                            window,
                            cx,
                        );
                    })),
            );
        }
        grid
    }

    fn render_wallpaper_pane(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        // The config stores the wallpaper's absolute path (the render layer
        // opens it as a file); selection matches by catalogue id the way the
        // Tauri sidebar's `path.includes(w.id)` does.
        let current = match &self.project.background.source {
            BackgroundSource::Wallpaper { path: Some(path) } => {
                editor_sidebar::wallpaper_id_for_path(path)
            }
            _ => None,
        };

        let mut theme_row = div().flex().flex_row().flex_wrap().gap(px(4.));
        for (index, (_, label)) in BACKGROUND_THEMES.iter().enumerate() {
            let selected = index == self.wallpaper_theme;
            theme_row = theme_row.child(
                div()
                    .id(("wallpaper-theme", index))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(6.))
                    .text_size(px(11.))
                    .text_color(if selected {
                        theme.gray_12
                    } else {
                        theme.gray_10
                    })
                    .bg(if selected { theme.gray_4 } else { theme.gray_2 })
                    .hover(|style| style.bg(theme.gray_4))
                    .child(*label)
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        cx.stop_propagation();
                        this.wallpaper_theme = index;
                        this.ensure_wallpapers(cx);
                        cx.notify();
                    })),
            );
        }

        let theme_name = BACKGROUND_THEMES[self.wallpaper_theme].0;
        let mut grid = div().flex().flex_row().flex_wrap().gap(px(6.));
        for (index, id) in editor_sidebar::wallpapers_for_theme(theme_name)
            .into_iter()
            .enumerate()
        {
            let selected = current == Some(id);
            let tile = div()
                .id(("wallpaper-tile", index))
                .size(px(56.))
                .rounded(px(8.))
                .border_2()
                .border_color(if selected { theme.blue_9 } else { theme.gray_4 })
                .overflow_hidden()
                .bg(theme.gray_3)
                .hover(|style| style.border_color(theme.gray_8))
                .when_some(self.wallpapers.get(id).cloned(), |this, image| {
                    this.child(img(image).size_full().object_fit(gpui::ObjectFit::Cover))
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
                            true
                        },
                        window,
                        cx,
                    );
                }));
            grid = grid.child(tile);
        }

        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(theme_row)
            .child(grid)
    }

    fn render_image_pane(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let current = match &self.project.background.source {
            BackgroundSource::Image { path } => path.clone(),
            _ => None,
        };
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .id("bg-image-pick")
                    .flex()
                    .justify_center()
                    .py(px(8.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme.gray_4)
                    .bg(theme.gray_2)
                    .hover(|style| style.bg(theme.gray_3))
                    .text_size(px(12.))
                    .text_color(theme.gray_12)
                    .child("Choose Image...")
                    .on_click(cx.listener(|this, _, window, cx| {
                        cx.stop_propagation();
                        this.pick_background_image(window, cx);
                    })),
            )
            .when_some(current, |this, path| {
                this.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme.gray_10)
                        .overflow_hidden()
                        .child(path),
                )
            })
    }

    fn render_corner_style(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let squircle = matches!(self.project.background.rounding_type, CornerStyle::Squircle);
        let mut row = div()
            .flex()
            .flex_row()
            .gap(px(4.))
            .p(px(2.))
            .rounded(px(8.))
            .bg(theme.gray_3);
        for (label, style, selected) in [
            ("Squircle", CornerStyle::Squircle, squircle),
            ("Rounded", CornerStyle::Rounded, !squircle),
        ] {
            row = row.child(
                div()
                    .id(gpui::SharedString::from(format!("corner-style-{label}")))
                    .flex_1()
                    .flex()
                    .justify_center()
                    .py(px(4.))
                    .rounded(px(6.))
                    .text_size(px(11.))
                    .text_color(if selected {
                        theme.gray_12
                    } else {
                        theme.gray_10
                    })
                    .when(selected, |this| this.bg(theme.gray_1))
                    .when(!selected, |this| this.hover(|style| style.bg(theme.gray_4)))
                    .child(label)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.edit_project(
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
                    })),
            );
        }
        row
    }

    fn render_border_section(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let enabled = self
            .project
            .background
            .border
            .as_ref()
            .is_some_and(|border| border.enabled);

        let mut section = div().flex().flex_col().gap(px(10.)).child(
            div()
                .flex()
                .flex_row()
                .justify_between()
                .items_center()
                .child(self.section_label("Border"))
                .child(
                    ui::Toggle::plain(&theme, "border-toggle", enabled).on_click(cx.listener(
                        move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.edit_project(
                                move |project| {
                                    let border =
                                        project.background.border.get_or_insert(BORDER_FALLBACK);
                                    border.enabled = !enabled;
                                    true
                                },
                                window,
                                cx,
                            );
                        },
                    )),
                ),
        );
        if enabled {
            section = section
                .child(self.slider_row("Width", StyleSlider::BorderWidth, cx))
                .child(self.slider_row("Opacity", StyleSlider::BorderOpacity, cx));
        }
        section
    }

    fn render_sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let bg_pane = match self.bg_tab {
            BgTab::Color => self.render_color_pane(cx),
            BgTab::Gradient => self.render_gradient_pane(cx),
            BgTab::Wallpaper => self.render_wallpaper_pane(cx),
            BgTab::Image => self.render_image_pane(cx),
        };

        div()
            .id("screenshot-style-panel")
            .w(px(280.))
            .flex_shrink_0()
            .m(px(14.))
            .mt(px(0.))
            .ml(px(0.))
            .p(px(14.))
            .rounded(px(12.))
            .border_1()
            .border_color(theme.gray_4)
            .bg(if theme.is_dark() {
                theme.gray_2
            } else {
                theme.gray_1
            })
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(self.section_label("Background"))
            .child(self.render_bg_tabs(cx))
            .child(bg_pane)
            .child(self.slider_row("Blur", StyleSlider::Blur, cx))
            .child(self.slider_row("Padding", StyleSlider::Padding, cx))
            .child(self.slider_row("Rounding", StyleSlider::Rounding, cx))
            .child(self.render_corner_style(cx))
            .child(self.slider_row("Shadow", StyleSlider::Shadow, cx))
            .child(self.render_border_section(cx))
    }

    fn render_preview(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let frame = self.frame.clone();
        let frame_size = self.frame_size;

        div()
            .flex_1()
            .min_h_0()
            .m(px(14.))
            .mt(px(0.))
            .rounded(px(12.))
            .border_1()
            .border_color(theme.gray_4)
            .overflow_hidden()
            .bg(if theme.is_dark() {
                theme.gray_2
            } else {
                theme.gray_3
            })
            .child(match (&self.error, frame) {
                (Some(message), _) => div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(theme.gray_11)
                    .child(message.clone())
                    .into_any_element(),
                (None, Some(frame)) => gpui::canvas(
                    |bounds, _window, _cx| bounds,
                    move |_, bounds, window, _cx| {
                        let container_width: f32 = bounds.size.width.into();
                        let container_height: f32 = bounds.size.height.into();
                        let (width, height) = crate::editor_window::letterbox(
                            (container_width, container_height),
                            frame_size,
                        );
                        let fitted = gpui::Bounds {
                            origin: gpui::point(
                                bounds.origin.x + px((container_width - width) / 2.),
                                bounds.origin.y + px((container_height - height) / 2.),
                            ),
                            size: gpui::size(px(width), px(height)),
                        };
                        let _ =
                            window.paint_image(fitted, gpui::Corners::default(), frame, 0, false);
                    },
                )
                .size_full()
                .into_any_element(),
                (None, None) => div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(13.))
                    .text_color(theme.gray_10)
                    .child("Loading screenshot...")
                    .into_any_element(),
            })
            .when(self.aspect_menu.is_some(), |this| {
                let state = self.aspect_menu.as_ref().unwrap();
                let items = self.aspect_menu_items();
                this.child(
                    ui::Menu::plain(&self.theme, "aspect-menu", items, state)
                        .min_width(px(160.))
                        .on_select(cx.listener(|this, index: &usize, window, cx| {
                            this.choose_aspect(*index, window, cx);
                        }))
                        .on_dismiss(cx.listener(|this, _, _window, cx| {
                            this.aspect_menu = None;
                            cx.notify();
                        })),
                )
            })
    }
}

impl Render for ScreenshotEditorWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        let theme = self.theme;

        div()
            .id("screenshot-editor-root")
            .track_focus(&self.focus)
            .key_context("ScreenshotEditor")
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                this.on_key(event.keystroke.key.as_str(), window, cx);
            }))
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            .font_weight(FontWeight::MEDIUM)
            // The video editor's root: `bg-gray-2 dark:bg-gray-1`.
            .bg(if theme.is_dark() {
                theme.gray_1
            } else {
                theme.gray_2
            })
            .text_color(theme.gray_12)
            .child(self.render_header(cx))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_preview(cx))
                    .child(self.render_sidebar(cx)),
            )
            .when_some(self.active_slider, |root, slider| {
                root.child(ui::Slider::drag_layer(
                    "style-slider-drag",
                    cx.listener(move |this, event: &MouseMoveEvent, window, cx| {
                        this.apply_slider(slider, event.position, window, cx);
                    }),
                    cx.listener(|this, _: &gpui::MouseUpEvent, _window, cx| {
                        this.active_slider = None;
                        cx.notify();
                    }),
                ))
            })
    }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

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

        if handle
            .update(cx, |view, window, cx| {
                view.set_loaded(
                    source.pretty_name.clone(),
                    source.config.clone(),
                    config_tx,
                    export_tx,
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
            let image = cx
                .background_executor()
                .spawn(async move { crate::editor_window::frame_image(&frame) })
                .await;
            let Some(image) = image else {
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
                    view.frame_arrived(image, size, window, cx)
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
