//! Editor export page -- `routes/editor/ExportPage.tsx`, 1:1 layout.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cap_export::gif::GifExportSettings;
use cap_export::mov::MovExportSettings;
use cap_export::mp4::{ExportCompression, Mp4ExportSettings};
use cap_export::preview::{ExportPreviewSettings, render_preview};
use cap_export::{ExporterBase, make_cursor_only_project};
use cap_project::{BackgroundSource, RecordingMeta, XY};
use gpui::{
    Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, RenderImage,
    StatefulInteractiveElement, Styled, Window, div, img, prelude::FluentBuilder, px, svg,
};

use crate::editor_window::EditorWindow;
use crate::store::{self, ExportPrefs};
use crate::ui;
use crate::{library, platform};

const SIDEBAR_WIDTH: f32 = 400.;

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
    Starting,
    Rendering,
    Copying,
    Uploading,
    Done,
    Failed,
}

impl ExportPhase {
    fn is_busy(self) -> bool {
        matches!(
            self,
            Self::Starting | Self::Rendering | Self::Copying | Self::Uploading
        )
    }
}

pub struct PreviewStats {
    pub width: u32,
    pub height: u32,
    pub total_frames: u32,
    pub estimated_size_mb: f64,
    pub frame_render_time_ms: f64,
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
    pub phase: ExportPhase,
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
    pub upload_progress: f32,
    pub copy_link_pressed: bool,
}

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
            phase: ExportPhase::Idle,
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
            upload_progress: 0.0,
            copy_link_pressed: false,
        }
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

    fn is_custom_bpp(&self) -> bool {
        self.custom_bpp
            .is_some_and(|bpp| (bpp - self.compression.bits_per_pixel()).abs() > 0.001)
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

fn format_export_time(seconds: f64) -> String {
    if seconds < 1.0 {
        "< 1s".into()
    } else if seconds < 60.0 {
        format!("~{:.0}s", seconds)
    } else {
        format!("~{:.0}m", (seconds / 60.0).ceil())
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
    pub(crate) fn open_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.playing {
            self.toggle_play_from_crop(cx);
        }
        let mut ui = ExportUi::load();
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
                ui.cancel.store(true, Ordering::Relaxed);
            }
            if let Some(image) = ui.preview.take() {
                let _ = window.drop_image(image);
            }
            ui.persist();
        }
        self.export = None;
        cx.notify();
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
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        let (width, height) = ui.resolution.size();
        let settings = ExportPreviewSettings {
            fps: ui.fps,
            resolution_base: XY::new(width, height),
            compression_bpp: ui.bpp(),
            cursor_only: ui.cursor_only,
        };
        let force = ui.force_ffmpeg;
        ui.preview_error = None;
        ui.preview_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(120))
                .await;
            let result = gpui_tokio::Tokio::spawn(cx, async move {
                render_preview(path, time, settings, force).await
            })
            .await
            .ok();
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(ui) = this.export.as_mut() else {
                    return;
                };
                match result {
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
                            frame_render_time_ms: preview.frame_render_time_ms,
                        });
                        ui.preview_error = None;
                    }
                    Some(Err(error)) => {
                        ui.preview_error = Some(error.to_string());
                    }
                    None => {
                        ui.preview_error = Some("Preview unavailable".into());
                    }
                }
                cx.notify();
                window.refresh();
            });
        }));
    }

    fn start_export(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pretty_name = self
            .summary()
            .map(|summary| summary.pretty_name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Cap Recording".into());
        let Some(ui) = self.export.as_mut() else {
            return;
        };
        if ui.phase.is_busy() {
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
        ui.cancel.store(false, Ordering::Relaxed);
        let cancel = ui.cancel.clone();
        ui.phase = ExportPhase::Starting;
        ui.error = None;
        ui.rendered = 0;
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
                let chosen = platform::save_file_panel(&default, &[ext]);
                if chosen.is_none() {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.phase = ExportPhase::Idle;
                        }
                        cx.notify();
                    });
                    return;
                }
                chosen
            } else {
                None
            };

            let _ = this.update(cx, |this, cx| {
                if let Some(ui) = this.export.as_mut() {
                    ui.phase = ExportPhase::Rendering;
                }
                cx.notify();
            });

            let (progress_tx, progress_rx) = flume::unbounded::<(u32, u32)>();
            let export_cancel = cancel.clone();
            let export = gpui_tokio::Tokio::spawn(cx, async move {
                run_export(
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
                    if destination == ExportDestination::Clipboard {
                        let _ = this.update(cx, |this, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                ui.phase = ExportPhase::Copying;
                            }
                            cx.notify();
                        });
                        let copied = cx
                            .background_executor()
                            .spawn({
                                let path = path.clone();
                                async move { platform::copy_file_to_clipboard(&path) }
                            })
                            .await;
                        let _ = this.update(cx, |this, cx| {
                            if let Some(ui) = this.export.as_mut() {
                                match copied {
                                    Ok(()) => {
                                        ui.phase = ExportPhase::Done;
                                        ui.output_path = Some(path);
                                    }
                                    Err(error) => {
                                        ui.phase = ExportPhase::Failed;
                                        ui.error = Some(error);
                                    }
                                }
                            }
                            cx.notify();
                        });
                    } else {
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
                    let cancelled = error == "Export cancelled" || cancel.load(Ordering::Relaxed);
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
        }));
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
                    if let Ok(plan) =
                        gpui_tokio::Tokio::spawn(cx, crate::auth::update_auth_plan()).await
                    {
                        if let Err(error) = plan {
                            tracing::warn!("updating auth plan after sign-in: {error}");
                        }
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
        if ui.phase.is_busy() {
            return;
        }

        let upgraded = store::auth_snapshot().is_upgraded();
        if !upgraded && duration >= 300.0 {
            cx.open_url(&format!("{}/pricing", crate::auth::server_url()));
            return;
        }

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
        ui.cancel.store(false, Ordering::Relaxed);
        let cancel = ui.cancel.clone();
        ui.phase = ExportPhase::Starting;
        ui.error = None;
        ui.share_link = None;
        ui.upload_progress = 0.0;
        ui.rendered = 0;
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
                                if let Some(ui) = this.export.as_mut() {
                                    ui.phase = ExportPhase::Done;
                                    ui.share_link = Some(link.clone());
                                    ui.upload_progress = 1.0;
                                }
                                cx.notify();
                            });
                            let _ = this.update(cx, |_, cx| {
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
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
                                cx.open_url(&format!("{}/pricing", crate::auth::server_url()));
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
                    let cancelled = error == "Export cancelled" || cancel.load(Ordering::Relaxed);
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
        }));
    }

    pub(crate) fn render_export_page(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let Some(ui) = self.export.as_ref() else {
            return div().into_any_element();
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .child(
                div()
                    .h(px(56.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .border_b_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child("Export"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_export_preview_pane(ui))
                    .child(self.render_export_sidebar(ui, cx)),
            )
            .when(ui.phase != ExportPhase::Idle, |this| {
                this.child(self.render_export_overlay(ui, cx))
            })
            .into_any_element()
    }

    fn render_export_preview_pane(&self, ui: &ExportUi) -> impl IntoElement {
        let theme = self.theme;
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
        let estimate_mult = if ui.format == ExportFormatKind::Gif {
            4.0
        } else {
            10.0
        };
        let export_secs = stats
            .map(|stats| {
                stats.frame_render_time_ms / 1000.0 * stats.total_frames as f64 / estimate_mult
            })
            .unwrap_or(0.0);

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .p(px(20.))
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
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
                                     settings below to see the quality of the final exported \
                                     video.",
                                )
                                .view(cx)
                            })
                            .child(
                                svg()
                                    .path("icons/info.svg")
                                    .size(px(14.))
                                    .text_color(Hsla::from(theme.gray_10)),
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
                    .rounded(px(12.))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .bg(Hsla::from(theme.gray_2))
                    .overflow_hidden()
                    .child(match ui.preview.clone() {
                        Some(image) => {
                            use gpui::StyledImage as _;
                            img(image)
                                .object_fit(gpui::ObjectFit::Contain)
                                .size_full()
                                .into_any_element()
                        }
                        None => div()
                            .text_size(px(13.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(
                                ui.preview_error
                                    .clone()
                                    .unwrap_or_else(|| "Generating preview…".into()),
                            )
                            .into_any_element(),
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(16.))
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.gray_11))
                    .child(export_stat("icons/clock.svg", format_duration(duration)))
                    .child(export_stat(
                        "icons/monitor-outline.svg",
                        stats
                            .map(|stats| format!("{}×{}", stats.width, stats.height))
                            .unwrap_or_else(|| "—".into()),
                    ))
                    .child(export_stat(
                        "icons/folder.svg",
                        stats
                            .map(|stats| format!("~{:.1} MB", stats.estimated_size_mb))
                            .unwrap_or_else(|| "—".into()),
                    ))
                    .child(export_stat(
                        "icons/zap.svg",
                        if stats.is_some() {
                            format_export_time(export_secs)
                        } else {
                            "—".into()
                        },
                    )),
            )
    }

    fn render_export_sidebar(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
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
            .border_l_1()
            .border_color(Hsla::from(theme.gray_3))
            .child(
                div()
                    .h(px(64.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .px(px(16.))
                    .border_b_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .child(
                        div()
                            .id("export-back")
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .h(px(36.))
                            .px(px(8.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .hover(|style| style.bg(Hsla::from(theme.gray_3)))
                            .child(
                                svg()
                                    .path("icons/move-left.svg")
                                    .size(px(14.))
                                    .text_color(Hsla::from(theme.gray_11)),
                            )
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("Back to editor"),
                            )
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.close_export(window, cx);
                            })),
                    ),
            )
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
                    .when(ui.format == ExportFormatKind::Mp4 && !ui.cursor_only, |this| {
                        this.child(self.export_quality_field(ui, cx))
                            .child(self.export_optimize_row(ui, cx))
                    })
                    .when(ui.cursor_only, |this| {
                        this.child(
                            div()
                                .p(px(12.))
                                .rounded(px(8.))
                                .bg(Hsla::from(theme.gray_3))
                                .text_size(px(12.))
                                .text_color(Hsla::from(theme.gray_11))
                                .child(
                                    "Cursor-only exports are saved as a transparent MOV and cannot be shared as a link.",
                                ),
                        )
                    })
                    .child(self.export_advanced(ui, cx)),
            )
            .child(
                div()
                    .p(px(16.))
                    .border_t_1()
                    .border_color(Hsla::from(theme.gray_3))
                    .child(
                        {
                            let signed_in = store::auth_snapshot().signed_in();
                            let (variant, label, icon) = match ui.destination {
                                ExportDestination::File => (
                                    ui::ButtonVariant::Primary,
                                    "Export to File",
                                    Some("icons/folder.svg"),
                                ),
                                ExportDestination::Clipboard => (
                                    ui::ButtonVariant::Primary,
                                    "Export to Clipboard",
                                    Some("icons/copy.svg"),
                                ),
                                ExportDestination::Link if ui.sign_in_pending => {
                                    (ui::ButtonVariant::Gray, "Cancel Sign In", None)
                                }
                                ExportDestination::Link if !signed_in => (
                                    ui::ButtonVariant::Primary,
                                    "Sign in to share",
                                    Some("icons/link.svg"),
                                ),
                                ExportDestination::Link => (
                                    ui::ButtonVariant::Primary,
                                    "Export to Link",
                                    Some("icons/link.svg"),
                                ),
                            };
                            let mut button = ui::Button::plain(
                                &theme,
                                "export-cta",
                                variant,
                                ui::ButtonSize::Lg,
                            )
                            .label(label)
                            .full_width()
                            .on_click(cx.listener(|this, _, window, cx| this.start_export(window, cx)));
                            if let Some(icon) = icon {
                                button = button.icon(icon);
                            }
                            button
                        }
                    ),
            )
    }

    fn export_destination_field(
        &self,
        ui: &ExportUi,
        link_disabled: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        ui::Field::plain(&theme, "Destination")
            .icon("icons/upload-arrow.svg")
            .child(
                ui::SegmentedControl::pills(
                    &theme,
                    "export-destination",
                    ExportDestination::ALL
                        .iter()
                        .map(|dest| {
                            let mut option =
                                ui::SegmentOption::new(dest.label(), ui.destination == *dest)
                                    .disabled(*dest == ExportDestination::Link && link_disabled);
                            option.icon = Some(dest.icon().into());
                            option
                        })
                        .collect(),
                )
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
            .when(
                ui.destination == ExportDestination::Link
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
                            .px(px(12.))
                            .py(px(8.))
                            .rounded(px(8.))
                            .bg(Hsla::from(theme.gray_3))
                            .cursor_pointer()
                            .hover(|style| style.bg(Hsla::from(theme.gray_4)))
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
                                    .text_size(px(13.))
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child("Organization"),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(4.))
                                    .text_size(px(13.))
                                    .text_color(Hsla::from(theme.gray_12))
                                    .child(label)
                                    .child(
                                        svg()
                                            .path("icons/caret-down.svg")
                                            .size(px(16.))
                                            .text_color(Hsla::from(theme.gray_11)),
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
        ui::Field::plain(&theme, "Format")
            .icon("icons/video.svg")
            .disabled(locked)
            .child(
                ui::SegmentedControl::pills(
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
        ui::Field::plain(&theme, "Resolution")
            .icon("icons/monitor-outline.svg")
            .child(
                ui::SegmentedControl::pills(
                    &theme,
                    "export-resolution",
                    resolutions
                        .iter()
                        .map(|res| ui::SegmentOption::new(res.label(), ui.resolution == *res))
                        .collect(),
                )
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
        ui::Field::plain(&theme, "Frame Rate")
            .icon("icons/gauge.svg")
            .child(
                ui::SegmentedControl::pills(
                    &theme,
                    "export-fps",
                    options
                        .iter()
                        .map(|fps| ui::SegmentOption::new(format!("{fps} FPS"), ui.fps == *fps))
                        .collect(),
                )
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
        let options = [
            (ExportCompression::Potato, "Potato"),
            (ExportCompression::Web, "Web"),
            (ExportCompression::Social, "Social"),
            (ExportCompression::Maximum, "Maximum"),
        ];
        ui::Field::plain(&theme, "Quality")
            .icon("icons/diamond.svg")
            .child(
                ui::SegmentedControl::pills(
                    &theme,
                    "export-quality",
                    options
                        .iter()
                        .map(|(value, label)| {
                            ui::SegmentOption::new(
                                *label,
                                matches_compression(ui.compression, *value),
                            )
                        })
                        .collect(),
                )
                .on_select(cx.listener(move |this, index: &usize, window, cx| {
                    let Some((compression, _)) = options.get(*index).copied() else {
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
                    .text_size(px(11.))
                    .text_color(Hsla::from(theme.gray_10))
                    .child("Smaller file")
                    .child("Larger file"),
            )
    }

    fn export_optimize_row(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .child("Optimize file size"),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child("Re-encodes with software for much smaller files (slower)"),
                    ),
            )
            .child(
                ui::Toggle::plain(&theme, "export-optimize", ui.optimize_filesize).on_click(
                    cx.listener(|this, _, window, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.optimize_filesize = !ui.optimize_filesize;
                            ui.persist();
                        }
                        this.refresh_export_preview(window, cx);
                        cx.notify();
                    }),
                ),
            )
    }

    fn export_advanced(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .id("export-advanced-toggle")
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _window, cx| {
                        if let Some(ui) = this.export.as_mut() {
                            ui.advanced_open = !ui.advanced_open;
                            ui.persist();
                        }
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .child("Advanced Options"),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_11))
                            .child(if ui.advanced_open {
                                "Hide options"
                            } else {
                                "Show options"
                            }),
                    ),
            )
            .when(ui.advanced_open, |this| {
                this.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child("Export cursor only"),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(Hsla::from(theme.gray_11))
                                        .child("Renders just the cursor as a transparent MOV"),
                                ),
                        )
                        .child(
                            ui::Toggle::plain(&theme, "export-cursor-only", ui.cursor_only)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    if let Some(ui) = this.export.as_mut() {
                                        ui.cursor_only = !ui.cursor_only;
                                        if ui.cursor_only
                                            && ui.destination == ExportDestination::Link
                                        {
                                            ui.destination = ExportDestination::File;
                                        }
                                        ui.persist();
                                    }
                                    this.refresh_export_preview(window, cx);
                                    cx.notify();
                                })),
                        ),
                )
                .when(
                    ui.format == ExportFormatKind::Mp4 && !ui.cursor_only,
                    |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .justify_between()
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .child("Bits per pixel"),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(Hsla::from(theme.gray_11))
                                                .child(format!("{:.2}", ui.bpp())),
                                        ),
                                )
                                .when(ui.is_custom_bpp(), |this| {
                                    this.child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(Hsla::from(theme.gray_11))
                                            .child("Using custom bitrate"),
                                    )
                                }),
                        )
                    },
                )
                .when(
                    cfg!(target_os = "macos")
                        && ui.format == ExportFormatKind::Mp4
                        && !ui.cursor_only,
                    |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .justify_between()
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child("Force FFmpeg decoder"),
                                )
                                .child(
                                    ui::Toggle::plain(
                                        &theme,
                                        "export-force-ffmpeg",
                                        ui.force_ffmpeg,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            if let Some(ui) = this.export.as_mut() {
                                                ui.force_ffmpeg = !ui.force_ffmpeg;
                                                ui.persist();
                                            }
                                            this.refresh_export_preview(window, cx);
                                            cx.notify();
                                        },
                                    )),
                                ),
                        )
                    },
                )
            })
    }

    fn render_export_overlay(&self, ui: &ExportUi, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
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
            ExportPhase::Uploading => "Creating shareable link",
            ExportPhase::Done if ui.destination == ExportDestination::Clipboard => {
                "Copied to clipboard"
            }
            ExportPhase::Done if ui.destination == ExportDestination::Link => "Upload complete",
            ExportPhase::Done => "Export complete",
            ExportPhase::Failed => "Export failed",
            ExportPhase::Idle => "",
        };

        let mut wash: Hsla = theme.gray(1);
        wash.a = 0.94;

        div()
            .absolute()
            .inset_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(16.))
            .bg(wash)
            .child({
                let ring = ui::CircularProgress::new(
                    px(80.),
                    px(6.),
                    theme.gray(4),
                    Hsla::from(theme.blue_9),
                )
                .label(Hsla::from(theme.gray_12), px(14.));
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
                                    .text_color(Hsla::from(theme.gray_11))
                                    .child("Your Cap has been uploaded successfully"),
                            )
                        },
                    ),
            )
            .when(ui.phase == ExportPhase::Rendering && ui.total_frames > 0, |this| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.gray_11))
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
                        ui.cancel.store(true, Ordering::Relaxed);
                        cx.spawn_in(window, async move |this, cx| {
                            let confirmed = platform::confirm_dialog(
                                "Cancel export?",
                                "Are you sure you want to cancel the export?",
                                "Cancel export",
                                "Keep exporting",
                                true,
                            );
                            if confirmed {
                                let _ = this.update(cx, |this, cx| {
                                    if let Some(ui) = this.export.as_mut() {
                                        ui.cancel.store(true, Ordering::Relaxed);
                                        ui.phase = ExportPhase::Idle;
                                    }
                                    cx.notify();
                                });
                            }
                        })
                        .detach();
                    })),
                )
                .child(
                    div()
                        .max_w(px(320.))
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.gray_11))
                        .text_center()
                        .child(
                            "Use Instant Mode for your next recording if you want a link the moment you stop.",
                        ),
                )
            })
            .when(ui.phase == ExportPhase::Done || ui.phase == ExportPhase::Failed, |this| {
                this                .when(
                    ui.phase == ExportPhase::Done && ui.destination == ExportDestination::File,
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

fn export_stat(icon: &'static str, value: String) -> impl IntoElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.))
        .child(svg().path(icon).size(px(12.)))
        .child(value)
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

    let base = builder.build().await.map_err(|error| error.to_string())?;
    let total = base.total_frames(fps);
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
    if cursor_only {
        MovExportSettings {
            fps,
            resolution_base: resolution,
            cursor_only: true,
        }
        .export(base, progress)
        .await
    } else if format == ExportFormatKind::Gif {
        GifExportSettings {
            fps,
            resolution_base: resolution,
            quality: None,
        }
        .export(base, progress)
        .await
    } else {
        Mp4ExportSettings {
            fps,
            resolution_base: resolution,
            compression,
            custom_bpp,
            force_ffmpeg_decoder: force,
            optimize_filesize: optimize,
        }
        .export(base, progress)
        .await
    }
}
