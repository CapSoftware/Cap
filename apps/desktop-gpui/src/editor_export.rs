//! Editor export page -- `routes/editor/ExportPage.tsx`, 1:1 layout.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cap_export::estimates::{ExportEstimates, estimate_export};
use cap_export::gif::GifExportSettings;
use cap_export::mov::MovExportSettings;
use cap_export::mp4::{ExportCompression, Mp4ExportSettings};
use cap_export::preview::{
    ExportPreviewSettings, render_preview_with_config, render_preview_with_editor,
};
use cap_export::settings::ExportSettings;
use cap_export::{ExporterBase, make_cursor_only_project};
use cap_project::{BackgroundSource, RecordingMeta, XY};
use cap_utils::export_resources::{
    DiskBudget, ExportResources, estimated_working_bytes, is_resource_stop,
};
use gpui::{
    Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, RenderImage, StatefulInteractiveElement, Styled, Window, div, img,
    prelude::FluentBuilder, px, svg,
};

use crate::editor_window::EditorWindow;
use crate::store::{self, ExportPrefs};
use crate::ui;
use crate::{library, platform};

const SIDEBAR_WIDTH: f32 = 400.;
const HEADER_HEIGHT: f32 = 52.;
const STAGE_PADDING_X: f32 = 24.;
/// Stage top padding, caption row, preview padding, stats card and bottom
/// padding: everything on the stage that is not the preview itself.
const STAGE_VERTICAL_CHROME: f32 = 16. + 22. + 14. + 18. + STATS_HEIGHT + 20.;
const STATS_HEIGHT: f32 = 44.;
const SEGMENT_HEIGHT: f32 = 26.;
const COMPRESSION_PRESETS: [(ExportCompression, &str); 4] = [
    (ExportCompression::Potato, "Potato"),
    (ExportCompression::Web, "Web"),
    (ExportCompression::Social, "Social"),
    (ExportCompression::Maximum, "Maximum"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportDestination {
    File,
    Clipboard,
    Link,
}

impl ExportDestination {
    const ALL: &'static [Self] = &[Self::File, Self::Clipboard, Self::Link];

    fn label(self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Clipboard => "Clipboard",
            Self::Link => "Shareable Link",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::File => "icons/folder.svg",
            Self::Clipboard => "icons/copy.svg",
            Self::Link => "icons/link.svg",
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Clipboard => "clipboard",
            Self::Link => "link",
        }
    }

    fn from_slug(slug: &str) -> Self {
        match slug {
            "clipboard" => Self::Clipboard,
            "link" => Self::Link,
            _ => Self::File,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormatKind {
    Mp4,
    Gif,
}

impl ExportFormatKind {
    fn label(self) -> &'static str {
        match self {
            Self::Mp4 => "MP4",
            Self::Gif => "GIF",
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Mp4 => "Mp4",
            Self::Gif => "Gif",
        }
    }

    fn from_slug(slug: &str) -> Self {
        match slug {
            "Gif" => Self::Gif,
            _ => Self::Mp4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportResolution {
    P720,
    P1080,
    P4k,
}

impl ExportResolution {
    fn label(self) -> &'static str {
        match self {
            Self::P720 => "720p",
            Self::P1080 => "1080p",
            Self::P4k => "4K",
        }
    }

    fn size(self) -> (u32, u32) {
        match self {
            Self::P720 => (1280, 720),
            Self::P1080 => (1920, 1080),
            Self::P4k => (3840, 2160),
        }
    }

    fn from_slug(slug: &str) -> Self {
        match slug {
            "1080p" => Self::P1080,
            "4K" | "4k" => Self::P4k,
            _ => Self::P720,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportPhase {
    Idle,
    ChoosingFile,
    Starting,
    Rendering,
    Copying,
    Uploading,
    Done,
    Failed,
}

impl ExportPhase {
    pub(crate) fn is_busy(self) -> bool {
        matches!(
            self,
            Self::ChoosingFile | Self::Starting | Self::Rendering | Self::Copying | Self::Uploading
        )
    }

    fn shows_progress(self) -> bool {
        !matches!(self, Self::Idle | Self::ChoosingFile)
    }
}

pub struct PreviewStats {
    pub width: u32,
    pub height: u32,
    pub total_frames: u32,
    pub estimated_size_mb: f64,
}

pub struct ExportUi {
    pub destination: ExportDestination,
    pub format: ExportFormatKind,
    pub resolution: ExportResolution,
    pub fps: u32,
    pub compression: ExportCompression,
    pub optimize_filesize: bool,
    pub cursor_only: bool,
    pub custom_bpp: Option<f32>,
    pub force_ffmpeg: bool,
    pub advanced_open: bool,
    pub preview: Option<Arc<RenderImage>>,
    pub preview_stats: Option<PreviewStats>,
    pub preview_error: Option<String>,
    pub preview_task: Option<gpui::Task<()>>,
    preview_request: Arc<()>,
    estimate: Option<ExportEstimates>,
    estimate_loading: bool,
    estimate_cancel: Arc<AtomicBool>,
    pub phase: ExportPhase,
    close_requested: bool,
    pub rendered: u32,
    pub total_frames: u32,
    pub output_path: Option<PathBuf>,
    pub error: Option<String>,
    pub cancel: Arc<AtomicBool>,
    pub export_task: Option<gpui::Task<()>>,
    pub sign_in_pending: bool,
    pub sign_in_cancel: Arc<AtomicBool>,
    pub organization_id: Option<String>,
    pub share_link: Option<String>,
    pub reuploading: bool,
    pub upload_progress: f32,
    pub copy_link_pressed: bool,
    bpp_track: ui::SliderTrack,
    bpp_dragging: bool,
}

impl Drop for ExportUi {
    fn drop(&mut self) {
        self.estimate_cancel.store(true, Ordering::Release);
    }
}

const BPP_MIN: f32 = 0.02;
const BPP_MAX: f32 = 0.5;
const BPP_STEP: f32 = 0.01;

impl ExportUi {
    pub fn load() -> Self {
        let prefs = store::load().export.unwrap_or(ExportPrefs {
            format: "Mp4".into(),
            fps: 30,
            export_to: "file".into(),
            resolution: "720p".into(),
            compression: "Maximum".into(),
            optimize_filesize: false,
            cursor_only: false,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            advanced_open: false,
            organization_id: None,
        });
        Self::from_preferences(prefs)
    }

    fn from_preferences(prefs: ExportPrefs) -> Self {
        Self {
            destination: ExportDestination::from_slug(&prefs.export_to),
            format: ExportFormatKind::from_slug(&prefs.format),
            resolution: ExportResolution::from_slug(&prefs.resolution),
            fps: prefs.fps,
            compression: match prefs.compression.as_str() {
                "Social" => ExportCompression::Social,
                "Web" => ExportCompression::Web,
                "Potato" => ExportCompression::Potato,
                _ => ExportCompression::Maximum,
            },
            optimize_filesize: prefs.optimize_filesize,
            cursor_only: prefs.cursor_only,
            custom_bpp: prefs.custom_bpp,
            force_ffmpeg: prefs.force_ffmpeg_decoder,
            advanced_open: prefs.advanced_open,
            preview: None,
            preview_stats: None,
            preview_error: None,
            preview_task: None,
            preview_request: Arc::new(()),
            estimate: None,
            estimate_loading: false,
            estimate_cancel: Arc::new(AtomicBool::new(false)),
            phase: ExportPhase::Idle,
            close_requested: false,
            rendered: 0,
            total_frames: 0,
            output_path: None,
            error: None,
            cancel: Arc::new(AtomicBool::new(false)),
            export_task: None,
            sign_in_pending: false,
            sign_in_cancel: Arc::new(AtomicBool::new(false)),
            organization_id: prefs.organization_id,
            share_link: None,
            reuploading: false,
            upload_progress: 0.0,
            copy_link_pressed: false,
            bpp_track: ui::SliderTrack::default(),
            bpp_dragging: false,
        }
    }

    fn update_preview(&mut self, request: &Arc<()>, update: impl FnOnce(&mut Self)) -> bool {
        if !Arc::ptr_eq(&self.preview_request, request) {
            return false;
        }
        update(self);
        true
    }

    fn persist(&self) {
        let prefs = ExportPrefs {
            format: self.format.slug().to_string(),
            fps: self.fps,
            export_to: self.destination.slug().to_string(),
            resolution: self.resolution.label().to_string(),
            compression: format!("{:?}", self.compression),
            optimize_filesize: self.optimize_filesize,
            cursor_only: self.cursor_only,
            custom_bpp: self.custom_bpp,
            force_ffmpeg_decoder: self.force_ffmpeg,
            advanced_open: self.advanced_open,
            organization_id: self.organization_id.clone(),
        };
        store::update(|state| state.export = Some(prefs));
    }

    fn bpp(&self) -> f32 {
        self.custom_bpp
            .unwrap_or_else(|| self.compression.bits_per_pixel())
    }

    fn estimate_settings(&self) -> ExportSettings {
        let (width, height) = self.resolution.size();
        let resolution_base = XY::new(width, height);
        if self.cursor_only {
            ExportSettings::Mov(MovExportSettings {
                fps: self.fps,
                resolution_base,
                cursor_only: true,
            })
        } else if self.format == ExportFormatKind::Gif {
            ExportSettings::Gif(GifExportSettings {
                fps: self.fps,
                resolution_base,
                quality: None,
            })
        } else {
            ExportSettings::Mp4(Mp4ExportSettings {
                fps: self.fps,
                resolution_base,
                compression: self.compression,
                custom_bpp: self.custom_bpp,
                force_ffmpeg_decoder: self.force_ffmpeg,
                optimize_filesize: self.optimize_filesize,
            })
        }
    }

    fn is_custom_bpp(&self) -> bool {
        self.custom_bpp
            .is_some_and(|bpp| (bpp - self.compression.bits_per_pixel()).abs() > 0.001)
    }

    fn clipboard_retry_path(&self) -> Option<&Path> {
        if self.phase == ExportPhase::Failed && self.destination == ExportDestination::Clipboard {
            self.output_path.as_deref()
        } else {
            None
        }
    }

    fn copy_completed_export(
        &mut self,
        path: PathBuf,
        copy: impl FnOnce(&Path) -> Result<(), String>,
    ) {
        self.output_path = Some(path.clone());
        self.error = None;
        if self.close_requested || self.cancel.load(Ordering::Relaxed) {
            self.phase = ExportPhase::Idle;
            return;
        }

        self.phase = ExportPhase::Copying;
        match copy(&path) {
            Ok(()) => self.phase = ExportPhase::Done,
            Err(error) => {
                self.phase = ExportPhase::Failed;
                self.error = Some(error);
            }
        }
    }
}

fn has_transparent_background(project: &cap_project::ProjectConfiguration) -> bool {
    matches!(
        project.background.source,
        BackgroundSource::Color { alpha, .. } if alpha < 255
    )
}

fn format_duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let secs = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

fn format_estimate_range(range: [f64; 2], time: bool) -> String {
    if range[1] < 1.0 {
        return if time { "< 1s" } else { "< 1 MB" }.into();
    }
    let (scale, unit) = if time {
        if range[1] >= 3600.0 {
            (3600.0, "hr")
        } else if range[1] >= 60.0 {
            (60.0, "min")
        } else {
            (1.0, "s")
        }
    } else if range[1] >= 1024.0 {
        (1024.0, "GB")
    } else {
        (1.0, "MB")
    };
    let precision = if scale == 1.0 { 1.0 } else { 10.0 };
    let lower = ((range[0] / scale * precision).round() / precision).max(1.0 / precision);
    let upper = ((range[1] / scale * precision).round() / precision).max(lower);
    if lower == upper {
        format!("~{lower} {unit}")
    } else {
        format!("~{lower}–{upper} {unit}")
    }
}

fn decode_jpeg_bytes(bytes: &[u8]) -> Option<Arc<RenderImage>> {
    let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
    let mut rgba = decoded.into_rgba8();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(rgba)
    ])))
}

impl EditorWindow {
    pub(crate) fn render_reupload_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .rounded(px(8.))
            .bg(Hsla::from(self.theme.blue_3))
            .border_1()
            .border_color(Hsla::from(self.theme.blue_5))
            .child(
                ui::EditorButton::plain(&self.theme, "editor-reupload")
                    .left_icon("icons/cloud-upload.svg")
                    .label("Reupload")
                    .tooltip(
                        &self.theme,
                        if has_transparent_background(&self.project) {
                            "Share links require a background without transparency"
                        } else {
                            "Upload your latest edit to the same link"
                        },
                    )
                    .disabled(!self.project_ready() || has_transparent_background(&self.project))
                    .on_click(cx.listener(|this, _, window, cx| {
                        if !this.project_ready() {
                            return;
                        }
                        this.open_export(window, cx);
                        if !has_transparent_background(&this.project)
                            && let Some(ui) = this.export.as_mut()
                        {
                            ui.destination = ExportDestination::Link;
                            ui.format = ExportFormatKind::Mp4;
                            ui.cursor_only = false;
                        }
                        this.normalize_loaded_export_fps();
                        this.refresh_export_preview(window, cx);
                        cx.notify();
                    })),
            )
    }

    pub(crate) fn open_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.playing {
            self.toggle_play_from_crop(cx);
        }
        let mut ui = ExportUi::load();
        if let Ok(meta) = RecordingMeta::load_for_project(&self.project_path) {
            self.sharing = meta.sharing;
        }
        if has_transparent_background(&self.project) {
            ui.format = ExportFormatKind::Gif;
            if ui.resolution == ExportResolution::P4k {
                ui.resolution = ExportResolution::P1080;
            }
            if ui.destination == ExportDestination::Link {
                ui.destination = ExportDestination::File;
            }
        }
        if ui.cursor_only && ui.destination == ExportDestination::Link {
            ui.destination = ExportDestination::File;
        }
        self.normalize_export_fps(&mut ui);
        self.export = Some(ui);
        self.refresh_export_preview(window, cx);
        cx.notify();
    }

    pub(crate) fn close_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ui) = self.export.as_mut() {
            if ui.phase.is_busy() {
                ui.close_requested = true;
                ui.cancel.store(true, Ordering::Relaxed);
                cx.notify();
                return;
            }
            ui.sign_in_cancel.store(true, Ordering::Relaxed);
            if let Some(image) = ui.preview.take() {
                let _ = window.drop_image(image);
            }
            ui.persist();
        }
        self.export = None;
        cx.notify();
    }

    fn finish_requested_export_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .export
            .as_ref()
            .is_some_and(|ui| ui.close_requested && !ui.phase.is_busy())
        {
            self.close_export(window, cx);
        }
    }

    fn copy_share_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(link) = self.export.as_ref().and_then(|ui| ui.share_link.clone()) else {
            return;
        };
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
        if let Some(ui) = self.export.as_mut() {
            ui.copy_link_pressed = true;
        }
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _ = this.update(cx, |this, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.copy_link_pressed = false;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn normalize_export_fps(&self, ui: &mut ExportUi) {
        let allowed = self.export_fps_options(ui);
        if !allowed.contains(&ui.fps) {
            ui.fps = if ui.format == ExportFormatKind::Gif {
                15
            } else {
                30
            };
        }
    }

    fn normalize_loaded_export_fps(&mut self) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let gif = ui.format == ExportFormatKind::Gif;
        let allowed = if gif && !ui.cursor_only {
            &[10, 15, 20, 25, 30][..]
        } else {
            &[15, 30, 60][..]
        };
        if !allowed.contains(&ui.fps) {
            ui.fps = if gif { 15 } else { 30 };
        }
    }

    fn export_fps_options(&self, ui: &ExportUi) -> &'static [u32] {
        if ui.format == ExportFormatKind::Gif && !ui.cursor_only {
            &[10, 15, 20, 25, 30]
        } else {
            &[15, 30, 60]
        }
    }

    fn export_resolutions(&self, ui: &ExportUi) -> Vec<ExportResolution> {
        let transparent = has_transparent_background(&self.project);
        if ui.format == ExportFormatKind::Gif || transparent || ui.cursor_only {
            vec![ExportResolution::P720, ExportResolution::P1080]
        } else {
            vec![
                ExportResolution::P720,
                ExportResolution::P1080,
                ExportResolution::P4k,
            ]
        }
    }

    fn refresh_export_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.project_path.clone();
        let time = self.preview_or_playhead();
        let instance = self.instance.clone();
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let project = self.project.clone();
        ui.estimate_cancel.store(true, Ordering::Release);
        ui.estimate_cancel = Arc::new(AtomicBool::new(false));
        ui.estimate = None;
        ui.estimate_loading = true;
        ui.preview_stats = None;
        let estimate_cancel = ui.estimate_cancel.clone();
        let estimate_settings = ui.estimate_settings();
        let estimate_instance = instance.clone();
        let estimate_project = project.clone();
        let (width, height) = ui.resolution.size();
        let settings = ExportPreviewSettings {
            fps: ui.fps,
            resolution_base: XY::new(width, height),
            compression_bpp: ui.bpp(),
            cursor_only: ui.cursor_only,
        };
        // Match Windows editor playback: a fresh Media Foundation preview seek can return black.
        let force = cfg!(target_os = "windows") || ui.force_ffmpeg;
        ui.preview_error = None;
        let request = Arc::new(());
        ui.preview_request = request.clone();
        ui.preview_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(120))
                .await;
            let started = std::time::Instant::now();
            let result = gpui_tokio::Tokio::spawn(cx, async move {
                match instance {
                    Some(instance) => {
                        render_preview_with_editor(&instance, project, time, settings).await
                    }
                    None => render_preview_with_config(path, project, time, settings, force).await,
                }
            })
            .await
            .ok();
            tracing::debug!(
                elapsed_ms = started.elapsed().as_millis() as u64,
                "export preview rendered"
            );
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return;
                };
                let updated = ui.update_preview(&request, |ui| match result {
                    Some(Ok(preview)) => {
                        let bytes = base64::Engine::decode(
                            &base64::engine::general_purpose::STANDARD,
                            preview.jpeg_base64.as_bytes(),
                        )
                        .ok();
                        if let Some(image) = bytes.as_deref().and_then(decode_jpeg_bytes)
                            && let Some(old) = ui.preview.replace(image)
                        {
                            let _ = window.drop_image(old);
                        }
                        ui.preview_stats = Some(PreviewStats {
                            width: preview.actual_width,
                            height: preview.actual_height,
                            total_frames: preview.total_frames,
                            estimated_size_mb: preview.estimated_size_mb,
                        });
                        ui.preview_error = None;
                    }
                    Some(Err(error)) => {
                        ui.preview_error = Some(error.to_string());
                    }
                    None => {
                        ui.preview_error = Some("Preview unavailable".into());
                    }
                });
                if !updated {
                    return;
                }
                cx.notify();
                window.refresh();
            });
            let result = if let Some(instance) = estimate_instance {
                let (estimate_tx, estimate_rx) = flume::unbounded();
                let estimate_task = gpui_tokio::Tokio::spawn(cx, async move {
                    estimate_export(
                        instance,
                        estimate_project,
                        estimate_settings,
                        estimate_cancel,
                        move |estimate| {
                            let _ = estimate_tx.send(estimate);
                        },
                    )
                    .await
                });
                while let Ok(estimate) = estimate_rx.recv_async().await {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut()
                            && !ui.estimate_cancel.load(Ordering::Acquire)
                            && ui.update_preview(&request, |ui| ui.estimate = Some(estimate))
                        {
                            cx.notify();
                        }
                    });
                }
                estimate_task.await.ok().and_then(Result::ok)
            } else {
                None
            };
            let _ = this.update(cx, |this, cx| {
                if let Some(ui) = this.export.as_mut()
                    && ui.update_preview(&request, |ui| {
                        if let Some(estimate) = result {
                            ui.estimate = Some(estimate);
                        }
                        ui.estimate_loading = false;
                    })
                {
                    cx.notify();
                }
            });
        }));
    }

    pub(crate) fn start_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pretty_name = self
            .summary()
            .map(|summary| summary.pretty_name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Cap Recording".into());
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        ui.estimate_cancel.store(true, Ordering::Release);
        if ui.phase.is_busy() || ui.close_requested {
            return;
        }
        if ui.destination == ExportDestination::Link {
            if ui.sign_in_pending {
                ui.sign_in_cancel.store(true, Ordering::Relaxed);
                ui.sign_in_pending = false;
                cx.notify();
                return;
            }
            if !store::auth_snapshot().signed_in() {
                self.start_share_sign_in(window, cx);
                return;
            }
            self.start_link_export(window, cx);
            return;
        }

        let estimate = ui
            .estimate
            .as_ref()
            .map(|estimate| estimate.size_range_mb[1])
            .or_else(|| {
                ui.preview_stats
                    .as_ref()
                    .map(|stats| stats.estimated_size_mb)
            })
            .map(estimated_working_bytes)
            .unwrap_or(0);
        let destination = ui.destination;
        let format = ui.format;
        let cursor_only = ui.cursor_only;
        let fps = ui.fps;
        let (width, height) = ui.resolution.size();
        let compression = ui.compression;
        let custom_bpp = ui.custom_bpp;
        let optimize = ui.optimize_filesize;
        let force = ui.force_ffmpeg;
        let project_path = self.project_path.clone();
        let project = self.project.clone();
        ui.cancel = Arc::new(AtomicBool::new(false));
        let cancel = ui.cancel.clone();
        ui.phase = if destination == ExportDestination::File {
            ExportPhase::ChoosingFile
        } else {
            ExportPhase::Starting
        };
        ui.error = None;
        ui.rendered = 0;
        ui.total_frames = 0;
        ui.output_path = None;
        cx.notify();

        ui.export_task = Some(cx.spawn_in(window, async move |this, cx| {
            let save_path = if destination == ExportDestination::File {
                let ext = if cursor_only {
                    "mov"
                } else if format == ExportFormatKind::Gif {
                    "gif"
                } else {
                    "mp4"
                };
                let default = format!("{pretty_name}.{ext}");
                let chosen: Result<Option<PathBuf>, String> = match std::env::var_os("CAP_GPUI_AUTO_EXPORT") {
                    Some(path) => Ok(Some(PathBuf::from(path))),
                    None => {
                        #[cfg(target_os = "macos")]
                        {
                            platform::try_save_file_panel(&default, &[ext])
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            Ok(platform::save_file_panel_async(&default, &[ext], cx).await)
                        }
                    }
                };
                if matches!(chosen, Ok(None)) {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut()
                            && Arc::ptr_eq(&ui.cancel, &cancel)
                        {
                            ui.phase = ExportPhase::Idle;
                        }
                        cx.notify();
                    });
                    let _ = this.update_in(cx, |this, window, cx| {
                        this.finish_requested_export_close(window, cx)
                    });
                    return;
                }
                match chosen {
                    Ok(path) => path,
                    Err(error) => {
                        tracing::warn!(error, "Save dialog unavailable; keeping the export in its project output folder");
                        None
                    }
                }
            } else {
                None
            };

            let output = save_path.clone().unwrap_or_else(|| project_path.join("output"));
            let resources = ExportResources::new(vec![DiskBudget {
                path: output,
                description: "your export drive",
                estimated_bytes: estimate,
            }]);
            if !confirm_export_resources(&this, cx, &resources, &cancel).await {
                let _ = this.update_in(cx, |this, window, cx| this.finish_requested_export_close(window, cx));
                return;
            }

            let started = this.update_in(cx, |this, _, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return false;
                };
                if !Arc::ptr_eq(&ui.cancel, &cancel) {
                    return false;
                }
                if cancel.load(Ordering::Relaxed) {
                    ui.phase = ExportPhase::Idle;
                    cx.notify();
                    return false;
                }
                ui.phase = ExportPhase::Starting;
                cx.notify();
                true
            });
            if !started.unwrap_or(false) {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }

            let notify_file_save = save_path.is_some();
            let (progress_tx, progress_rx) = flume::unbounded::<(u32, u32)>();
            let export_cancel = cancel.clone();
            let export = gpui_tokio::Tokio::spawn(cx, async move {
                let stopped = export_cancel.clone();
                resources.supervise(run_export(
                    project_path,
                    project,
                    format,
                    cursor_only,
                    fps,
                    width,
                    height,
                    compression,
                    custom_bpp,
                    optimize,
                    force,
                    save_path.clone(),
                    progress_tx,
                    export_cancel,
                ), || stopped.store(true, Ordering::Release)).await
            });

            loop {
                while let Ok((rendered, total)) = progress_rx.try_recv() {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.rendered = rendered;
                            ui.total_frames = total;
                            ui.phase = ExportPhase::Rendering;
                        }
                        cx.notify();
                    });
                }
                if progress_rx.is_disconnected() {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }

            match export.await {
                Ok(Ok(path)) => {
                    tracing::info!(path = %path.display(), "editor export completed");
                    if destination == ExportDestination::Clipboard {
                        let _ = this.update(cx, |this, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                ui.copy_completed_export(path, |path| {
                                    let result = platform::copy_file_to_clipboard(path, cx);
                                    crate::app_sounds::play_notification();
                                    result
                                });
                            }
                            cx.notify();
                        });
                    } else {
                        if notify_file_save {
                            crate::app_sounds::play_notification();
                        }
                        let _ = this.update(cx, |this, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                ui.phase = ExportPhase::Done;
                                ui.output_path = Some(path);
                            }
                            cx.notify();
                        });
                    }
                }
                Ok(Err(error)) => {
                    tracing::error!(error, "editor export failed");
                    let cancelled = !is_resource_stop(&error) && (error == "Export cancelled" || cancel.load(Ordering::Relaxed));
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            if cancelled {
                                ui.phase = ExportPhase::Idle;
                            } else {
                                ui.phase = ExportPhase::Failed;
                                ui.error = Some(error);
                            }
                        }
                        cx.notify();
                    });
                }
                Err(_) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.phase = ExportPhase::Failed;
                            ui.error = Some("Export task failed".into());
                        }
                        cx.notify();
                    });
                }
            }
            let _ = this.update_in(cx, |this, window, cx| {
                this.finish_requested_export_close(window, cx)
            });
        }));
    }

    fn retry_clipboard_copy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let Some(path) = ui.clipboard_retry_path().map(Path::to_path_buf) else {
            return;
        };
        ui.cancel = Arc::new(AtomicBool::new(false));
        ui.copy_completed_export(path, |path| {
            let result = platform::copy_file_to_clipboard(path, cx);
            crate::app_sounds::play_notification();
            result
        });
        cx.notify();
        self.finish_requested_export_close(window, cx);
    }

    fn start_share_sign_in(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        ui.sign_in_cancel.store(false, Ordering::Relaxed);
        let cancel = ui.sign_in_cancel.clone();
        ui.sign_in_pending = true;
        cx.notify();

        let session = match crate::auth::begin_sign_in(cancel.clone()) {
            Ok(session) => session,
            Err(error) => {
                ui.sign_in_pending = false;
                ui.error = Some(error);
                cx.notify();
                return;
            }
        };
        cx.open_url(&session.url);

        ui.export_task = Some(cx.spawn_in(window, async move |this, cx| {
            let signed_in = cx
                .background_executor()
                .spawn(async move { session.complete() })
                .await;
            match signed_in {
                Ok(true) => {
                    if let Ok(Err(error)) =
                        gpui_tokio::Tokio::spawn(cx, crate::auth::update_auth_plan()).await
                    {
                        tracing::warn!("updating auth plan after sign-in: {error}");
                    }
                    platform::activate_app();
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.sign_in_pending = false;
                            ui.error = None;
                            if ui.organization_id.is_none() {
                                ui.organization_id = store::auth_snapshot()
                                    .organizations
                                    .first()
                                    .map(|org| org.id.clone());
                            }
                            ui.persist();
                        }
                        cx.notify();
                    });
                }
                Ok(false) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.sign_in_pending = false;
                        }
                        cx.notify();
                    });
                }
                Err(error) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.sign_in_pending = false;
                            ui.error = Some(error.clone());
                        }
                        cx.notify();
                    });
                    if !cancel.load(Ordering::Relaxed) {
                        platform::alert_dialog("Sign in failed", &error);
                    }
                }
            }
        }));
    }

    fn start_link_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let duration = self.total_duration();
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        if ui.phase.is_busy() || ui.close_requested {
            return;
        }

        let upgraded = store::auth_snapshot().is_upgraded();
        if !upgraded && duration >= 300.0 {
            cx.open_url(crate::auth::PRICING_URL);
            return;
        }

        let estimate = ui
            .estimate
            .as_ref()
            .map(|estimate| estimate.size_range_mb[1])
            .or_else(|| {
                ui.preview_stats
                    .as_ref()
                    .map(|stats| stats.estimated_size_mb)
            })
            .map(estimated_working_bytes)
            .unwrap_or(0);
        let format = ui.format;
        let cursor_only = ui.cursor_only;
        let fps = ui.fps;
        let (width, height) = ui.resolution.size();
        let compression = ui.compression;
        let custom_bpp = ui.custom_bpp;
        let optimize = ui.optimize_filesize;
        let force = ui.force_ffmpeg;
        let project_path = self.project_path.clone();
        let project = self.project.clone();
        let organization_id = ui.organization_id.clone().or_else(|| {
            store::auth_snapshot()
                .organizations
                .first()
                .map(|org| org.id.clone())
        });
        ui.cancel = Arc::new(AtomicBool::new(false));
        let cancel = ui.cancel.clone();
        ui.phase = ExportPhase::Starting;
        ui.reuploading = self.sharing.is_some();
        ui.error = None;
        ui.share_link = None;
        ui.upload_progress = 0.0;
        ui.rendered = 0;
        ui.total_frames = 0;
        cx.notify();

        ui.export_task = Some(cx.spawn_in(window, async move |this, cx| {
            let save_path = RecordingMeta::load_for_project(&project_path)
                .ok()
                .map(|meta| meta.output_path());
            if let Some(path) = save_path.as_ref()
                && let Some(parent) = path.parent()
            {
                let _ = std::fs::create_dir_all(parent);
            }

            let resources = ExportResources::new(vec![DiskBudget {
                path: save_path
                    .clone()
                    .unwrap_or_else(|| project_path.join("output")),
                description: "your recording drive",
                estimated_bytes: estimate,
            }]);
            if !confirm_export_resources(&this, cx, &resources, &cancel).await {
                let _ = this.update_in(cx, |this, window, cx| {
                    this.finish_requested_export_close(window, cx)
                });
                return;
            }

            let _ = this.update(cx, |this, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.phase = ExportPhase::Rendering;
                }
                cx.notify();
            });

            let (progress_tx, progress_rx) = flume::unbounded::<(u32, u32)>();
            let export_cancel = cancel.clone();
            let export_path = project_path.clone();
            let export = gpui_tokio::Tokio::spawn(cx, async move {
                let stopped = export_cancel.clone();
                resources
                    .supervise(
                        run_export(
                            export_path,
                            project,
                            format,
                            cursor_only,
                            fps,
                            width,
                            height,
                            compression,
                            custom_bpp,
                            optimize,
                            force,
                            save_path.clone(),
                            progress_tx,
                            export_cancel,
                        ),
                        || stopped.store(true, Ordering::Release),
                    )
                    .await
            });

            loop {
                while let Ok((rendered, total)) = progress_rx.try_recv() {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.rendered = rendered;
                            ui.total_frames = total;
                            ui.phase = ExportPhase::Rendering;
                        }
                        cx.notify();
                    });
                }
                if progress_rx.is_disconnected() {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
            }

            match export.await {
                Ok(Ok(path)) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.phase = ExportPhase::Uploading;
                            ui.output_path = Some(path);
                            ui.upload_progress = 0.0;
                        }
                        cx.notify();
                    });

                    let (upload_tx, upload_rx) = flume::unbounded::<f64>();
                    let upload_cancel = cancel.clone();
                    let upload_project = project_path.clone();
                    let upload = gpui_tokio::Tokio::spawn(cx, async move {
                        crate::upload::upload_exported_video(
                            upload_project,
                            organization_id,
                            |progress| {
                                let _ = upload_tx.send(progress);
                            },
                            upload_cancel,
                        )
                        .await
                    });

                    loop {
                        while let Ok(progress) = upload_rx.try_recv() {
                            let _ = this.update(cx, |this, cx| {
                                if let Some(ui) = this.export.as_mut() {
                                    ui.upload_progress = progress as f32;
                                    ui.phase = ExportPhase::Uploading;
                                }
                                cx.notify();
                            });
                        }
                        if upload_rx.is_disconnected() {
                            break;
                        }
                        cx.background_executor()
                            .timer(Duration::from_millis(50))
                            .await;
                    }

                    match upload.await {
                        Ok(Ok(crate::upload::UploadResult::Success(link))) => {
                            let _ = this.update(cx, |this, cx| {
                                if let Ok(meta) =
                                    RecordingMeta::load_for_project(&this.project_path)
                                {
                                    this.sharing = meta.sharing;
                                }
                                if let Some(ui) = this.export.as_mut() {
                                    ui.phase = ExportPhase::Done;
                                    ui.share_link = Some(link.clone());
                                    ui.upload_progress = 1.0;
                                }
                                cx.notify();
                            });
                            let _ = this.update(cx, |_, cx| {
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
                                crate::app_sounds::play_notification();
                            });
                        }
                        Ok(Ok(crate::upload::UploadResult::NotAuthenticated)) => {
                            show_upload_failure(
                                &this,
                                cx,
                                "You need to sign in to share recordings",
                                true,
                            );
                        }
                        Ok(Ok(crate::upload::UploadResult::UpgradeRequired)) => {
                            let _ = this.update(cx, |this, cx| {
                                if let Some(ui) = this.export.as_mut() {
                                    ui.phase = ExportPhase::Idle;
                                }
                                cx.notify();
                            });
                            let _ = this.update(cx, |_, cx| {
                                cx.open_url(crate::auth::PRICING_URL);
                            });
                            platform::alert_dialog(
                                "Upgrade required",
                                "This feature requires an upgraded plan",
                            );
                        }
                        Ok(Err(error)) => {
                            if error == "Export cancelled" || cancel.load(Ordering::Relaxed) {
                                let _ = this.update(cx, |this, cx| {
                                    if let Some(ui) = this.export.as_mut() {
                                        ui.phase = ExportPhase::Idle;
                                    }
                                    cx.notify();
                                });
                            } else {
                                show_upload_failure(&this, cx, &error, true);
                            }
                        }
                        Err(_) => {
                            show_upload_failure(&this, cx, "Failed to upload recording", true);
                        }
                    }
                }
                Ok(Err(error)) => {
                    let cancelled = !is_resource_stop(&error)
                        && (error == "Export cancelled" || cancel.load(Ordering::Relaxed));
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            if cancelled {
                                ui.phase = ExportPhase::Idle;
                            } else {
                                ui.phase = ExportPhase::Failed;
                                ui.error = Some(error.clone());
                            }
                        }
                        cx.notify();
                    });
                    if !cancelled {
                        platform::alert_dialog("Export failed", &error);
                    }
                }
                Err(_) => {
                    show_upload_failure(&this, cx, "Export task failed", false);
                }
            }
            let _ = this.update_in(cx, |this, window, cx| {
                this.finish_requested_export_close(window, cx)
            });
        }));
    }

    pub(crate) fn render_export_page(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let Some(ui) = self.export.as_ref() else {
            return div().into_any_element();
        };

        let header = div()
            .relative()
            .h(px(HEADER_HEIGHT))
            .flex_none()
            .flex()
            .flex_row()
            .items_center()
            .pl(px(if cfg!(target_os = "macos") { 92. } else { 12. }))
            .pr(px(12.))
            .border_b_1()
            .border_color(Hsla::from(editor.line))
            .when(cfg!(target_os = "windows"), |header| {
                header.window_control_area(gpui::WindowControlArea::Drag)
            })
            .when(!cfg!(target_os = "windows"), |header| {
                header.on_mouse_down(gpui::MouseButton::Left, |event, window, _| {
                    if event.click_count == 2 {
                        window.titlebar_double_click();
                    } else {
                        window.start_window_move();
                    }
                })
            })
            .child(
                div().flex_1().flex().flex_row().items_center().child(
                    div()
                        .id("export-back")
                        .when(cfg!(target_os = "windows"), |button| button.occlude())
                        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .h(px(28.))
                        .pl(px(8.))
                        .pr(px(10.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(editor.text_2))
                        .hover(move |style| {
                            style
                                .bg(Hsla::from(editor.ctl))
                                .text_color(Hsla::from(editor.text_1))
                        })
                        .child(
                            svg()
                                .path("icons/move-left.svg")
                                .size(px(14.))
                                .text_color(Hsla::from(editor.text_2)),
                        )
                        .child("Back to editor")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.close_export(window, cx);
                        })),
                ),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(editor.text_1))
                    .child("Export"),
            )
            .child(div().flex_1());
        #[cfg(target_os = "windows")]
        let header = header.child(div().absolute().right_0().top_0().h_full().child(
            ui::windows_caption_controls(
                theme,
                window.is_window_active(),
                window.is_maximized(),
                true,
                true,
            ),
        ));

        let viewport = window.viewport_size();
        let preview_box = preview_fit(
            f32::from(viewport.width) - SIDEBAR_WIDTH - STAGE_PADDING_X * 2.,
            f32::from(viewport.height) - HEADER_HEIGHT - STAGE_VERTICAL_CHROME,
            ui.preview.as_ref().map(|image| {
                let size = image.size(0);
                (size.width.0 as f32, size.height.0 as f32)
            }),
        );

        div()
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .child(header)
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_export_preview_pane(ui, preview_box))
                    .child(self.render_export_sidebar(ui, cx))
                    .when(ui.phase.shows_progress(), |this| {
                        this.child(self.render_export_overlay(ui, cx))
                    })
                    .when(ui.phase == ExportPhase::ChoosingFile, |this| {
                        this.child(div().absolute().inset_0().occlude())
                    }),
            )
            .when(ui.bpp_dragging, |this| {
                this.child(ui::Slider::drag_layer(
                    "export-bpp-drag",
                    cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                        this.export_bpp_drag_to(event.position.x, cx);
                    }),
                    cx.listener(|this, _: &MouseUpEvent, window, cx| {
                        this.export_bpp_mouse_up(window, cx);
                    }),
                ))
            })
            .into_any_element()
    }

    fn render_export_preview_pane(
        &self,
        ui: &ExportUi,
        preview_box: (f32, f32),
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let stats = ui.preview_stats.as_ref();
        let duration = stats
            .map(|stats| {
                if ui.fps == 0 {
                    0.0
                } else {
                    stats.total_frames as f64 / ui.fps as f64
                }
            })
            .unwrap_or(0.0);
        let (box_w, box_h) = preview_box;

        let preview = match ui.preview.clone() {
            Some(image) => {
                use gpui::StyledImage as _;
                div()
                    .w(px(box_w))
                    .h(px(box_h))
                    .rounded(px(10.))
                    .overflow_hidden()
                    .shadow(crate::theme::preview_shadow())
                    .child(img(image).object_fit(gpui::ObjectFit::Contain).size_full())
                    .into_any_element()
            }
            None => div()
                .w(px(box_w))
                .h(px(box_h))
                .rounded(px(10.))
                .bg(Hsla::from(editor.ctl))
                .flex()
                .items_center()
                .justify_center()
                .px(px(24.))
                .text_size(px(12.))
                .text_color(Hsla::from(editor.text_2))
                .text_center()
                .child(
                    ui.preview_error
                        .clone()
                        .unwrap_or_else(|| "Generating preview…".into()),
                )
                .into_any_element(),
        };

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .bg(Hsla::from(editor.stage))
            .pt(px(16.))
            .px(px(STAGE_PADDING_X))
            .pb(px(20.))
            .child(
                div()
                    .h(px(22.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(editor.text_2))
                            .child("Preview"),
                    )
                    .child(
                        div()
                            .id("export-preview-info")
                            .flex()
                            .items_center()
                            .tooltip(move |_window, cx| {
                                crate::ui::Tooltip::new(
                                    &theme,
                                    "This is a rendered frame from your video. Adjust the \
                                     settings to see the quality of the final export.",
                                )
                                .view(cx)
                            })
                            .child(
                                svg()
                                    .path("icons/info.svg")
                                    .size(px(13.))
                                    .text_color(Hsla::from(editor.text_3)),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .items_center()
                    .justify_center()
                    .pt(px(14.))
                    .pb(px(18.))
                    .child(preview),
            )
            .child(
                div().flex().flex_row().justify_center().child(
                    div()
                        .h(px(STATS_HEIGHT))
                        .min_w(px(520.))
                        .flex()
                        .flex_row()
                        .rounded(px(10.))
                        .bg(Hsla::from(editor.card))
                        .shadow(editor.card_shadow())
                        .child(export_stat(
                            &theme,
                            "Duration",
                            stats.map(|_| format_duration(duration)),
                            false,
                        ))
                        .child(export_stat(
                            &theme,
                            "Output",
                            stats.map(|stats| {
                                format!("{}×{} · {} fps", stats.width, stats.height, ui.fps)
                            }),
                            true,
                        ))
                        .child(export_stat(
                            &theme,
                            if ui.estimate_loading && ui.estimate.is_some() {
                                "Refining size…"
                            } else {
                                "Estimated size"
                            },
                            Some(
                                ui.estimate
                                    .as_ref()
                                    .map(|estimate| {
                                        format_estimate_range(estimate.size_range_mb, false)
                                    })
                                    .unwrap_or_else(|| {
                                        if ui.estimate_loading {
                                            "Calculating…".into()
                                        } else {
                                            "Unavailable".into()
                                        }
                                    }),
                            ),
                            true,
                        ))
                        .child(export_stat(
                            &theme,
                            if ui.estimate_loading && ui.estimate.is_some() {
                                "Refining time…"
                            } else {
                                "Export time"
                            },
                            Some(
                                ui.estimate
                                    .as_ref()
                                    .map(|estimate| {
                                        format_estimate_range(estimate.time_range_seconds, true)
                                    })
                                    .unwrap_or_else(|| {
                                        if ui.estimate_loading {
                                            "Calculating…".into()
                                        } else {
                                            "Unavailable".into()
                                        }
                                    }),
                            ),
                            true,
                        )),
                ),
            )
    }

    fn render_export_sidebar(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let transparent = has_transparent_background(&self.project);
        let link_disabled = transparent || ui.cursor_only;
        let format_locked = transparent || ui.cursor_only;
        let resolutions = self.export_resolutions(ui);
        let fps_options = self.export_fps_options(ui);

        div()
            .w(px(SIDEBAR_WIDTH))
            .flex_shrink_0()
            .h_full()
            .flex()
            .flex_col()
            .bg(Hsla::from(editor.card))
            .border_l_1()
            .border_color(Hsla::from(editor.line))
            .child(
                div()
                    .id("export-settings")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(16.))
                    .gap(px(20.))
                    .child(self.export_destination_field(ui, link_disabled, cx))
                    .child(self.export_format_field(ui, format_locked, cx))
                    .child(self.export_resolution_field(ui, &resolutions, cx))
                    .child(self.export_fps_field(ui, fps_options, cx))
                    .when(
                        ui.format == ExportFormatKind::Mp4 && !ui.cursor_only,
                        |this| this.child(self.export_quality_field(ui, cx)),
                    )
                    .child(div().h(px(1.)).flex_none().bg(Hsla::from(editor.line)))
                    .child(self.export_advanced(ui, cx)),
            )
            .child(
                div()
                    .px(px(16.))
                    .pt(px(12.))
                    .pb(px(16.))
                    .border_t_1()
                    .border_color(Hsla::from(editor.line))
                    .child(self.export_cta(ui, cx)),
            )
    }

    fn export_cta(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let signed_in = store::auth_snapshot().signed_in();
        let (label, icon, primary) = match ui.destination {
            ExportDestination::File => ("Export to File", Some("icons/folder.svg"), true),
            ExportDestination::Clipboard => ("Export to Clipboard", Some("icons/copy.svg"), true),
            ExportDestination::Link if ui.sign_in_pending => ("Cancel Sign In", None, false),
            ExportDestination::Link if !signed_in => {
                ("Sign in to share", Some("icons/link.svg"), true)
            }
            ExportDestination::Link => (
                if self.sharing.is_some() {
                    "Reupload to same link"
                } else {
                    "Create shareable link"
                },
                Some("icons/link.svg"),
                true,
            ),
        };
        let busy = ui.phase.is_busy();
        let (bg, hover_bg, text) = if primary {
            (
                Hsla::from(editor.accent),
                Hsla::from(editor.accent_2),
                gpui::white(),
            )
        } else {
            (
                Hsla::from(editor.ctl),
                Hsla::from(editor.ctl_hover),
                Hsla::from(editor.text_1),
            )
        };

        div()
            .id("export-cta")
            .tab_index(0)
            .w_full()
            .h(px(40.))
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .rounded(px(10.))
            .bg(bg)
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(text)
            .when(primary, |this| {
                this.shadow(vec![gpui::BoxShadow {
                    color: gpui::hsla(0., 0., 1., 0.18),
                    offset: gpui::point(px(0.), px(1.)),
                    blur_radius: px(0.),
                    spread_radius: px(0.),
                    inset: true,
                }])
            })
            .when(busy, |this| this.opacity(0.5))
            .when(!busy, |this| {
                this.cursor_pointer()
                    .hover(move |style| style.bg(hover_bg))
                    .on_click(cx.listener(|this, _, window, cx| this.start_export(window, cx)))
            })
            .children(icon.map(|icon| svg().path(icon).size(px(16.)).text_color(text)))
            .child(label)
    }

    fn export_section(&self, name: &'static str, icon: &'static str) -> ui::Field {
        ui::Field::section(&self.theme, name)
            .icon(icon)
            .icon_size(px(14.))
            .gap(px(8.))
    }

    fn export_destination_field(
        &self,
        ui: &ExportUi,
        link_disabled: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        self.export_section("Destination", "icons/upload-arrow.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-destination",
                    ExportDestination::ALL
                        .iter()
                        .map(|dest| {
                            let label = if *dest == ExportDestination::Link
                                && self.sharing.is_some()
                            {
                                "Reupload"
                            } else {
                                dest.label()
                            };
                            let mut option =
                                ui::SegmentOption::new(label, ui.destination == *dest)
                                    .disabled(*dest == ExportDestination::Link && link_disabled);
                            option.icon = Some(dest.icon().into());
                            option
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(30.))
                .on_select(cx.listener(|this, index: &usize, window, cx| {
                    let Some(dest) = ui::option_at(ExportDestination::ALL, *index) else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        if dest == ExportDestination::Link
                            && (has_transparent_background(&this.project) || ui.cursor_only)
                        {
                            return;
                        }
                        ui.destination = dest;
                        if dest == ExportDestination::Link && ui.format == ExportFormatKind::Gif {
                            ui.format = ExportFormatKind::Mp4;
                        }
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
            .when(link_disabled, |field| {
                field.child(
                    div()
                        .text_size(px(11.))
                        .text_color(Hsla::from(editor.text_3))
                        .child(if ui.cursor_only {
                            "Cursor-only exports can only be saved to a file or clipboard."
                        } else {
                            "Transparent exports can only be saved to a file or clipboard."
                        }),
                )
            })
            .when(
                ui.destination == ExportDestination::Link && self.sharing.is_some(),
                |field| {
                    let link = self.sharing.as_ref()
                        .map(|sharing| sharing.link.clone())
                        .unwrap_or_default();
                    field.child(
                        div()
                            .p(px(12.))
                            .rounded(px(10.))
                            .bg(Hsla::from(editor.card_2))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .text_size(px(12.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(Hsla::from(editor.text_1))
                                    .child("Update your existing link"),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .line_height(px(15.))
                                    .text_color(Hsla::from(editor.text_3))
                                    .child("Reupload replaces the video at this link with your latest edit. Everyone with the link will see the updated version."),
                            )
                            .child(
                                div()
                                    .id("reupload-existing-link")
                                    .text_size(px(11.5))
                                    .text_color(Hsla::from(editor.accent))
                                    .truncate()
                                    .cursor_pointer()
                                    .child(link.clone())
                                    .on_click(move |_, _, cx| cx.open_url(&link)),
                            ),
                    )
                },
            )
            .when(
                ui.destination == ExportDestination::Link
                    && self.sharing.is_none()
                    && store::auth_snapshot().organizations.len() > 1,
                |this| {
                    let orgs = store::auth_snapshot().organizations;
                    let selected = ui
                        .organization_id
                        .clone()
                        .or_else(|| orgs.first().map(|org| org.id.clone()));
                    let label = orgs
                        .iter()
                        .find(|org| Some(org.id.as_str()) == selected.as_deref())
                        .or(orgs.first())
                        .map(|org| org.name.clone())
                        .unwrap_or_else(|| "Organization".into());
                    this.child(
                        div()
                            .id("export-organization")
                            .flex()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .h(px(30.))
                            .px(px(10.))
                            .rounded(px(7.))
                            .bg(Hsla::from(editor.ctl))
                            .cursor_pointer()
                            .hover(move |style| style.bg(Hsla::from(editor.ctl_hover)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let orgs = store::auth_snapshot().organizations;
                                if orgs.is_empty() {
                                    return;
                                }
                                if let Some(ui) = this.export.as_mut() {
                                    let current = ui
                                        .organization_id
                                        .as_deref()
                                        .or(orgs.first().map(|org| org.id.as_str()));
                                    let index = orgs
                                        .iter()
                                        .position(|org| Some(org.id.as_str()) == current)
                                        .unwrap_or(0);
                                    let next = orgs[(index + 1) % orgs.len()].id.clone();
                                    ui.organization_id = Some(next);
                                    ui.persist();
                                }
                                cx.notify();
                            }))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(editor.text_2))
                                    .child("Organization"),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(4.))
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(editor.text_1))
                                    .child(label)
                                    .child(
                                        svg()
                                            .path("icons/caret-down.svg")
                                            .size(px(14.))
                                            .text_color(Hsla::from(editor.text_3)),
                                    ),
                            ),
                    )
                },
            )
    }

    fn export_format_field(
        &self,
        ui: &ExportUi,
        locked: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let options = [ExportFormatKind::Mp4, ExportFormatKind::Gif];
        self.export_section("Format", "icons/video.svg")
            .disabled(locked)
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-format",
                    options
                        .iter()
                        .map(|format| {
                            ui::SegmentOption::new(format.label(), ui.format == *format)
                                .disabled(locked)
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    if locked {
                        return;
                    }
                    let Some(format) = options.get(*index).copied() else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        ui.format = format;
                        if format == ExportFormatKind::Gif {
                            if ui.destination == ExportDestination::Link {
                                ui.destination = ExportDestination::File;
                            }
                            if ui.resolution == ExportResolution::P4k {
                                ui.resolution = ExportResolution::P1080;
                            }
                        }
                    }
                    this.normalize_loaded_export_fps();
                    if let Some(ui) = this.export.as_mut() {
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
    }

    fn export_resolution_field(
        &self,
        ui: &ExportUi,
        resolutions: &[ExportResolution],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let resolutions = resolutions.to_vec();
        self.export_section("Resolution", "icons/monitor-outline.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-resolution",
                    resolutions
                        .iter()
                        .map(|res| ui::SegmentOption::new(res.label(), ui.resolution == *res))
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    let Some(resolution) = resolutions.get(*index).copied() else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        ui.resolution = resolution;
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
    }

    fn export_fps_field(
        &self,
        ui: &ExportUi,
        options: &[u32],
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let options = options.to_vec();
        self.export_section("Frame rate", "icons/gauge.svg").child(
            ui::SegmentedControl::editor(
                &theme,
                "export-fps",
                options
                    .iter()
                    .map(|fps| ui::SegmentOption::new(format!("{fps} FPS"), ui.fps == *fps))
                    .collect(),
            )
            .stretch()
            .item_height(px(SEGMENT_HEIGHT))
            .on_select(cx.listener(move |this, index: &usize, window, cx| {
                let Some(fps) = options.get(*index).copied() else {
                    return;
                };
                if let Some(ui) = this.export.as_mut() {
                    ui.fps = fps;
                    ui.persist();
                }
                this.refresh_export_preview(window, cx);
                cx.notify();
            })),
        )
    }

    fn export_quality_field(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        self.export_section("Quality", "icons/gem.svg")
            .child(
                ui::SegmentedControl::editor(
                    &theme,
                    "export-quality",
                    COMPRESSION_PRESETS
                        .iter()
                        .map(|(value, label)| {
                            ui::SegmentOption::new(
                                *label,
                                !ui.is_custom_bpp() && matches_compression(ui.compression, *value),
                            )
                        })
                        .collect(),
                )
                .stretch()
                .item_height(px(SEGMENT_HEIGHT))
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    let Some((compression, _)) = COMPRESSION_PRESETS.get(*index).copied() else {
                        return;
                    };
                    if let Some(ui) = this.export.as_mut() {
                        ui.compression = compression;
                        ui.custom_bpp = None;
                        ui.persist();
                    }
                    this.refresh_export_preview(window, cx);
                    cx.notify();
                })),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .px(px(2.))
                    .text_size(px(10.5))
                    .text_color(Hsla::from(editor.text_3))
                    .child("Smaller file")
                    .child("Larger file"),
            )
            .child(self.export_optimize_row(ui, cx))
    }

    fn export_toggle_row(
        &self,
        id: &'static str,
        title: &'static str,
        description: &'static str,
        checked: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> impl IntoElement {
        let editor = self.theme.editor;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .min_h(px(34.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(editor.text_1))
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .line_height(px(14.))
                            .text_color(Hsla::from(editor.text_3))
                            .child(description),
                    ),
            )
            .child(ui::Toggle::plain(&self.theme, id, checked).on_click(on_click))
    }

    fn export_optimize_row(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        self.export_toggle_row(
            "export-optimize",
            "Optimize file size",
            "Re-encodes with software for much smaller files (slower)",
            ui.optimize_filesize,
            cx.listener(|this, _, window, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.optimize_filesize = !ui.optimize_filesize;
                    ui.persist();
                }
                this.refresh_export_preview(window, cx);
                cx.notify();
            }),
        )
    }

    fn export_advanced(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let show_bpp = ui.format == ExportFormatKind::Mp4 && !ui.cursor_only;
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .id("export-advanced-toggle")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .h(px(30.))
                    .mx(px(-6.))
                    .px(px(6.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(editor.text_2))
                    .hover(move |style| {
                        style
                            .bg(Hsla::from(editor.ctl))
                            .text_color(Hsla::from(editor.text_1))
                    })
                    .on_click(cx.listener(|this, _, _window, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.advanced_open = !ui.advanced_open;
                            ui.persist();
                        }
                        cx.notify();
                    }))
                    .child(
                        svg()
                            .path("icons/sliders-horizontal.svg")
                            .size(px(14.))
                            .text_color(Hsla::from(editor.text_2)),
                    )
                    .child("Advanced")
                    .child(
                        svg()
                            .path(if ui.advanced_open {
                                "icons/chevron-up.svg"
                            } else {
                                "icons/chevron-down.svg"
                            })
                            .size(px(14.))
                            .ml_auto()
                            .text_color(Hsla::from(editor.text_3)),
                    ),
            )
            .when(ui.advanced_open, |this| {
                this.child(self.export_toggle_row(
                    "export-cursor-only",
                    "Export cursor only",
                    "Keeps the same cursor motion and clicks on a transparent background",
                    ui.cursor_only,
                    cx.listener(|this, _, window, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.cursor_only = !ui.cursor_only;
                            if ui.cursor_only && ui.destination == ExportDestination::Link {
                                ui.destination = ExportDestination::File;
                            }
                            ui.persist();
                        }
                        this.refresh_export_preview(window, cx);
                        cx.notify();
                    }),
                ))
                .when(ui.cursor_only, |this| {
                    this.child(
                        div()
                            .mt(px(4.))
                            .p(px(12.))
                            .rounded(px(10.))
                            .bg(Hsla::from(editor.card_2))
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(8.))
                            .child(
                                svg()
                                    .path("icons/triangle-alert.svg")
                                    .size(px(14.))
                                    .flex_shrink_0()
                                    .mt(px(1.))
                                    .text_color(Hsla::from(editor.text_2)),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .line_height(px(15.))
                                    .text_color(Hsla::from(editor.text_2))
                                    .child(
                                        "Exports as a transparent MOV. Files are large and best for compositing or editing.",
                                    ),
                            ),
                    )
                })
                .when(show_bpp, |this| {
                    let fraction = ((ui.bpp() - BPP_MIN) / (BPP_MAX - BPP_MIN)).clamp(0., 1.);
                    this.child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .h(px(34.))
                            .gap(px(10.))
                            .child(
                                div()
                                    .flex_none()
                                    .min_w(px(96.))
                                    .text_size(px(13.))
                                    .text_color(Hsla::from(editor.text_1))
                                    .child("Bits per pixel"),
                            )
                            .child(
                                div()
                                    .id("export-bpp-row")
                                    .flex_1()
                                    .min_w_0()
                                    .px(px(4.))
                                    .h(px(32.))
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .child(
                                        ui::Slider::new(
                                            "export-bpp",
                                            fraction,
                                            ui.bpp_track.clone(),
                                        )
                                        .flex()
                                        .row_height(px(28.))
                                        .track(px(3.), Hsla::from(editor.ctl_active))
                                        .fill(Hsla::from(editor.accent))
                                        .thumb(
                                            px(14.),
                                            Hsla::from(editor.thumb),
                                            Some(gpui::hsla(0., 0., 0., 0.12)),
                                        )
                                        .thumb_shadow()
                                        .on_drag_start(cx.listener(
                                            |this, event: &MouseDownEvent, _window, cx| {
                                                this.export_bpp_mouse_down(event, cx);
                                            },
                                        )),
                                    ),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .min_w(px(36.))
                                    .text_right()
                                    .text_size(px(11.))
                                    .text_color(Hsla::from(editor.text_3))
                                    .child(format!("{:.2}", ui.bpp())),
                            ),
                    )
                    .when(ui.is_custom_bpp(), |this| {
                        this.child(
                            div()
                                .text_size(px(11.))
                                .text_color(Hsla::from(editor.text_3))
                                .child("Using a custom bitrate"),
                        )
                    })
                })
                .when(cfg!(target_os = "macos") && show_bpp, |this| {
                    this.child(self.export_toggle_row(
                        "export-force-ffmpeg",
                        "Force FFmpeg decoder",
                        "Skip hardware decoder (auto-fallback enabled)",
                        ui.force_ffmpeg,
                        cx.listener(|this, _, window, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                ui.force_ffmpeg = !ui.force_ffmpeg;
                                ui.persist();
                            }
                            this.refresh_export_preview(window, cx);
                            cx.notify();
                        }),
                    ))
                })
            })
    }

    fn export_bpp_mouse_down(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        if let Some(ui) = self.export.as_mut() {
            ui.bpp_dragging = true;
        }
        self.export_bpp_drag_to(event.position.x, cx);
        cx.notify();
    }

    fn export_bpp_drag_to(&mut self, x: gpui::Pixels, cx: &mut Context<Self>) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let Some(bounds) = ui.bpp_track.get() else {
            return;
        };
        let Some(fraction) = ui::fraction_from_x(x, bounds) else {
            return;
        };
        let value = ui::snap_to_step(
            ui::value_from_fraction(fraction, BPP_MIN, BPP_MAX),
            BPP_MIN,
            BPP_MAX,
            BPP_STEP,
        );
        if (value - ui.bpp()).abs() < f32::EPSILON {
            return;
        }
        ui.custom_bpp = Some(value);
        if let Some((preset, _)) = COMPRESSION_PRESETS
            .iter()
            .find(|(preset, _)| (preset.bits_per_pixel() - value).abs() < 0.001)
        {
            ui.compression = *preset;
        }
        cx.notify();
    }

    fn export_bpp_mouse_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        if !ui.bpp_dragging {
            return;
        }
        ui.bpp_dragging = false;
        ui.persist();
        self.refresh_export_preview(window, cx);
        cx.notify();
    }

    fn render_export_overlay(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let editor = theme.editor;
        let fraction = if ui.phase == ExportPhase::Uploading {
            Some(ui.upload_progress.clamp(0.0, 1.0))
        } else if ui.total_frames == 0 {
            None
        } else {
            Some(ui.rendered as f32 / ui.total_frames as f32)
        };
        let heading = match ui.phase {
            ExportPhase::Starting => "Preparing export",
            ExportPhase::Rendering if ui.cursor_only => "Rendering cursor track",
            ExportPhase::Rendering if ui.format == ExportFormatKind::Gif => "Rendering GIF",
            ExportPhase::Rendering => "Rendering video",
            ExportPhase::Copying if ui.destination == ExportDestination::Clipboard => {
                "Copying to clipboard"
            }
            ExportPhase::Copying => "Saving to file",
            ExportPhase::Uploading if ui.reuploading => "Reuploading to your link",
            ExportPhase::Uploading => "Creating shareable link",
            ExportPhase::Done if ui.destination == ExportDestination::Clipboard => {
                "Copied to clipboard"
            }
            ExportPhase::Done if ui.destination == ExportDestination::Link && ui.reuploading => {
                "Reupload complete"
            }
            ExportPhase::Done if ui.destination == ExportDestination::Link => "Upload complete",
            ExportPhase::Done => "Export complete",
            ExportPhase::Failed if ui.clipboard_retry_path().is_some() => {
                "Export complete; clipboard copy failed"
            }
            ExportPhase::Failed => "Export failed",
            ExportPhase::Idle | ExportPhase::ChoosingFile => "",
        };

        let mut wash: Hsla = editor.window.into();
        wash.a = 0.94;

        div()
            .absolute()
            .inset_0()
            .occlude()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(16.))
            .bg(wash)
            .text_color(Hsla::from(editor.text_1))
            .child({
                let ring = ui::CircularProgress::new(
                    px(80.),
                    px(6.),
                    Hsla::from(editor.ctl_active),
                    Hsla::from(editor.accent),
                )
                .label(Hsla::from(editor.text_1), px(14.));
                if let Some(fraction) = fraction {
                    ring.progress(fraction)
                } else {
                    ring.indeterminate()
                }
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(16.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(heading),
                    )
                    .when(
                        ui.phase == ExportPhase::Done
                            && ui.destination == ExportDestination::Link,
                        |this| {
                            this.child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(Hsla::from(editor.text_2))
                                    .child(if ui.reuploading {
                                        "Your latest edit is ready at the same link"
                                    } else {
                                        "Your Cap has been uploaded successfully"
                                    }),
                            )
                        },
                    ),
            )
            .when(ui.phase == ExportPhase::Rendering && ui.total_frames > 0, |this| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .text_color(Hsla::from(editor.text_2))
                        .child(format!("{} / {} frames", ui.rendered, ui.total_frames)),
                )
            })
            .when_some(ui.error.clone(), |this, error| {
                this.child(
                    div()
                        .max_w(px(360.))
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.red_9))
                        .text_center()
                        .child(error),
                )
            })
            .when(ui.phase.is_busy(), |this| {
                this.child(
                    ui::Button::plain(
                        &theme,
                        "export-cancel",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Md,
                    )
                    .label("Cancel")
                    .on_click(cx.listener(|this, _, window, cx| {
                        let Some(ui) = this.export.as_mut() else {
                            return;
                        };
                        let cancel = ui.cancel.clone();
                        #[cfg(target_os = "linux")]
                        {
                            if !ui.phase.is_busy() {
                                return;
                            }
                            let response = crate::editor_modal::confirm_cancel_export(window, cx);
                            cx.spawn_in(window, async move |this, cx| {
                                let confirmed = response.await;
                                let _ = this.update_in(cx, |this, _, cx| {
                                    if let Some(ui) = this.export.as_mut()
                                        && ui.phase.is_busy()
                                    {
                                        cancel_matching_export(&ui.cancel, &cancel, confirmed);
                                    }
                                    cx.notify();
                                });
                            })
                            .detach();
                        }
                        #[cfg(not(target_os = "linux"))]
                        cx.spawn_in(window, async move |this, cx| {
                            let confirmed = platform::confirm_dialog(
                                "Cancel export?",
                                "Are you sure you want to cancel the export?",
                                "Cancel export",
                                "Keep exporting",
                                true,
                            );
                            let _ = this.update(cx, |this, cx| {
                                if let Some(ui) = this.export.as_mut() {
                                    cancel_matching_export(&ui.cancel, &cancel, confirmed);
                                }
                                cx.notify();
                            });
                        })
                        .detach();
                    })),
                )
                .child(
                    div()
                        .max_w(px(320.))
                        .text_size(px(12.))
                        .text_color(Hsla::from(editor.text_2))
                        .text_center()
                        .child(
                            "Use Instant Mode for your next recording if you want a link the moment you stop.",
                        ),
                )
            })
            .when(ui.phase == ExportPhase::Done || ui.phase == ExportPhase::Failed, |this| {
                this.when(ui.clipboard_retry_path().is_some(), |this| {
                    this.child(
                        ui::Button::plain(
                            &theme,
                            "export-retry-copy",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Md,
                        )
                        .icon("icons/copy.svg")
                        .label("Retry Copy")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.retry_clipboard_copy(window, cx);
                        })),
                    )
                })
                .when(
                    (ui.phase == ExportPhase::Done && ui.destination == ExportDestination::File)
                        || ui.clipboard_retry_path().is_some(),
                    |this| {
                        let path = ui.output_path.clone();
                        this.child(
                            ui::Button::plain(
                                &theme,
                                "export-open-file",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Md,
                            )
                            .label("Open File")
                            .on_click(move |_, _, _| {
                                if let Some(path) = &path {
                                    library::open_path(path);
                                }
                            }),
                        )
                    },
                )
                .when(
                    ui.phase == ExportPhase::Done
                        && ui.destination == ExportDestination::Link
                        && ui.share_link.is_some(),
                    |this| {
                        let copied = ui.copy_link_pressed;
                        let open = ui.share_link.clone().unwrap_or_default();
                        this.child(
                            ui::Button::plain(
                                &theme,
                                "export-copy-link",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Md,
                            )
                            .icon(if copied {
                                "icons/check.svg"
                            } else {
                                "icons/copy.svg"
                            })
                            .label(if copied { "Link copied" } else { "Copy link" })
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.copy_share_link(window, cx);
                            })),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "export-open-link",
                                ui::ButtonVariant::Primary,
                                ui::ButtonSize::Md,
                            )
                            .icon("icons/link.svg")
                            .label("Open link")
                            .on_click(move |_, _, cx| {
                                cx.open_url(&open);
                            }),
                        )
                    },
                )
                .child(
                    ui::Button::plain(
                        &theme,
                        "export-back-done",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Md,
                    )
                    .label("Back to editor")
                    .on_click(cx.listener(|this, _, window, cx| this.close_export(window, cx))),
                )
            })
    }
}

/// The largest box of the preview's aspect that fits the stage, so the frame's
/// rounded corners and shadow hug the picture instead of a letterboxed pane.
fn preview_fit(avail_w: f32, avail_h: f32, image: Option<(f32, f32)>) -> (f32, f32) {
    let avail_w = avail_w.max(120.);
    let avail_h = avail_h.max(68.);
    let (iw, ih) = match image {
        Some((w, h)) if w > 0. && h > 0. => (w, h),
        _ => (16., 9.),
    };
    let scale = (avail_w / iw).min(avail_h / ih);
    ((iw * scale).floor(), (ih * scale).floor())
}

async fn confirm_export_resources(
    this: &gpui::WeakEntity<EditorWindow>,
    cx: &mut gpui::AsyncWindowContext,
    resources: &ExportResources,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let check = {
        let resources = resources.clone();
        gpui_tokio::Tokio::spawn(cx, async move { resources.check().await }).await
    };
    let result = async {
        let warning = check.map_err(|error| error.to_string())??;
        if let Some(message) = warning {
            #[cfg(target_os = "linux")]
            let confirmed = {
                let response = loop {
                    let pending = this.update_in(cx, |this, window, cx| {
                        let current = this.export.as_ref().is_some_and(|ui| {
                            Arc::ptr_eq(&ui.cancel, cancel)
                                && !ui.close_requested
                                && !cancel.load(Ordering::Acquire)
                        });
                        let response = (current && !window.has_active_prompt()).then(|| {
                            crate::editor_modal::confirm_action(
                                "Check export resources",
                                &message,
                                "Proceed anyway",
                                "Go back",
                                window,
                                cx,
                            )
                        });
                        (current, response)
                    });
                    match pending {
                        Ok((true, Some(response))) => break response,
                        Ok((true, None)) => {
                            cx.background_executor()
                                .timer(Duration::from_millis(50))
                                .await;
                        }
                        _ => return Ok(false),
                    }
                };
                response.await
            };
            #[cfg(not(target_os = "linux"))]
            let confirmed = {
                let current = this
                    .update(cx, |this, _| {
                        this.export.as_ref().is_some_and(|ui| {
                            Arc::ptr_eq(&ui.cancel, cancel)
                                && !ui.close_requested
                                && !cancel.load(Ordering::Acquire)
                        })
                    })
                    .unwrap_or(false);
                if !current {
                    return Ok(false);
                }
                platform::confirm_dialog(
                    "Check export resources",
                    &message,
                    "Proceed anyway",
                    "Go back",
                    false,
                )
            };
            if !confirmed {
                return Ok(false);
            }
            let resources = resources.clone();
            let _ = gpui_tokio::Tokio::spawn(cx, async move { resources.check().await })
                .await
                .map_err(|error| error.to_string())??;
        }
        Ok::<bool, String>(true)
    }
    .await;
    this.update(cx, |this, cx| {
        let Some(ui) = this.export.as_mut() else {
            return false;
        };
        if !Arc::ptr_eq(&ui.cancel, cancel) {
            return false;
        }
        let accepted = result.as_ref().is_ok_and(|accepted| *accepted)
            && !ui.close_requested
            && !cancel.load(Ordering::Acquire);
        if !accepted {
            match result {
                Err(error) if !ui.close_requested && !cancel.load(Ordering::Acquire) => {
                    ui.phase = ExportPhase::Failed;
                    ui.error = Some(error);
                }
                _ => ui.phase = ExportPhase::Idle,
            }
            cx.notify();
        }
        accepted
    })
    .unwrap_or(false)
}

fn cancel_matching_export(current: &Arc<AtomicBool>, requested: &Arc<AtomicBool>, confirmed: bool) {
    if confirmed && Arc::ptr_eq(current, requested) {
        current.store(true, Ordering::Relaxed);
    }
}

fn show_upload_failure(
    this: &gpui::WeakEntity<EditorWindow>,
    cx: &mut gpui::AsyncWindowContext,
    message: &str,
    dialog: bool,
) {
    let message = message.to_string();
    let _ = this.update(cx, |this, cx| {
        if let Some(ui) = this.export.as_mut() {
            ui.phase = ExportPhase::Failed;
            ui.error = Some(message.clone());
        }
        cx.notify();
    });
    if dialog {
        platform::alert_dialog("Failed to upload recording", &message);
    }
}

fn export_stat(
    theme: &crate::theme::Theme,
    label: &'static str,
    value: Option<String>,
    divided: bool,
) -> impl IntoElement {
    let editor = theme.editor;
    div()
        .flex()
        .flex_1()
        .flex_col()
        .justify_center()
        .px(px(16.))
        .gap(px(1.))
        .when(divided, |this| {
            this.border_l_1().border_color(Hsla::from(editor.line))
        })
        .child(
            div()
                .text_size(px(10.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(editor.text_3))
                .child(label),
        )
        .child(match value {
            Some(value) => div()
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(editor.text_1))
                .whitespace_nowrap()
                .child(value)
                .into_any_element(),
            None => div()
                .my(px(3.))
                .h(px(12.))
                .w(px(56.))
                .rounded(px(4.))
                .bg(Hsla::from(editor.ctl_active))
                .into_any_element(),
        })
}

fn matches_compression(current: ExportCompression, expected: ExportCompression) -> bool {
    std::mem::discriminant(&current) == std::mem::discriminant(&expected)
}

#[allow(clippy::too_many_arguments)]
async fn run_export(
    project_path: PathBuf,
    project: cap_project::ProjectConfiguration,
    format: ExportFormatKind,
    cursor_only: bool,
    fps: u32,
    width: u32,
    height: u32,
    compression: ExportCompression,
    custom_bpp: Option<f32>,
    optimize: bool,
    force: bool,
    save_path: Option<PathBuf>,
    progress_tx: flume::Sender<(u32, u32)>,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("Export cancelled".into());
    }

    let mut builder = ExporterBase::builder(project_path).with_force_ffmpeg_decoder(force);
    if cursor_only {
        builder = builder.with_config(make_cursor_only_project(project));
    } else {
        builder = builder.with_config(project);
    }
    if let Some(path) = save_path.clone() {
        builder = builder.with_output_path(path);
    }

    enum PreparedBase {
        Mp4(cap_export::Mp4ExporterBase),
        Other(ExporterBase),
    }
    let (base, total) = if !cursor_only && format != ExportFormatKind::Gif {
        let base = builder
            .build_for_mp4(cancel.clone())
            .await
            .map_err(|error| error.to_string())?;
        let total = base.total_frames(fps);
        (PreparedBase::Mp4(base), total)
    } else {
        let base = builder.build().await.map_err(|error| error.to_string())?;
        let total = base.total_frames(fps);
        (PreparedBase::Other(base), total)
    };
    let _ = progress_tx.send((0, total));

    let progress = {
        let progress_tx = progress_tx.clone();
        let cancel = cancel.clone();
        move |frame_index: u32| {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            progress_tx
                .send(((frame_index + 1).min(total), total))
                .is_ok()
        }
    };

    let resolution = XY::new(width, height);
    match base {
        PreparedBase::Other(base) if cursor_only => {
            MovExportSettings {
                fps,
                resolution_base: resolution,
                cursor_only: true,
            }
            .export(base, progress)
            .await
        }
        PreparedBase::Other(base) => {
            GifExportSettings {
                fps,
                resolution_base: resolution,
                quality: None,
            }
            .export(base, progress)
            .await
        }
        PreparedBase::Mp4(base) => {
            Mp4ExportSettings {
                fps,
                resolution_base: resolution,
                compression,
                custom_bpp,
                force_ffmpeg_decoder: force,
                optimize_filesize: optimize,
            }
            .export_prepared(base, progress)
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ExportDestination, ExportPhase, ExportUi, cancel_matching_export};
    use crate::store::ExportPrefs;
    use std::path::PathBuf;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    fn clipboard_export() -> ExportUi {
        ExportUi::from_preferences(ExportPrefs {
            format: "Mp4".into(),
            fps: 30,
            export_to: "clipboard".into(),
            resolution: "720p".into(),
            compression: "Maximum".into(),
            optimize_filesize: false,
            cursor_only: false,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            advanced_open: false,
            organization_id: None,
        })
    }

    #[test]
    fn stale_preview_results_cannot_replace_the_latest_or_reopened_preview() {
        let mut ui = clipboard_export();
        let previous = ui.preview_request.clone();
        let current = Arc::new(());
        ui.preview_request = current.clone();
        assert!(ui.update_preview(&current, |ui| ui.preview_error = Some("Latest".into())));
        assert!(!ui.update_preview(&previous, |ui| ui.preview_error = Some("Stale".into())));
        assert_eq!(ui.preview_error.as_deref(), Some("Latest"));

        let mut reopened = clipboard_export();
        assert!(!reopened.update_preview(&current, |ui| ui.preview_error = Some("Closed".into())));
        assert!(reopened.preview_error.is_none());
    }

    #[test]
    fn failed_clipboard_copy_retries_the_completed_file() {
        let mut ui = clipboard_export();
        let output = PathBuf::from("finished recording.mp4");
        ui.copy_completed_export(output.clone(), |path| {
            assert_eq!(path, output);
            Err("Clipboard is busy".into())
        });
        assert_eq!(ui.phase, ExportPhase::Failed);
        assert_eq!(ui.error.as_deref(), Some("Clipboard is busy"));
        let retry = ui.clipboard_retry_path().unwrap().to_path_buf();
        assert_eq!(retry, output);

        ui.copy_completed_export(retry, |path| {
            assert_eq!(path, output);
            Ok(())
        });
        assert_eq!(ui.phase, ExportPhase::Done);
        assert_eq!(ui.output_path, Some(output));
        assert!(ui.error.is_none());
        assert!(ui.clipboard_retry_path().is_none());
    }

    #[test]
    fn cancellation_or_close_prevents_late_clipboard_mutation() {
        for closing in [false, true] {
            let mut ui = clipboard_export();
            ui.close_requested = closing;
            ui.cancel.store(!closing, Ordering::Relaxed);
            let output = PathBuf::from("finished recording.mp4");
            ui.copy_completed_export(output.clone(), |_| {
                panic!("cancelled exports must not replace the clipboard")
            });
            assert_eq!(ui.phase, ExportPhase::Idle);
            assert_eq!(ui.output_path, Some(output));
            assert!(ui.clipboard_retry_path().is_none());
        }
    }

    #[test]
    fn incomplete_or_non_clipboard_exports_cannot_retry_copy() {
        let mut ui = clipboard_export();
        ui.phase = ExportPhase::Failed;
        assert!(ui.clipboard_retry_path().is_none());
        ui.output_path = Some(PathBuf::from("finished recording.mp4"));
        ui.destination = ExportDestination::File;
        assert!(ui.clipboard_retry_path().is_none());
        ui.destination = ExportDestination::Link;
        assert!(ui.clipboard_retry_path().is_none());
    }

    #[test]
    fn declining_cancel_preserves_the_running_export() {
        let cancel = Arc::new(AtomicBool::new(false));
        cancel_matching_export(&cancel, &cancel, false);
        assert!(!cancel.load(Ordering::Relaxed));
        cancel_matching_export(&cancel, &cancel, true);
        assert!(cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn late_confirmation_cannot_cancel_a_subsequent_export() {
        let previous = Arc::new(AtomicBool::new(false));
        let current = Arc::new(AtomicBool::new(false));
        cancel_matching_export(&current, &previous, true);
        assert!(!current.load(Ordering::Relaxed));
        assert!(!previous.load(Ordering::Relaxed));
    }

    #[test]
    fn choosing_a_file_blocks_duplicate_exports_without_showing_progress() {
        assert!(ExportPhase::ChoosingFile.is_busy());
        assert!(!ExportPhase::ChoosingFile.shows_progress());
    }

    #[test]
    fn cancelling_file_selection_returns_to_the_idle_page() {
        assert!(!ExportPhase::Idle.is_busy());
        assert!(!ExportPhase::Idle.shows_progress());
    }

    #[test]
    fn export_work_and_results_remain_visible() {
        for phase in [
            ExportPhase::Starting,
            ExportPhase::Rendering,
            ExportPhase::Copying,
            ExportPhase::Uploading,
            ExportPhase::Done,
            ExportPhase::Failed,
        ] {
            assert!(phase.shows_progress());
        }
    }
}
