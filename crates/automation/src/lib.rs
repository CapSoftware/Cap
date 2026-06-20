mod types;

pub use types::*;

use std::path::PathBuf;
use tracing::{info, warn};

#[derive(Debug)]
pub struct TriggerContext {
    pub project_path: Option<PathBuf>,
    pub image_path: Option<PathBuf>,
    pub output_path: Option<PathBuf>,
    pub capture_target: Option<CaptureTargetKind>,
    pub recording_mode: Option<AutomationRecordingMode>,
    pub duration_secs: Option<f64>,
    pub share_link: Option<String>,
    pub share_id: Option<String>,
    pub organization_id: Option<String>,
    pub window_title: Option<String>,
}

impl TriggerContext {
    pub fn new() -> Self {
        Self {
            project_path: None,
            image_path: None,
            output_path: None,
            capture_target: None,
            recording_mode: None,
            duration_secs: None,
            share_link: None,
            share_id: None,
            organization_id: None,
            window_title: None,
        }
    }

    pub fn with_project_path(mut self, path: PathBuf) -> Self {
        self.project_path = Some(path);
        self
    }

    pub fn with_image_path(mut self, path: PathBuf) -> Self {
        self.image_path = Some(path);
        self
    }

    pub fn with_output_path(mut self, path: PathBuf) -> Self {
        self.output_path = Some(path);
        self
    }

    pub fn with_capture_target(mut self, target: CaptureTargetKind) -> Self {
        self.capture_target = Some(target);
        self
    }

    pub fn with_recording_mode(mut self, mode: AutomationRecordingMode) -> Self {
        self.recording_mode = Some(mode);
        self
    }

    pub fn with_duration(mut self, secs: f64) -> Self {
        self.duration_secs = Some(secs);
        self
    }

    pub fn with_share_link(mut self, link: String) -> Self {
        self.share_link = Some(link);
        self
    }

    pub fn with_share_id(mut self, id: String) -> Self {
        self.share_id = Some(id);
        self
    }

    pub fn with_organization_id(mut self, id: String) -> Self {
        self.organization_id = Some(id);
        self
    }

    pub fn with_window_title(mut self, title: String) -> Self {
        self.window_title = Some(title);
        self
    }
}

impl Default for TriggerContext {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    CopyToClipboard,
    SaveToLocation,
    Export,
    Upload,
    RevealInFileManager,
    OpenFile,
    RunCommand,
    Webhook,
    RecognizeText,
    Notify,
    OpenEditor,
    ApplyPreset,
    DeleteLocalFiles,
}

impl Action {
    /// The host capability an action needs to run, or `None` for control-only actions that are
    /// always a no-op in the engine (`SkipEditor`). Returning `None` keeps such actions from being
    /// reported as "unsupported" on hosts that lack an editor (e.g. the CLI).
    pub fn required_capability(&self) -> Option<Capability> {
        Some(match self {
            Action::CopyToClipboard { .. } => Capability::CopyToClipboard,
            Action::SaveToLocation { .. } => Capability::SaveToLocation,
            Action::Export { .. } => Capability::Export,
            Action::Upload { .. } => Capability::Upload,
            Action::RevealInFileManager => Capability::RevealInFileManager,
            Action::OpenFile => Capability::OpenFile,
            Action::RunCommand { .. } => Capability::RunCommand,
            Action::Webhook { .. } => Capability::Webhook,
            Action::RecognizeTextToClipboard => Capability::RecognizeText,
            Action::Notify { .. } => Capability::Notify,
            Action::OpenEditor => Capability::OpenEditor,
            Action::SkipEditor => return None,
            Action::ApplyPreset { .. } => Capability::ApplyPreset,
            Action::DeleteLocalFiles => Capability::DeleteLocalFiles,
        })
    }
}

pub fn evaluate(
    store: &AutomationsStore,
    trigger: &Trigger,
    ctx: &TriggerContext,
) -> Vec<(String, Vec<Action>)> {
    let mut matched = Vec::new();
    for rule in &store.rules {
        if !rule.enabled {
            continue;
        }
        if rule.trigger != *trigger {
            continue;
        }
        if rule.conditions.is_empty() || check_conditions(&rule.conditions, rule.match_mode, ctx) {
            matched.push((rule.id.clone(), rule.actions.clone()));
        }
    }
    matched
}

fn check_conditions(conditions: &[Condition], mode: MatchMode, ctx: &TriggerContext) -> bool {
    match mode {
        MatchMode::All => conditions.iter().all(|c| evaluate_condition(c, ctx)),
        MatchMode::Any => conditions.iter().any(|c| evaluate_condition(c, ctx)),
    }
}

fn evaluate_condition(condition: &Condition, ctx: &TriggerContext) -> bool {
    match condition {
        Condition::CaptureTargetIs { target } => ctx.capture_target.as_ref() == Some(target),
        Condition::RecordingModeIs { mode } => ctx.recording_mode.as_ref() == Some(mode),
        Condition::DurationAtLeast { secs } => ctx.duration_secs.is_some_and(|d| d >= *secs),
        Condition::DurationAtMost { secs } => ctx.duration_secs.is_some_and(|d| d <= *secs),
        Condition::WindowTitleContains { pattern } => ctx
            .window_title
            .as_ref()
            .is_some_and(|t| t.to_lowercase().contains(&pattern.to_lowercase())),
        // Reserved for future per-organization filtering: no trigger currently populates
        // `organization_id`, and the desktop UI hides this condition (CONDITION_REQUIRES maps it to
        // null), so this arm stays inert until org context is plumbed through the trigger pipeline.
        Condition::OrganizationIs { id } => ctx.organization_id.as_ref() == Some(id),
    }
}

pub trait AutomationHost: Send + Sync {
    fn capabilities(&self) -> &[Capability];

    fn copy_to_clipboard(
        &self,
        ctx: &TriggerContext,
        source: &ClipboardSource,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn save_to_location(
        &self,
        ctx: &TriggerContext,
        dir: &str,
        filename_template: Option<&str>,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn export(
        &self,
        ctx: &TriggerContext,
        profile: &ExportProfile,
        destination: &ExportDestination,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn upload(
        &self,
        ctx: &TriggerContext,
        organization_id: Option<&str>,
        copy_link: bool,
        open_in_browser: bool,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn reveal_in_file_manager(
        &self,
        ctx: &TriggerContext,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn open_file(
        &self,
        ctx: &TriggerContext,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn run_command(
        &self,
        ctx: &TriggerContext,
        program: &str,
        args: &[String],
        cwd: Option<&str>,
        env: &std::collections::HashMap<String, String>,
        use_shell: bool,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn webhook(
        &self,
        ctx: &TriggerContext,
        url: &str,
        method: &str,
        headers: &std::collections::HashMap<String, String>,
        body_template: Option<&str>,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn recognize_text_to_clipboard(
        &self,
        ctx: &TriggerContext,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn notify(
        &self,
        ctx: &TriggerContext,
        title_template: &str,
        body_template: &str,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn open_editor(
        &self,
        ctx: &TriggerContext,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn apply_preset(
        &self,
        ctx: &TriggerContext,
        name: &str,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    fn delete_local_files(
        &self,
        ctx: &TriggerContext,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
}

pub struct RunResult {
    pub rule_id: String,
    pub action_results: Vec<ActionResult>,
}

pub struct ActionResult {
    pub action: Action,
    pub success: bool,
    pub error: Option<String>,
}

pub fn has_skip_editor(store: &AutomationsStore, trigger: &Trigger, ctx: &TriggerContext) -> bool {
    let matched = evaluate(store, trigger, ctx);
    matched
        .iter()
        .any(|(_, actions)| actions.iter().any(|a| matches!(a, Action::SkipEditor)))
}

pub fn has_open_editor(store: &AutomationsStore, trigger: &Trigger, ctx: &TriggerContext) -> bool {
    let matched = evaluate(store, trigger, ctx);
    matched
        .iter()
        .any(|(_, actions)| actions.iter().any(|a| matches!(a, Action::OpenEditor)))
}

pub async fn run<H: AutomationHost>(
    host: &H,
    store: &AutomationsStore,
    trigger: &Trigger,
    ctx: &TriggerContext,
) -> Vec<RunResult> {
    let matched = evaluate(store, trigger, ctx);
    let caps = host.capabilities();
    let mut results = Vec::new();

    for (rule_id, actions) in matched {
        info!(rule_id = %rule_id, trigger = ?trigger, "Running automation rule");
        let mut action_results = Vec::new();

        for action in &actions {
            if let Some(cap) = action.required_capability()
                && !caps.contains(&cap)
            {
                warn!(
                    rule_id = %rule_id,
                    action = ?action,
                    capability = ?cap,
                    "Skipping action: host does not support required capability"
                );
                action_results.push(ActionResult {
                    action: action.clone(),
                    success: false,
                    error: Some(format!("Unsupported capability: {cap:?}")),
                });
                continue;
            }

            let result = execute_action(host, action, ctx).await;
            let (success, error) = match result {
                Ok(()) => (true, None),
                Err(e) => {
                    warn!(
                        rule_id = %rule_id,
                        action = ?action,
                        error = %e,
                        "Automation action failed"
                    );
                    (false, Some(e))
                }
            };
            action_results.push(ActionResult {
                action: action.clone(),
                success,
                error,
            });
        }

        results.push(RunResult {
            rule_id,
            action_results,
        });
    }

    results
}

async fn execute_action<H: AutomationHost>(
    host: &H,
    action: &Action,
    ctx: &TriggerContext,
) -> Result<(), String> {
    match action {
        Action::CopyToClipboard { source } => host.copy_to_clipboard(ctx, source).await,
        Action::SaveToLocation {
            dir,
            filename_template,
        } => {
            host.save_to_location(ctx, dir, filename_template.as_deref())
                .await
        }
        Action::Export {
            profile,
            destination,
        } => host.export(ctx, profile, destination).await,
        Action::Upload {
            organization_id,
            copy_link,
            open_in_browser,
        } => {
            host.upload(
                ctx,
                organization_id.as_deref(),
                *copy_link,
                *open_in_browser,
            )
            .await
        }
        Action::RevealInFileManager => host.reveal_in_file_manager(ctx).await,
        Action::OpenFile => host.open_file(ctx).await,
        Action::RunCommand {
            program,
            args,
            cwd,
            env,
            use_shell,
        } => {
            host.run_command(ctx, program, args, cwd.as_deref(), env, *use_shell)
                .await
        }
        Action::Webhook {
            url,
            method,
            headers,
            body_template,
        } => {
            host.webhook(ctx, url, method, headers, body_template.as_deref())
                .await
        }
        Action::RecognizeTextToClipboard => host.recognize_text_to_clipboard(ctx).await,
        Action::Notify {
            title_template,
            body_template,
        } => host.notify(ctx, title_template, body_template).await,
        Action::OpenEditor => host.open_editor(ctx).await,
        Action::SkipEditor => Ok(()),
        Action::ApplyPreset { name } => host.apply_preset(ctx, name).await,
        Action::DeleteLocalFiles => host.delete_local_files(ctx).await,
    }
}

pub fn load_store_from_json(value: &serde_json::Value) -> Option<AutomationsStore> {
    value
        .get("automations")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// Sanitize attacker-influenced text (e.g. an active window title) into a single, safe filename
/// component before it is substituted into a `SaveToLocation` filename template. Window titles can
/// contain path separators or reserved characters; substituting them raw would let a write escape the
/// target directory (path traversal) or produce an invalid name. Replacing separators keeps the value
/// a single component, so directories in the resolved path can only come from the user-authored template.
pub fn sanitize_filename_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            // Braces are template markers; replacing them stops a window title like `{image_path}`
            // from acting as a live variable when the substituted value is run through a second
            // template pass (e.g. notifications compose the filename and body templates).
            '{' | '}' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .take(128)
        .collect();

    // Windows rejects filenames ending in a space or '.', so trim those after clamping the length.
    let trimmed = sanitized.trim_end_matches([' ', '.']);
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build a single shell command line from a program and its arguments, quoting each token so that
/// arguments containing spaces or shell metacharacters survive as written instead of being re-split
/// by the shell. Used by hosts running `RunCommand { use_shell: true }`.
pub fn shell_command_line(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(quote_shell_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_shell_safe_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"-_./:=@%+,".contains(&b)
}

#[cfg(not(target_os = "windows"))]
fn quote_shell_arg(arg: &str) -> String {
    if !arg.is_empty() && arg.bytes().all(is_shell_safe_byte) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

#[cfg(target_os = "windows")]
fn quote_shell_arg(arg: &str) -> String {
    if !arg.is_empty() && arg.bytes().all(is_shell_safe_byte) {
        arg.to_string()
    } else {
        format!("\"{}\"", arg.replace('"', "\"\""))
    }
}

#[cfg(test)]
mod tests;
