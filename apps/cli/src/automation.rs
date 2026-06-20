//! Runs Cap automation rules from the CLI, sharing the exact rule model and engine the desktop app
//! uses (`cap_automation`). Rules are authored in Cap Desktop and persisted to its tauri-plugin-store
//! file; the CLI reads that file directly (same approach as `credentials.rs`) so a rule like
//! "on screenshot, save to ~/Shots" is honored whether the capture came from the app or `cap`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cap_automation::{
    AutomationExportCompression, AutomationHost, AutomationRecordingMode, AutomationsStore,
    Capability, ClipboardSource, ExportDestination, ExportFormat, ExportProfile, Trigger,
    TriggerContext, sanitize_filename_component,
};
use cap_recording::screen_capture::ScreenCaptureTarget;
use serde_json::Value;

const DESKTOP_BUNDLE_IDS: [&str; 2] = ["so.cap.desktop", "so.cap.desktop.dev"];

const WEBHOOK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

fn load_desktop_store_value() -> Option<Value> {
    let data_dir = dirs::data_dir()?;
    DESKTOP_BUNDLE_IDS.into_iter().find_map(|id| {
        let bytes = std::fs::read(data_dir.join(id).join("store")).ok()?;
        serde_json::from_slice::<Value>(&bytes).ok()
    })
}

pub fn load_store() -> Option<AutomationsStore> {
    cap_automation::load_store_from_json(&load_desktop_store_value()?)
}

/// `(total_rules, enabled_rules)` configured in Cap Desktop, for `cap doctor`.
pub fn rule_counts() -> (usize, usize) {
    let store = load_store().unwrap_or_default();
    let enabled = store.rules.iter().filter(|r| r.enabled).count();
    (store.rules.len(), enabled)
}

fn capture_target_kind(target: &ScreenCaptureTarget) -> Option<cap_automation::CaptureTargetKind> {
    match target {
        ScreenCaptureTarget::Window { .. } => Some(cap_automation::CaptureTargetKind::Window),
        ScreenCaptureTarget::Display { .. } => Some(cap_automation::CaptureTargetKind::Display),
        ScreenCaptureTarget::Area { .. } => Some(cap_automation::CaptureTargetKind::Area),
        ScreenCaptureTarget::CameraOnly => None,
    }
}

struct CliAutomationHost;

impl AutomationHost for CliAutomationHost {
    fn capabilities(&self) -> &[Capability] {
        &[
            Capability::SaveToLocation,
            Capability::Export,
            Capability::Upload,
            Capability::RevealInFileManager,
            Capability::OpenFile,
            Capability::RunCommand,
            Capability::Webhook,
            Capability::ApplyPreset,
            Capability::DeleteLocalFiles,
        ]
    }

    async fn copy_to_clipboard(
        &self,
        _ctx: &TriggerContext,
        _source: &ClipboardSource,
    ) -> Result<(), String> {
        Err("Clipboard is not available from the CLI".to_string())
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

        let filename = match filename_template {
            Some(tmpl) => apply_filename_template(tmpl, ctx),
            None => src
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "capture".to_string()),
        };

        let dst = PathBuf::from(dir).join(filename);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
        }
        std::fs::copy(src, &dst).map_err(|e| format!("Failed to copy file: {e}"))?;
        tracing::info!(dst = %dst.display(), "automation: saved file");
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

        let result = match profile.format {
            ExportFormat::Mp4 => {
                cap_export::mp4::Mp4ExportSettings {
                    fps: profile.fps,
                    resolution_base: profile.resolution_base,
                    compression: map_compression(profile.compression),
                    custom_bpp: None,
                    force_ffmpeg_decoder: false,
                    optimize_filesize: false,
                }
                .export(base, |_| true)
                .await
            }
            ExportFormat::Gif => {
                cap_export::gif::GifExportSettings {
                    fps: profile.fps,
                    resolution_base: profile.resolution_base,
                    quality: None,
                }
                .export(base, |_| true)
                .await
            }
            ExportFormat::Mov => {
                cap_export::mov::MovExportSettings {
                    fps: profile.fps,
                    resolution_base: profile.resolution_base,
                    cursor_only: false,
                }
                .export(base, |_| true)
                .await
            }
        }
        .map_err(|e| format!("Export failed: {e}"))?;

        tracing::info!(output = %result.display(), "automation: export complete");
        Ok(())
    }

    async fn upload(
        &self,
        ctx: &TriggerContext,
        _organization_id: Option<&str>,
        _copy_link: bool,
        open_in_browser: bool,
    ) -> Result<(), String> {
        if let Some(link) = ctx.share_link.as_deref() {
            tracing::info!(link = %link, "automation: recording already uploaded, reusing link");
            if open_in_browser {
                open_path_or_url(link)?;
            }
            return Ok(());
        }

        let project_path = ctx
            .project_path
            .as_ref()
            .ok_or("CLI upload supports recordings only (no project path available)")?;

        let meta = cap_project::RecordingMeta::load_for_project(project_path)
            .map_err(|e| format!("Failed to load project: {e}"))?;
        let output = meta.output_path();
        if !output.exists() {
            return Err(format!(
                "No exported video at {}; add an Export action before Upload",
                output.display()
            ));
        }

        let link =
            crate::upload::upload_video_path(&output, Some(meta.pretty_name.clone())).await?;
        tracing::info!(link = %link, "automation: upload complete");
        if open_in_browser {
            open_path_or_url(&link)?;
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
        open_path_or_url(&path.to_string_lossy())
    }

    async fn open_file(&self, ctx: &TriggerContext) -> Result<(), String> {
        let path = ctx
            .image_path
            .as_ref()
            .or(ctx.output_path.as_ref())
            .ok_or("No file path available to open")?;
        open_path_or_url(&path.to_string_lossy())
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
        for (key, value) in context_env(ctx) {
            cmd.env(key, value);
        }

        // Kill the child if the timeout drops the future, so a hung command can't outlive the run.
        cmd.kill_on_drop(true);
        let output = tokio::time::timeout(COMMAND_TIMEOUT, cmd.output())
            .await
            .map_err(|_| format!("Command timed out after {}s", COMMAND_TIMEOUT.as_secs()))?
            .map_err(|e| format!("Failed to run command: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "Command exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            ));
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

    async fn recognize_text_to_clipboard(&self, _ctx: &TriggerContext) -> Result<(), String> {
        Err("OCR is not available from the CLI".to_string())
    }

    async fn notify(
        &self,
        _ctx: &TriggerContext,
        _title_template: &str,
        _body_template: &str,
    ) -> Result<(), String> {
        Err("Notifications are not available from the CLI".to_string())
    }

    async fn open_editor(&self, _ctx: &TriggerContext) -> Result<(), String> {
        Err("Opening the editor is not available from the CLI".to_string())
    }

    async fn apply_preset(&self, ctx: &TriggerContext, name: &str) -> Result<(), String> {
        let project_path = ctx
            .project_path
            .as_ref()
            .ok_or("No project path for preset")?;

        let store = load_desktop_store_value().ok_or("Cap Desktop store not found")?;
        let presets = store
            .get("presets")
            .and_then(|p| p.get("presets"))
            .and_then(Value::as_array)
            .ok_or("No presets found in Cap Desktop store")?;

        let preset = presets
            .iter()
            .find(|p| p.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| format!("Preset '{name}' not found"))?;

        let config_value = preset.get("config").ok_or("Preset has no config")?;
        let mut config: cap_project::ProjectConfiguration =
            serde_json::from_value(config_value.clone())
                .map_err(|e| format!("Failed to parse preset config: {e}"))?;

        if config.timeline.is_none() {
            config.timeline = cap_project::ProjectConfiguration::load(project_path)
                .ok()
                .and_then(|c| c.timeline);
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
        std::fs::remove_dir_all(path).map_err(|e| format!("Failed to delete: {e}"))
    }
}

fn map_compression(
    compression: Option<AutomationExportCompression>,
) -> cap_export::mp4::ExportCompression {
    match compression {
        Some(AutomationExportCompression::Maximum) => cap_export::mp4::ExportCompression::Maximum,
        Some(AutomationExportCompression::Social) => cap_export::mp4::ExportCompression::Social,
        Some(AutomationExportCompression::Web) | None => cap_export::mp4::ExportCompression::Web,
        Some(AutomationExportCompression::Potato) => cap_export::mp4::ExportCompression::Potato,
    }
}

fn context_env(ctx: &TriggerContext) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    if let Some(p) = &ctx.project_path {
        env.push(("CAP_PROJECT_PATH", p.to_string_lossy().to_string()));
    }
    if let Some(p) = &ctx.image_path {
        env.push(("CAP_IMAGE_PATH", p.to_string_lossy().to_string()));
    }
    if let Some(p) = &ctx.output_path {
        env.push(("CAP_OUTPUT_PATH", p.to_string_lossy().to_string()));
    }
    if let Some(l) = &ctx.share_link {
        env.push(("CAP_SHARE_LINK", l.clone()));
    }
    env
}

fn apply_filename_template(template: &str, ctx: &TriggerContext) -> String {
    let now = chrono::Local::now();
    let mut result = template.to_string();
    result = result.replace("{date}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{time}", &now.format("%H-%M-%S").to_string());
    result = result.replace("{datetime}", &now.format("%Y-%m-%d_%H-%M-%S").to_string());
    if let Some(title) = &ctx.window_title {
        result = result.replace("{window}", &sanitize_filename_component(title));
    }
    result
}

fn apply_body_template(template: &str, ctx: &TriggerContext) -> String {
    let mut result = template.to_string();
    if let Some(p) = &ctx.project_path {
        result = result.replace("{project_path}", &p.to_string_lossy());
    }
    if let Some(p) = &ctx.image_path {
        result = result.replace("{image_path}", &p.to_string_lossy());
    }
    if let Some(p) = &ctx.output_path {
        result = result.replace("{output_path}", &p.to_string_lossy());
    }
    if let Some(l) = &ctx.share_link {
        result = result.replace("{share_link}", l);
    }
    result
}

fn open_path_or_url(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");

    cmd.arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open: {e}"))
}

async fn run_trigger(trigger: Trigger, ctx: TriggerContext) {
    let Some(store) = load_store() else {
        return;
    };
    if store.rules.is_empty() {
        return;
    }

    let host = CliAutomationHost;
    let results = cap_automation::run(&host, &store, &trigger, &ctx).await;
    for result in &results {
        for action in &result.action_results {
            if let Some(error) = &action.error {
                tracing::warn!(
                    rule_id = %result.rule_id,
                    error = %error,
                    "automation action skipped or failed"
                );
            }
        }
    }
}

pub async fn run_screenshot(path: &Path, target: &ScreenCaptureTarget) {
    if load_store().is_none() {
        return;
    }

    let mut ctx = TriggerContext::new().with_image_path(path.to_path_buf());
    if let Some(kind) = capture_target_kind(target) {
        ctx = ctx.with_capture_target(kind);
    }
    if let Some(title) = target.title() {
        ctx = ctx.with_window_title(title);
    }
    run_trigger(Trigger::ScreenshotTaken, ctx).await;
}

pub async fn run_recording_finished(project_path: &Path, mode: AutomationRecordingMode) {
    if load_store().is_none() {
        return;
    }

    let trigger = match mode {
        AutomationRecordingMode::Studio => Trigger::StudioRecordingFinished,
        AutomationRecordingMode::Instant => Trigger::InstantRecordingFinished,
    };

    let mut ctx = TriggerContext::new()
        .with_project_path(project_path.to_path_buf())
        .with_recording_mode(mode);

    if let Ok(meta) = cap_project::RecordingMeta::load_for_project(project_path)
        && let Some(sharing) = meta.sharing
    {
        ctx = ctx.with_share_link(sharing.link).with_share_id(sharing.id);
    }

    run_trigger(trigger, ctx).await;
}

pub async fn run_upload_completed(project_path: &Path, link: &str, id: &str) {
    if load_store().is_none() {
        return;
    }

    let ctx = TriggerContext::new()
        .with_project_path(project_path.to_path_buf())
        .with_share_link(link.to_string())
        .with_share_id(id.to_string());
    run_trigger(Trigger::UploadCompleted, ctx).await;
}

/// `cap automations list` — print the automation rules shared with Cap Desktop.
pub fn list(format: crate::OutputFormat) -> Result<(), String> {
    let store = load_store().unwrap_or_default();

    match format {
        crate::OutputFormat::Json => crate::write_json(&store),
        crate::OutputFormat::Text => {
            if store.rules.is_empty() {
                println!(
                    "No automations configured. Add them in Cap Desktop under Settings > Automations."
                );
                return Ok(());
            }
            for rule in &store.rules {
                let status = if rule.enabled { "enabled" } else { "disabled" };
                println!("{} [{}]", rule.name, status);
                println!("  trigger: {:?}", rule.trigger);
                if !rule.conditions.is_empty() {
                    println!("  conditions ({:?}):", rule.match_mode);
                    for condition in &rule.conditions {
                        println!("    - {condition:?}");
                    }
                }
                println!("  actions:");
                for action in &rule.actions {
                    match action.required_capability() {
                        Some(cap) => println!("    - {cap:?}"),
                        None => println!("    - SkipEditor"),
                    }
                }
            }
            Ok(())
        }
    }
}
