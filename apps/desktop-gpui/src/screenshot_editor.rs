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
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use cap_project::{ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use cap_rendering::{
    DecodedFrame, DecodedSegmentFrames, FrameRenderer, ProjectUniforms, RenderOptions,
    RenderVideoConstants, RenderedFrame, RendererLayers, ZoomTransformTimeline,
};
use gpui::{
    App, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    RenderImage, StatefulInteractiveElement as _, Styled, Window, WindowHandle, div,
    prelude::FluentBuilder as _, px,
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

/// The render loop, on the tokio runtime: build the GPU constants, then
/// re-render the still whenever the config changes. Ends when the window
/// drops its `config_tx` or the pump drops `frame_rx`.
pub async fn run_still_renderer(
    source: LoadedSource,
    mut config_rx: tokio::sync::watch::Receiver<ConfigUpdate>,
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

    loop {
        let update = config_rx.borrow().clone();
        match render_still(
            &constants,
            &mut frame_renderer,
            &mut layers,
            &decoded,
            &update.config,
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
        if config_rx.changed().await.is_err() {
            break;
        }
    }
}

/// One `render_immediate` of the still -- the body of the Tauri loop
/// (`screenshot_editor.rs:385-430` over there): frame 0 at 30fps, empty
/// cursor events, a zoom timeline precomputed to one frame.
async fn render_still(
    constants: &RenderVideoConstants,
    frame_renderer: &mut FrameRenderer<'_>,
    layers: &mut RendererLayers,
    source: &DecodedFrame,
    config: &ProjectConfiguration,
) -> Result<RenderedFrame, String> {
    let segment_frames = DecodedSegmentFrames {
        screen_frame: Some(source.clone()),
        camera_frame: None,
        segment_time: 0.0,
        recording_time: 0.0,
        segment_has_camera: false,
    };

    let (base_w, base_h) = ProjectUniforms::get_base_size(&constants.options, config);
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
        cap_project::XY::new(base_w, base_h),
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

pub struct ScreenshotEditorWindow {
    theme: Theme,
    bundle: PathBuf,
    pretty_name: String,
    error: Option<String>,
    /// The live config, published to the render loop on every edit.
    project: ProjectConfiguration,
    revision: u64,
    config_tx: Option<tokio::sync::watch::Sender<ConfigUpdate>>,
    /// The latest GPU frame, already BGRA in gpui's atlas format.
    frame: Option<Arc<RenderImage>>,
    frame_size: (f32, f32),
    pending_save: Rc<RefCell<PendingConfigSave>>,
    save_task: Option<gpui::Task<()>>,
    aspect_menu: Option<ui::MenuState>,
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
            frame: None,
            frame_size: (1., 1.),
            pending_save: Rc::new(RefCell::new(PendingConfigSave::default())),
            save_task: None,
            aspect_menu: None,
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
        cx: &mut Context<Self>,
    ) {
        self.pretty_name = pretty_name;
        self.project = config;
        self.config_tx = Some(config_tx);
        self.pending_save.borrow_mut().path = Some(self.bundle.clone());
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

    /// Traffic-light spacer + name on the left, the aspect menu button on the
    /// right -- the skeleton of the Tauri editor's `Header.tsx`.
    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
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
            .child(self.render_preview(cx))
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
        // Bounded and latest-wins like the video pump; stills only re-render
        // on edits, so it never actually fills.
        let (frame_tx, frame_rx) = flume::bounded(2);
        let (setup_tx, setup_rx) = flume::bounded(1);

        if handle
            .update(cx, |view, _window, cx| {
                view.set_loaded(
                    source.pretty_name.clone(),
                    source.config.clone(),
                    config_tx,
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
                run_still_renderer(source, config_rx, frame_tx, setup_tx),
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
