use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use cap_automation::{
    Action, AutomationExportCompression, AutomationHost, AutomationRecordingMode, AutomationsStore,
    Capability, CaptureTargetKind, ClipboardSource, Condition, ExportDestination, ExportFormat,
    ExportProfile, PrecedingAction, Trigger, TriggerContext, sanitize_filename_component,
};
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::App;

const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);
const REMEMBERED_EVENTS: usize = 256;

enum UiRequest {
    CopyImage(PathBuf),
    CopyText(String),
    OpenUrl(String),
    Reveal(PathBuf),
    Open(PathBuf),
    OpenEditor(PathBuf),
    OpenScreenshotEditor(PathBuf),
    DeleteScreenshot(PathBuf),
    LibraryChanged,
}

struct UiMessage {
    request: UiRequest,
    reply: flume::Sender<Result<(), String>>,
}

enum UiOutcome {
    Done(Result<(), String>),
    Pending(gpui::Task<Result<(), String>>),
}

struct Runtime {
    handle: tokio::runtime::Handle,
    ui: flume::Sender<UiMessage>,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

pub fn init(cx: &mut App) {
    let (ui, requests) = flume::unbounded::<UiMessage>();
    let runtime = Runtime {
        handle: gpui_tokio::Tokio::handle(cx),
        ui,
    };
    if RUNTIME.set(runtime).is_err() {
        return;
    }
    cx.spawn(async move |cx| {
        while let Ok(message) = requests.recv_async().await {
            let outcome = cx.update(|cx| handle_ui_request(message.request, cx));
            let result = match outcome {
                UiOutcome::Done(result) => result,
                UiOutcome::Pending(task) => task.await,
            };
            let _ = message.reply.send(result);
        }
    })
    .detach();
}

fn handle_ui_request(request: UiRequest, cx: &mut App) -> UiOutcome {
    match request {
        UiRequest::CopyImage(path) => {
            UiOutcome::Pending(crate::platform::copy_image_to_clipboard(path, cx))
        }
        UiRequest::CopyText(text) => {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            UiOutcome::Done(Ok(()))
        }
        UiRequest::OpenUrl(url) => {
            cx.open_url(&url);
            UiOutcome::Done(Ok(()))
        }
        UiRequest::Reveal(path) => {
            crate::library::reveal_path(&path, cx);
            UiOutcome::Done(Ok(()))
        }
        UiRequest::Open(path) => {
            crate::library::open_with_system(&path, cx);
            UiOutcome::Done(Ok(()))
        }
        UiRequest::OpenEditor(path) => {
            crate::app_windows::open_editor(path, cx);
            UiOutcome::Done(Ok(()))
        }
        UiRequest::OpenScreenshotEditor(path) => {
            crate::app_windows::open_screenshot_editor(path, cx);
            UiOutcome::Done(Ok(()))
        }
        UiRequest::DeleteScreenshot(bundle) => UiOutcome::Done(
            crate::app_windows::delete_screenshot_for_automation(&bundle, cx),
        ),
        UiRequest::LibraryChanged => {
            crate::app_windows::refresh_library_after_delete(cx);
            UiOutcome::Done(Ok(()))
        }
    }
}

async fn ui(request: UiRequest) -> Result<(), String> {
    let runtime = RUNTIME
        .get()
        .ok_or_else(|| "Cap is not ready to run this action".to_string())?;
    let (reply, response) = flume::bounded(1);
    runtime
        .ui
        .send(UiMessage { request, reply })
        .map_err(|_| "Cap is closing".to_string())?;
    response
        .recv_async()
        .await
        .map_err(|_| "Cap is closing".to_string())?
}

#[cfg(not(test))]
fn load_store() -> Option<AutomationsStore> {
    parse_store(crate::store::automations_value()?)
}

fn parse_store(value: serde_json::Value) -> Option<AutomationsStore> {
    match serde_json::from_value(value) {
        Ok(store) => Some(store),
        Err(error) => {
            tracing::error!("deserializing the automations store: {error}");
            None
        }
    }
}

#[cfg(test)]
fn load_store() -> Option<AutomationsStore> {
    None
}

fn store_for(trigger: Trigger) -> Option<AutomationsStore> {
    load_store().filter(|store| has_enabled_rule(store, trigger))
}

fn has_enabled_rule(store: &AutomationsStore, trigger: Trigger) -> bool {
    store
        .rules
        .iter()
        .any(|rule| rule.enabled && rule.trigger == trigger)
}

struct FiredEvents(Mutex<VecDeque<(Trigger, PathBuf)>>);

impl FiredEvents {
    const fn new() -> Self {
        Self(Mutex::new(VecDeque::new()))
    }

    fn claim(&self, trigger: Trigger, key: &Path) -> bool {
        let mut fired = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if fired
            .iter()
            .any(|(seen, path)| *seen == trigger && path == key)
        {
            return false;
        }
        if fired.len() >= REMEMBERED_EVENTS {
            fired.pop_front();
        }
        fired.push_back((trigger, key.to_path_buf()));
        true
    }
}

static FIRED: FiredEvents = FiredEvents::new();

fn spawn_run(
    trigger: Trigger,
    key: &Path,
    build: impl FnOnce(&AutomationsStore) -> TriggerContext + Send + 'static,
) {
    let Some(store) = store_for(trigger) else {
        return;
    };
    if !FIRED.claim(trigger, key) {
        tracing::warn!(?trigger, path = %key.display(), "automations already ran for this event");
        return;
    }
    let Some(runtime) = RUNTIME.get() else {
        tracing::warn!(?trigger, "automations are not ready; skipping");
        return;
    };
    runtime.handle.spawn(async move {
        let store = Arc::new(store);
        let context_store = store.clone();
        let ctx = match tokio::task::spawn_blocking(move || build(&context_store)).await {
            Ok(ctx) => ctx,
            Err(error) => {
                tracing::error!(?trigger, %error, "building the automation context failed");
                return;
            }
        };
        run_trigger(&store, trigger, ctx).await;
    });
}

async fn run_trigger(store: &AutomationsStore, trigger: Trigger, ctx: TriggerContext) {
    let host = GpuiAutomationHost::default();
    let results = cap_automation::run(&host, store, &trigger, &ctx).await;
    for result in &results {
        for action in &result.action_results {
            match &action.error {
                Some(error) => tracing::warn!(
                    rule_id = %result.rule_id,
                    action = action_name(&action.action),
                    %error,
                    "automation action did not complete"
                ),
                None => tracing::info!(
                    rule_id = %result.rule_id,
                    action = action_name(&action.action),
                    "automation action completed"
                ),
            }
        }
    }
}

fn action_name(action: &Action) -> &'static str {
    match action {
        Action::CopyToClipboard { .. } => "copyToClipboard",
        Action::SaveToLocation { .. } => "saveToLocation",
        Action::Export { .. } => "export",
        Action::Upload { .. } => "upload",
        Action::RevealInFileManager => "revealInFileManager",
        Action::OpenFile => "openFile",
        Action::RunCommand { .. } => "runCommand",
        Action::Webhook { .. } => "webhook",
        Action::RecognizeTextToClipboard => "recognizeTextToClipboard",
        Action::Notify { .. } => "notify",
        Action::OpenEditor => "openEditor",
        Action::SkipEditor => "skipEditor",
        Action::ApplyPreset { .. } => "applyPreset",
        Action::DeleteLocalFiles => "deleteLocalFiles",
    }
}

pub fn recording_started(project_dir: &Path) {
    spawn_run(Trigger::RecordingStarted, project_dir, |_| {
        TriggerContext::new()
    });
}

pub fn studio_recording_finished(project_dir: PathBuf) {
    let key = project_dir.clone();
    spawn_run(Trigger::StudioRecordingFinished, &key, move |store| {
        studio_context(project_dir, store)
    });
}

fn studio_context(project_dir: PathBuf, store: &AutomationsStore) -> TriggerContext {
    let ctx = TriggerContext::new()
        .with_project_path(project_dir.clone())
        .with_recording_mode(AutomationRecordingMode::Studio);
    if !rules_use_duration(store, Trigger::StudioRecordingFinished) {
        return ctx;
    }
    match studio_duration_secs(&project_dir) {
        Some(duration) if duration > 0.0 => ctx.with_duration(duration),
        _ => ctx,
    }
}

fn rules_use_duration(store: &AutomationsStore, trigger: Trigger) -> bool {
    store.rules.iter().any(|rule| {
        rule.enabled
            && rule.trigger == trigger
            && rule.conditions.iter().any(|condition| {
                matches!(
                    condition,
                    Condition::DurationAtLeast { .. } | Condition::DurationAtMost { .. }
                )
            })
    })
}

fn studio_duration_secs(project_dir: &Path) -> Option<f64> {
    let meta = cap_project::RecordingMeta::load_for_project(project_dir).ok()?;
    let studio = meta.studio_meta()?;
    let owned = project_dir.to_path_buf();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        cap_rendering::ProjectRecordingsMeta::new(&owned, studio)
            .ok()
            .map(|recordings| recordings.duration())
    }))
    .ok()
    .flatten()
}

pub fn instant_recording_finished(
    project_dir: PathBuf,
    share_link: Option<String>,
    share_id: Option<String>,
) {
    let key = project_dir.clone();
    spawn_run(Trigger::InstantRecordingFinished, &key, move |_| {
        with_share(
            TriggerContext::new()
                .with_project_path(project_dir)
                .with_recording_mode(AutomationRecordingMode::Instant),
            share_link,
            share_id,
        )
    });
}

/// Called before the upload's local cleanup may remove the folder, so the
/// share link is read while the recording's metadata is still on disk.
pub fn upload_completed(project_dir: &Path, video_id: &str) {
    if store_for(Trigger::UploadCompleted).is_none() {
        return;
    }
    let share_link = cap_project::RecordingMeta::load_for_project(project_dir)
        .ok()
        .and_then(|meta| meta.sharing)
        .filter(|sharing| sharing.id == video_id)
        .map(|sharing| sharing.link);
    let project_dir = project_dir.to_path_buf();
    let video_id = video_id.to_string();
    let key = project_dir.clone();
    spawn_run(Trigger::UploadCompleted, &key, move |_| {
        with_share(
            TriggerContext::new().with_project_path(project_dir),
            share_link,
            Some(video_id),
        )
    });
}

fn with_share(
    mut ctx: TriggerContext,
    share_link: Option<String>,
    share_id: Option<String>,
) -> TriggerContext {
    if let Some(link) = share_link {
        ctx = ctx.with_share_link(link);
    }
    if let Some(id) = share_id {
        ctx = ctx.with_share_id(id);
    }
    ctx
}

pub fn video_imported(project_dir: PathBuf) {
    let key = project_dir.clone();
    spawn_run(Trigger::VideoImported, &key, move |_| {
        TriggerContext::new().with_project_path(project_dir)
    });
}

pub fn recording_deleted(project_dir: PathBuf) {
    let key = project_dir.clone();
    spawn_run(Trigger::RecordingDeleted, &key, move |_| {
        TriggerContext::new().with_project_path(project_dir)
    });
}

#[derive(Debug, Clone)]
pub struct ScreenshotTarget {
    kind: Option<CaptureTargetKind>,
    title: Option<String>,
}

fn capture_target_kind(target: &ScreenCaptureTarget) -> Option<CaptureTargetKind> {
    match target {
        ScreenCaptureTarget::Window { .. } => Some(CaptureTargetKind::Window),
        ScreenCaptureTarget::Display { .. } => Some(CaptureTargetKind::Display),
        ScreenCaptureTarget::Area { .. } => Some(CaptureTargetKind::Area),
        ScreenCaptureTarget::CameraOnly => None,
    }
}

/// `None` when no enabled rule listens for screenshots, so a capture with no
/// rules never looks up the window title.
pub fn screenshot_target(target: &ScreenCaptureTarget) -> Option<ScreenshotTarget> {
    store_for(Trigger::ScreenshotTaken)?;
    Some(ScreenshotTarget {
        kind: capture_target_kind(target),
        title: target.title(),
    })
}

fn screenshot_context(image_path: PathBuf, target: &ScreenshotTarget) -> TriggerContext {
    let mut ctx = TriggerContext::new();
    if let Some(project) = image_path.parent() {
        ctx = ctx.with_project_path(project.to_path_buf());
    }
    ctx = ctx.with_image_path(image_path);
    if let Some(kind) = target.kind {
        ctx = ctx.with_capture_target(kind);
    }
    if let Some(title) = target.title.clone() {
        ctx = ctx.with_window_title(title);
    }
    ctx
}

/// Whether a matching `SkipEditor` rule asks for the screenshot editor to
/// stay closed (`should_open_screenshot_editor` in 0.6.0).
pub fn screenshot_skips_editor(target: Option<&ScreenshotTarget>, image_path: &Path) -> bool {
    let (Some(target), Some(store)) = (target, store_for(Trigger::ScreenshotTaken)) else {
        return false;
    };
    cap_automation::has_skip_editor(
        &store,
        &Trigger::ScreenshotTaken,
        &screenshot_context(image_path.to_path_buf(), target),
    )
}

pub fn screenshot_taken(image_path: PathBuf, target: ScreenshotTarget) {
    let key = image_path.clone();
    spawn_run(Trigger::ScreenshotTaken, &key, move |_| {
        screenshot_context(image_path, &target)
    });
}

/// `studio_recording_editor_behaviour` in 0.6.0: a matching `SkipEditor`
/// keeps both the editor and Cap's windows away, a matching `OpenEditor`
/// opens the editor even when the setting says otherwise.
pub fn studio_editor_behaviour(
    project_dir: &Path,
    elapsed: Duration,
    default: crate::store::PostStudioBehaviour,
) -> crate::store::PostStudioBehaviour {
    match store_for(Trigger::StudioRecordingFinished) {
        Some(store) => studio_editor_behaviour_for(&store, project_dir, elapsed, default),
        None => default,
    }
}

fn studio_editor_behaviour_for(
    store: &AutomationsStore,
    project_dir: &Path,
    elapsed: Duration,
    default: crate::store::PostStudioBehaviour,
) -> crate::store::PostStudioBehaviour {
    let mut ctx = TriggerContext::new()
        .with_project_path(project_dir.to_path_buf())
        .with_recording_mode(AutomationRecordingMode::Studio);
    if !elapsed.is_zero() {
        ctx = ctx.with_duration(elapsed.as_secs_f64());
    }
    if cap_automation::has_skip_editor(store, &Trigger::StudioRecordingFinished, &ctx) {
        crate::store::PostStudioBehaviour::DoNothing
    } else if cap_automation::has_open_editor(store, &Trigger::StudioRecordingFinished, &ctx) {
        crate::store::PostStudioBehaviour::OpenEditor
    } else {
        default
    }
}

#[derive(Default)]
struct GpuiAutomationHost {
    last_output: Mutex<Option<PathBuf>>,
}

impl GpuiAutomationHost {
    fn remember_output(&self, path: PathBuf) {
        *self
            .last_output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(path);
    }

    fn last_output(&self) -> Option<PathBuf> {
        self.last_output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl AutomationHost for GpuiAutomationHost {
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
            Capability::OpenEditor,
            Capability::ApplyPreset,
            Capability::DeleteLocalFiles,
        ]
    }

    async fn copy_to_clipboard(
        &self,
        ctx: &TriggerContext,
        source: &ClipboardSource,
    ) -> Result<(), String> {
        ui(UiRequest::CopyImage(clipboard_image(ctx, *source)?)).await
    }

    async fn save_to_location(
        &self,
        ctx: &TriggerContext,
        dir: &str,
        filename_template: Option<&str>,
    ) -> Result<(), String> {
        let destination = save_to_location(ctx, dir, filename_template).await?;
        self.remember_output(destination);
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
        tracing::info!(project = %project_path.display(), format = ?profile.format, "automation: exporting");
        let mut builder = cap_export::ExporterBase::builder(project_path.clone());
        if let Some(output) = export_output_path(project_path, profile.format, destination) {
            builder = builder.with_output_path(output);
        }
        let base = builder.build().await.map_err(|error| format!("{error}"))?;
        let output = match profile.format {
            ExportFormat::Mp4 => {
                cap_export::mp4::Mp4ExportSettings {
                    fps: profile.fps,
                    resolution_base: profile.resolution_base,
                    compression: export_compression(profile.compression),
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
        .map_err(|error| format!("Export failed: {error}"))?;
        tracing::info!(output = %output.display(), "automation: export complete");
        self.remember_output(output);
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
            upload_screenshot(ctx, image_path).await?
        } else if let Some(existing) = ctx.share_link.as_ref() {
            tracing::info!(link = %existing, "automation: recording already uploaded, reusing its link");
            existing.clone()
        } else if let Some(project_path) = ctx.project_path.as_ref() {
            tracing::info!(path = %project_path.display(), "automation: uploading recording");
            match crate::upload::upload_exported_video(
                project_path.clone(),
                organization_id.map(str::to_string),
                |_| {},
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .await?
            {
                crate::upload::UploadResult::Success(link) => link,
                crate::upload::UploadResult::NotAuthenticated => {
                    return Err("Not authenticated for upload".to_string());
                }
                crate::upload::UploadResult::UpgradeRequired => {
                    return Err("Upgrade required for upload".to_string());
                }
            }
        } else {
            return Err("No image or project path available for upload".to_string());
        };

        if copy_link {
            ui(UiRequest::CopyText(link.clone())).await?;
        }
        if open_in_browser {
            ui(UiRequest::OpenUrl(link)).await?;
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
        ui(UiRequest::Reveal(path.clone())).await
    }

    async fn open_file(&self, ctx: &TriggerContext) -> Result<(), String> {
        let path = ctx
            .image_path
            .as_ref()
            .or(ctx.output_path.as_ref())
            .ok_or("No file path available to open")?;
        ui(UiRequest::Open(path.clone())).await
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
        tracing::info!(program, "automation: running command");
        let mut cmd = if use_shell {
            let shell_line = cap_automation::shell_command_line(program, args);
            #[cfg(target_os = "windows")]
            let mut command = tokio::process::Command::new("cmd");
            #[cfg(target_os = "windows")]
            command.args(["/C", &shell_line]);
            #[cfg(not(target_os = "windows"))]
            let mut command = tokio::process::Command::new("sh");
            #[cfg(not(target_os = "windows"))]
            command.args(["-c", &shell_line]);
            command
        } else {
            let mut command = tokio::process::Command::new(program);
            command.args(args);
            command
        };
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        for (key, value) in env {
            cmd.env(key, value);
        }
        for (key, value) in context_env(ctx) {
            cmd.env(key, value);
        }
        cmd.kill_on_drop(true);
        let output = tokio::time::timeout(COMMAND_TIMEOUT, cmd.output())
            .await
            .map_err(|_| format!("Command timed out after {}s", COMMAND_TIMEOUT.as_secs()))?
            .map_err(|error| format!("Failed to run command: {error}"))?;
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
        tracing::info!(url, method, "automation: sending webhook");
        let client = reqwest::Client::builder()
            .timeout(WEBHOOK_TIMEOUT)
            .build()
            .map_err(|error| format!("Failed to build HTTP client: {error}"))?;
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|error| format!("Invalid HTTP method: {error}"))?;
        let body = match body_template {
            Some(template) => apply_body_template(template, ctx),
            None => serde_json::to_string(&serde_json::json!({
                "project_path": ctx.project_path,
                "image_path": ctx.image_path,
                "output_path": ctx.output_path,
                "share_link": ctx.share_link,
            }))
            .map_err(|error| format!("Failed to serialize webhook body: {error}"))?,
        };
        let mut request = client.request(method, url).body(body);
        for (key, value) in headers {
            request = request.header(key, value);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Webhook request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Webhook returned status {}", response.status()));
        }
        Ok(())
    }

    async fn recognize_text_to_clipboard(&self, _ctx: &TriggerContext) -> Result<(), String> {
        Err("Recognizing text is not available in Cap yet".to_string())
    }

    async fn notify(
        &self,
        _ctx: &TriggerContext,
        _title_template: &str,
        _body_template: &str,
    ) -> Result<(), String> {
        Err("Automation notifications are not available in Cap yet".to_string())
    }

    async fn open_editor(&self, ctx: &TriggerContext) -> Result<(), String> {
        if let Some(image_path) = ctx.image_path.as_ref() {
            return ui(UiRequest::OpenScreenshotEditor(image_path.clone())).await;
        }
        let path = ctx
            .project_path
            .as_ref()
            .ok_or("No project path for editor")?;
        ui(UiRequest::OpenEditor(path.clone())).await
    }

    async fn apply_preset(&self, ctx: &TriggerContext, name: &str) -> Result<(), String> {
        let project_path = ctx
            .project_path
            .as_ref()
            .ok_or("No project path for preset")?;
        let presets = crate::presets::PresetsStore::load();
        let preset = presets
            .presets
            .iter()
            .find(|preset| preset.name == name)
            .ok_or_else(|| format!("Preset '{name}' not found"))?;
        tracing::info!(preset = name, project = %project_path.display(), "automation: applying preset");
        let current = match cap_project::ProjectConfiguration::load(project_path) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(error) => return Err(format!("Failed to load project config: {error}")),
        };
        crate::presets::apply_preset(&preset.config, &current)
            .ok_or_else(|| format!("Preset '{name}' could not be read"))?
            .write(project_path)
            .map_err(|error| format!("Failed to write project config: {error}"))
    }

    async fn delete_local_files(&self, ctx: &TriggerContext) -> Result<(), String> {
        let project = ctx
            .project_path
            .clone()
            .ok_or("No project path for deletion")?;
        if ctx.image_path.is_some() {
            tracing::info!(path = %project.display(), "automation: deleting screenshot");
            return ui(UiRequest::DeleteScreenshot(project)).await;
        }
        crate::library::ensure_not_recording_in_progress(&project)?;
        crate::library::ensure_not_open_in_editor(&project)?;
        ensure_no_pending_upload(&project)?;
        tracing::info!(path = %project.display(), "automation: deleting local recording");
        crate::upload::queue::delete_recording_without_automations(project).await?;
        ui(UiRequest::LibraryChanged).await
    }

    async fn verify_before_delete(
        &self,
        ctx: &TriggerContext,
        preceding: Option<PrecedingAction<'_>>,
    ) -> Result<(), String> {
        let project = ctx
            .project_path
            .as_ref()
            .ok_or("No project path for deletion")?;
        verify_before_delete(project, preceding, self.last_output().as_deref())
    }
}

fn verify_before_delete(
    project: &Path,
    preceding: Option<PrecedingAction<'_>>,
    last_output: Option<&Path>,
) -> Result<(), String> {
    let preceding = preceding.ok_or(
        "Delete local files needs an Export or Save to location before it; local files kept",
    )?;
    if !matches!(
        preceding.action,
        Action::Export { .. } | Action::SaveToLocation { .. }
    ) {
        return Err(format!(
            "Delete local files only follows an Export or Save to location, not {}; local files kept",
            action_name(preceding.action)
        ));
    }
    if !preceding.succeeded {
        return Err(format!(
            "{} did not succeed; local files kept",
            action_name(preceding.action)
        ));
    }
    let output =
        last_output.ok_or("The previous action left no file to check; local files kept")?;
    verify_output(output, project)
}

fn verify_output(output: &Path, project: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(output).map_err(|error| {
        format!(
            "{} could not be checked ({error}); local files kept",
            output.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(format!(
            "{} is missing or empty; local files kept",
            output.display()
        ));
    }
    let output = output.canonicalize().map_err(|error| {
        format!(
            "{} could not be resolved ({error}); local files kept",
            output.display()
        )
    })?;
    let project = project.canonicalize().map_err(|error| {
        format!(
            "{} could not be resolved ({error}); local files kept",
            project.display()
        )
    })?;
    if output.starts_with(&project) {
        return Err(format!(
            "{} is inside the folder that would be deleted; local files kept",
            output.display()
        ));
    }
    Ok(())
}

fn ensure_no_pending_upload(project: &Path) -> Result<(), String> {
    match crate::upload::queue::read_state(project)? {
        Some(state) if state.phase != crate::upload::queue::UploadPhase::Verified => {
            Err("The recording's upload has not finished; local files kept".to_string())
        }
        _ => Ok(()),
    }
}

async fn upload_screenshot(ctx: &TriggerContext, image_path: &Path) -> Result<String, String> {
    tracing::info!(path = %image_path.display(), "automation: uploading screenshot");
    let project = ctx
        .project_path
        .clone()
        .or_else(|| image_path.parent().map(Path::to_path_buf))
        .ok_or("No screenshot project for upload")?;
    let meta = cap_project::RecordingMeta::load_for_project(&project).ok();
    let existing_id = meta
        .as_ref()
        .and_then(|meta| meta.sharing.as_ref().map(|sharing| sharing.id.clone()));
    let bytes = tokio::fs::read(image_path)
        .await
        .map_err(|error| format!("Failed to read screenshot: {error}"))?;
    let uploaded =
        match crate::upload::upload_rendered_screenshot(bytes, "image/png", existing_id).await? {
            crate::upload::ScreenshotShareOutcome::Uploaded(item) => item,
            crate::upload::ScreenshotShareOutcome::NotAuthenticated => {
                return Err("Not authenticated for upload".to_string());
            }
            crate::upload::ScreenshotShareOutcome::UpgradeRequired => {
                return Err("Upgrade required for upload".to_string());
            }
        };
    if let Some(mut meta) = meta {
        meta.sharing = Some(cap_project::SharingMeta {
            id: uploaded.id,
            link: uploaded.link.clone(),
            content_hash: None,
        });
        if let Err(error) = meta.save_for_project() {
            tracing::warn!(
                ?error,
                "automation: could not save the screenshot's share link"
            );
        }
    }
    Ok(uploaded.link)
}

fn clipboard_image(ctx: &TriggerContext, source: ClipboardSource) -> Result<PathBuf, String> {
    match source {
        ClipboardSource::Raw => ctx
            .image_path
            .as_ref()
            .or(ctx.output_path.as_ref())
            .cloned()
            .ok_or_else(|| "No image or output path available for clipboard copy".to_string()),
        ClipboardSource::Rendered => {
            if let Some(path) = ctx.output_path.clone() {
                return Ok(path);
            }
            if ctx.image_path.is_some() && ctx.project_path.is_some() {
                return Err(
                    "Copying the edited screenshot is not available in Cap yet; choose the original capture"
                        .to_string(),
                );
            }
            ctx.image_path
                .clone()
                .ok_or_else(|| "No rendered output available for clipboard copy".to_string())
        }
    }
}

async fn save_to_location(
    ctx: &TriggerContext,
    dir: &str,
    filename_template: Option<&str>,
) -> Result<PathBuf, String> {
    let source = ctx
        .image_path
        .as_ref()
        .or(ctx.output_path.as_ref())
        .ok_or("No file path available for save")?;
    let filename = match filename_template {
        Some(template) => apply_filename_template(template, ctx),
        None => source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "capture.png".to_string()),
    };
    let destination = PathBuf::from(dir).join(&filename);
    tracing::info!(src = %source.display(), dst = %destination.display(), "automation: saving to location");
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Failed to create directory: {error}"))?;
    }
    tokio::fs::copy(source, &destination)
        .await
        .map_err(|error| format!("Failed to copy file: {error}"))?;
    Ok(destination)
}

fn export_output_path(
    project_path: &Path,
    format: ExportFormat,
    destination: &ExportDestination,
) -> Option<PathBuf> {
    match destination {
        ExportDestination::ProjectFolder => None,
        ExportDestination::CustomPath { dir } => {
            let extension = match format {
                ExportFormat::Mp4 => "mp4",
                ExportFormat::Gif => "gif",
                ExportFormat::Mov => "mov",
            };
            let name = project_path
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .unwrap_or_else(|| "export".to_string());
            Some(PathBuf::from(dir).join(format!("{name}.{extension}")))
        }
    }
}

fn export_compression(
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
    if let Some(path) = &ctx.project_path {
        env.push(("CAP_PROJECT_PATH", path.to_string_lossy().to_string()));
    }
    if let Some(path) = &ctx.image_path {
        env.push(("CAP_IMAGE_PATH", path.to_string_lossy().to_string()));
    }
    if let Some(path) = &ctx.output_path {
        env.push(("CAP_OUTPUT_PATH", path.to_string_lossy().to_string()));
    }
    if let Some(link) = &ctx.share_link {
        env.push(("CAP_SHARE_LINK", link.clone()));
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
    if let Some(path) = &ctx.project_path {
        result = result.replace("{project_path}", &path.to_string_lossy());
    }
    if let Some(path) = &ctx.image_path {
        result = result.replace("{image_path}", &path.to_string_lossy());
    }
    if let Some(path) = &ctx.output_path {
        result = result.replace("{output_path}", &path.to_string_lossy());
    }
    if let Some(link) = &ctx.share_link {
        result = result.replace("{share_link}", link);
    }
    result
}

#[cfg(test)]
mod tests;
