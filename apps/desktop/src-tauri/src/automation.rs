use cap_automation::{
    AutomationExportCompression, AutomationHost, AutomationRecordingMode, AutomationsStore,
    Capability, CaptureTargetKind, ClipboardSource, ExportDestination, ExportFormat, ExportProfile,
    Trigger, TriggerContext, sanitize_filename_component,
};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use clipboard_rs::Clipboard;
use clipboard_rs::common::RustImage;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::ClipboardContext;
use crate::general_settings::PostStudioRecordingBehaviour;

const WEBHOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

pub struct DesktopAutomationHost {
    app: AppHandle,
    clipboard: Arc<RwLock<ClipboardContext>>,
}

impl DesktopAutomationHost {
    pub fn new(app: AppHandle, clipboard: Arc<RwLock<ClipboardContext>>) -> Self {
        Self { app, clipboard }
    }
}

impl AutomationHost for DesktopAutomationHost {
    fn capabilities(&self) -> &[Capability] {
        &[
            Capability::CopyToClipboard,
            Capability::SaveToLocation,
            Capability::Export,
            Capability::Upload,
            Capability::RevealInFileManager,
            Capability::OpenFile,
            Capability::RunCommand,
            Capability::Webhook,
            Capability::Notify,
            Capability::OpenEditor,
            Capability::ApplyPreset,
            Capability::DeleteLocalFiles,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Capability::RecognizeText,
        ]
    }

    async fn copy_to_clipboard(
        &self,
        ctx: &TriggerContext,
        source: &ClipboardSource,
    ) -> Result<(), String> {
        let path = match source {
            ClipboardSource::Raw => ctx
                .image_path
                .as_ref()
                .or(ctx.output_path.as_ref())
                .ok_or("No image or output path available for clipboard copy")?,
            ClipboardSource::Rendered => ctx
                .output_path
                .as_ref()
                .or(ctx.image_path.as_ref())
                .ok_or("No output path available for clipboard copy")?,
        };

        let path_str = path.to_string_lossy().to_string();
        info!(path = %path_str, "Automation: copying to clipboard");

        let img_data = clipboard_rs::RustImageData::from_path(&path_str)
            .map_err(|e| format!("Failed to load image for clipboard: {e}"))?;
        self.clipboard
            .write()
            .await
            .set_image(img_data)
            .map_err(|e| format!("Failed to set clipboard image: {e}"))?;

        Ok(())
    }

    async fn save_to_location(
        &self,
        ctx: &TriggerContext,
        dir: &str,
        filename_template: Option<&str>,
    ) -> Result<(), String> {
        let src = ctx
            .image_path
            .as_ref()
            .or(ctx.output_path.as_ref())
            .ok_or("No file path available for save")?;

        let filename = if let Some(tmpl) = filename_template {
            apply_filename_template(tmpl, ctx)
        } else {
            src.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "capture.png".to_string())
        };

        let dst = PathBuf::from(dir).join(&filename);
        info!(src = %src.display(), dst = %dst.display(), "Automation: saving to location");

        if let Some(parent) = dst.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        }

        tokio::fs::copy(src, &dst)
            .await
            .map_err(|e| format!("Failed to copy file: {e}"))?;

        Ok(())
    }

    async fn export(
        &self,
        ctx: &TriggerContext,
        profile: &ExportProfile,
        destination: &ExportDestination,
    ) -> Result<(), String> {
        let project_path = ctx
            .project_path
            .as_ref()
            .ok_or("No project path available for export")?;

        info!(
            project = %project_path.display(),
            format = ?profile.format,
            "Automation: exporting"
        );

        let settings = build_desktop_export_settings(profile);

        let output_path = match destination {
            ExportDestination::ProjectFolder => None,
            ExportDestination::CustomPath { dir } => {
                let ext = match profile.format {
                    ExportFormat::Mp4 => "mp4",
                    ExportFormat::Gif => "gif",
                    ExportFormat::Mov => "mov",
                };
                let name = project_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "export".to_string());
                Some(PathBuf::from(dir).join(format!("{name}.{ext}")))
            }
        };

        let mut builder = cap_export::ExporterBase::builder(project_path.clone());

        if let Some(ref out) = output_path {
            builder = builder.with_output_path(out.clone());
        }

        let base = builder.build().await.map_err(|e| format!("{e}"))?;

        let result_path = match settings {
            crate::export::ExportSettings::Mp4(s) => s.export(base, |_| true).await,
            crate::export::ExportSettings::Gif(s) => s.export(base, |_| true).await,
            crate::export::ExportSettings::Mov(s) => s.export(base, |_| true).await,
        }
        .map_err(|e| format!("Export failed: {e}"))?;

        info!(output = %result_path.display(), "Automation: export complete");
        Ok(())
    }

    async fn upload(
        &self,
        ctx: &TriggerContext,
        organization_id: Option<&str>,
        copy_link: bool,
        open_in_browser: bool,
    ) -> Result<(), String> {
        let link = if let Some(image_path) = ctx.image_path.as_ref() {
            info!(path = %image_path.display(), "Automation: uploading screenshot");
            let uploaded = crate::upload::upload_image(&self.app, image_path.clone())
                .await
                .map_err(|e| format!("Upload failed: {e}"))?;

            if let Some(project_path) = ctx.project_path.as_ref()
                && let Ok(mut meta) = cap_project::RecordingMeta::load_for_project(project_path)
            {
                meta.sharing = Some(cap_project::SharingMeta {
                    link: uploaded.link.clone(),
                    id: uploaded.id.clone(),
                });
                let _ = meta.save_for_project();
            }

            uploaded.link
        } else if let Some(existing) = ctx.share_link.as_ref() {
            info!(link = %existing, "Automation: recording already uploaded, reusing existing link");
            existing.clone()
        } else if let Some(project_path) = ctx.project_path.as_ref() {
            info!(path = %project_path.display(), "Automation: uploading recording");
            let channel = tauri::ipc::Channel::new(|_| Ok(()));
            let result = crate::upload_exported_video(
                self.app.clone(),
                project_path.clone(),
                crate::UploadMode::Initial {
                    pre_created_video: None,
                },
                channel,
                organization_id.map(|s| s.to_string()),
            )
            .await?;

            match result {
                crate::UploadResult::Success(link) => link,
                crate::UploadResult::NotAuthenticated => {
                    return Err("Not authenticated for upload".to_string());
                }
                crate::UploadResult::UpgradeRequired => {
                    return Err("Upgrade required for upload".to_string());
                }
                crate::UploadResult::PlanCheckFailed => {
                    return Err("Plan check failed for upload".to_string());
                }
            }
        } else {
            return Err("No image or project path available for upload".to_string());
        };

        if copy_link {
            self.clipboard
                .write()
                .await
                .set_text(link.clone())
                .map_err(|e| format!("Failed to copy link: {e}"))?;
        }

        if open_in_browser {
            let _ = crate::open_external_link(self.app.clone(), link.clone());
        }

        Ok(())
    }

    async fn reveal_in_file_manager(&self, ctx: &TriggerContext) -> Result<(), String> {
        let path = ctx
            .image_path
            .as_ref()
            .or(ctx.output_path.as_ref())
            .or(ctx.project_path.as_ref())
            .ok_or("No path available to reveal")?;

        reveal_path(path)
    }

    async fn open_file(&self, ctx: &TriggerContext) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;

        let path = ctx
            .image_path
            .as_ref()
            .or(ctx.output_path.as_ref())
            .ok_or("No file path available to open")?;

        let path_str = path.to_str().ok_or("Invalid path")?;
        self.app
            .opener()
            .open_path(path_str, None::<String>)
            .map_err(|e| format!("Failed to open file: {e}"))?;

        Ok(())
    }

    async fn run_command(
        &self,
        ctx: &TriggerContext,
        program: &str,
        args: &[String],
        cwd: Option<&str>,
        env: &HashMap<String, String>,
        use_shell: bool,
    ) -> Result<(), String> {
        info!(program, "Automation: running command");

        let mut cmd = if use_shell {
            let shell_line = cap_automation::shell_command_line(program, args);

            #[cfg(target_os = "windows")]
            let mut c = tokio::process::Command::new("cmd");
            #[cfg(target_os = "windows")]
            c.args(["/C", &shell_line]);

            #[cfg(not(target_os = "windows"))]
            let mut c = tokio::process::Command::new("sh");
            #[cfg(not(target_os = "windows"))]
            c.args(["-c", &shell_line]);

            c
        } else {
            let mut c = tokio::process::Command::new(program);
            c.args(args);
            c
        };

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        for (k, v) in env {
            cmd.env(k, v);
        }

        if let Some(ref p) = ctx.project_path {
            cmd.env("CAP_PROJECT_PATH", p);
        }
        if let Some(ref p) = ctx.image_path {
            cmd.env("CAP_IMAGE_PATH", p);
        }
        if let Some(ref p) = ctx.output_path {
            cmd.env("CAP_OUTPUT_PATH", p);
        }
        if let Some(ref l) = ctx.share_link {
            cmd.env("CAP_SHARE_LINK", l);
        }

        // Kill the child if the timeout drops the future, so a hung command can't outlive the run.
        cmd.kill_on_drop(true);
        let output = tokio::time::timeout(COMMAND_TIMEOUT, cmd.output())
            .await
            .map_err(|_| format!("Command timed out after {}s", COMMAND_TIMEOUT.as_secs()))?
            .map_err(|e| format!("Failed to run command: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Command exited with {}: {}", output.status, stderr));
        }

        Ok(())
    }

    async fn webhook(
        &self,
        ctx: &TriggerContext,
        url: &str,
        method: &str,
        headers: &HashMap<String, String>,
        body_template: Option<&str>,
    ) -> Result<(), String> {
        info!(url, method, "Automation: sending webhook");

        let client = reqwest::Client::builder()
            .timeout(WEBHOOK_TIMEOUT)
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|e| format!("Invalid HTTP method: {e}"))?;

        let body = if let Some(tmpl) = body_template {
            apply_body_template(tmpl, ctx)
        } else {
            serde_json::to_string(&serde_json::json!({
                "project_path": ctx.project_path,
                "image_path": ctx.image_path,
                "output_path": ctx.output_path,
                "share_link": ctx.share_link,
            }))
            .map_err(|e| format!("Failed to serialize webhook body: {e}"))?
        };

        let mut req = client.request(method, url).body(body);
        for (k, v) in headers {
            req = req.header(k, v);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("Webhook request failed: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("Webhook returned status {}", resp.status()));
        }

        Ok(())
    }

    async fn recognize_text_to_clipboard(&self, ctx: &TriggerContext) -> Result<(), String> {
        let path = ctx
            .image_path
            .as_ref()
            .or(ctx.output_path.as_ref())
            .ok_or("No image path available for OCR")?;

        info!(path = %path.display(), "Automation: recognizing text");

        let text = crate::screenshot_editor::recognize_text_from_image_path(path).await?;

        if text.trim().is_empty() {
            return Err("No text recognized in image".to_string());
        }

        self.clipboard
            .write()
            .await
            .set_text(text)
            .map_err(|e| format!("Failed to set clipboard text: {e}"))?;

        Ok(())
    }

    async fn notify(
        &self,
        ctx: &TriggerContext,
        title_template: &str,
        body_template: &str,
    ) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;

        let enabled = crate::general_settings::GeneralSettingsStore::get(&self.app)
            .map(|s| s.is_some_and(|s| s.enable_notifications))
            .unwrap_or(false);

        if !enabled {
            return Ok(());
        }

        let title = apply_body_template(&apply_filename_template(title_template, ctx), ctx);
        let body = apply_body_template(&apply_filename_template(body_template, ctx), ctx);

        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| format!("Failed to send notification: {e}"))?;

        Ok(())
    }

    async fn open_editor(&self, ctx: &TriggerContext) -> Result<(), String> {
        if let Some(image_path) = ctx.image_path.as_ref() {
            let _ = crate::windows::ShowCapWindow::ScreenshotEditor {
                path: image_path.clone(),
            }
            .show(&self.app)
            .await;
            return Ok(());
        }

        let path = ctx
            .project_path
            .as_ref()
            .ok_or("No project path for editor")?;

        let _ = crate::windows::ShowCapWindow::Editor {
            project_path: path.clone(),
        }
        .show(&self.app)
        .await;

        Ok(())
    }

    async fn apply_preset(&self, ctx: &TriggerContext, name: &str) -> Result<(), String> {
        let project_path = ctx
            .project_path
            .as_ref()
            .ok_or("No project path for preset")?;

        let preset = crate::presets::PresetsStore::get_by_name(&self.app, name)?
            .ok_or_else(|| format!("Preset '{name}' not found"))?;

        info!(preset = name, project = %project_path.display(), "Automation: applying preset");

        let existing_timeline = cap_project::ProjectConfiguration::load(project_path)
            .ok()
            .and_then(|c| c.timeline);

        let mut config = preset.config;
        if config.timeline.is_none() {
            config.timeline = existing_timeline;
        }

        config
            .write(project_path)
            .map_err(|e| format!("Failed to write project config: {e}"))?;

        Ok(())
    }

    async fn delete_local_files(&self, ctx: &TriggerContext) -> Result<(), String> {
        let path = ctx
            .project_path
            .as_ref()
            .ok_or("No project path for deletion")?;

        info!(path = %path.display(), "Automation: deleting local files");
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|e| format!("Failed to delete: {e}"))?;

        Ok(())
    }
}

fn reveal_path(path: &Path) -> Result<(), String> {
    let path_str = path.to_str().ok_or("Invalid path")?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path_str)
            .spawn()
            .map_err(|e| format!("Failed to reveal: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", path_str])
            .spawn()
            .map_err(|e| format!("Failed to reveal: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let parent = path.parent().and_then(|p| p.to_str()).unwrap_or(path_str);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Failed to reveal: {e}"))?;
    }

    Ok(())
}

fn build_desktop_export_settings(profile: &ExportProfile) -> crate::export::ExportSettings {
    let compression = profile
        .compression
        .map(|c| match c {
            AutomationExportCompression::Maximum => cap_export::mp4::ExportCompression::Maximum,
            AutomationExportCompression::Social => cap_export::mp4::ExportCompression::Social,
            AutomationExportCompression::Web => cap_export::mp4::ExportCompression::Web,
            AutomationExportCompression::Potato => cap_export::mp4::ExportCompression::Potato,
        })
        .unwrap_or(cap_export::mp4::ExportCompression::Web);

    match profile.format {
        ExportFormat::Mp4 => {
            crate::export::ExportSettings::Mp4(cap_export::mp4::Mp4ExportSettings {
                fps: profile.fps,
                resolution_base: profile.resolution_base,
                compression,
                custom_bpp: None,
                force_ffmpeg_decoder: false,
                optimize_filesize: false,
            })
        }
        ExportFormat::Gif => {
            crate::export::ExportSettings::Gif(cap_export::gif::GifExportSettings {
                fps: profile.fps,
                resolution_base: profile.resolution_base,
                quality: None,
            })
        }
        ExportFormat::Mov => {
            crate::export::ExportSettings::Mov(cap_export::mov::MovExportSettings {
                fps: profile.fps,
                resolution_base: profile.resolution_base,
                cursor_only: false,
            })
        }
    }
}

fn apply_filename_template(template: &str, ctx: &TriggerContext) -> String {
    let now = chrono::Local::now();
    let mut result = template.to_string();
    result = result.replace("{date}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{time}", &now.format("%H-%M-%S").to_string());
    result = result.replace("{datetime}", &now.format("%Y-%m-%d_%H-%M-%S").to_string());
    if let Some(ref title) = ctx.window_title {
        result = result.replace("{window}", &sanitize_filename_component(title));
    }
    result
}

fn apply_body_template(template: &str, ctx: &TriggerContext) -> String {
    let mut result = template.to_string();
    if let Some(ref p) = ctx.project_path {
        result = result.replace("{project_path}", &p.to_string_lossy());
    }
    if let Some(ref p) = ctx.image_path {
        result = result.replace("{image_path}", &p.to_string_lossy());
    }
    if let Some(ref p) = ctx.output_path {
        result = result.replace("{output_path}", &p.to_string_lossy());
    }
    if let Some(ref l) = ctx.share_link {
        result = result.replace("{share_link}", l);
    }
    result
}

pub fn capture_target_kind(target: &ScreenCaptureTarget) -> Option<CaptureTargetKind> {
    match target {
        ScreenCaptureTarget::Window { .. } => Some(CaptureTargetKind::Window),
        ScreenCaptureTarget::Display { .. } => Some(CaptureTargetKind::Display),
        ScreenCaptureTarget::Area { .. } => Some(CaptureTargetKind::Area),
        ScreenCaptureTarget::CameraOnly => None,
    }
}

fn build_host(app: &AppHandle) -> Option<DesktopAutomationHost> {
    let clipboard = app
        .try_state::<Arc<RwLock<ClipboardContext>>>()
        .map(|s| s.inner().clone())?;
    Some(DesktopAutomationHost::new(app.clone(), clipboard))
}

pub async fn run_trigger(app: &AppHandle, trigger: Trigger, ctx: TriggerContext) {
    let store = match get_store(app) {
        Ok(Some(store)) => store,
        Ok(None) => return,
        Err(e) => {
            error!("Failed to load automations store: {e}");
            return;
        }
    };

    if store.rules.is_empty() {
        return;
    }

    let Some(host) = build_host(app) else {
        warn!("Automation host unavailable (clipboard state missing)");
        return;
    };

    let results = cap_automation::run(&host, &store, &trigger, &ctx).await;
    for result in &results {
        for action in &result.action_results {
            if let Some(error) = &action.error {
                warn!(
                    rule_id = %result.rule_id,
                    error = %error,
                    "Automation action did not complete"
                );
            }
        }
    }
}

pub fn should_open_screenshot_editor(app: &AppHandle, target: &ScreenCaptureTarget) -> bool {
    let store = match get_store(app) {
        Ok(Some(store)) => store,
        _ => return true,
    };

    if store.rules.is_empty() {
        return true;
    }

    let mut ctx = TriggerContext::new();
    if let Some(kind) = capture_target_kind(target) {
        ctx = ctx.with_capture_target(kind);
    }
    if let Some(title) = target.title() {
        ctx = ctx.with_window_title(title);
    }

    !cap_automation::has_skip_editor(&store, &Trigger::ScreenshotTaken, &ctx)
}

// `None` means a matching `SkipEditor` rule asked for a headless flow, so the caller must suppress
// both the editor and the recordings overlay. Automation rules win over the user's default behaviour.
pub fn studio_recording_editor_behaviour(
    app: &AppHandle,
    project_path: &Path,
    duration_secs: f64,
    default: PostStudioRecordingBehaviour,
) -> Option<PostStudioRecordingBehaviour> {
    let store = match get_store(app) {
        Ok(Some(store)) if !store.rules.is_empty() => store,
        _ => return Some(default),
    };

    let mut ctx = TriggerContext::new()
        .with_project_path(project_path.to_path_buf())
        .with_recording_mode(AutomationRecordingMode::Studio);
    if duration_secs > 0.0 {
        ctx = ctx.with_duration(duration_secs);
    }

    if cap_automation::has_skip_editor(&store, &Trigger::StudioRecordingFinished, &ctx) {
        None
    } else if cap_automation::has_open_editor(&store, &Trigger::StudioRecordingFinished, &ctx) {
        Some(PostStudioRecordingBehaviour::OpenEditor)
    } else {
        Some(default)
    }
}

pub fn run_screenshot_automations(
    app: AppHandle,
    image_path: PathBuf,
    target: &ScreenCaptureTarget,
) {
    let project_path = image_path.parent().map(Path::to_path_buf);
    let capture_target = capture_target_kind(target);
    let window_title = target.title();

    tokio::spawn(async move {
        let mut ctx = TriggerContext::new().with_image_path(image_path);
        if let Some(project_path) = project_path {
            ctx = ctx.with_project_path(project_path);
        }
        if let Some(kind) = capture_target {
            ctx = ctx.with_capture_target(kind);
        }
        if let Some(title) = window_title {
            ctx = ctx.with_window_title(title);
        }

        run_trigger(&app, Trigger::ScreenshotTaken, ctx).await;
    });
}

pub fn run_studio_recording_automations(app: AppHandle, project_path: PathBuf, duration_secs: f64) {
    tokio::spawn(async move {
        let mut ctx = TriggerContext::new()
            .with_project_path(project_path)
            .with_recording_mode(AutomationRecordingMode::Studio);
        if duration_secs > 0.0 {
            ctx = ctx.with_duration(duration_secs);
        }
        run_trigger(&app, Trigger::StudioRecordingFinished, ctx).await;
    });
}

pub fn run_instant_recording_automations(
    app: AppHandle,
    project_path: PathBuf,
    share_link: Option<String>,
    share_id: Option<String>,
) {
    tokio::spawn(async move {
        let mut ctx = TriggerContext::new()
            .with_project_path(project_path)
            .with_recording_mode(AutomationRecordingMode::Instant);
        if let Some(link) = share_link {
            ctx = ctx.with_share_link(link);
        }
        if let Some(id) = share_id {
            ctx = ctx.with_share_id(id);
        }
        run_trigger(&app, Trigger::InstantRecordingFinished, ctx).await;
    });
}

pub fn run_upload_completed_automations(
    app: AppHandle,
    project_path: PathBuf,
    share_link: Option<String>,
    share_id: Option<String>,
) {
    tokio::spawn(async move {
        let mut ctx = TriggerContext::new().with_project_path(project_path);
        if let Some(link) = share_link {
            ctx = ctx.with_share_link(link);
        }
        if let Some(id) = share_id {
            ctx = ctx.with_share_id(id);
        }
        run_trigger(&app, Trigger::UploadCompleted, ctx).await;
    });
}

pub fn run_video_imported_automations(app: AppHandle, project_path: PathBuf) {
    tokio::spawn(async move {
        let ctx = TriggerContext::new().with_project_path(project_path);
        run_trigger(&app, Trigger::VideoImported, ctx).await;
    });
}

pub fn run_recording_started_automations(app: AppHandle) {
    tokio::spawn(async move {
        run_trigger(&app, Trigger::RecordingStarted, TriggerContext::new()).await;
    });
}

pub fn run_recording_deleted_automations(app: AppHandle, project_path: PathBuf) {
    tokio::spawn(async move {
        let ctx = TriggerContext::new().with_project_path(project_path);
        run_trigger(&app, Trigger::RecordingDeleted, ctx).await;
    });
}

pub fn get_store(app: &AppHandle<Wry>) -> Result<Option<AutomationsStore>, String> {
    match app.store("store").map(|s| s.get("automations")) {
        Ok(Some(store)) => match serde_json::from_value(store) {
            Ok(settings) => Ok(Some(settings)),
            Err(e) => {
                error!("Failed to deserialize automations store: {e}");
                Ok(None)
            }
        },
        _ => Ok(None),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_automations(app: AppHandle) -> Result<AutomationsStore, String> {
    Ok(get_store(&app)?.unwrap_or_default())
}

#[tauri::command]
#[specta::specta]
pub async fn set_automations(app: AppHandle, store: AutomationsStore) -> Result<(), String> {
    let tauri_store = app.store("store").map_err(|e| e.to_string())?;
    tauri_store.set("automations", json!(store));
    tauri_store.save().map_err(|e| e.to_string())
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutomationActionCheck {
    pub action_type: String,
    pub capability: String,
    pub supported: bool,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTestReport {
    pub rule_id: String,
    pub rule_name: String,
    pub action_checks: Vec<AutomationActionCheck>,
}

#[tauri::command]
#[specta::specta]
pub async fn test_automation(
    app: AppHandle,
    rule_id: String,
) -> Result<AutomationTestReport, String> {
    let store = get_store(&app)?.unwrap_or_default();
    let rule = store
        .rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| format!("Rule '{rule_id}' not found"))?;

    let clipboard = app
        .try_state::<Arc<RwLock<ClipboardContext>>>()
        .map(|s| s.inner().clone());

    let supported: Vec<Capability> = if let Some(clipboard) = clipboard {
        let host = DesktopAutomationHost::new(app.clone(), clipboard);
        host.capabilities().to_vec()
    } else {
        Vec::new()
    };

    let action_checks = rule
        .actions
        .iter()
        .map(|action| {
            let cap = action.required_capability();
            AutomationActionCheck {
                action_type: format!("{action:?}")
                    .split_whitespace()
                    .next()
                    .unwrap_or("Unknown")
                    .to_string(),
                capability: cap.map_or_else(|| "None".to_string(), |c| format!("{c:?}")),
                supported: cap.is_none_or(|c| supported.contains(&c)),
            }
        })
        .collect();

    Ok(AutomationTestReport {
        rule_id: rule.id.clone(),
        rule_name: rule.name.clone(),
        action_checks,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn automation_should_open_screenshot_editor(
    app: AppHandle,
    target: ScreenCaptureTarget,
) -> bool {
    should_open_screenshot_editor(&app, &target)
}

#[tauri::command]
#[specta::specta]
pub async fn list_automation_capabilities() -> Vec<String> {
    vec![
        "CopyToClipboard".to_string(),
        "SaveToLocation".to_string(),
        "Export".to_string(),
        "Upload".to_string(),
        "RevealInFileManager".to_string(),
        "OpenFile".to_string(),
        "RunCommand".to_string(),
        "Webhook".to_string(),
        "RecognizeText".to_string(),
        "Notify".to_string(),
        "OpenEditor".to_string(),
        "ApplyPreset".to_string(),
        "DeleteLocalFiles".to_string(),
    ]
}
