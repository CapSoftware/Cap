//! The settings pages beyond General/Recordings/Screenshots -- Shortcuts,
//! CLI, Automations, Transcription, Integrations, License, Experimental,
//! Feedback and Changelog -- kept out of `settings_window.rs` so the shell
//! stays readable. Every renderer here is an `impl SettingsWindow` extension.
//!
//! Transcribed from the routes under
//! `apps/desktop/src/routes/(window-chrome)/settings/`, with every store key
//! and HTTP endpoint spelled exactly the way the Tauri app spells it so the
//! two apps keep reading each other's state. Web calls run on the gpui_tokio
//! runtime (reqwest needs tokio); persistence goes through [`crate::store`].

use std::{
    collections::HashMap,
    path::PathBuf,
    str::FromStr as _,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use gpui::{
    AppContext as _, Context, Entity, FontWeight, Hsla, InteractiveElement, IntoElement,
    MouseButton, ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, rgb, svg,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    diagnostics,
    settings_window::{MenuKind, Page, SettingsWindow},
    store::{
        self, Action, AutomationExportCompression, AutomationRecordingMode, AutomationRule,
        AutomationsStore, CaptureTargetKind, ClipboardSource, Condition, ExportDestination,
        ExportFormat, ExportProfile, GENERAL_SETTINGS, Hotkey, MatchMode, Trigger,
    },
    theme::Theme,
    ui,
};

/// `font-mono` in the TSX resolves to the platform mono stack; the closest
/// single face per OS, since no mono font is bundled.
const MONO_FONT: &str = if cfg!(target_os = "macos") {
    "Menlo"
} else if cfg!(target_os = "windows") {
    "Consolas"
} else {
    "monospace"
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Which text field an event came from, so one dispatcher serves every static
/// input these pages own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageField {
    Hint,
    Feedback,
    LicenseKey,
    S3(usize),
}

/// `saveState` in transcription.tsx.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HintSave {
    Idle,
    Saving,
    Saved,
}

/// `useSubmission(sendFeedbackAction)`'s phases.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FeedbackStatus {
    Idle,
    Pending,
    Success,
    Error(String),
}

/// The Diagnostic Report's phases. `Running` carries the CLI's own stage name
/// and leg so the label is built at render time, not at send time.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DiagnosticStatus {
    Idle,
    Running {
        stage: String,
        mode: Option<String>,
    },
    Done {
        verdict: Option<String>,
        summary: Option<String>,
        report_path: Option<PathBuf>,
        /// Set when the sync test could not run at all; the environment half
        /// of the report is still there.
        sync_test_error: Option<String>,
    },
    Error(String),
}

/// The finished report, kept whole so "Send to Cap" never re-collects it.
#[derive(Debug, Clone)]
struct DiagnosticPayload {
    report_json: String,
    diagnostics_json: String,
}

/// Which of the two upload buttons a result belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadTarget {
    /// "Send to Cap" on a finished diagnostic: log + diagnostics + report.
    Diagnostic,
    /// "Upload Logs" under Debug Information: log + diagnostics only.
    Logs,
}

/// `useSubmission`'s phases again, for the two upload buttons.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UploadStatus {
    Idle,
    Pending,
    Success,
    Error(String),
}

/// The three routes under `/settings/integrations`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IntegrationsView {
    Index,
    S3,
    GoogleDrive,
}

/// One post from `apiClient.desktop.getChangelogPosts` -- the CHANGELOG
/// metadata plus `content` (`packages/web-api-contract/src/desktop.ts:84-108`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangelogEntry {
    title: String,
    version: String,
    published_at: String,
    content: String,
}

/// `DesktopStorageIntegrations` (`web-api-contract/src/desktop.ts:58-79`),
/// narrowed to the fields the two pages read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageIntegrations {
    active_provider: String,
    #[serde(default)]
    managed_by_organization: Option<ManagedOrganization>,
    google_drive: GoogleDriveIntegration,
}

#[derive(Debug, Clone, Deserialize)]
struct ManagedOrganization {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleDriveIntegration {
    connected: bool,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    storage_quota: Option<DriveQuota>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveQuota {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    usage: Option<String>,
    #[serde(default)]
    usage_in_drive: Option<String>,
    #[serde(default)]
    usage_in_drive_trash: Option<String>,
    #[serde(default)]
    remaining: Option<String>,
    fetched_at: String,
    #[serde(default)]
    stale: bool,
}

/// hotkeys.tsx's `listening` signal: which action is armed, and the binding
/// to restore when the capture is abandoned.
struct ListeningHotkey {
    action: usize,
    prev: Option<Value>,
}

/// The S3 form's five text fields, in render order.
const S3_ACCESS_KEY: usize = 0;
const S3_SECRET_KEY: usize = 1;
const S3_ENDPOINT: usize = 2;
const S3_BUCKET: usize = 3;
const S3_REGION: usize = 4;

/// `DEFAULT_CONFIG` in s3-config.tsx, indexed like the fields above.
const S3_DEFAULTS: [&str; 5] = ["", "", "https://s3.amazonaws.com", "", "us-east-1"];

const S3_FIELDS: [(&str, &str); 5] = [
    ("Access Key ID", "PL31OADSQNK"),
    ("Secret Access Key", "PL31OADSQNK"),
    ("Endpoint", "https://s3.amazonaws.com"),
    ("Bucket Name", "my-bucket"),
    ("Region", "us-east-1"),
];

const S3_PROVIDERS: [(&str, &str); 5] = [
    ("aws", "AWS S3"),
    ("cloudflare", "Cloudflare R2"),
    ("supabase", "Supabase"),
    ("minio", "MinIO"),
    ("other", "Other S3-Compatible"),
];

struct S3Page {
    loading: bool,
    error: Option<String>,
    /// `hasConfig()`: `source === "user" && !!config.accessKeyId`, evaluated
    /// on the *fetched* config, not the drafts.
    has_config: bool,
    managed_by: Option<String>,
    provider: String,
    drafts: [String; 5],
    inputs: [Entity<ui::TextInputState>; 5],
    saving: bool,
    deleting: bool,
    testing: bool,
}

struct GDrivePage {
    refreshing: bool,
    connect_pending: bool,
    waiting: bool,
    testing: bool,
    set_active_pending: bool,
    disconnecting: bool,
    /// `hasS3Config()` on google-drive-config.tsx, from its own S3 fetch.
    s3_has_config: bool,
    error: Option<String>,
    poll: Option<gpui::Task<()>>,
}

/// The per-field text inputs for one expanded rule's editor. Rebuilt whenever
/// the rule's structure (conditions/actions lists, types) changes, because the
/// fields are positional.
struct RuleEditor {
    rule_id: String,
    fields: Vec<(AutoField, Entity<ui::TextInputState>)>,
    _subscriptions: Vec<gpui::Subscription>,
}

/// Which rule field a text input edits; the payload is the condition/action
/// index within the rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutoField {
    Name,
    ConditionSecs(usize),
    ConditionPattern(usize),
    ConditionOrg(usize),
    ActionDir(usize),
    ActionFilename(usize),
    ActionOrgId(usize),
    ActionProgram(usize),
    ActionArgs(usize),
    ActionUrl(usize),
    ActionWebhookBody(usize),
    ActionNotifyTitle(usize),
    ActionNotifyBody(usize),
    ActionExportDir(usize),
}

/// Everything the pages here own. Lives on [`SettingsWindow`] as one field so
/// the shell's struct stays readable.
pub(crate) struct PagesState {
    // Shortcuts (hotkeys.tsx)
    hotkeys: Map<String, Value>,
    listening: Option<ListeningHotkey>,

    // CLI (cli.tsx). `None` while the status fetch is in flight.
    cli_status: Option<Result<cli_install::CliInstallStatus, String>>,
    cli_installing: bool,
    cli_uninstalling: bool,
    /// Stand-in for cli.tsx's `toast.error` -- there is no toast layer here.
    cli_error: Option<String>,
    cli_copied: bool,
    cli_copied_reset: Option<gpui::Task<()>>,

    // Transcription (transcription.tsx)
    hints: Vec<String>,
    hint_input: Entity<ui::TextInputState>,
    hint_draft: String,
    hint_save: HintSave,
    hint_save_task: Option<gpui::Task<()>>,

    // Feedback (feedback.tsx)
    feedback_input: Entity<ui::TextInputState>,
    feedback_draft: String,
    feedback: FeedbackStatus,
    /// Best-effort local stand-in for `commands.getSystemDiagnostics`.
    os_version: Option<Option<String>>,
    /// "Upload Logs" under Debug Information.
    logs_upload: UploadStatus,

    // Diagnostic Report (feedback.tsx's diagnostic section)
    diagnostic: DiagnosticStatus,
    diagnostic_mode: diagnostics::SyncMode,
    diagnostic_mic: bool,
    /// Set for the length of a run; the Cancel button flips it and the runner's
    /// watchdog kills the self-test subprocess. It stays readable after Cancel
    /// so the run's later stages can still see it.
    diagnostic_cancel: Option<Arc<AtomicBool>>,
    /// Cancel has been pressed and the run has not resolved yet: the label
    /// stays on "Cancelling..." and no later stage walks it back.
    diagnostic_cancelling: bool,
    diagnostic_payload: Option<DiagnosticPayload>,
    diagnostic_upload: UploadStatus,
    /// `None` until the Feedback page resolves it once; `Some(None)` means no
    /// `cap` sidecar was found and the run will be environment-only.
    selftest_binary: Option<Option<PathBuf>>,

    // Changelog (changelog.tsx). `None` until the first fetch lands; a
    // refetch keeps showing the loaded list, the way the cached query does.
    changelog: Option<Result<Vec<ChangelogEntry>, String>>,

    // License (license.tsx)
    license_input: Entity<ui::TextInputState>,
    license_draft: String,
    /// `isCommercialAnnual`, default true.
    license_annual: bool,
    license_checkout_pending: bool,
    license_activating: bool,
    license_error: Option<String>,

    // Integrations
    integrations_view: IntegrationsView,
    storage: Option<StorageIntegrations>,
    s3: S3Page,
    gdrive: GDrivePage,

    // Experimental (experimental.tsx). The Native app row's hand-back takes the
    // whole settings window over, so its clock and the ticker that repaints the
    // sequence live here and the overlay renders from the window root.
    switch_back: Option<SwitchBack>,
    switch_back_ticker: Option<gpui::Task<()>>,

    // Automations (automations.tsx)
    automations: AutomationsStore,
    automations_loaded: bool,
    expanded_rule: Option<String>,
    rule_editor: Option<RuleEditor>,
    /// `testReports`, reduced to per-action `supported` flags.
    test_reports: HashMap<String, Vec<bool>>,

    _subscriptions: Vec<gpui::Subscription>,
}

impl PagesState {
    pub(crate) fn new(window: &mut Window, cx: &mut Context<SettingsWindow>) -> Self {
        let hint_input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("Add a term");
            input
        });
        let feedback_input = cx.new(|cx| {
            let mut input = ui::TextInputState::multi_line(window, cx);
            input.set_placeholder("Tell us what you think about Cap...");
            input
        });
        let license_input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("License key");
            input
        });
        let s3_inputs = std::array::from_fn(|index| {
            cx.new(|cx| {
                let mut input = ui::TextInputState::single_line(window, cx);
                input.set_placeholder(S3_FIELDS[index].1);
                input.set_text(S3_DEFAULTS[index], cx);
                input
            })
        });

        let mut subscriptions = vec![
            cx.subscribe(&hint_input, |this, input, event, cx| {
                this.page_field_event(PageField::Hint, input, event, cx)
            }),
            cx.subscribe(&feedback_input, |this, input, event, cx| {
                this.page_field_event(PageField::Feedback, input, event, cx)
            }),
            cx.subscribe(&license_input, |this, input, event, cx| {
                this.page_field_event(PageField::LicenseKey, input, event, cx)
            }),
        ];
        for (index, input) in s3_inputs.iter().enumerate() {
            subscriptions.push(cx.subscribe(input, move |this, input, event, cx| {
                this.page_field_event(PageField::S3(index), input, event, cx)
            }));
        }

        Self {
            hotkeys: store::hotkeys_raw(),
            listening: None,
            cli_status: None,
            cli_installing: false,
            cli_uninstalling: false,
            cli_error: None,
            cli_copied: false,
            cli_copied_reset: None,
            hints: store::transcription_hints(),
            hint_input,
            hint_draft: String::new(),
            hint_save: HintSave::Idle,
            hint_save_task: None,
            feedback_input,
            feedback_draft: String::new(),
            feedback: FeedbackStatus::Idle,
            os_version: None,
            logs_upload: UploadStatus::Idle,
            diagnostic: DiagnosticStatus::Idle,
            diagnostic_mode: diagnostics::SyncMode::Both,
            diagnostic_mic: false,
            diagnostic_cancel: None,
            diagnostic_cancelling: false,
            diagnostic_payload: None,
            diagnostic_upload: UploadStatus::Idle,
            selftest_binary: None,
            changelog: None,
            license_input,
            license_draft: String::new(),
            license_annual: true,
            license_checkout_pending: false,
            license_activating: false,
            license_error: None,
            integrations_view: IntegrationsView::Index,
            storage: None,
            s3: S3Page {
                loading: false,
                error: None,
                has_config: false,
                managed_by: None,
                provider: "aws".to_string(),
                drafts: std::array::from_fn(|index| S3_DEFAULTS[index].to_string()),
                inputs: s3_inputs,
                saving: false,
                deleting: false,
                testing: false,
            },
            gdrive: GDrivePage {
                refreshing: false,
                connect_pending: false,
                waiting: false,
                testing: false,
                set_active_pending: false,
                disconnecting: false,
                s3_has_config: false,
                error: None,
                poll: None,
            },
            switch_back: None,
            switch_back_ticker: None,
            automations: AutomationsStore::default(),
            automations_loaded: false,
            expanded_rule: None,
            rule_editor: None,
            test_reports: HashMap::new(),
            _subscriptions: subscriptions,
        }
    }
}

// ---------------------------------------------------------------------------
// Shell hooks
// ---------------------------------------------------------------------------

impl SettingsWindow {
    /// Per-page fetch/reset on navigation -- what each route's mount effects
    /// do. Called from [`SettingsWindow::page_shown`].
    pub(crate) fn pages_shown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.page {
            Page::Shortcuts => {
                self.pages.hotkeys = store::hotkeys_raw();
                self.pages.listening = None;
            }
            Page::Cli => self.cli_refresh(window, cx),
            Page::Transcription => {
                self.pages.hints = store::transcription_hints();
                self.pages.hint_draft.clear();
                self.pages.hint_save = HintSave::Idle;
                self.pages.hint_save_task = None;
                let input = self.pages.hint_input.clone();
                input.update(cx, |input, cx| input.set_text("", cx));
            }
            Page::Feedback => {
                self.pages.feedback = FeedbackStatus::Idle;
                self.pages.feedback_draft.clear();
                let input = self.pages.feedback_input.clone();
                input.update(cx, |input, cx| input.set_text("", cx));
                self.feedback_load_os_version(window, cx);
            }
            Page::Changelog => self.changelog_fetch(window, cx),
            Page::License => {
                self.pages.license_draft.clear();
                self.pages.license_annual = true;
                self.pages.license_checkout_pending = false;
                self.pages.license_activating = false;
                self.pages.license_error = None;
                let input = self.pages.license_input.clone();
                input.update(cx, |input, cx| input.set_text("", cx));
            }
            Page::Integrations => {
                self.pages.integrations_view = IntegrationsView::Index;
                self.integrations_fetch_storage(false, window, cx);
            }
            Page::Automations => {
                self.pages.automations = store::automations();
                self.pages.automations_loaded = true;
                self.pages.expanded_rule = None;
                self.pages.rule_editor = None;
                self.pages.test_reports.clear();
            }
            _ => {}
        }
    }

    /// The static text fields' events, dispatched from the subscriptions in
    /// [`PagesState::new`].
    fn page_field_event(
        &mut self,
        field: PageField,
        input: Entity<ui::TextInputState>,
        event: &ui::TextInputEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                let value = input.read(cx).text().to_string();
                match field {
                    PageField::Hint => self.pages.hint_draft = value,
                    PageField::Feedback => self.pages.feedback_draft = value,
                    PageField::LicenseKey => self.pages.license_draft = value,
                    PageField::S3(index) => self.pages.s3.drafts[index] = value,
                }
                cx.notify();
            }
            // `onKeyDown` in transcription.tsx: Enter adds the pending term.
            ui::TextInputEvent::Confirmed if field == PageField::Hint => {
                self.transcription_add_hint(cx);
            }
            _ => {}
        }
    }

    /// Option lists for the [`MenuKind`] variants owned by these pages.
    pub(crate) fn pages_menu_items(&self, kind: MenuKind) -> Vec<ui::MenuItem> {
        match kind {
            MenuKind::S3Provider => S3_PROVIDERS
                .iter()
                .map(|(value, label)| ui::MenuItem::new(*label, *value == self.pages.s3.provider))
                .collect(),
            MenuKind::AutomationTrigger(rule) => {
                let current = self.rule_at(rule).map(|rule| rule.trigger);
                ALL_TRIGGERS
                    .iter()
                    .map(|trigger| {
                        ui::MenuItem::new(trigger_label(*trigger), Some(*trigger) == current)
                    })
                    .collect()
            }
            MenuKind::AutomationMatchMode(rule) => {
                let current = self.rule_at(rule).map(|rule| rule.match_mode);
                [(MatchMode::All, "Match all"), (MatchMode::Any, "Match any")]
                    .iter()
                    .map(|(mode, label)| ui::MenuItem::new(*label, Some(*mode) == current))
                    .collect()
            }
            MenuKind::AutomationConditionType(rule, index) => {
                let current = self
                    .rule_at(rule)
                    .and_then(|rule| rule.conditions.get(index))
                    .map(condition_type_of);
                ALL_CONDITION_TYPES
                    .iter()
                    .map(|kind| ui::MenuItem::new(condition_label(*kind), Some(*kind) == current))
                    .collect()
            }
            MenuKind::AutomationConditionTarget(rule, index) => {
                let current = match self
                    .rule_at(rule)
                    .and_then(|rule| rule.conditions.get(index))
                {
                    Some(Condition::CaptureTargetIs { target }) => Some(*target),
                    _ => None,
                };
                CAPTURE_TARGETS
                    .iter()
                    .map(|(target, label)| ui::MenuItem::new(*label, Some(*target) == current))
                    .collect()
            }
            MenuKind::AutomationConditionMode(rule, index) => {
                let current = match self
                    .rule_at(rule)
                    .and_then(|rule| rule.conditions.get(index))
                {
                    Some(Condition::RecordingModeIs { mode }) => Some(*mode),
                    _ => None,
                };
                RECORDING_MODES
                    .iter()
                    .map(|(mode, label)| ui::MenuItem::new(*label, Some(*mode) == current))
                    .collect()
            }
            MenuKind::AutomationActionType(rule, index) => {
                let current = self
                    .rule_at(rule)
                    .and_then(|rule| rule.actions.get(index))
                    .map(action_type_of);
                ALL_ACTION_TYPES
                    .iter()
                    .map(|kind| ui::MenuItem::new(action_label(*kind), Some(*kind) == current))
                    .collect()
            }
            MenuKind::AutomationClipboardSource(rule, index) => {
                let current = match self.rule_at(rule).and_then(|rule| rule.actions.get(index)) {
                    Some(Action::CopyToClipboard { source }) => Some(*source),
                    _ => None,
                };
                CLIPBOARD_SOURCES
                    .iter()
                    .map(|(source, label)| ui::MenuItem::new(*label, Some(*source) == current))
                    .collect()
            }
            MenuKind::AutomationWebhookMethod(rule, index) => {
                let current = match self.rule_at(rule).and_then(|rule| rule.actions.get(index)) {
                    Some(Action::Webhook { method, .. }) => Some(method.clone()),
                    _ => None,
                };
                WEBHOOK_METHODS
                    .iter()
                    .map(|method| ui::MenuItem::new(*method, current.as_deref() == Some(*method)))
                    .collect()
            }
            MenuKind::AutomationExportFormat(rule, index) => {
                let current = self
                    .export_profile_at(rule, index)
                    .map(|profile| profile.format);
                EXPORT_FORMATS
                    .iter()
                    .map(|(format, label)| ui::MenuItem::new(*label, Some(*format) == current))
                    .collect()
            }
            MenuKind::AutomationExportResolution(rule, index) => {
                let current = self
                    .export_profile_at(rule, index)
                    .map(resolution_value)
                    .unwrap_or("1080p");
                RESOLUTION_PRESETS
                    .iter()
                    .map(|(value, label, ..)| ui::MenuItem::new(*label, *value == current))
                    .collect()
            }
            MenuKind::AutomationExportFps(rule, index) => {
                let current = self
                    .export_profile_at(rule, index)
                    .map(|profile| profile.fps);
                FPS_PRESETS
                    .iter()
                    .map(|fps| ui::MenuItem::new(format!("{fps} FPS"), Some(*fps) == current))
                    .collect()
            }
            MenuKind::AutomationExportCompression(rule, index) => {
                let current = self
                    .export_profile_at(rule, index)
                    .and_then(|profile| profile.compression)
                    .unwrap_or(AutomationExportCompression::Web);
                COMPRESSIONS
                    .iter()
                    .map(|(compression, label)| ui::MenuItem::new(*label, *compression == current))
                    .collect()
            }
            MenuKind::AutomationPreset(rule, index) => {
                let current = match self.rule_at(rule).and_then(|rule| rule.actions.get(index)) {
                    Some(Action::ApplyPreset { name }) => Some(name.clone()),
                    _ => None,
                };
                store::preset_names()
                    .into_iter()
                    .map(|name| {
                        let checked = current.as_deref() == Some(name.as_str());
                        ui::MenuItem::new(name, checked)
                    })
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    /// Commit for the pages' menus -- the other half of `pages_menu_items`.
    pub(crate) fn pages_choose(
        &mut self,
        kind: MenuKind,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match kind {
            MenuKind::S3Provider => {
                if let Some((value, _)) = S3_PROVIDERS.get(index) {
                    self.pages.s3.provider = (*value).to_string();
                }
            }
            MenuKind::AutomationTrigger(rule) => {
                if let Some(trigger) = ALL_TRIGGERS.get(index).copied() {
                    // Rebuilt because the name field's placeholder is derived
                    // from the trigger.
                    self.automation_mutate(rule, true, window, cx, |rule| rule.trigger = trigger);
                }
            }
            MenuKind::AutomationMatchMode(rule) => {
                let mode = if index == 0 {
                    MatchMode::All
                } else {
                    MatchMode::Any
                };
                self.automation_mutate(rule, false, window, cx, |rule| rule.match_mode = mode);
            }
            MenuKind::AutomationConditionType(rule, condition) => {
                if let Some(kind) = ALL_CONDITION_TYPES.get(index).copied() {
                    // `onReplace(defaultConditionForType(t))`.
                    self.automation_mutate(rule, true, window, cx, move |rule| {
                        if let Some(slot) = rule.conditions.get_mut(condition) {
                            *slot = default_condition(kind);
                        }
                    });
                }
            }
            MenuKind::AutomationConditionTarget(rule, condition) => {
                if let Some((target, _)) = CAPTURE_TARGETS.get(index).copied() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Condition::CaptureTargetIs { target: slot }) =
                            rule.conditions.get_mut(condition)
                        {
                            *slot = target;
                        }
                    });
                }
            }
            MenuKind::AutomationConditionMode(rule, condition) => {
                if let Some((mode, _)) = RECORDING_MODES.get(index).copied() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Condition::RecordingModeIs { mode: slot }) =
                            rule.conditions.get_mut(condition)
                        {
                            *slot = mode;
                        }
                    });
                }
            }
            MenuKind::AutomationActionType(rule, action) => {
                if let Some(kind) = ALL_ACTION_TYPES.get(index).copied() {
                    // `onReplace(defaultActionForType(t))`.
                    self.automation_mutate(rule, true, window, cx, move |rule| {
                        if let Some(slot) = rule.actions.get_mut(action) {
                            *slot = default_action(kind);
                        }
                    });
                }
            }
            MenuKind::AutomationClipboardSource(rule, action) => {
                if let Some((source, _)) = CLIPBOARD_SOURCES.get(index).copied() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Action::CopyToClipboard { source: slot }) =
                            rule.actions.get_mut(action)
                        {
                            *slot = source;
                        }
                    });
                }
            }
            MenuKind::AutomationWebhookMethod(rule, action) => {
                if let Some(method) = WEBHOOK_METHODS.get(index) {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Action::Webhook { method: slot, .. }) =
                            rule.actions.get_mut(action)
                        {
                            *slot = (*method).to_string();
                        }
                    });
                }
            }
            MenuKind::AutomationExportFormat(rule, action) => {
                if let Some((format, _)) = EXPORT_FORMATS.get(index).copied() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Action::Export { profile, .. }) = rule.actions.get_mut(action) {
                            profile.format = format;
                        }
                    });
                }
            }
            MenuKind::AutomationExportResolution(rule, action) => {
                if let Some((_, _, x, y)) = RESOLUTION_PRESETS.get(index).copied() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Action::Export { profile, .. }) = rule.actions.get_mut(action) {
                            profile.resolution_base = cap_project::XY { x, y };
                        }
                    });
                }
            }
            MenuKind::AutomationExportFps(rule, action) => {
                if let Some(fps) = FPS_PRESETS.get(index).copied() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Action::Export { profile, .. }) = rule.actions.get_mut(action) {
                            profile.fps = fps;
                        }
                    });
                }
            }
            MenuKind::AutomationExportCompression(rule, action) => {
                if let Some((compression, _)) = COMPRESSIONS.get(index).copied() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Action::Export { profile, .. }) = rule.actions.get_mut(action) {
                            profile.compression = Some(compression);
                        }
                    });
                }
            }
            MenuKind::AutomationPreset(rule, action) => {
                if let Some(name) = store::preset_names().get(index).cloned() {
                    self.automation_mutate(rule, false, window, cx, move |rule| {
                        if let Some(Action::ApplyPreset { name: slot }) =
                            rule.actions.get_mut(action)
                        {
                            *slot = name;
                        }
                    });
                }
            }
            _ => {}
        }
        cx.notify();
    }

    /// Run a future on the tokio runtime (reqwest and file IO both live
    /// there), then apply its result to the window. `window.refresh()` because
    /// a background-driven update does not repaint an inactive window.
    fn spawn_tokio<T, Fut>(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        future: Fut,
        done: impl FnOnce(&mut Self, T, &mut Window, &mut Context<Self>) + 'static,
    ) where
        T: Send + 'static,
        Fut: std::future::Future<Output = T> + Send + 'static,
    {
        cx.spawn_in(window, async move |this, cx| {
            let Ok(task) = cx.update(|_window, cx| gpui_tokio::Tokio::spawn(cx, future)) else {
                return;
            };
            let Ok(value) = task.await else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                done(this, value, window, cx);
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    /// `commands.globalMessageDialog(..)`.
    fn info_dialog(&mut self, message: &str, window: &mut Window, cx: &mut Context<Self>) {
        let answer = window.prompt(gpui::PromptLevel::Info, message, None, &["Ok"], cx);
        cx.spawn(async move |_this, _cx| {
            let _ = answer.await;
        })
        .detach();
    }

    /// A `ui::Select`-shaped trigger that opens one of these pages' menus.
    fn pages_select(
        &self,
        id: impl Into<gpui::ElementId>,
        label: impl Into<SharedString>,
        kind: MenuKind,
        cx: &mut Context<Self>,
    ) -> ui::Select {
        ui::Select::settings(&self.theme, id, label).on_click(cx.listener(
            move |this, event: &gpui::ClickEvent, window, cx| {
                this.open_menu(kind, event.position(), window, cx);
            },
        ))
    }

    /// A page-owned single-line input on the settings surface.
    fn pages_input(
        &self,
        id: impl Into<gpui::ElementId>,
        input: &Entity<ui::TextInputState>,
    ) -> ui::TextInput {
        ui::TextInput::settings(&self.theme, id, input)
    }
}

// ---------------------------------------------------------------------------
// Shortcuts (hotkeys.tsx)
// ---------------------------------------------------------------------------

/// `actions()` in hotkeys.tsx, with `ACTION_TEXT`'s labels, in render order.
const HOTKEY_ACTIONS: [(&str, &str); 11] = [
    ("screenshotDisplay", "Screenshot current display"),
    ("screenshotWindow", "Screenshot current window"),
    ("screenshotArea", "Screenshot area picker"),
    ("openRecordingPicker", "Open recording picker"),
    ("stopRecording", "Stop recording"),
    ("restartRecording", "Restart recording"),
    ("togglePauseRecording", "Pause/resume recording"),
    ("cycleRecordingMode", "Cycle recording mode"),
    ("openRecordingPickerDisplay", "Record display"),
    ("openRecordingPickerWindow", "Record window"),
    ("openRecordingPickerArea", "Record area"),
];

/// The gpui keystroke name for a key, as the W3C `KeyboardEvent.code` string
/// the Tauri app stores (`e.code` in hotkeys.tsx, `global_hotkey::Code` in
/// hotkeys.rs). `None` for keys neither side can bind.
fn hotkey_code_for_key(key: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix('f')
        && !rest.is_empty()
        && rest.len() <= 2
        && rest.chars().all(|c| c.is_ascii_digit())
    {
        return Some(format!("F{rest}"));
    }
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return match c {
            'a'..='z' => Some(format!("Key{}", c.to_ascii_uppercase())),
            'A'..='Z' => Some(format!("Key{c}")),
            '0'..='9' => Some(format!("Digit{c}")),
            ',' => Some("Comma".into()),
            '.' => Some("Period".into()),
            '/' => Some("Slash".into()),
            ';' => Some("Semicolon".into()),
            '\'' => Some("Quote".into()),
            '[' => Some("BracketLeft".into()),
            ']' => Some("BracketRight".into()),
            '\\' => Some("Backslash".into()),
            '-' => Some("Minus".into()),
            '=' => Some("Equal".into()),
            '`' => Some("Backquote".into()),
            _ => None,
        };
    }
    let code = match key {
        "space" => "Space",
        "enter" => "Enter",
        "tab" => "Tab",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        _ => return None,
    };
    Some(code.to_string())
}

/// `HotkeyText`'s key list: modifiers in ⌘⌃⌥⇧ order, then the main key.
/// [`ui::kbd_symbol`] does the per-OS glyph mapping.
fn hotkey_display_keys(hotkey: &Hotkey) -> Vec<String> {
    let mut keys = Vec::new();
    if hotkey.meta {
        keys.push("meta".to_string());
    }
    if hotkey.ctrl {
        keys.push("ctrl".to_string());
    }
    if hotkey.alt {
        keys.push("alt".to_string());
    }
    if hotkey.shift {
        keys.push("shift".to_string());
    }
    keys.push(hotkey.code.clone());
    keys
}

impl SettingsWindow {
    /// The window keydown listener while a binding is armed. Returns whether
    /// the key was consumed. Modifier-only presses never arrive as
    /// `KeyDownEvent`s in gpui, so `MODIFIER_KEYS` needs no equivalent.
    pub(crate) fn shortcuts_capture_key(
        &mut self,
        keystroke: &gpui::Keystroke,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.page != Page::Shortcuts || self.pages.listening.is_none() {
            return false;
        }
        // Escape restores the previous binding instead of becoming one --
        // the one deliberate divergence from the DOM listener, which cannot
        // bind Escape globally anyway (it is the overlay-cancel key).
        if keystroke.key == "escape" {
            self.shortcuts_restore_prev(cx);
            return true;
        }
        let Some(code) = hotkey_code_for_key(&keystroke.key) else {
            return true;
        };
        // A code the Tauri app cannot parse must never reach the store: its
        // `HotkeysStore` deserializes the whole `hotkeys` map strictly
        // (`serde_json::from_value` in `HotkeysStore::get`), so one bad entry
        // would silently drop every binding over there.
        if global_hotkey::hotkey::Code::from_str(&code).is_err() {
            return true;
        }
        let Some(listening) = self.pages.listening.as_ref() else {
            return true;
        };
        let action = HOTKEY_ACTIONS[listening.action].0;
        let hotkey = Hotkey {
            code,
            meta: keystroke.modifiers.platform,
            ctrl: keystroke.modifiers.control,
            alt: keystroke.modifiers.alt,
            shift: keystroke.modifiers.shift,
        };
        let value = serde_json::to_value(&hotkey).unwrap_or(Value::Null);
        self.pages.hotkeys.insert(action.to_string(), value);
        // `createEffect` persists on every store change, captures included --
        // but the OS registration waits for the confirm, exactly as
        // `commands.setHotkey` only runs from the buttons over there. Pressing
        // the candidate combo again keeps re-capturing it instead of firing
        // the action.
        self.shortcuts_save();
        cx.notify();
        true
    }

    /// The `createEffect` half: write the map to the shared store, touch
    /// nothing at the OS.
    fn shortcuts_save(&self) {
        if !store::set_hotkeys_raw(&self.pages.hotkeys) {
            tracing::warn!("saving the hotkeys store failed");
        }
    }

    /// The `commands.setHotkey` half: persist and swap the OS registrations.
    /// Deferred because the registry swap reads the store this just wrote.
    fn shortcuts_commit(&self, cx: &mut Context<Self>) {
        self.shortcuts_save();
        cx.defer(crate::hotkeys::reload);
    }

    /// The window click listener: an abandoned capture puts the previous
    /// binding back. Store only -- the capture never touched the OS
    /// registration, so there is nothing to swap back (the TSX cancel path
    /// never calls `setHotkey` either).
    fn shortcuts_restore_prev(&mut self, cx: &mut Context<Self>) {
        let Some(listening) = self.pages.listening.take() else {
            return;
        };
        let action = HOTKEY_ACTIONS[listening.action].0;
        match listening.prev {
            Some(prev) => {
                self.pages.hotkeys.insert(action.to_string(), prev);
            }
            None => {
                self.pages.hotkeys.remove(action);
            }
        }
        self.shortcuts_save();
        cx.notify();
    }

    pub(crate) fn render_shortcuts(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let listening_any = self.pages.listening.is_some();

        let mut rows: Vec<gpui::AnyElement> = Vec::new();
        for (index, (action, label)) in HOTKEY_ACTIONS.iter().enumerate() {
            let binding = self
                .pages
                .hotkeys
                .get(*action)
                .and_then(store::hotkey_from_value);
            let listening = self
                .pages
                .listening
                .as_ref()
                .is_some_and(|listening| listening.action == index);

            let right: gpui::AnyElement = if listening {
                self.render_shortcut_listening(index, binding.as_ref(), cx)
                    .into_any_element()
            } else {
                self.render_shortcut_idle(index, binding.as_ref(), cx)
                    .into_any_element()
            };

            rows.push(
                // `flex flex-row justify-between items-center w-full h-8`.
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_center()
                    .w_full()
                    .h(px(32.))
                    .child(div().text_size(px(13.)).child(*label))
                    .child(right)
                    .into_any_element(),
            );
            if index + 1 != HOTKEY_ACTIONS.len() {
                // `w-full h-px bg-gray-3`.
                rows.push(
                    div()
                        .w_full()
                        .h(px(1.))
                        .bg(theme.settings_border())
                        .into_any_element(),
                );
            }
        }

        let card = self
            .card(false)
            .id("shortcuts-card")
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(16.))
            // The window click listener: any press that reaches the card while
            // a capture is armed abandons it and restores the old binding.
            .when(listening_any, |this| {
                this.on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, _window, cx| this.shortcuts_restore_prev(cx)),
                )
            })
            .children(rows);

        vec![
            self.section(
                "Shortcuts",
                Some("Configure system-wide keyboard shortcuts to control Cap."),
                None,
                vec![card.into_any_element()],
            )
            .into_any_element(),
        ]
    }

    /// The resting state: the binding as keycap chips, or the `None` pill.
    fn render_shortcut_idle(
        &self,
        index: usize,
        binding: Option<&Hotkey>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let content: gpui::AnyElement = match binding {
            Some(hotkey) => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.))
                .children(
                    hotkey_display_keys(hotkey)
                        .into_iter()
                        .map(|key| ui::KbdChip::row(&theme, key)),
                )
                .into_any_element(),
            // `text-[11px] uppercase py-3 px-2.5 h-5 bg-gray-4 border
            //  border-gray-5 rounded-lg text-gray-11`.
            None => div()
                .flex()
                .items_center()
                .h(px(20.))
                .px(px(10.))
                .rounded(px(8.))
                .bg(theme.settings_fill())
                .border_1()
                .border_color(theme.settings_border())
                .text_size(px(11.))
                .text_color(theme.settings_muted())
                .child("NONE")
                .into_any_element(),
        };

        div()
            .id(("hotkey", index))
            .cursor_pointer()
            .child(content)
            .on_click(cx.listener(move |this, _, window, cx| {
                let prev = this.pages.hotkeys.get(HOTKEY_ACTIONS[index].0).cloned();
                this.pages.listening = Some(ListeningHotkey {
                    action: index,
                    prev,
                });
                // Keys must reach the root's on_key_down, not a focused field.
                this.focus_root(window, cx);
                cx.notify();
            }))
    }

    /// The armed state: confirm/clear buttons on the left, the live capture
    /// (or "Set hotkeys...") on the right -- `flex-row-reverse` in the TSX.
    fn render_shortcut_listening(
        &self,
        index: usize,
        binding: Option<&Hotkey>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let has_binding = binding.is_some();

        let mut buttons = div().flex().flex_row().items_center().gap(px(2.));
        if has_binding {
            // IconCapCircleCheck: commit and stop listening.
            buttons = buttons.child(
                div()
                    .id(("hotkey-confirm", index))
                    .cursor_pointer()
                    .child(
                        svg()
                            .path("icons/circle-check.svg")
                            .size(px(20.))
                            .text_color(theme.settings_text()),
                    )
                    .hover(|style| style.opacity(0.7))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.pages.listening = None;
                        this.shortcuts_commit(cx);
                        cx.notify();
                    })),
            );
        }
        // IconCapCircleX: clear the binding entirely.
        buttons = buttons.child(
            div()
                .id(("hotkey-clear", index))
                .cursor_pointer()
                .child(
                    svg()
                        .path("icons/circle-x.svg")
                        .size(px(20.))
                        .text_color(Hsla::from(rgb(0xef4444))),
                )
                .hover(|style| style.opacity(0.7))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, _window, cx| {
                    this.pages.listening = None;
                    this.pages.hotkeys.remove(HOTKEY_ACTIONS[index].0);
                    this.shortcuts_commit(cx);
                    cx.notify();
                })),
        );

        let capture: gpui::AnyElement = match binding {
            Some(hotkey) => div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.))
                .children(
                    hotkey_display_keys(hotkey)
                        .into_iter()
                        .map(|key| ui::KbdChip::row(&theme, key)),
                )
                .into_any_element(),
            None => div()
                .text_size(px(13.))
                .text_color(theme.settings_muted())
                .child("Set hotkeys...")
                .into_any_element(),
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .child(buttons)
            .child(capture)
    }
}

// ---------------------------------------------------------------------------
// CLI (cli.tsx)
// ---------------------------------------------------------------------------

impl SettingsWindow {
    fn cli_refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pages.cli_status = None;
        cx.spawn_in(window, async move |this, cx| {
            let status = cx
                .background_executor()
                .spawn(async { cli_install::status() })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.pages.cli_status = Some(status);
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn cli_run(&mut self, uninstall: bool, window: &mut Window, cx: &mut Context<Self>) {
        if uninstall {
            self.pages.cli_uninstalling = true;
        } else {
            self.pages.cli_installing = true;
        }
        self.pages.cli_error = None;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    if uninstall {
                        cli_install::uninstall()
                    } else {
                        cli_install::install()
                    }
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.pages.cli_installing = false;
                this.pages.cli_uninstalling = false;
                match result {
                    Ok(status) => this.pages.cli_status = Some(Ok(status)),
                    Err(error) => {
                        // `toast.error(..)` then `refetch()` in cli.tsx.
                        this.pages.cli_error = Some(error);
                        this.cli_refresh(window, cx);
                    }
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn render_cli(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;

        let body: gpui::AnyElement = match &self.pages.cli_status {
            // `h-20 rounded-lg bg-gray-3 animate-pulse` (static here -- no
            // keyframe ticker for a placeholder).
            None => div()
                .h(px(80.))
                .rounded(px(8.))
                .bg(theme.settings_fill())
                .into_any_element(),
            Some(Err(error)) => div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(Hsla::from(theme.red_9))
                        .child(format!("Couldn't load CLI status: {error}")),
                )
                .child(div().child(self.button(
                    "cli-retry",
                    (ui::ButtonVariant::Gray, None),
                    "Retry",
                    false,
                    cx,
                    |this, window, cx| this.cli_refresh(window, cx),
                )))
                .into_any_element(),
            Some(Ok(status)) => self
                .render_cli_status(status.clone(), cx)
                .into_any_element(),
        };

        vec![
            self.section(
                "Command Line",
                Some(
                    "Install the Cap command for terminals, agents, scripts, and local automation.",
                ),
                None,
                vec![self.card(true).child(body).into_any_element()],
            )
            .into_any_element(),
        ]
    }

    fn render_cli_status(
        &self,
        status: cli_install::CliInstallStatus,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let installing = self.pages.cli_installing;
        let uninstalling = self.pages.cli_uninstalling;

        let install_label = if installing {
            if status.installed {
                "Repairing..."
            } else {
                "Installing..."
            }
        } else if status.installed {
            "Repair"
        } else {
            "Install CLI"
        };

        // `<code class="font-mono text-gray-12">`.
        let code_span = |text: String| {
            div()
                .font_family(MONO_FONT)
                .text_color(theme.settings_text())
                .child(text)
        };

        let header = div()
            .flex()
            .flex_row()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .min_w_0()
                    .child(div().text_size(px(13.)).child(if status.installed {
                        "Installed"
                    } else {
                        "Not installed"
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .flex_wrap()
                            .items_center()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(theme.settings_muted())
                            .child("The desktop app installs a local\u{a0}")
                            .child(code_span("cap".into()).text_size(px(12.)))
                            .child("\u{a0}command that points back to the bundled CLI."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_shrink_0()
                    .gap(px(8.))
                    .when(status.installed, |this| {
                        this.child(self.button(
                            "cli-remove",
                            (ui::ButtonVariant::Gray, None),
                            if uninstalling {
                                "Removing..."
                            } else {
                                "Remove"
                            },
                            uninstalling,
                            cx,
                            |this, window, cx| this.cli_run(true, window, cx),
                        ))
                    })
                    .child(self.button(
                        "cli-install",
                        (ui::ButtonVariant::Dark, None),
                        install_label,
                        installing,
                        cx,
                        |this, window, cx| this.cli_run(false, window, cx),
                    )),
            );

        // `<PathRow>`: `w-16` label, mono value chip.
        let path_row = |label: &'static str, value: String| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.))
                .min_w_0()
                .child(
                    div()
                        .w(px(64.))
                        .flex_shrink_0()
                        .text_size(px(12.))
                        .text_color(theme.settings_muted())
                        .child(label),
                )
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .px(px(8.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .bg(theme.settings_fill())
                        .font_family(MONO_FONT)
                        .text_size(px(11.))
                        .text_color(theme.settings_text())
                        .child(value),
                )
        };

        let shell_command = status.shell_command.clone();

        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(header)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(path_row("Command", status.shim_path.clone()))
                    .child(path_row("Target", status.target_path.clone())),
            )
            .when_some(status.conflict.clone(), |this, conflict| {
                // `rounded-lg border border-red-300/40 bg-red-500/10 px-3 py-2
                //  text-xs text-red-11`.
                this.child(
                    div()
                        .px(px(12.))
                        .py(px(8.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(Theme::with_alpha(theme.red_9, 0.4))
                        .bg(Theme::with_alpha(theme.red_9, 0.1))
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(Hsla::from(theme.red_9))
                        .child(conflict),
                )
            })
            .when_some(self.pages.cli_error.clone(), |this, error| {
                // cli.tsx surfaces install/remove failures as toasts; inline
                // red text is the stand-in.
                this.child(
                    div()
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.red_9))
                        .child(error),
                )
            })
            .when(status.installed && !status.on_path, |this| {
                let help: gpui::AnyElement = if status.path_configured {
                    div()
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(theme.settings_muted())
                        .child(
                            "Added cap to your PATH. Restart your terminal to use it, or run \
                             this now:",
                        )
                        .into_any_element()
                } else {
                    div()
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(theme.settings_muted())
                        .child(format!(
                            "Add {} to your PATH to use cap from a new terminal.",
                            status.path_entry
                        ))
                        .into_any_element()
                };
                this.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .px(px(12.))
                        .py(px(12.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(theme.settings_border())
                        .bg(theme.settings_fill())
                        .child(help)
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .px(px(8.))
                                        .py(px(6.))
                                        .rounded(px(6.))
                                        .bg(theme.settings_card_bg())
                                        .font_family(MONO_FONT)
                                        .text_size(px(12.))
                                        .text_color(theme.settings_text())
                                        .child(status.shell_command.clone()),
                                )
                                .child(self.button(
                                    "cli-copy-path",
                                    (ui::ButtonVariant::Gray, None),
                                    if self.pages.cli_copied {
                                        "Copied"
                                    } else {
                                        "Copy"
                                    },
                                    false,
                                    cx,
                                    move |this, window, cx| {
                                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                            shell_command.clone(),
                                        ));
                                        this.pages.cli_copied = true;
                                        this.pages.cli_copied_reset =
                                            Some(cx.spawn_in(window, async move |this, cx| {
                                                cx.background_executor()
                                                    .timer(Duration::from_millis(1500))
                                                    .await;
                                                this.update(cx, |this, cx| {
                                                    this.pages.cli_copied = false;
                                                    cx.notify();
                                                })
                                                .ok();
                                            }));
                                        cx.notify();
                                    },
                                )),
                        ),
                )
            })
    }
}

// ---------------------------------------------------------------------------
// Transcription (transcription.tsx)
// ---------------------------------------------------------------------------

impl SettingsWindow {
    /// `addHint()`.
    fn transcription_add_hint(&mut self, cx: &mut Context<Self>) {
        let value = self.pages.hint_draft.replace('\0', "");
        let value = value.trim().to_string();
        if value.is_empty() {
            return;
        }

        let mut next = self.pages.hints.clone();
        next.push(value);
        let next = store::normalize_transcription_hints(next);
        let input = self.pages.hint_input.clone();
        input.update(cx, |input, cx| input.set_text("", cx));
        self.pages.hint_draft.clear();
        if next.len() == self.pages.hints.len() {
            cx.notify();
            return;
        }
        self.pages.hints = next.clone();
        self.transcription_persist(next, cx);
    }

    /// `persist()`: 250ms debounce, then the store write, then the 1.2s
    /// "Saved" hold. Assigning over the task drops the pending write, which
    /// is `clearTimeout`.
    fn transcription_persist(&mut self, hints: Vec<String>, cx: &mut Context<Self>) {
        let normalized = store::normalize_transcription_hints(hints);
        self.pages.hint_save = HintSave::Saving;
        self.pages.hint_save_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(250))
                .await;
            let ok = this
                .update(cx, |this, cx| {
                    let ok = store::set_store_setting(
                        GENERAL_SETTINGS,
                        "transcriptionHints",
                        Value::Array(normalized.iter().cloned().map(Value::String).collect()),
                    );
                    this.pages.hint_save = if ok { HintSave::Saved } else { HintSave::Idle };
                    cx.notify();
                    ok
                })
                .unwrap_or(false);
            if !ok {
                return;
            }
            cx.background_executor()
                .timer(Duration::from_millis(1200))
                .await;
            this.update(cx, |this, cx| {
                if this.pages.hint_save == HintSave::Saved {
                    this.pages.hint_save = HintSave::Idle;
                    cx.notify();
                }
            })
            .ok();
        }));
        cx.notify();
    }

    fn transcription_remove_hint(&mut self, hint: String, cx: &mut Context<Self>) {
        self.pages.hints.retain(|existing| *existing != hint);
        let next = self.pages.hints.clone();
        self.transcription_persist(next, cx);
    }

    pub(crate) fn render_transcription(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let hints = self.pages.hints.clone();
        let save_label = match self.pages.hint_save {
            HintSave::Saving => "Saving...",
            HintSave::Saved => "Saved",
            HintSave::Idle => "",
        };

        let header = div()
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
                    .min_w_0()
                    .child(div().text_size(px(13.)).child("Remembered terms"))
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(theme.settings_muted())
                            .child(
                                "Add one term at a time to reduce typos and formatting mistakes.",
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .when(!hints.is_empty(), |this| {
                        this.child(self.button(
                            "hints-clear",
                            (ui::ButtonVariant::Gray, None),
                            "Clear",
                            false,
                            cx,
                            |this, _window, cx| {
                                this.pages.hints.clear();
                                this.transcription_persist(Vec::new(), cx);
                            },
                        ))
                    })
                    .child(
                        // `min-w-15 text-right text-xs text-gray-11`.
                        div()
                            .min_w(px(60.))
                            .text_size(px(12.))
                            .text_color(theme.settings_muted())
                            .child(save_label),
                    ),
            );

        let add_disabled = self.pages.hint_draft.trim().is_empty();
        let input_row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(self.pages_input("hint-input", &self.pages.hint_input)),
            )
            .child(self.button(
                "hints-add",
                (ui::ButtonVariant::Primary, Some("icons/plus.svg")),
                "Add",
                add_disabled,
                cx,
                |this, _window, cx| this.transcription_add_hint(cx),
            ));

        let card = self
            .card(true)
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(header)
            .child(input_row)
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.settings_muted())
                    .child("These hints are applied when you generate captions in the editor."),
            );

        let mut sections = vec![
            self.section(
                "Transcription",
                Some(
                    "Add names, spellings, domains, and capitalization preferences that caption \
                     generation should keep in mind.",
                ),
                None,
                vec![card.into_any_element()],
            )
            .into_any_element(),
        ];

        if !hints.is_empty() {
            let count = div()
                .text_size(px(12.))
                .text_color(theme.settings_muted())
                .child(format!(
                    "{} {}",
                    hints.len(),
                    if hints.len() == 1 { "item" } else { "items" }
                ))
                .into_any_element();
            let chips = div().flex().flex_row().flex_wrap().gap(px(8.)).children(
                hints.into_iter().enumerate().map(|(index, hint)| {
                    let remove = hint.clone();
                    // `px-2.5 py-1 rounded-full text-xs bg-gray-3 border
                    //  border-gray-4 hover:bg-gray-4`.
                    div()
                        .id(("hint-chip", index))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .px(px(10.))
                        .py(px(4.))
                        .rounded_full()
                        .bg(theme.settings_fill())
                        .border_1()
                        .border_color(theme.settings_border())
                        .text_size(px(12.))
                        .cursor_pointer()
                        .hover(|style| style.bg(theme.settings_selection()))
                        .child(hint)
                        .child(
                            svg()
                                .path("icons/x.svg")
                                .size(px(12.))
                                .text_color(theme.settings_muted()),
                        )
                        .on_click(cx.listener(move |this, _, _window, cx| {
                            this.transcription_remove_hint(remove.clone(), cx);
                        }))
                }),
            );

            sections.push(
                self.section(
                    "Active hints",
                    None,
                    Some(count),
                    vec![self.card(true).child(chips).into_any_element()],
                )
                .into_any_element(),
            );
        }

        sections
    }
}

// ---------------------------------------------------------------------------
// Experimental (experimental.tsx)
// ---------------------------------------------------------------------------

/// The hand-back takeover, mirroring `experimental.tsx`'s overlay: the toggle
/// is the confirmation, and the sequence is what the user reads while Cancel is
/// on screen.
pub(crate) enum SwitchBack {
    /// The sequence, timed from its start. One clock drives the sentence, its
    /// fade and the countdown, so nothing can drift apart.
    Running(std::time::Instant),
    /// Dev only: the switch is committed and the supervisor is rebuilding the
    /// classic app; this app stays up until the classic one deletes the
    /// pending file to say it is on screen (`store::classic_pending_path`).
    WaitingForClassic,
    /// The switch was refused; the overlay stays up with the reason and the
    /// toggle goes back to on, because nothing was switched.
    Failed(String),
}

/// A cold dev build can genuinely take this long; past it, assume the build
/// failed and hand the user back their app with a pointer at the terminal.
const CLASSIC_WAIT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// One line at a time, fading between them, underneath the countdown rather
/// than ahead of it: the numeral is on screen from the first frame.
const SWITCH_SENTENCES: &[&str] = &[
    "Switching back to the classic Cap app.",
    "Your recordings and settings stay exactly where they are.",
];
const SWITCH_SENTENCE_MS: u64 = 2000;
const SWITCH_FADE_MS: f32 = 400.;
const SWITCH_COUNTDOWN_FROM: u32 = 5;
const SWITCH_TAKEOVER_MS: u64 = SWITCH_COUNTDOWN_FROM as u64 * 1000;

/// The overlay's whole appearance at one instant: which sentence, how opaque,
/// and the number.
fn takeover_frame(elapsed_ms: f32) -> (usize, f32, u32) {
    let last = SWITCH_SENTENCES.len() - 1;
    let index = ((elapsed_ms / SWITCH_SENTENCE_MS as f32) as usize).min(last);
    let within = elapsed_ms - index as f32 * SWITCH_SENTENCE_MS as f32;
    let fade_in = (within / SWITCH_FADE_MS).clamp(0., 1.);
    // The last line holds rather than fading out; blanking the column while the
    // countdown finishes would read as a stall.
    let alpha = if index == last {
        fade_in
    } else {
        fade_in.min(((SWITCH_SENTENCE_MS as f32 - within) / SWITCH_FADE_MS).clamp(0., 1.))
    };
    // Five on the first frame down to one in the last second; the switch fires
    // rather than ever showing zero.
    let left = SWITCH_TAKEOVER_MS as f32 - elapsed_ms;
    let remaining = (left / 1000.)
        .ceil()
        .clamp(1., SWITCH_COUNTDOWN_FROM as f32) as u32;
    (index, alpha, remaining)
}

/// Where the classic app lives when this build was not started from inside its
/// bundle and is not a dev build either.
const CLASSIC_APP_FALLBACK: &str = "/Applications/Cap.app";

#[cfg(windows)]
const CLASSIC_EXECUTABLE_NAME: &str = "Cap.exe";
#[cfg(not(windows))]
const CLASSIC_EXECUTABLE_NAME: &str = "Cap";

/// What "the classic app" means for this process -- decided from where its
/// binary lives, so dev sessions reopen the dev app and installed ones the
/// installed app.
#[derive(Debug, PartialEq)]
enum ClassicTarget {
    /// `open` this bundle: the shipped layout is
    /// `.../Cap.app/Contents/MacOS/cap-gpui`, so the nearest `.app`
    /// ancestor is the classic app this binary shipped inside.
    Bundle(std::path::PathBuf),
    /// Windows and Linux install Tauri sidecars beside the main executable.
    Executable(std::path::PathBuf),
    /// A cargo-built binary (an ancestor directory literally named `target`):
    /// the classic app here is the `tauri dev` harness, which cannot be
    /// `open`ed -- ask the dev-session supervisor to restart it instead
    /// (`store::request_classic_reopen`).
    DevSupervisor,
}

fn classic_target_for_exe(exe: &std::path::Path) -> Option<ClassicTarget> {
    if let Some(bundle) = exe
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
    {
        return Some(ClassicTarget::Bundle(bundle.to_path_buf()));
    }
    if exe
        .components()
        .any(|component| component.as_os_str() == "target")
    {
        return Some(ClassicTarget::DevSupervisor);
    }

    if let Some(parent) = exe.parent() {
        let executable = parent.join(CLASSIC_EXECUTABLE_NAME);
        if executable.is_file() && executable != exe {
            return Some(ClassicTarget::Executable(executable));
        }
    }

    let fallback = std::path::PathBuf::from(CLASSIC_APP_FALLBACK);
    fallback.is_dir().then_some(ClassicTarget::Bundle(fallback))
}

fn classic_target() -> Option<ClassicTarget> {
    std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(classic_target_for_exe)
}

pub(crate) fn start_update_handoff(cx: &mut gpui::App) {
    begin_update_handoff(cx, store::request_update_handoff);
}

fn quit_after_flushing_editors(cx: &mut gpui::App) {
    crate::app_windows::flush_pending_editor_saves(cx);
    crate::menus::quit(cx);
}

#[cfg(debug_assertions)]
pub(crate) fn simulate_update_handoff(cx: &mut gpui::App) {
    cx.spawn(async move |cx| {
        crate::platform::activate_app();
        if crate::platform::confirm_dialog(
            "Update Cap",
            "Version 99.0.0 of Cap is available. Would you like to install it?",
            "Update",
            "Ignore",
            false,
        ) {
            cx.update(|cx| begin_update_handoff(cx, store::request_simulated_update_handoff));
        }
    })
    .detach();
}

fn begin_update_handoff(cx: &mut gpui::App, request_handoff: fn() -> std::io::Result<()>) {
    if update_handoff_blocked(cx) {
        return;
    }

    let Some(target) = classic_target() else {
        cx.open_url("https://cap.so/download");
        return;
    };

    if matches!(target, ClassicTarget::DevSupervisor) && !cfg!(debug_assertions) {
        cx.open_url("https://cap.so/download");
        return;
    }

    if update_handoff_blocked(cx) {
        return;
    }
    crate::app_windows::flush_pending_editor_saves(cx);

    if let Err(error) = request_handoff() {
        tracing::error!("couldn't request the Tauri updater: {error}");
        cx.open_url("https://cap.so/download");
        return;
    }

    let started = match &target {
        ClassicTarget::Bundle(_) | ClassicTarget::Executable(_) => launch_classic(&target),
        ClassicTarget::DevSupervisor => {
            store::mark_classic_pending().and_then(|()| store::request_classic_reopen())
        }
    };

    match (started, target) {
        (Ok(()), ClassicTarget::Bundle(_) | ClassicTarget::Executable(_)) => {
            tracing::info!("handing off to the Tauri updater");
            quit_after_flushing_editors(cx);
        }
        (Ok(()), ClassicTarget::DevSupervisor) => {
            tracing::info!("handing off to the Tauri updater; waiting for the dev app");
            cx.spawn(async move |cx| {
                let started = std::time::Instant::now();
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(250))
                        .await;

                    if !store::classic_pending_path().exists() {
                        tracing::info!("the Tauri updater is ready; quitting Cap GPUI");
                        cx.update(quit_after_flushing_editors);
                        return;
                    }

                    if started.elapsed() > CLASSIC_WAIT_TIMEOUT {
                        store::clear_update_handoff();
                        tracing::error!("the dev app did not start for the update hand-off");
                        return;
                    }
                }
            })
            .detach();
        }
        (Err(error), _) => {
            store::clear_update_handoff();
            tracing::error!("couldn't open the Tauri updater: {error}");
            cx.open_url("https://cap.so/download");
        }
    }
}

fn update_handoff_blocked(cx: &mut gpui::App) -> bool {
    if !crate::updates::work_in_flight(cx) {
        return false;
    }

    tracing::info!(
        "deferring update hand-off while recording, exporting, uploading, importing, or transcribing"
    );
    cx.spawn(async move |_| {
        crate::platform::alert_dialog(
            "Cap is busy",
            "Finish your recording, export, upload, import, or transcription task before checking for updates.",
        );
    })
    .detach();
    true
}

impl SettingsWindow {
    pub(crate) fn render_experimental(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        // No "Native camera preview" toggle here: in this app the native
        // camera path is the only implementation, so the Tauri page's
        // experimental switch has nothing to switch. The store key
        // (`enableNativeCameraPreview`) stays readable in `store.rs` and is
        // left untouched in the shared store -- the Tauri app still uses it.
        let sections = vec![
            self.section(
                "Reliability",
                None,
                None,
                vec![
                    self.rows(vec![
                        self.setting_row(
                            "Out-of-process muxer",
                            Some(
                                "Run the fragmented-MP4 muxer in an isolated subprocess so muxer \
                             crashes can't take down your recording. Requires the bundled \
                             cap-muxer binary.",
                            ),
                            self.toggle(
                                "out-of-process-muxer",
                                self.settings.out_of_process_muxer,
                                cx,
                                |this, cx| {
                                    this.settings.out_of_process_muxer =
                                        !this.settings.out_of_process_muxer;
                                    let value = this.settings.out_of_process_muxer;
                                    this.write_bool("outOfProcessMuxer", value, cx);
                                },
                            )
                            .into_any_element(),
                        ),
                    ])
                    .into_any_element(),
                ],
            )
            .into_any_element(),
            self.section(
                "Native app",
                None,
                None,
                vec![self.rows(vec![self.native_app_row(cx)]).into_any_element()],
            )
            .into_any_element(),
        ];

        #[cfg(debug_assertions)]
        let sections = {
            let mut sections = sections;
            sections.push(
                self.section(
                    "Updates",
                    None,
                    None,
                    vec![
                        self.rows(vec![
                            self.setting_row(
                                "Simulate an update",
                                Some(
                                    "Preview the complete update flow without downloading or \
                                     installing anything.",
                                ),
                                self.button(
                                    "simulate-update",
                                    (ui::ButtonVariant::Dark, None),
                                    "Simulate update",
                                    false,
                                    cx,
                                    |_, _, cx| simulate_update_handoff(cx),
                                )
                                .into_any_element(),
                            ),
                        ])
                        .into_any_element(),
                    ],
                )
                .into_any_element(),
            );
            sections
        };

        sections
    }

    /// The mirror of the Tauri page's Native app row: it hands the session over
    /// to this app, this one hands it back.
    fn native_app_row(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        // Being in this app is what the toggle means, so it reads on even when
        // the stored flag does not -- a `cargo run` or `dev.sh` launch never
        // went through the hand-off. The flag only routes the Tauri app's
        // startup.
        let checked = !matches!(self.pages.switch_back, Some(SwitchBack::Running(_)));
        self.setting_row(
            "Cap GPUI",
            Some(
                "You are using the native version of Cap. Turning this off closes it and reopens \
                 the classic app. Your recordings and settings are shared.",
            ),
            self.toggle("enable-gpui-app", checked, cx, |this, cx| {
                match this.pages.switch_back {
                    Some(SwitchBack::Running(_)) => this.cancel_switch_back(cx),
                    // Committed: the classic app is already being brought up.
                    Some(SwitchBack::WaitingForClassic) => {}
                    _ => this.start_switch_back(cx),
                }
            })
            .into_any_element(),
        )
    }

    /// The full-window takeover, painted from `SettingsWindow::render` so it
    /// covers the sidebar and the menus too.
    pub(crate) fn render_switch_overlay(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let switch = self.pages.switch_back.as_ref()?;
        let white = gpui::white();
        let mut column = div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            // Nothing behind the takeover is clickable while it runs.
            .occlude()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(28.))
            .bg(gpui::hsla(0., 0., 0., 0.92));

        match switch {
            SwitchBack::Running(started) => {
                let (index, alpha, remaining) =
                    takeover_frame(started.elapsed().as_secs_f32() * 1000.);
                column = column
                    .child(
                        div()
                            .text_size(px(72.))
                            .line_height(px(76.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(white)
                            .child(SharedString::from(remaining.to_string())),
                    )
                    .child(
                        div()
                            .h(px(40.))
                            .max_w(px(380.))
                            .flex()
                            .items_center()
                            .text_size(px(15.))
                            .text_center()
                            .text_color(gpui::hsla(0., 0., 1., alpha))
                            .child(SWITCH_SENTENCES[index]),
                    );
            }
            SwitchBack::WaitingForClassic => {
                column = column
                    .child(
                        div()
                            .max_w(px(380.))
                            .text_size(px(17.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_center()
                            .text_color(white)
                            .child("Opening the classic Cap app"),
                    )
                    .child(
                        div()
                            .max_w(px(380.))
                            .text_size(px(14.))
                            .text_center()
                            .text_color(gpui::hsla(0., 0., 1., 0.7))
                            .child(
                                "The dev build is compiling. This window closes by itself when \
                                 the classic app is on screen; a cold build can take a few \
                                 minutes.",
                            ),
                    );
            }
            SwitchBack::Failed(error) => {
                column = column.child(
                    div()
                        .max_w(px(380.))
                        .text_size(px(14.))
                        .text_center()
                        .text_color(rgb(0xf87171))
                        .child(SharedString::from(error.clone())),
                );
            }
        }

        // Committed states have nothing to cancel.
        if matches!(switch, SwitchBack::WaitingForClassic) {
            return Some(column.into_any_element());
        }

        Some(
            column
                .child(
                    div()
                        .id("switch-back-cancel")
                        .flex()
                        .items_center()
                        .px(px(16.))
                        .h(px(32.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(gpui::hsla(0., 0., 1., 0.25))
                        .text_size(px(13.))
                        .text_color(white)
                        .cursor_pointer()
                        .hover(|style| style.bg(gpui::hsla(0., 0., 1., 0.12)))
                        .on_click(cx.listener(|this, _, _window, cx| this.cancel_switch_back(cx)))
                        .child("Cancel"),
                )
                .into_any_element(),
        )
    }

    fn start_switch_back(&mut self, cx: &mut Context<Self>) {
        if self.switch_back_blocked(cx) {
            return;
        }

        self.pages.switch_back = Some(SwitchBack::Running(std::time::Instant::now()));
        // gpui only renders on invalidation, so the fades and the countdown
        // need a pulse to run at all -- the `toggle_placeholders` shape.
        // Assigning over the previous task drops it, which is how Cancel and a
        // restart stop the one already in flight.
        self.pages.switch_back_ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                let running = this
                    .update(cx, |this, cx| {
                        let started = match &this.pages.switch_back {
                            Some(SwitchBack::Running(started)) => *started,
                            _ => return false,
                        };
                        if started.elapsed() >= Duration::from_millis(SWITCH_TAKEOVER_MS) {
                            this.finish_switch_back(cx);
                            return false;
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !running {
                    return;
                }
            }
        }));
        cx.notify();
    }

    fn cancel_switch_back(&mut self, cx: &mut Context<Self>) {
        self.pages.switch_back = None;
        self.pages.switch_back_ticker = None;
        cx.notify();
    }

    fn switch_back_blocked(&mut self, cx: &mut Context<Self>) -> bool {
        if !crate::updates::work_in_flight(cx) {
            return false;
        }

        self.pages.switch_back = Some(SwitchBack::Failed(
            "Finish your recording, export, upload, import, or transcription task before switching to the classic app."
                .to_string(),
        ));
        cx.notify();
        true
    }

    /// Write the flag, start the classic app, then quit -- in that order, so
    /// the app that comes up already owns the session. Nothing is written when
    /// there is no way to start one: the flag would strand the user in an app
    /// that redirects to one that is not installed.
    fn finish_switch_back(&mut self, cx: &mut Context<Self>) {
        if self.switch_back_blocked(cx) {
            return;
        }

        let Some(target) = classic_target() else {
            self.pages.switch_back = Some(SwitchBack::Failed(
                "Couldn't find the Cap app to switch back to.".to_string(),
            ));
            cx.notify();
            return;
        };

        if self.switch_back_blocked(cx) {
            return;
        }
        crate::app_windows::flush_pending_editor_saves(cx);

        self.settings.enable_gpui_app = false;
        self.write_bool("enableGpuiApp", false, cx);

        let started = match &target {
            ClassicTarget::Bundle(_) | ClassicTarget::Executable(_) => launch_classic(&target)
                .map_err(|error| format!("Couldn't open the Cap app: {error}")),
            ClassicTarget::DevSupervisor => store::mark_classic_pending()
                .and_then(|()| store::request_classic_reopen())
                .map_err(|error| format!("Couldn't request the dev app restart: {error}")),
        };

        match (started, target) {
            // An installed bundle opens in a moment; quit right away.
            (Ok(()), ClassicTarget::Bundle(_) | ClassicTarget::Executable(_)) => {
                tracing::info!("handing back to the classic app");
                quit_after_flushing_editors(cx);
            }
            // The dev harness has to rebuild first, which can take minutes.
            // Stay up until the classic app deletes the pending file to say
            // it is on screen, so the user is never staring at no app at all.
            (Ok(()), ClassicTarget::DevSupervisor) => {
                tracing::info!("handing back to the classic app; waiting for the dev build");
                self.pages.switch_back = Some(SwitchBack::WaitingForClassic);
                cx.notify();
                // Occupies the ticker slot so starting or cancelling another
                // sequence drops this waiter with it.
                self.pages.switch_back_ticker = Some(cx.spawn(async move |this, cx| {
                    let started = std::time::Instant::now();
                    loop {
                        cx.background_executor()
                            .timer(Duration::from_millis(500))
                            .await;
                        let waiting = this
                            .update(cx, |this, _| {
                                matches!(
                                    this.pages.switch_back,
                                    Some(SwitchBack::WaitingForClassic)
                                )
                            })
                            .unwrap_or(false);
                        if !waiting {
                            break;
                        }
                        if !store::classic_pending_path().exists() {
                            tracing::info!("classic app is up; quitting");
                            cx.update(quit_after_flushing_editors);
                            break;
                        }
                        if started.elapsed() > CLASSIC_WAIT_TIMEOUT {
                            this.update(cx, |this, cx| {
                                this.pages.switch_back = Some(SwitchBack::Failed(
                                    "The classic app hasn't come up. Check the dev terminal for \
                                     build errors, then toggle again."
                                        .to_string(),
                                ));
                                cx.notify();
                            })
                            .ok();
                            break;
                        }
                    }
                }));
            }
            (Err(message), _) => {
                tracing::error!("{message}");
                self.settings.enable_gpui_app = true;
                self.write_bool("enableGpuiApp", true, cx);
                self.pages.switch_back = Some(SwitchBack::Failed(message));
                cx.notify();
            }
        }
    }
}

fn launch_classic(target: &ClassicTarget) -> std::io::Result<()> {
    match target {
        ClassicTarget::Bundle(bundle) => std::process::Command::new("/usr/bin/open")
            .arg(bundle)
            .spawn()
            .map(drop),
        ClassicTarget::Executable(executable) => {
            std::process::Command::new(executable).spawn().map(drop)
        }
        ClassicTarget::DevSupervisor => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Feedback (feedback.tsx)
// ---------------------------------------------------------------------------

impl SettingsWindow {
    /// The page's two one-shot probes: the OS string and whether there is a
    /// `cap` sidecar to run the sync test with. Both stat the filesystem, so
    /// neither runs on the UI thread and neither is repeated per frame.
    fn feedback_load_os_version(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pages.os_version.is_some() {
            return;
        }
        cx.spawn_in(window, async move |this, cx| {
            let version = cx.background_executor().spawn(async { os_version() }).await;
            let selftest = cx
                .background_executor()
                .spawn(async { diagnostics::resolve_selftest_binary() })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.pages.os_version = Some(version);
                this.pages.selftest_binary = Some(selftest);
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    /// `sendFeedbackAction`: POST `/api/desktop/feedback` as a urlencoded
    /// form with the bearer token from the auth store.
    fn feedback_submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pages.feedback == FeedbackStatus::Pending {
            return;
        }
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            // `protectedHeaders()`'s throw.
            self.pages.feedback = FeedbackStatus::Error(
                "Please sign in to continue. Alternatively, email hello@cap.so or join our \
                 Discord at cap.link/discord"
                    .to_string(),
            );
            cx.notify();
            return;
        };

        let feedback = self.pages.feedback_draft.clone();
        let url = format!("{}/api/desktop/feedback", self.settings.server_url);
        let os = if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "linux"
        };
        self.pages.feedback = FeedbackStatus::Pending;
        let input = self.pages.feedback_input.clone();
        input.update(cx, |input, cx| input.set_disabled(true, cx));
        cx.notify();

        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::Form(vec![
                        ("feedback", feedback),
                        ("os", os.to_string()),
                        ("version", env!("CARGO_PKG_VERSION").to_string()),
                    ]),
                    None,
                )
                .await
            },
            |this, result, _window, cx| {
                let input = this.pages.feedback_input.clone();
                input.update(cx, |input, cx| input.set_disabled(false, cx));
                this.pages.feedback = match result {
                    Ok((200, _)) => FeedbackStatus::Success,
                    Ok(_) => FeedbackStatus::Error("Failed to submit feedback".to_string()),
                    Err(error) => FeedbackStatus::Error(error.text()),
                };
            },
        );
    }

    /// Run the A/V sync self-test, then collect the environment report around
    /// it and write it next to the store.
    ///
    /// The self-test is a subprocess by necessity -- it builds its own event
    /// loop and needs the process main thread, which gpui owns -- and the
    /// environment probes block for tens of seconds, so the whole thing lives
    /// on the background executor and reports back over a channel, the same
    /// shape the editor's export progress uses.
    fn diagnostic_run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.pages.diagnostic, DiagnosticStatus::Running { .. }) {
            return;
        }

        // The test starts its own recording and flashes the screen, which
        // would land in whatever the user is currently recording.
        if crate::session::RecordingSession::recording_in_flight(cx) {
            self.pages.diagnostic = DiagnosticStatus::Error(
                "Stop the current recording before running a diagnostic.".to_string(),
            );
            cx.notify();
            return;
        }

        // A stray click costs a couple of minutes of hijacked screen and loud
        // beeps, so it is confirmed the way the Tauri app confirms it.
        let message = format!(
            "Cap will take over your screen with a flashing pattern and play loud beeps for \
             about {} seconds per pipeline. Take your headphones off, leave the volume \
             audible, and leave the machine alone until it finishes.",
            diagnostics::DEFAULT_DURATION_SECS
        );
        cx.spawn_in(window, async move |this, cx| {
            if !crate::platform::confirm_dialog(
                "Run diagnostic?",
                &message,
                "Run Diagnostic",
                "Cancel",
                true,
            ) {
                return;
            }
            this.update_in(cx, |this, window, cx| this.diagnostic_start(window, cx))
                .ok();
        })
        .detach();
    }

    fn diagnostic_start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Process-global, not per-page: Settings builds a fresh state every
        // time it opens while the run is a detached task that outlives the
        // window, so `self.pages.diagnostic` alone cannot see the run started
        // by a previous Settings window.
        let guard = match diagnostics::RunGuard::acquire() {
            Ok(guard) => guard,
            Err(error) => {
                self.pages.diagnostic = DiagnosticStatus::Error(error);
                cx.notify();
                return;
            }
        };

        let options = diagnostics::SyncTestOptions {
            mode: self.pages.diagnostic_mode,
            microphone: self.pages.diagnostic_mic,
            duration_secs: diagnostics::DEFAULT_DURATION_SECS,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.pages.diagnostic_cancel = Some(cancel.clone());
        self.pages.diagnostic_cancelling = false;
        self.pages.diagnostic_payload = None;
        self.pages.diagnostic_upload = UploadStatus::Idle;
        self.pages.diagnostic = DiagnosticStatus::Running {
            stage: diagnostics::START_STAGE.to_string(),
            mode: None,
        };
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let (stage_tx, stage_rx) = flume::unbounded::<diagnostics::Stage>();
            let run = cx.background_executor().spawn({
                let cancel = cancel.clone();
                async move {
                    // Released on every exit path below, and on the drop of the
                    // whole future if the run is ever abandoned.
                    let _guard = guard;
                    let stages = stage_tx.clone();
                    let (sync_test, sync_test_error) = match diagnostics::resolve_selftest_binary()
                    {
                        Some(binary) => {
                            match diagnostics::run_sync_test(&binary, &options, &cancel, |stage| {
                                let _ = stages.send(stage);
                            }) {
                                Ok(report) => (Some(report), None),
                                Err(error) => (None, Some(error)),
                            }
                        }
                        // No sidecar: the environment half of the report is
                        // still worth having, with the reason recorded in it.
                        None => (
                            None,
                            Some(
                                "The Cap command-line tool was not found next to this build, so \
                                 the sync test could not run."
                                    .to_string(),
                            ),
                        ),
                    };
                    if cancel.load(Ordering::Relaxed) {
                        return Err(diagnostics::CANCELLED.to_string());
                    }

                    let _ = stage_tx.send(diagnostics::Stage {
                        stage: diagnostics::COLLECT_STAGE.to_string(),
                        mode: None,
                    });
                    let report = diagnostics::collect_report(sync_test, sync_test_error.clone());
                    // `collect_report` blocks for tens of seconds and cannot be
                    // interrupted, so the flag is read again on the far side of
                    // it: a cancelled run must not still write a report.
                    if cancel.load(Ordering::Relaxed) {
                        return Err(diagnostics::CANCELLED.to_string());
                    }
                    let path = diagnostics::write_report(&report)
                        .map_err(|error| tracing::warn!("writing the diagnostic report: {error}"))
                        .ok();
                    let report_json = serde_json::to_string(&report)
                        .map_err(|error| format!("Failed to serialize the report: {error}"))?;
                    let diagnostics_json =
                        serde_json::to_string(&diagnostics::log_diagnostics_from_report(&report))
                            .unwrap_or_else(|_| "{}".to_string());
                    let sync = report.get("syncTest").cloned().unwrap_or(Value::Null);
                    Ok((
                        sync.get("verdict")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        sync.get("summary")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        path,
                        sync_test_error,
                        DiagnosticPayload {
                            report_json,
                            diagnostics_json,
                        },
                    ))
                }
            });

            // Poll the stage channel until the run drops its sender, the same
            // shape `editor_export` uses; only the newest stage is worth a
            // repaint.
            loop {
                let mut latest = None;
                while let Ok(stage) = stage_rx.try_recv() {
                    latest = Some(stage);
                }
                if let Some(stage) = latest {
                    this.update_in(cx, |this, window, cx| {
                        // A stage still in flight when Cancel was pressed must
                        // not walk the label back off "Cancelling".
                        if this.pages.diagnostic_cancelling
                            || this.pages.diagnostic_cancel.is_none()
                        {
                            return;
                        }
                        this.pages.diagnostic = DiagnosticStatus::Running {
                            stage: stage.stage,
                            mode: stage.mode,
                        };
                        cx.notify();
                        window.refresh();
                    })
                    .ok();
                }
                if stage_rx.is_disconnected() {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
            }

            let outcome = run.await;
            this.update_in(cx, |this, window, cx| {
                this.pages.diagnostic_cancel = None;
                this.pages.diagnostic_cancelling = false;
                this.pages.diagnostic = match outcome {
                    Ok((verdict, summary, report_path, sync_test_error, payload)) => {
                        this.pages.diagnostic_payload = Some(payload);
                        DiagnosticStatus::Done {
                            verdict,
                            summary,
                            report_path,
                            sync_test_error,
                        }
                    }
                    Err(error) if error == diagnostics::CANCELLED => DiagnosticStatus::Idle,
                    Err(error) => DiagnosticStatus::Error(error),
                };
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn diagnostic_stop(&mut self, cx: &mut Context<Self>) {
        // The flag stays in place rather than being taken: the run reads it
        // again after `collect_report`, which is the whole second half of a
        // run, and a taken flag left that half uncancellable.
        let Some(cancel) = self.pages.diagnostic_cancel.clone() else {
            return;
        };
        cancel.store(true, Ordering::Relaxed);
        self.pages.diagnostic_cancelling = true;
        if let DiagnosticStatus::Running { stage, .. } = &mut self.pages.diagnostic {
            diagnostics::CANCEL_STAGE.clone_into(stage);
        }
        cx.notify();
    }

    fn upload_status_mut(&mut self, target: UploadTarget) -> &mut UploadStatus {
        match target {
            UploadTarget::Diagnostic => &mut self.pages.diagnostic_upload,
            UploadTarget::Logs => &mut self.pages.logs_upload,
        }
    }

    fn upload_status(&self, target: UploadTarget) -> &UploadStatus {
        match target {
            UploadTarget::Diagnostic => &self.pages.diagnostic_upload,
            UploadTarget::Logs => &self.pages.logs_upload,
        }
    }

    /// `commands.uploadLogs()`: POST the log tail to `/api/desktop/logs`, with
    /// the diagnostic report attached when the caller has one. Auth is
    /// optional on that route, so a signed-out user can still send it.
    fn upload_to_cap(&mut self, target: UploadTarget, window: &mut Window, cx: &mut Context<Self>) {
        if self.upload_status(target) == &UploadStatus::Pending {
            return;
        }
        let payload = match target {
            UploadTarget::Diagnostic => match self.pages.diagnostic_payload.clone() {
                Some(payload) => Some(payload),
                None => return,
            },
            UploadTarget::Logs => None,
        };
        let server = self.settings.server_url.clone();
        let token = store::auth_snapshot().token;
        *self.upload_status_mut(target) = UploadStatus::Pending;
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            // Reading the log tail and (for the plain log upload) probing the
            // devices are both blocking; only the POST belongs on tokio.
            let (log, report, diagnostics_json) = cx
                .background_executor()
                .spawn(async move {
                    let log = diagnostics::log_tail();
                    match payload {
                        Some(payload) => (
                            log,
                            Some(payload.report_json),
                            Some(payload.diagnostics_json),
                        ),
                        None => {
                            let diagnostics_json =
                                serde_json::to_string(&diagnostics::collect_log_diagnostics()).ok();
                            (log, None, diagnostics_json)
                        }
                    }
                })
                .await;

            let Ok(task) = cx.update(|_window, cx| {
                gpui_tokio::Tokio::spawn(
                    cx,
                    diagnostics::upload_report(server, token, log, report, diagnostics_json),
                )
            }) else {
                return;
            };
            let result = task
                .await
                .unwrap_or_else(|_| Err("The upload was interrupted".to_string()));

            this.update_in(cx, |this, window, cx| {
                *this.upload_status_mut(target) = match result {
                    Ok(()) => UploadStatus::Success,
                    Err(error) => UploadStatus::Error(error),
                };
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    /// The status line under an upload button. `None` while idle.
    fn upload_note(&self, target: UploadTarget) -> Option<gpui::AnyElement> {
        let theme = self.theme;
        let (text, color): (String, Hsla) = match self.upload_status(target) {
            UploadStatus::Idle => return None,
            UploadStatus::Pending => ("Uploading...".to_string(), theme.settings_muted()),
            UploadStatus::Success => (
                "Sent. Thank you -- this helps us find the problem.".to_string(),
                theme.settings_muted(),
            ),
            UploadStatus::Error(error) => (error.clone(), Hsla::from(theme.red_9)),
        };
        Some(
            div()
                .text_size(px(11.))
                .text_color(color)
                .child(text)
                .into_any_element(),
        )
    }

    /// The Diagnostic Report section: the two options, the run button, and
    /// whichever of the four states the run is in.
    fn render_diagnostic(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let running = matches!(self.pages.diagnostic, DiagnosticStatus::Running { .. });

        let warning = self
            .note_box()
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.settings_text())
                    .font_weight(FontWeight::MEDIUM)
                    .child("The test takes over your screen and makes noise."),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.settings_muted())
                    .child(
                        "A fullscreen window flashes black and white while 1kHz beeps play \
                         through your speakers, and Cap records it and measures how far the \
                         picture and the sound have drifted apart. Leave the machine alone \
                         while it runs. Both modes together take a couple of minutes.",
                    ),
            );

        let mode = self.pages.diagnostic_mode;
        let mode_control = ui::SegmentedControl::settings(
            &theme,
            "diagnostic-mode",
            diagnostics::SyncMode::ALL
                .iter()
                .map(|value| {
                    ui::SegmentOption::new(value.label(), *value == mode).disabled(running)
                })
                .collect(),
        )
        .on_select(cx.listener(|this, index: &usize, _window, cx| {
            if let Some(value) = ui::option_at(diagnostics::SyncMode::ALL, *index) {
                this.pages.diagnostic_mode = value;
                cx.notify();
            }
        }));

        let options = self.rows(vec![
            self.setting_row(
                "Recording mode",
                Some("Which pipeline to test. Both runs the studio leg and then the instant one."),
                mode_control.into_any_element(),
            ),
            self.setting_row(
                "Test microphone",
                Some(
                    "Also record your microphone and check that it hears the beeps in time. \
                     Needs speakers the mic can actually hear.",
                ),
                self.toggle(
                    "diagnostic-mic",
                    self.pages.diagnostic_mic,
                    cx,
                    |this, cx| {
                        this.pages.diagnostic_mic = !this.pages.diagnostic_mic;
                        cx.notify();
                    },
                )
                .into_any_element(),
            ),
        ]);

        let mut body = div().flex().flex_col().gap(px(8.));
        match &self.pages.diagnostic {
            DiagnosticStatus::Idle => {
                body = body.child(
                    div().child(
                        ui::Button::settings(
                            &theme,
                            "diagnostic-run",
                            ui::ButtonVariant::Dark,
                            ui::ButtonSize::Md,
                        )
                        .label("Run Diagnostic")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.diagnostic_run(window, cx)),
                        ),
                    ),
                );
                // Resolved once when the page opens; a build with no sidecar
                // still produces the environment half of the report.
                if let Some(None) = &self.pages.selftest_binary {
                    body = body.child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme.settings_muted())
                            .child(
                                "The Cap command-line tool was not found next to this build, so \
                                 the report will cover your environment only.",
                            ),
                    );
                }
            }
            DiagnosticStatus::Running { stage, mode } => {
                body = body
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(theme.settings_text())
                            .child(diagnostics::stage_label(stage, mode.as_deref())),
                    )
                    .child(
                        div().child(
                            ui::Button::settings(
                                &theme,
                                "diagnostic-cancel",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Md,
                            )
                            .label("Cancel")
                            .disabled_settings(
                                &theme,
                                self.pages.diagnostic_cancel.is_none()
                                    || self.pages.diagnostic_cancelling,
                            )
                            .on_click(cx.listener(|this, _, _window, cx| this.diagnostic_stop(cx))),
                        ),
                    );
            }
            DiagnosticStatus::Done {
                verdict,
                summary,
                report_path,
                sync_test_error,
            } => {
                body = body.child(self.verdict_chip(verdict.as_deref()));
                if let Some(summary) = summary {
                    body = body.child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(19.))
                            .text_color(theme.settings_text())
                            .child(summary.clone()),
                    );
                }
                if let Some(error) = sync_test_error {
                    body = body.child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(18.))
                            .text_color(Hsla::from(theme.red_9))
                            .child(error.clone()),
                    );
                }

                let mut buttons = div().flex().flex_row().gap(px(8.)).child(
                    ui::Button::settings(
                        &theme,
                        "diagnostic-send",
                        ui::ButtonVariant::Dark,
                        ui::ButtonSize::Md,
                    )
                    .label(if self.pages.diagnostic_upload == UploadStatus::Pending {
                        "Sending..."
                    } else {
                        "Send to Cap"
                    })
                    .disabled_settings(
                        &theme,
                        self.pages.diagnostic_upload == UploadStatus::Pending
                            || self.pages.diagnostic_payload.is_none(),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.upload_to_cap(UploadTarget::Diagnostic, window, cx)
                    })),
                );
                if let Some(path) = report_path {
                    let path = path.clone();
                    buttons = buttons.child(
                        ui::Button::settings(
                            &theme,
                            "diagnostic-reveal",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Md,
                        )
                        .label("Show File")
                        .on_click(move |_, _, _| crate::library::reveal_in_folder(&path)),
                    );
                }
                buttons = buttons.child(
                    ui::Button::settings(
                        &theme,
                        "diagnostic-rerun",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Md,
                    )
                    .label("Run Again")
                    .on_click(cx.listener(|this, _, window, cx| this.diagnostic_run(window, cx))),
                );
                body = body
                    .child(buttons)
                    .children(self.upload_note(UploadTarget::Diagnostic));
            }
            DiagnosticStatus::Error(error) => {
                body = body
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(19.))
                            .text_color(Hsla::from(theme.red_9))
                            .child(error.clone()),
                    )
                    .child(
                        div().child(
                            ui::Button::settings(
                                &theme,
                                "diagnostic-retry",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Md,
                            )
                            .label("Try Again")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.diagnostic_run(window, cx)),
                            ),
                        ),
                    );
            }
        }

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(warning)
            .child(options)
            .child(body)
            .into_any_element()
    }

    /// PASS / WARN / FAIL / INCONCLUSIVE, in the same pill shape the System
    /// Information block's capture-support chip uses.
    fn verdict_chip(&self, verdict: Option<&str>) -> gpui::AnyElement {
        let theme = self.theme;
        // The same green/red pair the capture-support chip below uses, plus an
        // amber for `warn`; `inconclusive` and "no sync test at all" are not
        // failures, so they stay in the muted grey.
        let (label, fill, text): (&str, Hsla, Hsla) = match verdict {
            Some("pass") => (
                "PASS",
                gpui::rgb(0x22c55e).into(),
                gpui::rgb(0x4ade80).into(),
            ),
            Some("warn") => (
                "WARN",
                gpui::rgb(0xf59e0b).into(),
                gpui::rgb(0xfbbf24).into(),
            ),
            Some("fail") => ("FAIL", theme.red_9.into(), theme.red_9.into()),
            Some("inconclusive") => (
                "INCONCLUSIVE",
                theme.settings_muted(),
                theme.settings_muted(),
            ),
            // No sync test in the report: the environment half still ran.
            _ => (
                "ENVIRONMENT ONLY",
                theme.settings_muted(),
                theme.settings_muted(),
            ),
        };
        let mut fill = fill;
        fill.a = 0.2;
        div()
            .flex()
            .flex_row()
            .child(
                div()
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(px(4.))
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .bg(fill)
                    .text_color(text)
                    .child(label),
            )
            .into_any_element()
    }

    pub(crate) fn render_feedback(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let pending = self.pages.feedback == FeedbackStatus::Pending;
        // `disabled={feedback().trim().length < 4}`.
        let submit_disabled = pending || self.pages.feedback_draft.trim().chars().count() < 4;

        // The `<textarea>`: `p-2 w-full h-32 text-[13px] rounded-md border
        // bg-gray-2 border-gray-3`. The chrome lives on the container; the
        // multi-line field inside is bare and scrolls.
        let textarea = div()
            .id("feedback-box")
            .w_full()
            .h(px(128.))
            .p(px(8.))
            .rounded(px(6.))
            .bg(theme.settings_card_bg())
            .border_1()
            .border_color(theme.settings_border())
            .overflow_y_scroll()
            .child(
                ui::TextInput::bare(&theme, "feedback-input", &self.pages.feedback_input)
                    .text_size(px(13.))
                    .text_color(theme.settings_text())
                    .placeholder_color(theme.settings_muted()),
            );

        let mut form = div().flex().flex_col().gap(px(8.)).child(textarea);
        if let FeedbackStatus::Error(error) = &self.pages.feedback {
            form = form.child(
                div()
                    .text_size(px(13.))
                    .text_color(Hsla::from(theme.red_9))
                    .child(error.clone()),
            );
        }
        if self.pages.feedback == FeedbackStatus::Success {
            form = form.child(
                div()
                    .text_size(px(13.))
                    .child("Thank you for your feedback!"),
            );
        }
        form = form.child(
            div().child(
                ui::Button::settings(
                    &theme,
                    "feedback-submit",
                    ui::ButtonVariant::Dark,
                    ui::ButtonSize::Md,
                )
                .label(if pending {
                    "Submitting..."
                } else {
                    "Submit Feedback"
                })
                .disabled_settings(&theme, submit_disabled)
                .on_click(cx.listener(|this, _, window, cx| this.feedback_submit(window, cx))),
            ),
        );

        let discord = div().child(
            ui::Button::settings(
                &theme,
                "feedback-discord",
                ui::ButtonVariant::Gray,
                ui::ButtonSize::Md,
            )
            .label("Join Discord")
            .on_click(|_, _, cx| cx.open_url("https://cap.link/discord")),
        );

        // `commands.uploadLogs()`. The gpui app writes a rolling log file of
        // its own (`main.rs`), so this posts the same multipart form the Tauri
        // app posts -- minus the diagnostic report, which the section above
        // owns.
        let logs_pending = self.pages.logs_upload == UploadStatus::Pending;
        let upload_logs = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div().child(
                    ui::Button::settings(
                        &theme,
                        "feedback-upload-logs",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Md,
                    )
                    .label(if logs_pending {
                        "Uploading..."
                    } else {
                        "Upload Logs"
                    })
                    .disabled_settings(&theme, logs_pending)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.upload_to_cap(UploadTarget::Logs, window, cx)
                    })),
                ),
            )
            .children(self.upload_note(UploadTarget::Logs));

        let system_info: gpui::AnyElement = match &self.pages.os_version {
            None => div()
                .text_size(px(12.))
                .line_height(px(18.))
                .text_color(theme.settings_muted())
                .child("Loading system information...")
                .into_any_element(),
            Some(version) => {
                let info_block = |label: &'static str, value: String| {
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.settings_muted())
                                .child(label),
                        )
                        .child(
                            div()
                                .px(px(8.))
                                .py(px(6.))
                                .rounded(px(4.))
                                .bg(theme.settings_card_bg())
                                .font_family(MONO_FONT)
                                .text_size(px(12.))
                                .text_color(theme.settings_muted())
                                .child(value),
                        )
                };
                // ScreenCaptureKit / Windows Graphics Capture are both a given
                // on the OS versions this app runs on.
                let capture_supported = cfg!(any(target_os = "macos", target_os = "windows"));
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .children(
                        version
                            .clone()
                            .map(|version| info_block("Operating System", version)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.settings_muted())
                                    .child("Capture Support"),
                            )
                            .child(
                                div().flex().flex_row().child(
                                    div()
                                        .px(px(8.))
                                        .py(px(4.))
                                        .rounded(px(4.))
                                        .text_size(px(12.))
                                        .bg(Theme::with_alpha(
                                            if capture_supported {
                                                gpui::rgb(0x22c55e)
                                            } else {
                                                theme.red_9
                                            },
                                            0.2,
                                        ))
                                        .text_color(Hsla::from(if capture_supported {
                                            gpui::rgb(0x4ade80)
                                        } else {
                                            theme.red_9
                                        }))
                                        .child(format!(
                                            "Screen Capture: {}",
                                            if capture_supported {
                                                "Supported"
                                            } else {
                                                "Not Supported"
                                            }
                                        )),
                                ),
                            ),
                    )
                    .child(info_block(
                        "App Version",
                        format!("v{}", env!("CARGO_PKG_VERSION")),
                    ))
                    .into_any_element()
            }
        };

        vec![
            self.section(
                "Feedback",
                Some(
                    "Help us improve Cap by submitting feedback or reporting bugs. We'll get \
                     right on it.",
                ),
                None,
                vec![form.into_any_element()],
            )
            .into_any_element(),
            self.section(
                "Join the Community",
                Some(
                    "Have questions, want to share ideas, or just hang out? Join the Cap \
                     Discord community.",
                ),
                None,
                vec![discord.into_any_element()],
            )
            .into_any_element(),
            self.section(
                "Diagnostic Report",
                Some(
                    "Records a short flashing/beeping test pattern, measures how far the \
                     picture and sound drift apart, and snapshots your displays, cameras, \
                     microphones, disk space and recording settings. Nothing is sent \
                     anywhere until you choose to send it.",
                ),
                None,
                vec![self.render_diagnostic(cx)],
            )
            .into_any_element(),
            self.section(
                "Debug Information",
                Some(
                    "Upload your logs to help us diagnose issues with Cap. No personal \
                     information is included.",
                ),
                None,
                vec![upload_logs.into_any_element()],
            )
            .into_any_element(),
            self.section("System Information", None, None, vec![system_info])
                .into_any_element(),
        ]
    }
}

/// Best-effort `SystemDiagnostics.{macos,linux}Version.displayName`.
fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let read = |arg: &str| {
            std::process::Command::new("sw_vers")
                .arg(arg)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let version = read("-productVersion")?;
        Some(match read("-buildVersion") {
            Some(build) => format!("macOS {version} ({build})"),
            None => format!("macOS {version}"),
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::fs::read_to_string("/etc/os-release")
            .ok()?
            .lines()
            .find_map(|line| line.strip_prefix("PRETTY_NAME=").map(str::to_string))
            .map(|value| value.trim_matches('"').to_string())
    }
    #[cfg(target_os = "windows")]
    {
        None
    }
}

// ---------------------------------------------------------------------------
// Changelog (changelog.tsx)
// ---------------------------------------------------------------------------

impl SettingsWindow {
    /// `apiClient.desktop.getChangelogPosts({ query: { origin } })` -- GET
    /// `/api/changelog?origin=..`; the server only reads `origin` for CORS,
    /// so the configured server origin stands in for `window.location.origin`.
    fn changelog_fetch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let server = self.settings.server_url.clone();
        let url = format!("{server}/api/changelog");
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::GET,
                    url,
                    vec![("origin", server)],
                    Vec::new(),
                    None,
                    HttpBody::None,
                    None,
                )
                .await
            },
            |this, result, _window, _cx| {
                this.pages.changelog = Some(match result {
                    Ok((200, body)) => serde_json::from_value::<Vec<ChangelogEntry>>(body)
                        .map_err(|error| error.to_string()),
                    Ok(_) => Err("Failed to fetch changelog".to_string()),
                    Err(error) => Err(error.text()),
                });
            },
        );
    }

    pub(crate) fn render_changelog(&self, _cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;

        match &self.pages.changelog {
            None => vec![
                div()
                    .flex()
                    .flex_1()
                    .min_h(px(200.))
                    .items_center()
                    .justify_center()
                    .text_color(theme.settings_muted())
                    .child("Loading changelog...")
                    .into_any_element(),
            ],
            Some(Err(error)) => vec![
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(error.clone())
                    .into_any_element(),
            ],
            Some(Ok(entries)) => {
                let last = entries.len().saturating_sub(1);
                vec![
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(32.))
                        .children(entries.iter().enumerate().map(|(index, entry)| {
                            // `border-b-2 pb-8 last:border-b-0`.
                            div()
                                .flex()
                                .flex_col()
                                .when(index != last, |this| {
                                    this.pb(px(32.))
                                        .border_b_2()
                                        .border_color(theme.settings_border())
                                })
                                .when(index == 0, |this| {
                                    this.child(
                                        div().flex().flex_row().mb(px(8.)).child(
                                            div()
                                                .px(px(8.))
                                                .py(px(4.))
                                                .rounded(px(6.))
                                                .bg(Hsla::from(theme.blue_9))
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::BOLD)
                                                .text_color(gpui::white())
                                                .child("NEW"),
                                        ),
                                    )
                                })
                                .child(
                                    div()
                                        .text_size(px(14.))
                                        .font_weight(FontWeight::BOLD)
                                        .mb(px(8.))
                                        .child(entry.title.clone()),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .line_height(px(18.))
                                        .text_color(theme.settings_muted())
                                        .mb(px(16.))
                                        .child(format!(
                                            "Version {} - {}",
                                            entry.version,
                                            changelog_date(&entry.published_at)
                                        )),
                                )
                                .child(div().flex().flex_col().gap(px(10.)).children(
                                    markdown_paragraphs(&entry.content).into_iter().map(
                                        |paragraph| {
                                            div()
                                                .text_size(px(13.))
                                                .line_height(px(20.))
                                                .text_color(theme.settings_muted())
                                                .when(paragraph.heading, |this| {
                                                    this.font_weight(FontWeight::BOLD)
                                                        .text_color(theme.settings_text())
                                                })
                                                .child(paragraph.text)
                                        },
                                    ),
                                ))
                        }))
                        .into_any_element(),
                ]
            }
        }
    }
}

/// `new Date(publishedAt).toLocaleDateString()`.
fn changelog_date(published_at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(published_at)
        .map(|date| date.format("%-m/%-d/%Y").to_string())
        .unwrap_or_else(|_| published_at.to_string())
}

struct MarkdownParagraph {
    text: String,
    heading: bool,
}

/// The stand-in for `SolidMarkdown`: paragraphs split on blank lines,
/// headings bolded, image/link syntax reduced to its text. Deliberately not a
/// renderer -- the posts are short release notes.
fn markdown_paragraphs(content: &str) -> Vec<MarkdownParagraph> {
    content
        .replace("\r\n", "\n")
        .split("\n\n")
        .flat_map(|block| block.split('\n'))
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let (line, heading) = match line.trim_start_matches('#') {
                stripped if stripped.len() != line.len() => (stripped.trim_start(), true),
                _ => (line, false),
            };
            // Drop pure image lines, unwrap emphasis and links.
            if line.starts_with("![") {
                return None;
            }
            let mut text = line.replace("**", "").replace('`', "");
            while let (Some(open), Some(mid)) = (text.find('['), text.find("](")) {
                let Some(close) = text[mid..].find(')').map(|offset| mid + offset) else {
                    break;
                };
                if open < mid {
                    let label = text[open + 1..mid].to_string();
                    text.replace_range(open..=close, &label);
                } else {
                    break;
                }
            }
            Some(MarkdownParagraph {
                text: text.to_string(),
                heading,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// License (license.tsx)
// ---------------------------------------------------------------------------

/// `licenseApiClient`'s fixed base (`utils/web-api.ts:54-57`).
const LICENSE_API_BASE: &str = "https://l.cap.so/api";

impl SettingsWindow {
    /// `createCommercialCheckoutUrl`, opened externally.
    fn license_checkout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pages.license_checkout_pending {
            return;
        }
        self.pages.license_checkout_pending = true;
        let kind = if self.pages.license_annual {
            "yearly"
        } else {
            "lifetime"
        };
        let url = format!("{LICENSE_API_BASE}/commercial/checkout");
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    Vec::new(),
                    None,
                    HttpBody::Json(json!({ "type": kind })),
                    None,
                )
                .await
            },
            |this, result, _window, cx| {
                this.pages.license_checkout_pending = false;
                if let Ok((200, body)) = result
                    && let Some(url) = body.get("url").and_then(Value::as_str)
                {
                    cx.open_url(url);
                }
            },
        );
    }

    /// `activateCommercialLicense`: key and instance id go as headers, and a
    /// 200 writes `general_settings.commercialLicense` in the exact shape
    /// license.tsx's `onActivated` writes.
    fn license_activate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pages.license_activating || self.pages.license_draft.trim().is_empty() {
            return;
        }
        let Some(instance_id) = store::instance_id_or_create() else {
            self.pages.license_error = Some("No instance ID found".to_string());
            cx.notify();
            return;
        };
        let key = self.pages.license_draft.clone();
        self.pages.license_activating = true;
        self.pages.license_error = None;
        cx.notify();

        let url = format!("{LICENSE_API_BASE}/commercial/activate");
        let header_key = key.clone();
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    vec![("licensekey", header_key), ("instanceid", instance_id)],
                    None,
                    HttpBody::Json(json!({ "reset": false })),
                    None,
                )
                .await
            },
            move |this, result, _window, cx| {
                this.pages.license_activating = false;
                match result {
                    Ok((200, body)) => {
                        let license = store::CommercialLicense {
                            license_key: key.clone(),
                            expiry_date: body.get("expiryDate").and_then(Value::as_f64),
                            refresh: body.get("refresh").and_then(Value::as_f64).unwrap_or(0.),
                            activated_on: chrono::Utc::now().timestamp_millis() as f64,
                        };
                        if !store::set_commercial_license(Some(&license)) {
                            this.pages.license_error =
                                Some("Failed to save the license".to_string());
                            return;
                        }
                        this.pages.license_draft.clear();
                        let input = this.pages.license_input.clone();
                        input.update(cx, |input, cx| input.set_text("", cx));
                    }
                    Ok((_, body)) => {
                        this.pages.license_error = Some(
                            body.get("message")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| body.to_string()),
                        );
                    }
                    Err(error) => this.pages.license_error = Some(error.text()),
                }
            },
        );
    }

    pub(crate) fn render_license(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let auth = store::auth_snapshot();

        // `createLicenseQuery`: pro from the auth plan, else commercial from
        // the store, else the purchase/activate pair.
        if auth.plan_upgraded {
            return vec![
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .w_full()
                    .pt(px(96.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(12.))
                            .w_full()
                            .max_w(px(448.))
                            .p(px(24.))
                            .rounded(px(24.))
                            .border_1()
                            .border_color(theme.settings_border())
                            .bg(theme.settings_card_bg())
                            .child(
                                div()
                                    .text_size(px(24.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("Cap Pro License"),
                            )
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .line_height(px(20.))
                                    .text_color(theme.settings_muted())
                                    .child(
                                        "Your account is upgraded to Cap Pro and already \
                                         includes a commercial license.",
                                    ),
                            ),
                    )
                    .into_any_element(),
            ];
        }

        if let Some(license) = store::commercial_license() {
            return vec![self.render_license_active(license, cx)];
        }

        vec![
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(12.))
                .w_full()
                .child(self.render_license_purchase(cx))
                .child(self.render_license_activate(cx))
                .into_any_element(),
        ]
    }

    /// The activated-commercial card.
    fn render_license_active(
        &self,
        license: store::CommercialLicense,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let expiry = license.expiry_date.map(|ms| {
            chrono::DateTime::from_timestamp_millis(ms as i64)
                .map(|date| date.format("%-m/%-d/%Y").to_string())
                .unwrap_or_else(|| ms.to_string())
        });

        div()
            .flex()
            .flex_col()
            .items_center()
            .w_full()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(24.))
                    .w_full()
                    .max_w(px(700.))
                    .mt(px(24.))
                    .p(px(32.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme.settings_border())
                    .bg(theme.settings_card_bg())
                    .child(
                        div().flex().flex_col().items_center().gap(px(8.)).child(
                            div()
                                .text_size(px(24.))
                                .font_weight(FontWeight::MEDIUM)
                                .child("Commercial License"),
                        ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .child(div().text_size(px(13.)).child("License Key"))
                            .child(
                                div()
                                    .p(px(12.))
                                    .rounded(px(8.))
                                    .border_1()
                                    .border_color(theme.settings_border())
                                    .bg(theme.settings_fill())
                                    .font_family(MONO_FONT)
                                    .text_size(px(12.))
                                    .text_color(theme.settings_muted())
                                    .child(license.license_key.clone()),
                            ),
                    )
                    .when_some(expiry, |this, expiry| {
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(div().text_size(px(13.)).child("Expires"))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(theme.settings_muted())
                                        .child(expiry),
                                ),
                        )
                    })
                    .child(div().h(px(1.)).w_full().bg(theme.settings_border()))
                    .child(div().flex().flex_col().items_center().child(self.button(
                        "license-deactivate",
                        (ui::ButtonVariant::Destructive, None),
                        "Deactivate License",
                        false,
                        cx,
                        |this, _window, cx| {
                            if !store::set_commercial_license(None) {
                                tracing::warn!("clearing the commercial license failed");
                            }
                            this.pages.license_error = None;
                            cx.notify();
                        },
                    ))),
            )
            .into_any_element()
    }

    /// `CommercialLicensePurchase`'s pricing card. The Rive card-stack
    /// animation has no gpui equivalent and is omitted.
    fn render_license_purchase(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let annual = self.pages.license_annual;
        let pending = self.pages.license_checkout_pending;

        let left = div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(16.))
            .p(px(20.))
            .flex_1()
            .min_w_0()
            .rounded_l(px(12.))
            .border_1()
            .border_color(theme.settings_border())
            .bg(theme.settings_fill())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(24.))
                            .font_weight(FontWeight::MEDIUM)
                            .child("Commercial License"),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(theme.settings_muted())
                            .child("For commercial use"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .mt(px(20.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_end()
                            .child(div().text_size(px(36.)).child(if annual {
                                "$29"
                            } else {
                                "$58"
                            }))
                            .child(
                                div()
                                    .text_size(px(16.))
                                    .text_color(theme.settings_muted())
                                    .child(".00 /"),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(16.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.settings_muted())
                            .child(if annual {
                                "billed annually"
                            } else {
                                "one-time payment"
                            }),
                    ),
            )
            .child(
                div()
                    .id("license-billing-toggle")
                    .px(px(12.))
                    .py(px(8.))
                    .rounded_full()
                    .bg(theme.settings_selection())
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.settings_fill()))
                    .child(div().text_size(px(12.)).child(format!(
                        "Switch to {}: {}",
                        if annual { "lifetime" } else { "yearly" },
                        if annual { "$58" } else { "$29" }
                    )))
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.pages.license_annual = !this.pages.license_annual;
                        cx.notify();
                    })),
            )
            .child(
                div().w_full().mt(px(40.)).child(
                    ui::Button::settings(
                        &theme,
                        "license-purchase",
                        ui::ButtonVariant::Dark,
                        ui::ButtonSize::Lg,
                    )
                    .label(if pending {
                        "Loading..."
                    } else {
                        "Purchase License"
                    })
                    .radius(px(24.))
                    .height(px(48.))
                    .full_width()
                    .font_weight(FontWeight::MEDIUM)
                    .disabled_settings(&theme, pending)
                    .on_click(cx.listener(|this, _, window, cx| this.license_checkout(window, cx))),
                ),
            );

        let features = [
            "Commercial Use of Cap Recorder + Editor",
            "Community Support",
            "Local-only features",
            "Perpetual license option",
        ];
        let right = div()
            .flex()
            .flex_col()
            .justify_center()
            .items_center()
            .gap(px(16.))
            .p(px(20.))
            .flex_1()
            .min_w_0()
            .rounded_r(px(12.))
            .border_1()
            .border_color(theme.settings_border())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .children(features.into_iter().map(|feature| {
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.))
                            .child(
                                svg()
                                    .path("icons/check.svg")
                                    .size(px(16.))
                                    .flex_shrink_0()
                                    .text_color(theme.settings_text()),
                            )
                            .child(div().text_size(px(14.)).child(feature))
                    })),
            );

        div()
            .w_full()
            .max_w(px(700.))
            .rounded(px(12.))
            .bg(theme.settings_card_bg())
            .child(div().flex().flex_row().child(left).child(right))
    }

    /// `LicenseKeyActivate`.
    fn render_license_activate(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let activating = self.pages.license_activating;
        let disabled = activating || self.pages.license_draft.trim().is_empty();

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .w_full()
            .max_w(px(700.))
            .p(px(24.))
            .rounded(px(12.))
            .border_1()
            .border_color(theme.settings_border())
            .bg(theme.settings_card_bg())
            .child(
                div()
                    .text_size(px(20.))
                    .text_center()
                    .mb(px(8.))
                    .child("Have a license key?"),
            )
            .child(self.pages_input("license-key-input", &self.pages.license_input))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_center()
                    .mt(px(16.))
                    .child(self.button(
                        "license-activate",
                        (ui::ButtonVariant::Primary, None),
                        if activating {
                            "Activating..."
                        } else {
                            "Activate License"
                        },
                        disabled,
                        cx,
                        |this, window, cx| this.license_activate(window, cx),
                    )),
            )
            .when_some(self.pages.license_error.clone(), |this, error| {
                this.child(
                    div()
                        .mt(px(8.))
                        .text_size(px(13.))
                        .text_center()
                        .text_color(Hsla::from(theme.red_9))
                        .child(error),
                )
            })
    }
}

// ---------------------------------------------------------------------------
// Integrations (integrations/)
// ---------------------------------------------------------------------------

impl SettingsWindow {
    /// `getStorageIntegrations`, guarded on a signed-in session like
    /// integrations/index.tsx's resource.
    fn integrations_fetch_storage(
        &mut self,
        refresh_quota: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            self.pages.storage = None;
            return;
        };
        let url = format!(
            "{}/api/desktop/storage/integrations",
            self.settings.server_url
        );
        let mut query = Vec::new();
        if refresh_quota {
            query.push(("refreshStorageQuota", "true".to_string()));
        }
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::GET,
                    url,
                    query,
                    Vec::new(),
                    Some(token),
                    HttpBody::None,
                    None,
                )
                .await
            },
            |this, result, _window, _cx| {
                this.pages.gdrive.refreshing = false;
                if let Ok((200, body)) = result {
                    this.pages.storage = serde_json::from_value(body).ok();
                }
            },
        );
    }

    fn s3_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pages.integrations_view = IntegrationsView::S3;
        self.pages.s3.error = None;
        self.s3_fetch(window, cx);
        cx.notify();
    }

    fn gdrive_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pages.integrations_view = IntegrationsView::GoogleDrive;
        self.pages.gdrive.error = None;
        self.integrations_fetch_storage(false, window, cx);
        self.gdrive_fetch_s3_presence(window, cx);
        cx.notify();
    }

    /// `getS3Config` for the S3 page: populates the form.
    fn s3_fetch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.s3.loading = true;
        let url = format!("{}/api/desktop/s3/config/get", self.settings.server_url);
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::GET,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::None,
                    None,
                )
                .await
            },
            |this, result, _window, cx| {
                this.pages.s3.loading = false;
                let Ok((200, body)) = result else {
                    this.pages.s3.error = Some("Failed to fetch S3 config".to_string());
                    return;
                };
                let source = body
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("default");
                let managed = body
                    .get("managedByOrganization")
                    .and_then(|managed| managed.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let config = body.get("config").cloned().unwrap_or(Value::Null);
                let field = |key: &str| {
                    config
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                };
                this.pages.s3.provider = {
                    let provider = field("provider");
                    if provider.is_empty() {
                        "aws".to_string()
                    } else {
                        provider
                    }
                };
                let values = [
                    field("accessKeyId"),
                    field("secretAccessKey"),
                    field("endpoint"),
                    field("bucketName"),
                    field("region"),
                ];
                this.pages.s3.has_config = source == "user" && !values[S3_ACCESS_KEY].is_empty();
                this.pages.s3.managed_by = managed.clone();
                for (index, value) in values.into_iter().enumerate() {
                    this.pages.s3.drafts[index] = value.clone();
                    let input = this.pages.s3.inputs[index].clone();
                    let disabled = managed.is_some();
                    input.update(cx, |input, cx| {
                        input.set_text(value, cx);
                        input.set_disabled(disabled, cx);
                    });
                }
            },
        );
    }

    fn s3_config_body(&self) -> Value {
        json!({
            "provider": self.pages.s3.provider,
            "accessKeyId": self.pages.s3.drafts[S3_ACCESS_KEY],
            "secretAccessKey": self.pages.s3.drafts[S3_SECRET_KEY],
            "endpoint": self.pages.s3.drafts[S3_ENDPOINT],
            "bucketName": self.pages.s3.drafts[S3_BUCKET],
            "region": self.pages.s3.drafts[S3_REGION],
        })
    }

    fn s3_save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.s3.saving = true;
        self.pages.s3.error = None;
        let url = format!("{}/api/desktop/s3/config", self.settings.server_url);
        let body = self.s3_config_body();
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::Json(body),
                    None,
                )
                .await
            },
            |this, result, window, cx| {
                this.pages.s3.saving = false;
                match result {
                    Ok((200, _)) => {
                        this.s3_fetch(window, cx);
                        this.info_dialog("S3 configuration saved successfully", window, cx);
                    }
                    _ => this.pages.s3.error = Some("Failed to save S3 config".to_string()),
                }
            },
        );
    }

    fn s3_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.s3.deleting = true;
        self.pages.s3.error = None;
        let url = format!("{}/api/desktop/s3/config/delete", self.settings.server_url);
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::DELETE,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::None,
                    None,
                )
                .await
            },
            |this, result, window, cx| {
                this.pages.s3.deleting = false;
                match result {
                    Ok((200, _)) => {
                        this.s3_fetch(window, cx);
                        this.info_dialog("S3 configuration deleted successfully", window, cx);
                    }
                    _ => this.pages.s3.error = Some("Failed to delete S3 config".to_string()),
                }
            },
        );
    }

    /// `testS3Config`, with the page's 5.5s abort.
    fn s3_test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.s3.testing = true;
        self.pages.s3.error = None;
        let url = format!("{}/api/desktop/s3/config/test", self.settings.server_url);
        let body = self.s3_config_body();
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::Json(body),
                    Some(Duration::from_millis(5500)),
                )
                .await
            },
            |this, result, window, cx| {
                this.pages.s3.testing = false;
                match result {
                    Ok((200, _)) => this.info_dialog(
                        "S3 configuration test successful! Connection is working.",
                        window,
                        cx,
                    ),
                    Ok(_) => {
                        this.pages.s3.error = Some(
                            "S3 connection test failed. Check your config and network connection."
                                .to_string(),
                        )
                    }
                    Err(HttpError::Timeout) => {
                        this.pages.s3.error = Some(
                            "Connection test timed out after 5 seconds. Please check your \
                             endpoint URL and network connection."
                                .to_string(),
                        )
                    }
                    Err(error) => this.pages.s3.error = Some(error.text()),
                }
            },
        );
    }

    /// The Google Drive page's own `getS3Config`, only for `hasS3Config()`.
    fn gdrive_fetch_s3_presence(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        let url = format!("{}/api/desktop/s3/config/get", self.settings.server_url);
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::GET,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::None,
                    None,
                )
                .await
            },
            |this, result, _window, _cx| {
                if let Ok((200, body)) = result {
                    let user = body.get("source").and_then(Value::as_str) == Some("user");
                    let config = body.get("config").cloned().unwrap_or(Value::Null);
                    let filled = |key: &str| {
                        config
                            .get(key)
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.is_empty())
                    };
                    this.pages.gdrive.s3_has_config =
                        user && filled("accessKeyId") && filled("bucketName");
                }
            },
        );
    }

    /// `connect.mutate()`: open the returned URL, then poll for the
    /// connection (1.5s interval, 120s timeout).
    fn gdrive_connect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.gdrive.connect_pending = true;
        self.pages.gdrive.error = None;
        let url = format!(
            "{}/api/desktop/storage/google-drive/connect",
            self.settings.server_url
        );
        let server = self.settings.server_url.clone();
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::Json(json!({})),
                    None,
                )
                .await
            },
            move |this, result, window, cx| {
                this.pages.gdrive.connect_pending = false;
                match result {
                    Ok((200, body)) => {
                        if let Some(url) = body.get("url").and_then(Value::as_str) {
                            cx.open_url(url);
                            this.gdrive_wait_for_connection(window, cx);
                        }
                    }
                    // `showWindow("Upgrade")` has no gpui equivalent; the
                    // pricing page is the closest external destination.
                    Ok((403, _)) => cx.open_url(&format!("{server}/pricing")),
                    Ok(_) => {
                        this.pages.gdrive.error =
                            Some("Failed to start Google Drive connection".to_string())
                    }
                    Err(error) => this.pages.gdrive.error = Some(error.text()),
                }
            },
        );
    }

    /// `waitForGoogleDriveConnection`.
    fn gdrive_wait_for_connection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.gdrive.waiting = true;
        let url = format!(
            "{}/api/desktop/storage/integrations",
            self.settings.server_url
        );
        self.pages.gdrive.poll = Some(cx.spawn_in(window, async move |this, cx| {
            let mut ticks = 0u32;
            // 120000 / 1500.
            while ticks < 80 {
                cx.background_executor()
                    .timer(Duration::from_millis(1500))
                    .await;
                ticks += 1;
                let request_url = url.clone();
                let request_token = token.clone();
                let Ok(task) = cx.update(|_window, cx| {
                    gpui_tokio::Tokio::spawn(cx, async move {
                        http_json(
                            reqwest::Method::GET,
                            request_url,
                            Vec::new(),
                            Vec::new(),
                            Some(request_token),
                            HttpBody::None,
                            None,
                        )
                        .await
                    })
                }) else {
                    return;
                };
                let Ok(result) = task.await else { return };
                let connected = this
                    .update_in(cx, |this, window, cx| {
                        if let Ok((200, body)) = result {
                            let parsed: Option<StorageIntegrations> =
                                serde_json::from_value(body).ok();
                            let connected = parsed
                                .as_ref()
                                .is_some_and(|storage| storage.google_drive.connected);
                            if let Some(parsed) = parsed {
                                this.pages.storage = Some(parsed);
                            }
                            if connected {
                                this.pages.gdrive.waiting = false;
                                this.gdrive_fetch_s3_presence(window, cx);
                            }
                            cx.notify();
                            window.refresh();
                            connected
                        } else {
                            false
                        }
                    })
                    .unwrap_or(true);
                if connected {
                    return;
                }
            }
            this.update_in(cx, |this, window, cx| {
                this.pages.gdrive.waiting = false;
                this.info_dialog(
                    "Finish connecting Google Drive in your browser, then return here and refresh.",
                    window,
                    cx,
                );
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn gdrive_refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pages.gdrive.refreshing = true;
        self.integrations_fetch_storage(true, window, cx);
        self.gdrive_fetch_s3_presence(window, cx);
        cx.notify();
    }

    fn gdrive_test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.gdrive.testing = true;
        self.pages.gdrive.error = None;
        let url = format!(
            "{}/api/desktop/storage/google-drive/test",
            self.settings.server_url
        );
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::Json(json!({})),
                    None,
                )
                .await
            },
            |this, result, window, cx| {
                this.pages.gdrive.testing = false;
                match result {
                    Ok((200, body)) => {
                        let message = match body.get("email").and_then(Value::as_str) {
                            Some(email) => {
                                format!("Google Drive connection is working for {email}")
                            }
                            None => "Google Drive connection is working".to_string(),
                        };
                        this.info_dialog(&message, window, cx);
                    }
                    _ => {
                        this.pages.gdrive.error =
                            Some("Google Drive connection test failed".to_string())
                    }
                }
            },
        );
    }

    fn gdrive_set_active(
        &mut self,
        provider: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.gdrive.set_active_pending = true;
        self.pages.gdrive.error = None;
        let url = format!(
            "{}/api/desktop/storage/set-active",
            self.settings.server_url
        );
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::POST,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::Json(json!({ "provider": provider })),
                    None,
                )
                .await
            },
            |this, result, window, cx| {
                this.pages.gdrive.set_active_pending = false;
                match result {
                    Ok((200, _)) => this.gdrive_refresh(window, cx),
                    _ => {
                        this.pages.gdrive.error =
                            Some("Failed to update active storage provider".to_string())
                    }
                }
            },
        );
    }

    fn gdrive_disconnect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let auth = store::auth_snapshot();
        let Some(token) = auth.token else {
            return;
        };
        self.pages.gdrive.disconnecting = true;
        self.pages.gdrive.error = None;
        let url = format!(
            "{}/api/desktop/storage/google-drive/disconnect",
            self.settings.server_url
        );
        self.spawn_tokio(
            window,
            cx,
            async move {
                http_json(
                    reqwest::Method::DELETE,
                    url,
                    Vec::new(),
                    Vec::new(),
                    Some(token),
                    HttpBody::None,
                    None,
                )
                .await
            },
            |this, result, window, cx| {
                this.pages.gdrive.disconnecting = false;
                match result {
                    Ok((200, _)) => {
                        this.gdrive_refresh(window, cx);
                        this.info_dialog("Google Drive disconnected", window, cx);
                    }
                    _ => {
                        this.pages.gdrive.error =
                            Some("Failed to disconnect Google Drive".to_string())
                    }
                }
            },
        );
    }

    pub(crate) fn render_integrations(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        match self.pages.integrations_view {
            IntegrationsView::Index => self.render_integrations_index(cx),
            IntegrationsView::S3 => self.render_s3_config(cx),
            IntegrationsView::GoogleDrive => self.render_gdrive_config(cx),
        }
    }

    fn render_integrations_index(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let auth = store::auth_snapshot();
        let is_pro = auth.plan_upgraded;
        let managed = self
            .pages
            .storage
            .as_ref()
            .and_then(|storage| storage.managed_by_organization.as_ref())
            .map(|organization| organization.name.clone());
        let server = self.settings.server_url.clone();

        let apps: [(&'static str, &'static str, &'static str, IntegrationsView); 2] = [
            (
                "Google Drive",
                "icons/google-drive.svg",
                "Connect Google Drive for new shareable link uploads. Cap stores new videos in \
                 a private Cap folder in your Drive and continues serving them through Cap \
                 after normal access checks.",
                IntegrationsView::GoogleDrive,
            ),
            (
                "S3 Config",
                "icons/database.svg",
                "Connect your own S3 bucket for complete control over your data storage. All \
                 new shareable link uploads will be automatically uploaded to your configured \
                 S3 bucket, ensuring you maintain complete ownership and control over your \
                 content. Perfect for organizations requiring data sovereignty and custom \
                 storage policies.",
                IntegrationsView::S3,
            ),
        ];

        let cards =
            div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .children(apps.into_iter().enumerate().map(
                    |(index, (name, icon, description, view))| {
                        let button_label = if managed.is_some() {
                            "Managed by your organization"
                        } else if !is_pro {
                            "Upgrade to Pro"
                        } else {
                            "Configure"
                        };
                        let managed_here = managed.is_some();
                        let server = server.clone();
                        self.card(true)
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.))
                                    .child(
                                        div()
                                            .flex()
                                            .flex_row()
                                            .items_center()
                                            .gap(px(8.))
                                            .min_w_0()
                                            .child(
                                                svg()
                                                    .path(icon)
                                                    .size(px(16.))
                                                    .flex_shrink_0()
                                                    .text_color(theme.settings_text()),
                                            )
                                            .child(div().text_size(px(13.)).child(name)),
                                    )
                                    .child(self.button(
                                        ("integration-configure", index),
                                        (ui::ButtonVariant::Primary, None),
                                        button_label,
                                        managed_here,
                                        cx,
                                        move |this, window, cx| {
                                            if managed_here {
                                                return;
                                            }
                                            if !store::auth_snapshot().plan_upgraded {
                                                // `showWindow("Upgrade")` in the Tauri
                                                // app; no upgrade window exists here.
                                                cx.open_url(&format!("{server}/pricing"));
                                                return;
                                            }
                                            match view {
                                                IntegrationsView::S3 => this.s3_open(window, cx),
                                                IntegrationsView::GoogleDrive => {
                                                    this.gdrive_open(window, cx)
                                                }
                                                IntegrationsView::Index => {}
                                            }
                                        },
                                    )),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(theme.settings_muted())
                                    .child(description),
                            )
                    },
                ));

        vec![
            self.section(
                "Integrations",
                Some(
                    "Configure integrations to extend Cap's functionality and connect with \
                     third-party services.",
                ),
                None,
                vec![cards.into_any_element()],
            )
            .into_any_element(),
        ]
    }

    /// `IntegrationConfigHeader`.
    fn render_config_header(
        &self,
        title: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .pb(px(12.))
            .child(self.button(
                "integration-back",
                (ui::ButtonVariant::Gray, Some("icons/arrow-left.svg")),
                "Back",
                false,
                cx,
                |this, _window, cx| {
                    this.pages.integrations_view = IntegrationsView::Index;
                    cx.notify();
                },
            ))
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::BOLD)
                    .child(title),
            )
    }

    /// The sign-in gate both config pages need: the server-backed config is
    /// per-account, so without a token there is nothing to edit.
    fn render_sign_in_required(&self) -> gpui::AnyElement {
        let theme = self.theme;
        self.card(true)
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(div().text_size(px(13.)).child("Sign in required"))
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.settings_muted())
                    .child(
                        "Please sign in to continue. Alternatively, email hello@cap.so or join \
                         our Discord at cap.link/discord",
                    ),
            )
            .into_any_element()
    }

    fn render_s3_config(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let auth = store::auth_snapshot();
        let header = self
            .render_config_header("S3 Config", cx)
            .into_any_element();

        if !auth.signed_in() {
            return vec![
                header,
                self.section(
                    "Configuration",
                    None,
                    None,
                    vec![self.render_sign_in_required()],
                )
                .into_any_element(),
            ];
        }

        let s3 = &self.pages.s3;
        let managed = s3.managed_by.clone();
        let busy = s3.loading || s3.saving || s3.deleting || s3.testing || managed.is_some();

        let provider_label = S3_PROVIDERS
            .iter()
            .find(|(value, _)| *value == s3.provider)
            .map(|(_, label)| *label)
            .unwrap_or("AWS S3");

        let mut form = div().flex().flex_col().gap(px(16.));
        if let Some(organization) = managed.clone() {
            form = form.child(
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.settings_muted())
                    .child(format!("Managed by your organization: {organization}")),
            );
        }
        form = form.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(div().text_size(px(13.)).child("Storage Provider"))
                .child(
                    self.pages_select("s3-provider", provider_label, MenuKind::S3Provider, cx)
                        .stretch_label()
                        .disabled(managed.is_some()),
                ),
        );
        for (index, (label, _)) in S3_FIELDS.iter().enumerate() {
            // `type="password"` on the two key fields has no masked-input
            // equivalent in `ui::TextInput` yet; they render as plain text.
            form = form.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(div().text_size(px(13.)).child(*label))
                    .child(self.pages_input(("s3-field", index), &s3.inputs[index])),
            );
        }

        // The custom section header carries the linked Storage Config Guide,
        // which `ui::Section`'s plain-string description cannot.
        let section_header = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(4.))
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::BOLD)
                    .child("Configuration"),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.settings_muted())
                    .child(
                        "It should take under 10 minutes to set up and connect your storage \
                         bucket to Cap. View the\u{a0}",
                    )
                    .child(
                        div()
                            .id("s3-guide-link")
                            .text_color(theme.settings_text())
                            .underline()
                            .cursor_pointer()
                            .child("Storage Config Guide")
                            .on_click(|_, _, cx| cx.open_url("https://cap.so/docs/s3-config")),
                    )
                    .child("\u{a0}to get started."),
            );

        let footer = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .when(!s3.loading && s3.has_config, |this| {
                        this.child(self.button(
                            "s3-remove",
                            (ui::ButtonVariant::Destructive, None),
                            if s3.deleting {
                                "Removing..."
                            } else {
                                "Remove Config"
                            },
                            busy,
                            cx,
                            |this, window, cx| this.s3_delete(window, cx),
                        ))
                    })
                    .child(self.button(
                        "s3-test",
                        (ui::ButtonVariant::Gray, None),
                        if s3.testing {
                            "Testing..."
                        } else {
                            "Test Connection"
                        },
                        busy,
                        cx,
                        |this, window, cx| this.s3_test(window, cx),
                    )),
            )
            .child(self.button(
                "s3-save",
                (ui::ButtonVariant::Primary, None),
                if s3.saving { "Saving..." } else { "Save" },
                busy,
                cx,
                |this, window, cx| this.s3_save(window, cx),
            ));

        let mut children = vec![
            header,
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(section_header)
                .child(self.card(true).child(form))
                .into_any_element(),
            footer.into_any_element(),
        ];
        if let Some(error) = s3.error.clone() {
            children.push(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_9))
                    .child(error)
                    .into_any_element(),
            );
        }
        children
    }

    fn render_gdrive_config(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let auth = store::auth_snapshot();
        let header = self
            .render_config_header("Google Drive", cx)
            .into_any_element();

        if !auth.signed_in() {
            return vec![
                header,
                self.section(
                    "Connection",
                    Some(
                        "Google Drive stores new uploads in a private Cap folder in your Drive. \
                         Existing Cap-hosted and S3 videos keep using their current storage.",
                    ),
                    None,
                    vec![self.render_sign_in_required()],
                )
                .into_any_element(),
            ];
        }

        let storage = self.pages.storage.as_ref();
        let gdrive = &self.pages.gdrive;
        let managed = storage
            .and_then(|storage| storage.managed_by_organization.as_ref())
            .map(|organization| organization.name.clone());
        let connected = storage.is_some_and(|storage| storage.google_drive.connected);
        let active = storage.is_some_and(|storage| storage.active_provider == "googleDrive");
        let display_name = storage
            .and_then(|storage| storage.google_drive.display_name.clone())
            .unwrap_or_else(|| "Google Drive".to_string());
        let quota = storage.and_then(|storage| storage.google_drive.storage_quota.clone());
        let busy = managed.is_some()
            || gdrive.refreshing
            || gdrive.connect_pending
            || gdrive.waiting
            || gdrive.testing
            || gdrive.set_active_pending
            || gdrive.disconnecting;

        let mut card = div().flex().flex_col().gap(px(16.));
        if let Some(organization) = managed {
            card = card.child(
                div()
                    .text_size(px(12.))
                    .line_height(px(18.))
                    .text_color(theme.settings_muted())
                    .child(format!("Managed by your organization: {organization}")),
            );
        }
        card = card.child(
            div()
                .flex()
                .flex_row()
                .items_start()
                .justify_between()
                .gap(px(16.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .min_w_0()
                        .child(div().text_size(px(13.)).child(if connected {
                            display_name
                        } else {
                            "Google Drive".to_string()
                        }))
                        .child(
                            div()
                                .text_size(px(12.))
                                .line_height(px(16.))
                                .text_color(theme.settings_muted())
                                .child(if connected {
                                    if active {
                                        "Active for new uploads"
                                    } else {
                                        "Connected but not active"
                                    }
                                } else {
                                    "Not connected"
                                }),
                        ),
                )
                .child(self.button(
                    "gdrive-refresh",
                    (ui::ButtonVariant::Gray, None),
                    if gdrive.refreshing {
                        "Refreshing..."
                    } else {
                        "Refresh"
                    },
                    busy,
                    cx,
                    |this, window, cx| this.gdrive_refresh(window, cx),
                )),
        );

        if !connected {
            let connect_label = if gdrive.waiting {
                "Waiting..."
            } else if gdrive.connect_pending {
                "Opening..."
            } else {
                "Connect Google Drive"
            };
            card = card.child(div().flex().flex_row().child(self.button(
                "gdrive-connect",
                (ui::ButtonVariant::Primary, None),
                connect_label,
                busy,
                cx,
                |this, window, cx| this.gdrive_connect(window, cx),
            )));
        } else {
            if let Some(quota) = quota {
                card = card.child(self.render_gdrive_quota(&quota));
            }
            card = card.child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap(px(8.))
                    .child(self.button(
                        "gdrive-use",
                        (ui::ButtonVariant::Primary, None),
                        if active { "Active" } else { "Use Google Drive" },
                        busy || active,
                        cx,
                        |this, window, cx| this.gdrive_set_active("googleDrive", window, cx),
                    ))
                    .when(gdrive.s3_has_config, |this| {
                        this.child(self.button(
                            "gdrive-use-s3",
                            (ui::ButtonVariant::Gray, None),
                            "Use S3",
                            busy || !active,
                            cx,
                            |this, window, cx| this.gdrive_set_active("s3", window, cx),
                        ))
                    })
                    .child(self.button(
                        "gdrive-test",
                        (ui::ButtonVariant::Gray, None),
                        if gdrive.testing { "Testing..." } else { "Test" },
                        busy,
                        cx,
                        |this, window, cx| this.gdrive_test(window, cx),
                    ))
                    .child(self.button(
                        "gdrive-disconnect",
                        (ui::ButtonVariant::Destructive, None),
                        "Disconnect",
                        busy,
                        cx,
                        |this, window, cx| this.gdrive_disconnect(window, cx),
                    )),
            );
        }
        if let Some(error) = gdrive.error.clone() {
            card = card.child(
                div()
                    .text_size(px(12.))
                    .text_color(Hsla::from(theme.red_9))
                    .child(error),
            );
        }

        vec![
            header,
            self.section(
                "Connection",
                Some(
                    "Google Drive stores new uploads in a private Cap folder in your Drive. \
                     Existing Cap-hosted and S3 videos keep using their current storage.",
                ),
                None,
                vec![self.card(true).child(card).into_any_element()],
            )
            .into_any_element(),
        ]
    }

    /// The storage-quota block on the Google Drive page.
    fn render_gdrive_quota(&self, quota: &DriveQuota) -> impl IntoElement {
        let theme = self.theme;

        // `quotaUsageLabel()`.
        let usage_label = format_bytes(quota.usage.as_deref()).map(|usage| {
            match format_bytes(quota.limit.as_deref()) {
                Some(limit) => format!("{usage} of {limit} used"),
                None => format!("{usage} used"),
            }
        });
        // `quotaUsagePercent()`.
        let percent = match (
            quota
                .limit
                .as_deref()
                .and_then(|value| value.parse::<f64>().ok()),
            quota
                .usage
                .as_deref()
                .and_then(|value| value.parse::<f64>().ok()),
        ) {
            (Some(limit), Some(usage)) if limit > 0. && limit.is_finite() && usage.is_finite() => {
                Some(((usage / limit) * 100.).clamp(0., 100.))
            }
            _ => None,
        };
        // `quotaTimestampLabel()`.
        let timestamp = format_timestamp(&quota.fetched_at).map(|formatted| {
            format!(
                "{} {formatted}",
                if quota.stale { "Cached" } else { "Updated" }
            )
        });

        let detail_row = |label: &'static str, value: String| {
            div()
                .flex()
                .flex_row()
                .justify_between()
                .text_size(px(12.))
                .child(div().text_color(theme.settings_muted()).child(label))
                .child(div().text_color(theme.settings_text()).child(value))
        };

        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .pt(px(12.))
            .border_t_1()
            .border_color(theme.settings_border())
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .justify_between()
                    .gap(px(16.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(div().text_size(px(13.)).child("Storage"))
                            .children(usage_label.map(|label| {
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(theme.settings_muted())
                                    .child(label)
                            })),
                    )
                    .children(timestamp.map(|label| {
                        div()
                            .text_size(px(12.))
                            .text_color(theme.settings_muted())
                            .child(label)
                    })),
            )
            .children(percent.map(|percent| {
                div()
                    .h(px(6.))
                    .w_full()
                    .rounded_full()
                    .bg(theme.settings_fill())
                    .overflow_hidden()
                    .child(
                        div()
                            .h_full()
                            .w(gpui::relative((percent / 100.) as f32))
                            .rounded_full()
                            .bg(Hsla::from(theme.blue_9)),
                    )
            }))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .children(
                        format_bytes(quota.remaining.as_deref())
                            .map(|value| detail_row("Remaining", value)),
                    )
                    .children(
                        format_bytes(quota.usage_in_drive.as_deref())
                            .map(|value| detail_row("Drive files", value)),
                    )
                    .children(
                        format_bytes(quota.usage_in_drive_trash.as_deref())
                            .map(|value| detail_row("Trash", value)),
                    ),
            )
    }
}

/// `formatBytes` in google-drive-config.tsx.
fn format_bytes(value: Option<&str>) -> Option<String> {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let bytes = value?
        .parse::<f64>()
        .ok()
        .filter(|bytes| bytes.is_finite())?;
    if bytes == 0. {
        return Some("0 B".to_string());
    }
    let mut size = bytes;
    let mut unit = 0;
    while size >= 1024. && unit < UNITS.len() - 1 {
        size /= 1024.;
        unit += 1;
    }
    let decimals = if size >= 10. || unit == 0 { 0 } else { 1 };
    Some(format!("{size:.decimals$} {}", UNITS[unit]))
}

/// `formatTimestamp`: `Intl.DateTimeFormat(dateStyle: "medium", timeStyle:
/// "short")`, e.g. "Aug 17, 2026, 10:30 PM".
fn format_timestamp(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.format("%b %-d, %Y, %-I:%M %p").to_string())
}

// ---------------------------------------------------------------------------
// Automations (automations.tsx)
// ---------------------------------------------------------------------------

const ALL_TRIGGERS: [Trigger; 7] = [
    Trigger::ScreenshotTaken,
    Trigger::StudioRecordingFinished,
    Trigger::InstantRecordingFinished,
    Trigger::RecordingStarted,
    Trigger::UploadCompleted,
    Trigger::VideoImported,
    Trigger::RecordingDeleted,
];

/// The type half of [`Action`], for the type-select menus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActionType {
    CopyToClipboard,
    SaveToLocation,
    Export,
    Upload,
    RevealInFileManager,
    OpenFile,
    RecognizeTextToClipboard,
    Notify,
    OpenEditor,
    SkipEditor,
    ApplyPreset,
    RunCommand,
    Webhook,
    DeleteLocalFiles,
}

/// `ALL_ACTION_TYPES` order in automations.tsx.
const ALL_ACTION_TYPES: [ActionType; 14] = [
    ActionType::CopyToClipboard,
    ActionType::SaveToLocation,
    ActionType::Export,
    ActionType::Upload,
    ActionType::RevealInFileManager,
    ActionType::OpenFile,
    ActionType::RecognizeTextToClipboard,
    ActionType::Notify,
    ActionType::OpenEditor,
    ActionType::SkipEditor,
    ActionType::ApplyPreset,
    ActionType::RunCommand,
    ActionType::Webhook,
    ActionType::DeleteLocalFiles,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConditionType {
    CaptureTargetIs,
    RecordingModeIs,
    DurationAtLeast,
    DurationAtMost,
    WindowTitleContains,
    OrganizationIs,
}

const ALL_CONDITION_TYPES: [ConditionType; 6] = [
    ConditionType::CaptureTargetIs,
    ConditionType::RecordingModeIs,
    ConditionType::DurationAtLeast,
    ConditionType::DurationAtMost,
    ConditionType::WindowTitleContains,
    ConditionType::OrganizationIs,
];

const CAPTURE_TARGETS: [(CaptureTargetKind, &str); 3] = [
    (CaptureTargetKind::Display, "Display"),
    (CaptureTargetKind::Window, "Window"),
    (CaptureTargetKind::Area, "Area"),
];

const RECORDING_MODES: [(AutomationRecordingMode, &str); 2] = [
    (AutomationRecordingMode::Studio, "Studio"),
    (AutomationRecordingMode::Instant, "Instant"),
];

const CLIPBOARD_SOURCES: [(ClipboardSource, &str); 2] = [
    (ClipboardSource::Raw, "Original capture"),
    (ClipboardSource::Rendered, "Edited / rendered"),
];

const WEBHOOK_METHODS: [&str; 3] = ["POST", "PUT", "GET"];

const EXPORT_FORMATS: [(ExportFormat, &str); 3] = [
    (ExportFormat::Mp4, "MP4"),
    (ExportFormat::Gif, "GIF"),
    (ExportFormat::Mov, "MOV"),
];

const FPS_PRESETS: [u32; 3] = [15, 30, 60];

const RESOLUTION_PRESETS: [(&str, &str, u32, u32); 4] = [
    ("720p", "720p", 1280, 720),
    ("1080p", "1080p", 1920, 1080),
    ("1440p", "1440p", 2560, 1440),
    ("4k", "4K", 3840, 2160),
];

const COMPRESSIONS: [(AutomationExportCompression, &str); 4] = [
    (AutomationExportCompression::Maximum, "Maximum"),
    (AutomationExportCompression::Social, "Social"),
    (AutomationExportCompression::Web, "Web"),
    (AutomationExportCompression::Potato, "Potato"),
];

/// `TRIGGER_LABELS` (`utils/automations.ts`).
fn trigger_label(trigger: Trigger) -> &'static str {
    match trigger {
        Trigger::ScreenshotTaken => "On screenshot taken",
        Trigger::StudioRecordingFinished => "On studio recording finished",
        Trigger::InstantRecordingFinished => "On instant recording finished",
        Trigger::RecordingStarted => "On recording started",
        Trigger::UploadCompleted => "On upload completed",
        Trigger::VideoImported => "On video imported",
        Trigger::RecordingDeleted => "On recording deleted",
    }
}

/// `TRIGGER_PHRASE`.
fn trigger_phrase(trigger: Trigger) -> &'static str {
    match trigger {
        Trigger::ScreenshotTaken => "Screenshot taken",
        Trigger::StudioRecordingFinished => "Studio recording ends",
        Trigger::InstantRecordingFinished => "Instant recording ends",
        Trigger::RecordingStarted => "Recording starts",
        Trigger::UploadCompleted => "Upload completes",
        Trigger::VideoImported => "Video imported",
        Trigger::RecordingDeleted => "Recording deleted",
    }
}

/// `TRIGGER_NOUN`.
fn trigger_noun(trigger: Trigger) -> &'static str {
    match trigger {
        Trigger::ScreenshotTaken => "Screenshot",
        Trigger::StudioRecordingFinished => "Studio recording",
        Trigger::InstantRecordingFinished => "Instant recording",
        Trigger::RecordingStarted => "Recording start",
        Trigger::UploadCompleted => "Upload",
        Trigger::VideoImported => "Import",
        Trigger::RecordingDeleted => "Deletion",
    }
}

/// `TRIGGER_ICONS`.
fn trigger_icon(trigger: Trigger) -> &'static str {
    match trigger {
        Trigger::ScreenshotTaken => "icons/image.svg",
        Trigger::StudioRecordingFinished => "icons/clapperboard.svg",
        Trigger::InstantRecordingFinished => "icons/zap.svg",
        Trigger::RecordingStarted => "icons/play-circle.svg",
        Trigger::UploadCompleted => "icons/cloud-upload.svg",
        Trigger::VideoImported => "icons/import.svg",
        Trigger::RecordingDeleted => "icons/trash.svg",
    }
}

/// `ACTION_LABELS`.
fn action_label(kind: ActionType) -> &'static str {
    match kind {
        ActionType::CopyToClipboard => "Copy to clipboard",
        ActionType::SaveToLocation => "Save to location",
        ActionType::Export => "Export with profile",
        ActionType::Upload => "Upload + copy link",
        ActionType::RevealInFileManager => "Reveal in file manager",
        ActionType::OpenFile => "Open file",
        ActionType::RunCommand => "Run command",
        ActionType::Webhook => "Send webhook",
        ActionType::RecognizeTextToClipboard => "Recognize text (OCR) to clipboard",
        ActionType::Notify => "Show notification",
        ActionType::OpenEditor => "Open editor",
        ActionType::SkipEditor => "Skip editor (headless)",
        ActionType::ApplyPreset => "Apply editor preset",
        ActionType::DeleteLocalFiles => "Delete local files",
    }
}

/// `ACTION_SHORT`.
fn action_short(kind: ActionType) -> &'static str {
    match kind {
        ActionType::CopyToClipboard => "Copy to clipboard",
        ActionType::SaveToLocation => "Save to folder",
        ActionType::Export => "Export",
        ActionType::Upload => "Upload & copy link",
        ActionType::RevealInFileManager => "Reveal in file manager",
        ActionType::OpenFile => "Open file",
        ActionType::RecognizeTextToClipboard => "Copy text (OCR)",
        ActionType::Notify => "Notify",
        ActionType::OpenEditor => "Open editor",
        ActionType::SkipEditor => "Skip editor",
        ActionType::ApplyPreset => "Apply preset",
        ActionType::RunCommand => "Run command",
        ActionType::Webhook => "Send webhook",
        ActionType::DeleteLocalFiles => "Delete local files",
    }
}

/// `ACTION_NOUN`.
fn action_noun(kind: ActionType) -> &'static str {
    match kind {
        ActionType::CopyToClipboard => "Clipboard",
        ActionType::SaveToLocation => "Folder",
        ActionType::Export => "Export",
        ActionType::Upload => "Upload",
        ActionType::RevealInFileManager => "Reveal",
        ActionType::OpenFile => "Open",
        ActionType::RecognizeTextToClipboard => "Text",
        ActionType::Notify => "Notify",
        ActionType::OpenEditor => "Editor",
        ActionType::SkipEditor => "Skip editor",
        ActionType::ApplyPreset => "Preset",
        ActionType::RunCommand => "Command",
        ActionType::Webhook => "Webhook",
        ActionType::DeleteLocalFiles => "Delete",
    }
}

/// `CONDITION_LABELS`.
fn condition_label(kind: ConditionType) -> &'static str {
    match kind {
        ConditionType::CaptureTargetIs => "Capture target is",
        ConditionType::RecordingModeIs => "Recording mode is",
        ConditionType::DurationAtLeast => "Duration at least (seconds)",
        ConditionType::DurationAtMost => "Duration at most (seconds)",
        ConditionType::WindowTitleContains => "Window title contains",
        ConditionType::OrganizationIs => "Organization is",
    }
}

fn action_type_of(action: &Action) -> ActionType {
    match action {
        Action::CopyToClipboard { .. } => ActionType::CopyToClipboard,
        Action::SaveToLocation { .. } => ActionType::SaveToLocation,
        Action::Export { .. } => ActionType::Export,
        Action::Upload { .. } => ActionType::Upload,
        Action::RevealInFileManager => ActionType::RevealInFileManager,
        Action::OpenFile => ActionType::OpenFile,
        Action::RunCommand { .. } => ActionType::RunCommand,
        Action::Webhook { .. } => ActionType::Webhook,
        Action::RecognizeTextToClipboard => ActionType::RecognizeTextToClipboard,
        Action::Notify { .. } => ActionType::Notify,
        Action::OpenEditor => ActionType::OpenEditor,
        Action::SkipEditor => ActionType::SkipEditor,
        Action::ApplyPreset { .. } => ActionType::ApplyPreset,
        Action::DeleteLocalFiles => ActionType::DeleteLocalFiles,
    }
}

fn condition_type_of(condition: &Condition) -> ConditionType {
    match condition {
        Condition::CaptureTargetIs { .. } => ConditionType::CaptureTargetIs,
        Condition::RecordingModeIs { .. } => ConditionType::RecordingModeIs,
        Condition::DurationAtLeast { .. } => ConditionType::DurationAtLeast,
        Condition::DurationAtMost { .. } => ConditionType::DurationAtMost,
        Condition::WindowTitleContains { .. } => ConditionType::WindowTitleContains,
        Condition::OrganizationIs { .. } => ConditionType::OrganizationIs,
    }
}

/// `defaultActionForType`.
fn default_action(kind: ActionType) -> Action {
    match kind {
        ActionType::CopyToClipboard => Action::CopyToClipboard {
            source: ClipboardSource::Raw,
        },
        ActionType::SaveToLocation => Action::SaveToLocation {
            dir: String::new(),
            filename_template: None,
        },
        ActionType::Export => Action::Export {
            profile: ExportProfile {
                format: ExportFormat::Mp4,
                fps: 30,
                resolution_base: cap_project::XY { x: 1920, y: 1080 },
                compression: Some(AutomationExportCompression::Web),
                preset_name: None,
            },
            destination: ExportDestination::ProjectFolder,
        },
        ActionType::Upload => Action::Upload {
            organization_id: None,
            copy_link: true,
            open_in_browser: false,
        },
        ActionType::RevealInFileManager => Action::RevealInFileManager,
        ActionType::OpenFile => Action::OpenFile,
        ActionType::RunCommand => Action::RunCommand {
            program: String::new(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            use_shell: false,
        },
        ActionType::Webhook => Action::Webhook {
            url: String::new(),
            method: "POST".to_string(),
            headers: HashMap::new(),
            body_template: None,
        },
        ActionType::RecognizeTextToClipboard => Action::RecognizeTextToClipboard,
        ActionType::Notify => Action::Notify {
            title_template: "Cap".to_string(),
            body_template: String::new(),
        },
        ActionType::OpenEditor => Action::OpenEditor,
        ActionType::SkipEditor => Action::SkipEditor,
        ActionType::ApplyPreset => Action::ApplyPreset {
            name: String::new(),
        },
        ActionType::DeleteLocalFiles => Action::DeleteLocalFiles,
    }
}

/// `defaultConditionForType`.
fn default_condition(kind: ConditionType) -> Condition {
    match kind {
        ConditionType::CaptureTargetIs => Condition::CaptureTargetIs {
            target: CaptureTargetKind::Window,
        },
        ConditionType::RecordingModeIs => Condition::RecordingModeIs {
            mode: AutomationRecordingMode::Studio,
        },
        ConditionType::DurationAtLeast => Condition::DurationAtLeast { secs: 5. },
        ConditionType::DurationAtMost => Condition::DurationAtMost { secs: 300. },
        ConditionType::WindowTitleContains => Condition::WindowTitleContains {
            pattern: String::new(),
        },
        ConditionType::OrganizationIs => Condition::OrganizationIs { id: String::new() },
    }
}

/// `createEmptyRule`.
fn create_empty_rule() -> AutomationRule {
    AutomationRule {
        id: store::new_uuid_v4(),
        name: String::new(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: Vec::new(),
        actions: vec![Action::CopyToClipboard {
            source: ClipboardSource::Raw,
        }],
    }
}

/// The contextual data each trigger provides at runtime -- `TRIGGER_CONTEXT`
/// in `utils/automations.ts`, mirroring the Rust `TriggerContext`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerContextField {
    CaptureTarget,
    WindowTitle,
    RecordingMode,
    Duration,
    ProjectPath,
    FilePath,
    ShareLink,
}

fn trigger_context(trigger: Trigger) -> &'static [TriggerContextField] {
    use TriggerContextField::*;
    match trigger {
        Trigger::ScreenshotTaken => &[CaptureTarget, WindowTitle, ProjectPath, FilePath],
        Trigger::StudioRecordingFinished => &[RecordingMode, Duration, ProjectPath],
        Trigger::InstantRecordingFinished => &[RecordingMode, ProjectPath, ShareLink],
        Trigger::RecordingStarted => &[],
        Trigger::UploadCompleted => &[ProjectPath, ShareLink],
        Trigger::VideoImported => &[ProjectPath],
        Trigger::RecordingDeleted => &[ProjectPath],
    }
}

/// `conditionAppliesToTrigger`.
fn condition_applies_to_trigger(kind: ConditionType, trigger: Trigger) -> bool {
    use TriggerContextField::*;
    let required = match kind {
        ConditionType::CaptureTargetIs => CaptureTarget,
        ConditionType::RecordingModeIs => RecordingMode,
        ConditionType::DurationAtLeast | ConditionType::DurationAtMost => Duration,
        ConditionType::WindowTitleContains => WindowTitle,
        // `organizationIs: null` -- it never matches any trigger today.
        ConditionType::OrganizationIs => return false,
    };
    trigger_context(trigger).contains(&required)
}

/// `actionAppliesToTrigger`.
fn action_applies_to_trigger(kind: ActionType, trigger: Trigger) -> bool {
    use TriggerContextField::*;
    if kind == ActionType::SkipEditor {
        return matches!(
            trigger,
            Trigger::ScreenshotTaken | Trigger::StudioRecordingFinished
        );
    }
    let required: &[TriggerContextField] = match kind {
        ActionType::CopyToClipboard
        | ActionType::SaveToLocation
        | ActionType::OpenFile
        | ActionType::RecognizeTextToClipboard => &[FilePath],
        ActionType::Export | ActionType::ApplyPreset | ActionType::DeleteLocalFiles => {
            &[ProjectPath]
        }
        ActionType::RevealInFileManager | ActionType::OpenEditor | ActionType::Upload => {
            &[FilePath, ProjectPath]
        }
        _ => return true,
    };
    let provided = trigger_context(trigger);
    required.iter().any(|field| provided.contains(field))
}

/// `DANGEROUS_ACTIONS`.
fn action_is_dangerous(kind: ActionType) -> bool {
    matches!(kind, ActionType::RunCommand | ActionType::Webhook)
}

/// The desktop host's capability set (`DesktopAutomationHost::capabilities`):
/// everything, with OCR only where Vision/Windows-OCR exists. `skipEditor`
/// requires no capability at all (`required_capability` returns `None`).
fn action_supported_here(action: &Action) -> bool {
    !matches!(action, Action::RecognizeTextToClipboard)
        || cfg!(any(target_os = "macos", target_os = "windows"))
}

/// `ruleSummary`.
fn rule_summary(rule: &AutomationRule) -> String {
    let trigger = trigger_phrase(rule.trigger);
    if rule.actions.is_empty() {
        return format!("{trigger} → no actions yet");
    }
    let actions = rule
        .actions
        .iter()
        .map(|action| action_short(action_type_of(action)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{trigger} → {actions}")
}

/// `autoRuleName`.
fn auto_rule_name(rule: &AutomationRule) -> String {
    let trigger = trigger_noun(rule.trigger);
    match rule.actions.first() {
        Some(action) => format!("{trigger} → {}", action_noun(action_type_of(action))),
        None => format!("{trigger} automation"),
    }
}

/// `ruleDisplayName`.
fn rule_display_name(rule: &AutomationRule) -> String {
    let name = rule.name.trim();
    if name.is_empty() {
        auto_rule_name(rule)
    } else {
        name.to_string()
    }
}

/// `resolutionValue()`: the preset matching the profile, defaulting to 1080p.
fn resolution_value(profile: &ExportProfile) -> &'static str {
    RESOLUTION_PRESETS
        .iter()
        .find(|(_, _, x, y)| *x == profile.resolution_base.x && *y == profile.resolution_base.y)
        .map(|(value, ..)| *value)
        .unwrap_or("1080p")
}

/// `value={c.secs}` on a number input: integers without the trailing `.0`.
fn format_secs(secs: f64) -> String {
    if secs.fract() == 0. && secs.abs() < 1e15 {
        format!("{}", secs as i64)
    } else {
        format!("{secs}")
    }
}

/// One of `TEMPLATES` -- id, name, description, icon, and the built rule.
struct Template {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    icon: &'static str,
    build: fn() -> AutomationRule,
}

fn template_rule(name: &str, trigger: Trigger, actions: Vec<Action>) -> AutomationRule {
    AutomationRule {
        id: store::new_uuid_v4(),
        name: name.to_string(),
        enabled: true,
        trigger,
        match_mode: MatchMode::All,
        conditions: Vec::new(),
        actions,
    }
}

const TEMPLATES: [Template; 8] = [
    Template {
        id: "copy-screenshot",
        name: "Auto-copy new screenshots to clipboard",
        description: "Snap a screenshot and it's right there, ready to paste.",
        icon: "icons/copy.svg",
        build: || {
            template_rule(
                "Auto-copy new screenshots to clipboard",
                Trigger::ScreenshotTaken,
                vec![Action::CopyToClipboard {
                    source: ClipboardSource::Raw,
                }],
            )
        },
    },
    Template {
        id: "ocr-screenshot",
        name: "Pull the text out of screenshots",
        description: "Cap reads the text in your screenshot and copies it for you.",
        icon: "icons/scan-text.svg",
        build: || {
            template_rule(
                "Pull the text out of screenshots",
                Trigger::ScreenshotTaken,
                vec![Action::RecognizeTextToClipboard],
            )
        },
    },
    Template {
        id: "save-screenshot",
        name: "Tuck screenshots into a folder",
        description: "Send every new screenshot straight to a folder you pick.",
        icon: "icons/folder-down.svg",
        build: || {
            template_rule(
                "Tuck screenshots into a folder",
                Trigger::ScreenshotTaken,
                vec![default_action(ActionType::SaveToLocation)],
            )
        },
    },
    Template {
        id: "reveal-screenshot",
        name: "Jump to each new screenshot",
        description: "Pop open every screenshot in Finder the moment you take it.",
        icon: "icons/folder-open.svg",
        build: || {
            template_rule(
                "Jump to each new screenshot",
                Trigger::ScreenshotTaken,
                vec![Action::RevealInFileManager],
            )
        },
    },
    Template {
        id: "export-studio",
        name: "Auto-export when you finish recording",
        description: "Render an MP4 the second a Studio recording wraps up.",
        icon: "icons/film.svg",
        build: || {
            template_rule(
                "Auto-export when you finish recording",
                Trigger::StudioRecordingFinished,
                vec![default_action(ActionType::Export)],
            )
        },
    },
    Template {
        id: "upload-share",
        name: "Upload and grab the share link",
        description: "Finish a recording and the link is waiting on your clipboard.",
        icon: "icons/link.svg",
        build: || {
            template_rule(
                "Upload and grab the share link",
                Trigger::StudioRecordingFinished,
                vec![default_action(ActionType::Upload)],
            )
        },
    },
    Template {
        id: "notify-upload",
        name: "Ping me when an upload is ready",
        description: "Get a gentle desktop nudge once your recording is shareable.",
        icon: "icons/bell.svg",
        build: || {
            template_rule(
                "Ping me when an upload is ready",
                Trigger::UploadCompleted,
                vec![Action::Notify {
                    title_template: "Cap".to_string(),
                    body_template: "Your recording is ready to share.".to_string(),
                }],
            )
        },
    },
    Template {
        id: "webhook-share",
        name: "Tell Slack when you share something",
        description: "Send the share link to Slack, Discord, or your own webhook.",
        icon: "icons/webhook.svg",
        build: || {
            template_rule(
                "Tell Slack when you share something",
                Trigger::InstantRecordingFinished,
                vec![Action::Webhook {
                    url: String::new(),
                    method: "POST".to_string(),
                    headers: HashMap::new(),
                    body_template: Some(r#"{"text":"{share_link}"}"#.to_string()),
                }],
            )
        },
    },
];

impl SettingsWindow {
    fn rule_at(&self, index: usize) -> Option<&AutomationRule> {
        self.pages.automations.rules.get(index)
    }

    fn export_profile_at(&self, rule: usize, action: usize) -> Option<&ExportProfile> {
        match self.rule_at(rule).and_then(|rule| rule.actions.get(action)) {
            Some(Action::Export { profile, .. }) => Some(profile),
            _ => None,
        }
    }

    /// `mutate()`: apply, persist, and rebuild the expanded editor when the
    /// change was structural (field set changed).
    fn automation_mutate(
        &mut self,
        rule: usize,
        structural: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
        mutate: impl FnOnce(&mut AutomationRule),
    ) {
        let Some(slot) = self.pages.automations.rules.get_mut(rule) else {
            return;
        };
        mutate(slot);
        self.automations_persist();
        if structural {
            self.rebuild_rule_editor(window, cx);
        }
        cx.notify();
    }

    fn automations_persist(&self) {
        if !store::set_automations(&self.pages.automations) {
            tracing::warn!("saving the automations store failed");
        }
    }

    /// `addRule`: append, persist, and expand.
    fn automation_add_rule(
        &mut self,
        rule: AutomationRule,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = rule.id.clone();
        self.pages.automations.rules.push(rule);
        self.automations_persist();
        self.pages.expanded_rule = Some(id);
        self.rebuild_rule_editor(window, cx);
        cx.notify();
    }

    fn automation_remove_rule(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if index >= self.pages.automations.rules.len() {
            return;
        }
        let removed = self.pages.automations.rules.remove(index);
        self.automations_persist();
        if self.pages.expanded_rule.as_deref() == Some(removed.id.as_str()) {
            self.pages.expanded_rule = None;
            self.rebuild_rule_editor(window, cx);
        }
        cx.notify();
    }

    /// `runTest`, evaluated locally against the same capability table the
    /// desktop host reports.
    fn automation_test(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(rule) = self.pages.automations.rules.get(index) else {
            return;
        };
        let checks: Vec<bool> = rule.actions.iter().map(action_supported_here).collect();
        self.pages.test_reports.insert(rule.id.clone(), checks);
        cx.notify();
    }

    /// Build (or drop) the text-input entities behind the expanded rule's
    /// editor. Positional fields, so any structural change rebuilds.
    fn rebuild_rule_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rule_id) = self.pages.expanded_rule.clone() else {
            self.pages.rule_editor = None;
            return;
        };
        let Some(rule) = self
            .pages
            .automations
            .rules
            .iter()
            .find(|rule| rule.id == rule_id)
        else {
            self.pages.rule_editor = None;
            return;
        };

        let mut specs: Vec<(AutoField, String, String)> =
            vec![(AutoField::Name, rule.name.clone(), auto_rule_name(rule))];
        for (index, condition) in rule.conditions.iter().enumerate() {
            match condition {
                Condition::DurationAtLeast { secs } | Condition::DurationAtMost { secs } => {
                    specs.push((
                        AutoField::ConditionSecs(index),
                        format_secs(*secs),
                        String::new(),
                    ));
                }
                Condition::WindowTitleContains { pattern } => {
                    specs.push((
                        AutoField::ConditionPattern(index),
                        pattern.clone(),
                        "e.g. Slack".to_string(),
                    ));
                }
                Condition::OrganizationIs { id } => {
                    specs.push((
                        AutoField::ConditionOrg(index),
                        id.clone(),
                        "Organization ID".to_string(),
                    ));
                }
                _ => {}
            }
        }
        for (index, action) in rule.actions.iter().enumerate() {
            match action {
                Action::SaveToLocation {
                    dir,
                    filename_template,
                } => {
                    specs.push((
                        AutoField::ActionDir(index),
                        dir.clone(),
                        "/Users/you/Screenshots".to_string(),
                    ));
                    specs.push((
                        AutoField::ActionFilename(index),
                        filename_template.clone().unwrap_or_default(),
                        "{date}-{window}".to_string(),
                    ));
                }
                Action::Export { destination, .. } => {
                    let dir = match destination {
                        ExportDestination::ProjectFolder => String::new(),
                        ExportDestination::CustomPath { dir } => dir.clone(),
                    };
                    specs.push((
                        AutoField::ActionExportDir(index),
                        dir,
                        "Project folder".to_string(),
                    ));
                }
                Action::Upload {
                    organization_id, ..
                } => {
                    specs.push((
                        AutoField::ActionOrgId(index),
                        organization_id.clone().unwrap_or_default(),
                        String::new(),
                    ));
                }
                Action::RunCommand { program, args, .. } => {
                    specs.push((
                        AutoField::ActionProgram(index),
                        program.clone(),
                        "/usr/local/bin/my-script".to_string(),
                    ));
                    specs.push((AutoField::ActionArgs(index), args.join(" "), String::new()));
                }
                Action::Webhook {
                    url, body_template, ..
                } => {
                    specs.push((
                        AutoField::ActionUrl(index),
                        url.clone(),
                        "https://hooks.slack.com/...".to_string(),
                    ));
                    specs.push((
                        AutoField::ActionWebhookBody(index),
                        body_template.clone().unwrap_or_default(),
                        r#"{"text":"{share_link}"}"#.to_string(),
                    ));
                }
                Action::Notify {
                    title_template,
                    body_template,
                } => {
                    specs.push((
                        AutoField::ActionNotifyTitle(index),
                        title_template.clone(),
                        String::new(),
                    ));
                    specs.push((
                        AutoField::ActionNotifyBody(index),
                        body_template.clone(),
                        String::new(),
                    ));
                }
                _ => {}
            }
        }

        let mut fields = Vec::with_capacity(specs.len());
        let mut subscriptions = Vec::with_capacity(specs.len());
        for (field, text, placeholder) in specs {
            let input = cx.new(|cx| {
                let mut input = ui::TextInputState::single_line(window, cx);
                if !placeholder.is_empty() {
                    input.set_placeholder(placeholder);
                }
                input.set_text(text, cx);
                input
            });
            subscriptions.push(cx.subscribe(&input, move |this, input, event, cx| {
                this.rule_editor_event(field, input, event, cx)
            }));
            fields.push((field, input));
        }
        self.pages.rule_editor = Some(RuleEditor {
            rule_id,
            fields,
            _subscriptions: subscriptions,
        });
    }

    /// One editor field changed: apply it to the rule and persist -- every
    /// `onInput` in automations.tsx mutates and saves.
    fn rule_editor_event(
        &mut self,
        field: AutoField,
        input: Entity<ui::TextInputState>,
        event: &ui::TextInputEvent,
        cx: &mut Context<Self>,
    ) {
        if *event != ui::TextInputEvent::Changed {
            return;
        }
        let text = input.read(cx).text().to_string();
        let Some(rule_id) = self
            .pages
            .rule_editor
            .as_ref()
            .map(|editor| editor.rule_id.clone())
        else {
            return;
        };
        let Some(rule) = self
            .pages
            .automations
            .rules
            .iter_mut()
            .find(|rule| rule.id == rule_id)
        else {
            return;
        };

        match field {
            AutoField::Name => rule.name = text,
            AutoField::ConditionSecs(index) => {
                // `Number(v) || 0`.
                let secs = text.trim().parse::<f64>().ok().filter(|v| v.is_finite());
                match rule.conditions.get_mut(index) {
                    Some(
                        Condition::DurationAtLeast { secs: slot }
                        | Condition::DurationAtMost { secs: slot },
                    ) => *slot = secs.unwrap_or(0.),
                    _ => return,
                }
            }
            AutoField::ConditionPattern(index) => match rule.conditions.get_mut(index) {
                Some(Condition::WindowTitleContains { pattern }) => *pattern = text,
                _ => return,
            },
            AutoField::ConditionOrg(index) => match rule.conditions.get_mut(index) {
                Some(Condition::OrganizationIs { id }) => *id = text,
                _ => return,
            },
            AutoField::ActionDir(index) => match rule.actions.get_mut(index) {
                Some(Action::SaveToLocation { dir, .. }) => *dir = text,
                _ => return,
            },
            AutoField::ActionFilename(index) => match rule.actions.get_mut(index) {
                Some(Action::SaveToLocation {
                    filename_template, ..
                }) => *filename_template = (!text.is_empty()).then_some(text),
                _ => return,
            },
            AutoField::ActionOrgId(index) => match rule.actions.get_mut(index) {
                Some(Action::Upload {
                    organization_id, ..
                }) => *organization_id = (!text.is_empty()).then_some(text),
                _ => return,
            },
            AutoField::ActionProgram(index) => match rule.actions.get_mut(index) {
                Some(Action::RunCommand { program, .. }) => *program = text,
                _ => return,
            },
            AutoField::ActionArgs(index) => match rule.actions.get_mut(index) {
                // `v.split(" ")` -- a plain space split, as shipped.
                Some(Action::RunCommand { args, .. }) => {
                    *args = if text.is_empty() {
                        Vec::new()
                    } else {
                        text.split(' ').map(str::to_string).collect()
                    }
                }
                _ => return,
            },
            AutoField::ActionUrl(index) => match rule.actions.get_mut(index) {
                Some(Action::Webhook { url, .. }) => *url = text,
                _ => return,
            },
            AutoField::ActionWebhookBody(index) => match rule.actions.get_mut(index) {
                Some(Action::Webhook { body_template, .. }) => {
                    *body_template = (!text.is_empty()).then_some(text)
                }
                _ => return,
            },
            AutoField::ActionNotifyTitle(index) => match rule.actions.get_mut(index) {
                Some(Action::Notify { title_template, .. }) => *title_template = text,
                _ => return,
            },
            AutoField::ActionNotifyBody(index) => match rule.actions.get_mut(index) {
                Some(Action::Notify { body_template, .. }) => *body_template = text,
                _ => return,
            },
            AutoField::ActionExportDir(index) => match rule.actions.get_mut(index) {
                Some(Action::Export { destination, .. }) => {
                    *destination = if text.is_empty() {
                        ExportDestination::ProjectFolder
                    } else {
                        ExportDestination::CustomPath { dir: text }
                    }
                }
                _ => return,
            },
        }
        self.automations_persist();
        cx.notify();
    }

    /// A directory picker for the two Browse buttons, writing both the rule
    /// and the editor field's text.
    fn automation_pick_dir(
        &mut self,
        rule: usize,
        field: AutoField,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(dir) = paths.into_iter().next() else {
                return;
            };
            let dir = dir.to_string_lossy().to_string();
            this.update_in(cx, |this, window, cx| {
                let value = dir.clone();
                this.automation_mutate(rule, false, window, cx, move |rule| match field {
                    AutoField::ActionDir(index) => {
                        if let Some(Action::SaveToLocation { dir, .. }) =
                            rule.actions.get_mut(index)
                        {
                            *dir = value;
                        }
                    }
                    AutoField::ActionExportDir(index) => {
                        if let Some(Action::Export { destination, .. }) =
                            rule.actions.get_mut(index)
                        {
                            *destination = ExportDestination::CustomPath { dir: value };
                        }
                    }
                    _ => {}
                });
                if let Some(input) = this.rule_editor_input(field) {
                    input.update(cx, |input, cx| input.set_text(dir, cx));
                }
            })
            .ok();
        })
        .detach();
    }

    fn rule_editor_input(&self, field: AutoField) -> Option<Entity<ui::TextInputState>> {
        self.pages
            .rule_editor
            .as_ref()?
            .fields
            .iter()
            .find(|(candidate, _)| *candidate == field)
            .map(|(_, input)| input.clone())
    }

    pub(crate) fn render_automations(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        let loaded = self.pages.automations_loaded;

        let rules_body: gpui::AnyElement = if !loaded {
            // The `Suspense` fallback.
            div()
                .h(px(96.))
                .rounded(px(10.))
                .bg(theme.settings_fill())
                .into_any_element()
        } else if self.pages.automations.rules.is_empty() {
            self.render_automations_empty(cx).into_any_element()
        } else {
            let mut children: Vec<gpui::AnyElement> = Vec::new();
            for index in 0..self.pages.automations.rules.len() {
                children.push(self.render_rule_card(index, cx));
            }
            children.push(self.render_add_rule_button(cx).into_any_element());
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .children(children)
                .into_any_element()
        };

        // `grid grid-cols-2 gap-2.5`, as rows of two.
        let mut template_rows: Vec<gpui::AnyElement> = Vec::new();
        for pair in TEMPLATES.chunks(2) {
            template_rows.push(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(10.))
                    .children(
                        pair.iter()
                            .map(|template| self.render_template_card(template, cx)),
                    )
                    .into_any_element(),
            );
        }
        let templates = div().flex().flex_col().gap(px(10.)).children(template_rows);

        vec![
            self.section(
                "Automations",
                Some(
                    "Run actions automatically when something happens in Cap. Rules are shared \
                     with the Cap CLI.",
                ),
                None,
                vec![rules_body],
            )
            .into_any_element(),
            self.section(
                "Templates",
                Some("One click to add a ready-made automation. Tweak anything afterwards."),
                None,
                vec![templates.into_any_element()],
            )
            .into_any_element(),
        ]
    }

    /// `<EmptyState>`.
    fn render_automations_empty(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        self.card(true).child(
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.))
                .py(px(24.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(44.))
                        .mb(px(4.))
                        .rounded_full()
                        .bg(theme.settings_fill())
                        .child(
                            svg()
                                .path("icons/zap.svg")
                                .size(px(20.))
                                .text_color(theme.settings_muted()),
                        ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .child("No automations yet"),
                )
                .child(
                    div()
                        .max_w(px(320.))
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_center()
                        .text_color(theme.settings_muted())
                        .child(
                            "Pick a template below to get started in one click, or build your \
                             own from scratch.",
                        ),
                )
                .child(div().mt(px(4.)).child(self.button(
                    "automations-scratch",
                    (ui::ButtonVariant::Gray, Some("icons/plus.svg")),
                    "Start from scratch",
                    false,
                    cx,
                    |this, window, cx| {
                        this.automation_add_rule(create_empty_rule(), window, cx);
                    },
                ))),
        )
    }

    /// `<AddRuleButton>`.
    fn render_add_rule_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .id("automations-add")
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .py(px(10.))
            .w_full()
            .rounded(px(10.))
            .border_1()
            .border_dashed()
            .border_color(theme.settings_border())
            .text_size(px(13.))
            .text_color(theme.settings_muted())
            .cursor_pointer()
            .hover(|style| {
                style
                    .text_color(theme.settings_text())
                    .bg(theme.settings_card_bg())
            })
            .child(
                svg()
                    .path("icons/plus.svg")
                    .size(px(16.))
                    .text_color(theme.settings_muted()),
            )
            .child("New automation")
            .on_click(cx.listener(|this, _, window, cx| {
                this.automation_add_rule(create_empty_rule(), window, cx);
            }))
    }

    /// `<TemplateCard>`.
    fn render_template_card(
        &self,
        template: &Template,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let build = template.build;
        let name = template.name;
        div()
            .id(SharedString::from(format!("template-{}", template.id)))
            .flex()
            .flex_row()
            .items_start()
            .flex_1()
            .min_w_0()
            .gap(px(12.))
            .p(px(12.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme.settings_border())
            .bg(theme.settings_card_bg())
            .cursor_pointer()
            .hover(|style| style.bg(theme.settings_fill()))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(36.))
                    .flex_shrink_0()
                    .rounded(px(8.))
                    .bg(theme.settings_fill())
                    .child(
                        svg()
                            .path(template.icon)
                            .size(px(18.))
                            .text_color(theme.settings_muted()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(name),
                    )
                    .child(
                        div()
                            .mt(px(2.))
                            .text_size(px(11.))
                            .line_height(px(15.))
                            .text_color(theme.settings_muted())
                            .child(template.description),
                    ),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                // `addFromTemplate` also toasts `Added "{name}"`; no toast
                // layer here, the expanded editor is the feedback.
                tracing::info!(template = name, "added an automation template");
                this.automation_add_rule(build(), window, cx);
            }))
            .into_any_element()
    }

    /// `<RuleCard>`.
    fn render_rule_card(&self, index: usize, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let Some(rule) = self.pages.automations.rules.get(index) else {
            return div().into_any_element();
        };
        let expanded = self.pages.expanded_rule.as_deref() == Some(rule.id.as_str());
        let enabled = rule.enabled;
        let has_custom_name = !rule.name.trim().is_empty();

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .p(px(10.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(36.))
                    .flex_shrink_0()
                    .rounded(px(8.))
                    .bg(theme.settings_fill())
                    .when(!enabled, |this| this.opacity(0.6))
                    .child(
                        svg()
                            .path(trigger_icon(rule.trigger))
                            .size(px(18.))
                            .text_color(theme.settings_muted()),
                    ),
            )
            .child(
                div()
                    .id(("rule-expand-label", index))
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .cursor_pointer()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if enabled {
                                theme.settings_text()
                            } else {
                                theme.settings_muted()
                            })
                            .child(rule_display_name(rule)),
                    )
                    .when(has_custom_name, |this| {
                        this.child(
                            div()
                                .truncate()
                                .text_size(px(11.))
                                .text_color(theme.settings_muted())
                                .child(rule_summary(rule)),
                        )
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.automation_toggle_expand(index, window, cx);
                    })),
            )
            .child(
                self.toggle(("rule-enabled", index), enabled, cx, move |this, cx| {
                    if let Some(rule) = this.pages.automations.rules.get_mut(index) {
                        rule.enabled = !rule.enabled;
                        this.automations_persist();
                        cx.notify();
                    }
                }),
            )
            .child(
                div()
                    .id(("rule-expand", index))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.settings_fill()))
                    .child(
                        svg()
                            .path(if expanded {
                                "icons/chevron-up.svg"
                            } else {
                                "icons/chevron-down.svg"
                            })
                            .size(px(16.))
                            .text_color(theme.settings_muted()),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.automation_toggle_expand(index, window, cx);
                    })),
            );

        let mut card = self.card(false).flex().flex_col().child(header);
        if expanded {
            card = card.child(
                div()
                    .border_t_1()
                    .border_color(theme.settings_border())
                    .child(self.render_rule_editor(index, cx)),
            );
        }
        card.into_any_element()
    }

    fn automation_toggle_expand(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(rule) = self.pages.automations.rules.get(index) else {
            return;
        };
        let id = rule.id.clone();
        if self.pages.expanded_rule.as_deref() == Some(id.as_str()) {
            self.pages.expanded_rule = None;
        } else {
            self.pages.expanded_rule = Some(id);
        }
        self.rebuild_rule_editor(window, cx);
        cx.notify();
    }

    /// The editor field for one [`AutoField`], if the rebuilt editor has it.
    fn render_editor_input(&self, field: AutoField) -> gpui::AnyElement {
        match self.rule_editor_input(field) {
            Some(input) => {
                let id = SharedString::from(format!("auto-field-{field:?}"));
                self.pages_input(id, &input).into_any_element()
            }
            None => div().into_any_element(),
        }
    }

    /// `<Field>`: an 11px label over the control.
    fn editor_field(&self, label: &'static str, control: gpui::AnyElement) -> gpui::AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(4.))
            .child(
                div()
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.settings_muted())
                    .child(label),
            )
            .child(control)
            .into_any_element()
    }

    /// `<GroupLabel>`.
    fn group_label(&self, text: &'static str) -> impl IntoElement {
        div()
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(self.theme.settings_muted())
            .child(text.to_uppercase())
    }

    /// `<RuleEditorBody>`.
    fn render_rule_editor(&self, index: usize, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let Some(rule) = self.pages.automations.rules.get(index) else {
            return div().into_any_element();
        };
        let trigger = rule.trigger;
        let has_dangerous = rule
            .actions
            .iter()
            .any(|action| action_is_dangerous(action_type_of(action)));
        let report = self.pages.test_reports.get(&rule.id).cloned();

        let name_field = self.editor_field("Name", self.render_editor_input(AutoField::Name));

        let trigger_block = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(self.group_label("When this happens"))
            .child(
                self.pages_select(
                    ("rule-trigger", index),
                    trigger_label(trigger),
                    MenuKind::AutomationTrigger(index),
                    cx,
                )
                .stretch_label(),
            );

        // -- Conditions -----------------------------------------------------
        let mut conditions_header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(self.group_label("Only run if"));
        let mut header_right = div().flex().flex_row().items_center().gap(px(8.));
        if rule.conditions.len() > 1 {
            let mode_label = match rule.match_mode {
                MatchMode::All => "Match all",
                MatchMode::Any => "Match any",
            };
            header_right = header_right.child(self.pages_select(
                ("rule-match-mode", index),
                mode_label,
                MenuKind::AutomationMatchMode(index),
                cx,
            ));
        }
        header_right = header_right.child(
            ui::Button::settings(
                &theme,
                ("rule-add-condition", index),
                ui::ButtonVariant::Gray,
                ui::ButtonSize::Xs,
            )
            .label("Add condition")
            .on_click(cx.listener(move |this, _, window, cx| {
                this.automation_mutate(index, true, window, cx, |rule| {
                    // The first condition type that applies to the trigger,
                    // falling back to `captureTargetIs`.
                    let kind = ALL_CONDITION_TYPES
                        .iter()
                        .copied()
                        .find(|kind| condition_applies_to_trigger(*kind, rule.trigger))
                        .unwrap_or(ConditionType::CaptureTargetIs);
                    rule.conditions.push(default_condition(kind));
                });
            })),
        );
        conditions_header = conditions_header.child(header_right);

        let conditions_body: gpui::AnyElement = if rule.conditions.is_empty() {
            div()
                .text_size(px(12.))
                .text_color(theme.settings_muted())
                .child(format!(
                    "Runs for every {}.",
                    trigger_phrase(trigger).to_lowercase()
                ))
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .children(
                    rule.conditions
                        .iter()
                        .enumerate()
                        .map(|(ci, condition)| self.render_condition_row(index, ci, condition, cx)),
                )
                .into_any_element()
        };

        // -- Actions ----------------------------------------------------------
        let actions_header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(self.group_label("Then do this"))
            .child(
                ui::Button::settings(
                    &theme,
                    ("rule-add-action", index),
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Xs,
                )
                .label("Add action")
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.automation_mutate(index, true, window, cx, |rule| {
                        // `copyToClipboard` when it applies, else the first
                        // applicable type, else `notify`.
                        let kind =
                            if action_applies_to_trigger(ActionType::CopyToClipboard, rule.trigger)
                            {
                                ActionType::CopyToClipboard
                            } else {
                                ALL_ACTION_TYPES
                                    .iter()
                                    .copied()
                                    .find(|kind| action_applies_to_trigger(*kind, rule.trigger))
                                    .unwrap_or(ActionType::Notify)
                            };
                        rule.actions.push(default_action(kind));
                    });
                })),
            );

        let action_count = rule.actions.len();
        let actions_body =
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .children(rule.actions.iter().enumerate().map(|(ai, action)| {
                    let support = report.as_ref().and_then(|checks| checks.get(ai)).copied();
                    self.render_action_row(index, ai, action, trigger, action_count, support, cx)
                }));

        let footer = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .pt(px(16.))
            .mt(px(8.))
            .border_t_1()
            .border_color(theme.settings_border())
            .child(
                ui::Button::settings(
                    &theme,
                    ("rule-test", index),
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Xs,
                )
                .label("Check compatibility")
                .on_click(cx.listener(move |this, _, _window, cx| this.automation_test(index, cx))),
            )
            .child(
                div()
                    .id(("rule-delete", index))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .h(px(24.))
                    .px(px(8.))
                    .rounded(px(8.))
                    .text_size(px(12.))
                    .text_color(theme.settings_muted())
                    .cursor_pointer()
                    .hover(|style| {
                        style
                            .text_color(Hsla::from(rgb(0xef4444)))
                            .bg(Theme::with_alpha(rgb(0xef4444), 0.1))
                    })
                    .child(
                        svg()
                            .path("icons/trash.svg")
                            .size(px(14.))
                            .text_color(theme.settings_muted()),
                    )
                    .child("Delete")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.automation_remove_rule(index, window, cx);
                    })),
            );

        div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .p(px(16.))
            .child(name_field)
            .child(trigger_block)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(conditions_header)
                    .child(conditions_body),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(actions_header)
                    .child(actions_body),
            )
            .when(has_dangerous, |this| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(Hsla::from(theme.amber_11))
                        .child(
                            "This automation runs commands or sends network requests. Only use \
                             values you trust — they execute automatically with your permissions.",
                        ),
                )
            })
            .child(footer)
            .into_any_element()
    }

    /// `<ConditionRow>`.
    fn render_condition_row(
        &self,
        rule: usize,
        index: usize,
        condition: &Condition,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let kind = condition_type_of(condition);
        let trigger = self
            .rule_at(rule)
            .map(|rule| rule.trigger)
            .unwrap_or(Trigger::ScreenshotTaken);
        let applies = condition_applies_to_trigger(kind, trigger);

        let value: gpui::AnyElement = match condition {
            Condition::CaptureTargetIs { target } => {
                let label = CAPTURE_TARGETS
                    .iter()
                    .find(|(candidate, _)| candidate == target)
                    .map(|(_, label)| *label)
                    .unwrap_or("Window");
                self.pages_select(
                    SharedString::from(format!("condition-target-{rule}-{index}")),
                    label,
                    MenuKind::AutomationConditionTarget(rule, index),
                    cx,
                )
                .stretch_label()
                .into_any_element()
            }
            Condition::RecordingModeIs { mode } => {
                let label = RECORDING_MODES
                    .iter()
                    .find(|(candidate, _)| candidate == mode)
                    .map(|(_, label)| *label)
                    .unwrap_or("Studio");
                self.pages_select(
                    SharedString::from(format!("condition-mode-{rule}-{index}")),
                    label,
                    MenuKind::AutomationConditionMode(rule, index),
                    cx,
                )
                .stretch_label()
                .into_any_element()
            }
            Condition::DurationAtLeast { .. } | Condition::DurationAtMost { .. } => self
                .render_editor_input(AutoField::ConditionSecs(index))
                .into_any_element(),
            Condition::WindowTitleContains { .. } => self
                .render_editor_input(AutoField::ConditionPattern(index))
                .into_any_element(),
            Condition::OrganizationIs { .. } => self
                .render_editor_input(AutoField::ConditionOrg(index))
                .into_any_element(),
        };

        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(8.))
                    .p(px(10.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme.settings_border())
                    .bg(theme.settings_card_bg())
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .flex_1()
                            .min_w_0()
                            .gap(px(8.))
                            .child(
                                div().flex_1().min_w_0().child(
                                    self.pages_select(
                                        SharedString::from(format!(
                                            "condition-type-{rule}-{index}"
                                        )),
                                        condition_label(kind),
                                        MenuKind::AutomationConditionType(rule, index),
                                        cx,
                                    )
                                    .stretch_label(),
                                ),
                            )
                            .child(div().flex_1().min_w_0().child(value)),
                    )
                    .child(self.render_row_icon_button(
                        SharedString::from(format!("condition-remove-{rule}-{index}")),
                        "icons/x.svg",
                        false,
                        cx,
                        move |this, window, cx| {
                            this.automation_mutate(rule, true, window, cx, move |rule| {
                                if index < rule.conditions.len() {
                                    rule.conditions.remove(index);
                                }
                            });
                        },
                    )),
            )
            .when(!applies, |this| {
                this.child(
                    div()
                        .px(px(4.))
                        .text_size(px(11.))
                        .text_color(Hsla::from(theme.amber_11))
                        .child("This condition never matches for the selected trigger."),
                )
            })
            .into_any_element()
    }

    /// `<RowButton>`: the 28px icon buttons on condition/action rows.
    fn render_row_icon_button(
        &self,
        id: SharedString,
        icon: &'static str,
        disabled: bool,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .size(px(28.))
            .flex_shrink_0()
            .rounded(px(8.))
            .when(disabled, |this| this.opacity(0.4))
            .child(
                svg()
                    .path(icon)
                    .size(px(16.))
                    .text_color(theme.settings_muted()),
            )
            .when(!disabled, |this| {
                this.cursor_pointer()
                    .hover(|style| style.bg(theme.settings_fill()))
                    .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            })
            .into_any_element()
    }

    /// `<ActionRow>`.
    #[allow(clippy::too_many_arguments)]
    fn render_action_row(
        &self,
        rule: usize,
        index: usize,
        action: &Action,
        trigger: Trigger,
        action_count: usize,
        support: Option<bool>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        let kind = action_type_of(action);
        let applies = action_applies_to_trigger(kind, trigger);

        let mut header = div().flex().flex_row().items_center().gap(px(8.)).child(
            div().flex_1().min_w_0().child(
                self.pages_select(
                    SharedString::from(format!("action-type-{rule}-{index}")),
                    action_label(kind),
                    MenuKind::AutomationActionType(rule, index),
                    cx,
                )
                .stretch_label(),
            ),
        );
        if support == Some(false) {
            header = header.child(
                div()
                    .px(px(6.))
                    .py(px(2.))
                    .rounded(px(6.))
                    .bg(Theme::with_alpha(theme.amber_11, 0.15))
                    .text_size(px(10.))
                    .text_color(Hsla::from(theme.amber_11))
                    .child("SKIPPED HERE"),
            );
        }
        header = header
            .child(self.render_row_icon_button(
                SharedString::from(format!("action-up-{rule}-{index}")),
                "icons/chevron-up.svg",
                index == 0,
                cx,
                move |this, window, cx| {
                    this.automation_mutate(rule, true, window, cx, move |rule| {
                        if index > 0 && index < rule.actions.len() {
                            rule.actions.swap(index, index - 1);
                        }
                    });
                },
            ))
            .child(self.render_row_icon_button(
                SharedString::from(format!("action-down-{rule}-{index}")),
                "icons/chevron-down.svg",
                index + 1 == action_count,
                cx,
                move |this, window, cx| {
                    this.automation_mutate(rule, true, window, cx, move |rule| {
                        if index + 1 < rule.actions.len() {
                            rule.actions.swap(index, index + 1);
                        }
                    });
                },
            ))
            .child(self.render_row_icon_button(
                SharedString::from(format!("action-remove-{rule}-{index}")),
                "icons/x.svg",
                false,
                cx,
                move |this, window, cx| {
                    this.automation_mutate(rule, true, window, cx, move |rule| {
                        if index < rule.actions.len() {
                            rule.actions.remove(index);
                        }
                    });
                },
            ));

        let params = self.render_action_params(rule, index, action, cx);

        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(12.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.settings_border())
            .bg(theme.settings_card_bg())
            .child(header)
            .children(params)
            .when(!applies, |this| {
                this.child(
                    div()
                        .text_size(px(11.))
                        .text_color(Hsla::from(theme.amber_11))
                        .child("This action has no effect for the selected trigger."),
                )
            })
            .into_any_element()
    }

    /// `<ActionParams>`: the per-type body of an action row.
    fn render_action_params(
        &self,
        rule: usize,
        index: usize,
        action: &Action,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let theme = self.theme;
        match action {
            Action::CopyToClipboard { source } => {
                let label = CLIPBOARD_SOURCES
                    .iter()
                    .find(|(candidate, _)| candidate == source)
                    .map(|(_, label)| *label)
                    .unwrap_or("Original capture");
                Some(
                    self.editor_field(
                        "Source",
                        self.pages_select(
                            SharedString::from(format!("action-source-{rule}-{index}")),
                            label,
                            MenuKind::AutomationClipboardSource(rule, index),
                            cx,
                        )
                        .stretch_label()
                        .into_any_element(),
                    ),
                )
            }
            Action::SaveToLocation { .. } => {
                Some(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(8.))
                        .child(
                            self.editor_field(
                                "Folder",
                                div()
                                    .flex()
                                    .flex_row()
                                    .gap(px(8.))
                                    .child(div().flex_1().min_w_0().child(
                                        self.render_editor_input(AutoField::ActionDir(index)),
                                    ))
                                    .child(self.button(
                                        SharedString::from(format!("action-browse-{rule}-{index}")),
                                        (ui::ButtonVariant::Gray, None),
                                        "Browse",
                                        false,
                                        cx,
                                        move |this, window, cx| {
                                            this.automation_pick_dir(
                                                rule,
                                                AutoField::ActionDir(index),
                                                window,
                                                cx,
                                            );
                                        },
                                    ))
                                    .into_any_element(),
                            ),
                        )
                        .child(self.editor_field(
                            "Filename template (optional)",
                            self.render_editor_input(AutoField::ActionFilename(index)),
                        ))
                        .into_any_element(),
                )
            }
            Action::Export { profile, .. } => {
                Some(self.render_export_params(rule, index, profile, cx))
            }
            Action::Upload {
                copy_link,
                open_in_browser,
                ..
            } => {
                let copy_link = *copy_link;
                let open_in_browser = *open_in_browser;
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(self.editor_field(
                            "Organization ID (optional)",
                            self.render_editor_input(AutoField::ActionOrgId(index)),
                        ))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(24.))
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .gap(px(8.))
                                        .child(self.toggle(
                                            SharedString::from(format!(
                                                "action-copy-link-{rule}-{index}"
                                            )),
                                            copy_link,
                                            cx,
                                            move |this, cx| {
                                                if let Some(Action::Upload { copy_link, .. }) = this
                                                    .pages
                                                    .automations
                                                    .rules
                                                    .get_mut(rule)
                                                    .and_then(|rule| rule.actions.get_mut(index))
                                                {
                                                    *copy_link = !*copy_link;
                                                    this.automations_persist();
                                                    cx.notify();
                                                }
                                            },
                                        ))
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .child("Copy link to clipboard"),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .flex_row()
                                        .items_center()
                                        .gap(px(8.))
                                        .child(self.toggle(
                                            SharedString::from(format!(
                                                "action-open-browser-{rule}-{index}"
                                            )),
                                            open_in_browser,
                                            cx,
                                            move |this, cx| {
                                                if let Some(Action::Upload {
                                                    open_in_browser,
                                                    ..
                                                }) = this
                                                    .pages
                                                    .automations
                                                    .rules
                                                    .get_mut(rule)
                                                    .and_then(|rule| rule.actions.get_mut(index))
                                                {
                                                    *open_in_browser = !*open_in_browser;
                                                    this.automations_persist();
                                                    cx.notify();
                                                }
                                            },
                                        ))
                                        .child(div().text_size(px(13.)).child("Open in browser")),
                                ),
                        )
                        .into_any_element(),
                )
            }
            Action::RunCommand { use_shell, .. } => {
                let use_shell = *use_shell;
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(8.))
                                .child(self.editor_field(
                                    "Program",
                                    self.render_editor_input(AutoField::ActionProgram(index)),
                                ))
                                .child(self.editor_field(
                                    "Arguments (space-separated)",
                                    self.render_editor_input(AutoField::ActionArgs(index)),
                                )),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.))
                                .child(self.toggle(
                                    SharedString::from(format!("action-shell-{rule}-{index}")),
                                    use_shell,
                                    cx,
                                    move |this, cx| {
                                        if let Some(Action::RunCommand { use_shell, .. }) = this
                                            .pages
                                            .automations
                                            .rules
                                            .get_mut(rule)
                                            .and_then(|rule| rule.actions.get_mut(index))
                                        {
                                            *use_shell = !*use_shell;
                                            this.automations_persist();
                                            cx.notify();
                                        }
                                    },
                                ))
                                .child(div().text_size(px(13.)).child("Run through shell")),
                        )
                        .into_any_element(),
                )
            }
            Action::Webhook { method, .. } => {
                let method_label = SharedString::from(method.clone());
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(8.))
                                .child(self.editor_field(
                                    "URL",
                                    self.render_editor_input(AutoField::ActionUrl(index)),
                                ))
                                .child(
                                    div().w(px(112.)).flex_shrink_0().child(
                                        self.editor_field(
                                            "Method",
                                            self.pages_select(
                                                SharedString::from(format!(
                                                    "action-method-{rule}-{index}"
                                                )),
                                                method_label,
                                                MenuKind::AutomationWebhookMethod(rule, index),
                                                cx,
                                            )
                                            .stretch_label()
                                            .into_any_element(),
                                        ),
                                    ),
                                ),
                        )
                        .child(self.editor_field(
                            "Body template (optional)",
                            self.render_editor_input(AutoField::ActionWebhookBody(index)),
                        ))
                        .into_any_element(),
                )
            }
            Action::Notify { .. } => Some(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .child(self.editor_field(
                        "Title",
                        self.render_editor_input(AutoField::ActionNotifyTitle(index)),
                    ))
                    .child(self.editor_field(
                        "Body",
                        self.render_editor_input(AutoField::ActionNotifyBody(index)),
                    ))
                    .into_any_element(),
            ),
            Action::ApplyPreset { name } => {
                let names = store::preset_names();
                if names.is_empty() {
                    return Some(
                        div()
                            .px(px(2.))
                            .py(px(6.))
                            .text_size(px(11.))
                            .text_color(theme.settings_muted())
                            .child("No presets yet — create one in the editor first.")
                            .into_any_element(),
                    );
                }
                let label = if name.is_empty() {
                    SharedString::from(names[0].clone())
                } else {
                    SharedString::from(name.clone())
                };
                Some(
                    self.editor_field(
                        "Preset",
                        self.pages_select(
                            SharedString::from(format!("action-preset-{rule}-{index}")),
                            label,
                            MenuKind::AutomationPreset(rule, index),
                            cx,
                        )
                        .stretch_label()
                        .into_any_element(),
                    ),
                )
            }
            _ => None,
        }
    }

    /// `<ExportParams>`.
    fn render_export_params(
        &self,
        rule: usize,
        index: usize,
        profile: &ExportProfile,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let format_label = EXPORT_FORMATS
            .iter()
            .find(|(candidate, _)| *candidate == profile.format)
            .map(|(_, label)| *label)
            .unwrap_or("MP4");
        let resolution_label = RESOLUTION_PRESETS
            .iter()
            .find(|(value, ..)| *value == resolution_value(profile))
            .map(|(_, label, ..)| *label)
            .unwrap_or("1080p");
        let compression_label = COMPRESSIONS
            .iter()
            .find(|(candidate, _)| {
                *candidate
                    == profile
                        .compression
                        .unwrap_or(AutomationExportCompression::Web)
            })
            .map(|(_, label)| *label)
            .unwrap_or("Web");
        let is_mp4 = profile.format == ExportFormat::Mp4;

        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .child(
                        self.editor_field(
                            "Format",
                            self.pages_select(
                                SharedString::from(format!("export-format-{rule}-{index}")),
                                format_label,
                                MenuKind::AutomationExportFormat(rule, index),
                                cx,
                            )
                            .stretch_label()
                            .into_any_element(),
                        ),
                    )
                    .child(
                        self.editor_field(
                            "Resolution",
                            self.pages_select(
                                SharedString::from(format!("export-resolution-{rule}-{index}")),
                                resolution_label,
                                MenuKind::AutomationExportResolution(rule, index),
                                cx,
                            )
                            .stretch_label()
                            .into_any_element(),
                        ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .child(
                        self.editor_field(
                            "Frame rate",
                            self.pages_select(
                                SharedString::from(format!("export-fps-{rule}-{index}")),
                                format!("{} FPS", profile.fps),
                                MenuKind::AutomationExportFps(rule, index),
                                cx,
                            )
                            .stretch_label()
                            .into_any_element(),
                        ),
                    )
                    .when(is_mp4, |this| {
                        this.child(
                            self.editor_field(
                                "Compression",
                                self.pages_select(
                                    SharedString::from(format!(
                                        "export-compression-{rule}-{index}"
                                    )),
                                    compression_label,
                                    MenuKind::AutomationExportCompression(rule, index),
                                    cx,
                                )
                                .stretch_label()
                                .into_any_element(),
                            ),
                        )
                    }),
            )
            .child(
                self.editor_field(
                    "Destination folder (optional, blank = project folder)",
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(self.render_editor_input(AutoField::ActionExportDir(index))),
                        )
                        .child(self.button(
                            SharedString::from(format!("export-browse-{rule}-{index}")),
                            (ui::ButtonVariant::Gray, None),
                            "Browse",
                            false,
                            cx,
                            move |this, window, cx| {
                                this.automation_pick_dir(
                                    rule,
                                    AutoField::ActionExportDir(index),
                                    window,
                                    cx,
                                );
                            },
                        ))
                        .into_any_element(),
                ),
            )
            .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

enum HttpBody {
    None,
    Json(Value),
    /// `application/x-www-form-urlencoded` -- the feedback contract's
    /// `contentType`.
    Form(Vec<(&'static str, String)>),
}

enum HttpError {
    Timeout,
    Message(String),
}

impl HttpError {
    fn text(&self) -> String {
        match self {
            Self::Timeout => "The request timed out".to_string(),
            Self::Message(message) => message.clone(),
        }
    }
}

/// One request, one `(status, parsed body)` -- the same shape the ts-rest
/// `ApiFetcher` in `utils/web-api.ts` hands every page.
async fn http_json(
    method: reqwest::Method,
    url: String,
    query: Vec<(&'static str, String)>,
    headers: Vec<(&'static str, String)>,
    bearer: Option<String>,
    body: HttpBody,
    timeout: Option<Duration>,
) -> Result<(u16, Value), HttpError> {
    let mut request = reqwest::Client::new().request(method, &url);
    if !query.is_empty() {
        request = request.query(&query);
    }
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    request = match body {
        HttpBody::None => request,
        HttpBody::Json(value) => request.json(&value),
        HttpBody::Form(fields) => request.form(&fields),
    };
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }

    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            HttpError::Timeout
        } else {
            HttpError::Message(error.to_string())
        }
    })?;
    let status = response.status().as_u16();
    let is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
    let text = response
        .text()
        .await
        .map_err(|error| HttpError::Message(error.to_string()))?;
    let body = if is_json {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    } else {
        Value::String(text)
    };
    Ok((status, body))
}

// ---------------------------------------------------------------------------
// CLI install (crates/cli-install/src/lib.rs, ported)
// ---------------------------------------------------------------------------

/// A direct port of `crates/cli-install` -- this standalone workspace cannot
/// depend on the crate, and the whole point is that `status`/`install`/
/// `uninstall` behave byte-for-byte like the Tauri commands
/// (`src-tauri/src/cli.rs`) so the two apps manage the same shim.
mod cli_install {
    #[cfg(unix)]
    use std::ffi::OsStr;
    use std::{
        env, fs,
        path::{Path, PathBuf},
    };

    const CAP_DIR_NAME: &str = ".cap";
    const BIN_DIR_NAME: &str = "bin";
    const CLI_BINARY_STEM: &str = "cap-cli";

    #[cfg(windows)]
    const SHIM_NAME: &str = "cap.cmd";
    #[cfg(not(windows))]
    const SHIM_NAME: &str = "cap";

    #[cfg(windows)]
    const CLI_BINARY_NAME: &str = "cap-cli.exe";
    #[cfg(not(windows))]
    const CLI_BINARY_NAME: &str = "cap-cli";

    /// `CliInstallStatus`, minus the serde/specta derives the commands need
    /// and minus `install_dir`, which neither cli.tsx nor this page displays
    /// (`path_entry` carries the same string).
    #[derive(Clone, Debug)]
    pub(crate) struct CliInstallStatus {
        pub shim_path: String,
        pub target_path: String,
        pub installed: bool,
        pub on_path: bool,
        pub conflict: Option<String>,
        pub path_entry: String,
        pub shell_command: String,
        pub path_configured: bool,
    }

    fn home_dir() -> Result<PathBuf, String> {
        dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())
    }

    fn install_dir() -> Result<PathBuf, String> {
        let home = home_dir()?;
        let cap_bin = home.join(CAP_DIR_NAME).join(BIN_DIR_NAME);
        let local_bin = home.join(".local/bin");

        // Prefer whichever candidate already holds a Cap-managed shim, so
        // status and install agree regardless of the launching PATH.
        if let Ok(target) = target_path() {
            for candidate in [&cap_bin, &local_bin] {
                let shim = candidate.join(SHIM_NAME);
                if shim_points_to(&shim, &target).unwrap_or(false) || shim_is_cap_managed(&shim) {
                    return Ok(candidate.clone());
                }
            }
        }

        if path_is_present(&cap_bin.join(SHIM_NAME)) || cfg!(windows) {
            return Ok(cap_bin);
        }

        if path_contains_install_dir(&local_bin) {
            return Ok(local_bin);
        }

        Ok(cap_bin)
    }

    fn shim_path() -> Result<PathBuf, String> {
        Ok(install_dir()?.join(SHIM_NAME))
    }

    fn target_path() -> Result<PathBuf, String> {
        let exe =
            env::current_exe().map_err(|e| format!("Could not locate Cap executable: {e}"))?;
        let exe = resolve_path_for_target_lookup(exe);
        let dir = exe
            .parent()
            .ok_or_else(|| "Could not locate Cap executable directory".to_string())?;

        for candidate in cli_binary_candidates(dir) {
            if candidate.exists() {
                return Ok(resolve_path_for_target_lookup(candidate));
            }
        }

        Ok(dir.join(CLI_BINARY_NAME))
    }

    #[cfg(windows)]
    fn resolve_path_for_target_lookup(path: PathBuf) -> PathBuf {
        path
    }

    #[cfg(not(windows))]
    fn resolve_path_for_target_lookup(path: PathBuf) -> PathBuf {
        fs::canonicalize(&path).unwrap_or(path)
    }

    fn cli_binary_candidates(dir: &Path) -> Vec<PathBuf> {
        let mut names = vec![CLI_BINARY_NAME.to_string()];
        if let Some(target_triple) = current_target_triple() {
            names.push(target_specific_cli_binary_name(target_triple));
        }

        let dirs = [
            dir.to_path_buf(),
            dir.join("../MacOS"),
            dir.join("../Resources"),
        ];
        let mut candidates = Vec::new();
        for dir in dirs {
            for name in &names {
                candidates.push(dir.join(name));
            }
        }
        candidates
    }

    fn target_specific_cli_binary_name(target_triple: &str) -> String {
        format!(
            "{CLI_BINARY_STEM}-{target_triple}{}",
            exe_suffix_for_target(target_triple)
        )
    }

    fn exe_suffix_for_target(target_triple: &str) -> &'static str {
        if target_triple.contains("windows") {
            ".exe"
        } else {
            ""
        }
    }

    fn current_target_triple() -> Option<&'static str> {
        if cfg!(all(
            target_os = "windows",
            target_arch = "x86_64",
            target_env = "msvc"
        )) {
            Some("x86_64-pc-windows-msvc")
        } else if cfg!(all(
            target_os = "windows",
            target_arch = "aarch64",
            target_env = "msvc"
        )) {
            Some("aarch64-pc-windows-msvc")
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some("aarch64-apple-darwin")
        } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            Some("x86_64-apple-darwin")
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some("x86_64-unknown-linux-gnu")
        } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            Some("aarch64-unknown-linux-gnu")
        } else {
            None
        }
    }

    #[cfg(unix)]
    fn cli_binary_file_name_is_cap_managed(name: &OsStr) -> bool {
        if name == CLI_BINARY_NAME {
            return true;
        }

        let Some(name) = name.to_str() else {
            return false;
        };

        current_target_triple().is_some_and(|target_triple| {
            name.eq_ignore_ascii_case(&target_specific_cli_binary_name(target_triple))
        })
    }

    fn display_path(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn path_is_present(path: &Path) -> bool {
        fs::symlink_metadata(path).is_ok()
    }

    fn path_contains_install_dir(install_dir: &Path) -> bool {
        let Some(path) = env::var_os("PATH") else {
            return false;
        };

        env::split_paths(&path).any(|entry| entry == install_dir)
    }

    #[cfg(unix)]
    fn shim_points_to(shim_path: &Path, target_path: &Path) -> Result<bool, String> {
        match fs::read_link(shim_path) {
            Ok(link) => Ok(link == target_path || same_file(&link, target_path)),
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
                ) =>
            {
                Ok(false)
            }
            Err(err) => Err(format!("Could not read CLI shim: {err}")),
        }
    }

    #[cfg(unix)]
    fn same_file(a: &Path, b: &Path) -> bool {
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }

    #[cfg(windows)]
    fn shim_points_to(shim_path: &Path, target_path: &Path) -> Result<bool, String> {
        let contents = match fs::read(shim_path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(format!("Could not read CLI shim: {err}")),
        };

        let target = windows_command_path(target_path);
        Ok(windows_shim_target(&contents).is_some_and(|shim_target| {
            windows_shim_target_matches(shim_target, &target, |name| env::var(name).ok())
        }))
    }

    #[cfg(unix)]
    fn shim_is_cap_managed(shim_path: &Path) -> bool {
        match fs::read_link(shim_path) {
            Ok(link) => link
                .file_name()
                .is_some_and(cli_binary_file_name_is_cap_managed),
            Err(_) => false,
        }
    }

    #[cfg(windows)]
    fn shim_is_cap_managed(shim_path: &Path) -> bool {
        fs::read(shim_path).is_ok_and(|contents| windows_shim_target(&contents).is_some())
    }

    #[cfg(windows)]
    fn windows_shim_target(contents: &[u8]) -> Option<&[u8]> {
        let contents = contents.strip_prefix(b"\xef\xbb\xbf").unwrap_or(contents);
        let mut lines = contents.split(|byte| *byte == b'\n');
        if !trim_ascii_whitespace(lines.next()?).eq_ignore_ascii_case(b"@echo off") {
            return None;
        }

        let command = trim_ascii_whitespace(lines.next()?);
        if lines.any(|line| !trim_ascii_whitespace(line).is_empty()) {
            return None;
        }

        let target = command.strip_prefix(b"\"")?.strip_suffix(b"\" %*")?;
        if windows_cli_binary_file_name_is_cap_managed(windows_path_file_name(target)) {
            Some(target)
        } else {
            None
        }
    }

    #[cfg(windows)]
    fn windows_path_file_name(path: &[u8]) -> &[u8] {
        path.rsplit(|byte| *byte == b'\\' || *byte == b'/')
            .next()
            .unwrap_or(path)
    }

    #[cfg(windows)]
    fn windows_cli_binary_file_name_is_cap_managed(name: &[u8]) -> bool {
        name.eq_ignore_ascii_case(b"cap-cli.exe")
            || name.eq_ignore_ascii_case(b"cap-cli-x86_64-pc-windows-msvc.exe")
            || name.eq_ignore_ascii_case(b"cap-cli-aarch64-pc-windows-msvc.exe")
    }

    #[cfg(windows)]
    fn windows_command_path(path: &Path) -> String {
        let path = display_path(path);

        if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
            return format!("\\\\{rest}");
        }

        if let Some(rest) = path.strip_prefix("\\\\?\\") {
            return rest.to_string();
        }

        path
    }

    #[cfg(windows)]
    fn windows_shim_target_matches<F>(shim_target: &[u8], target: &str, env_value: F) -> bool
    where
        F: FnMut(&str) -> Option<String>,
    {
        if shim_target.eq_ignore_ascii_case(target.as_bytes()) {
            return true;
        }

        let Ok(shim_target) = std::str::from_utf8(shim_target) else {
            return false;
        };

        windows_expand_env_prefix(shim_target, env_value)
            .is_some_and(|expanded| expanded.eq_ignore_ascii_case(target))
    }

    #[cfg(windows)]
    fn windows_expand_env_prefix<F>(target: &str, mut env_value: F) -> Option<String>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let rest = target.strip_prefix('%')?;
        let (name, suffix) = rest.split_once('%')?;
        if name.is_empty() {
            return None;
        }

        env_value(name).map(|value| format!("{value}{suffix}"))
    }

    #[cfg(windows)]
    fn windows_env_prefixed_path<F>(target: &str, mut env_value: F) -> Option<String>
    where
        F: FnMut(&str) -> Option<String>,
    {
        for name in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            let Some(value) = env_value(name) else {
                continue;
            };
            let Some(suffix) = strip_ascii_prefix(target, &value) else {
                continue;
            };
            if suffix.is_empty() || suffix.starts_with('\\') || suffix.starts_with('/') {
                return Some(format!("%{name}%{suffix}"));
            }
        }

        None
    }

    #[cfg(windows)]
    fn strip_ascii_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
        let head = value.get(..prefix.len())?;
        let tail = value.get(prefix.len()..)?;
        head.eq_ignore_ascii_case(prefix).then_some(tail)
    }

    #[cfg(windows)]
    fn trim_ascii_whitespace(mut value: &[u8]) -> &[u8] {
        while value.first().is_some_and(|byte| byte.is_ascii_whitespace()) {
            value = &value[1..];
        }

        while value.last().is_some_and(|byte| byte.is_ascii_whitespace()) {
            value = &value[..value.len() - 1];
        }

        value
    }

    fn shell_command(install_dir: &Path) -> String {
        let install_dir = display_path(install_dir);

        if cfg!(windows) {
            let install_dir = install_dir.replace('\'', "''");
            format!(
                r#"powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';{install_dir}', 'User')""#
            )
        } else {
            format!(r#"export PATH="{install_dir}:$PATH""#)
        }
    }

    pub(crate) fn status() -> Result<CliInstallStatus, String> {
        let install_dir = install_dir()?;
        let shim_path = shim_path()?;
        let target_path = target_path()?;
        let target_exists = target_path.exists();
        let shim_exists = path_is_present(&shim_path);
        let installed = target_exists && shim_points_to(&shim_path, &target_path)?;
        let conflict = if shim_exists && !installed && !shim_is_cap_managed(&shim_path) {
            Some(format!(
                "{} already exists and is not managed by Cap",
                display_path(&shim_path)
            ))
        } else if !target_exists {
            Some(format!(
                "Bundled CLI binary not found at {}",
                display_path(&target_path)
            ))
        } else {
            None
        };

        let on_path = path_contains_install_dir(&install_dir);

        Ok(CliInstallStatus {
            shim_path: display_path(&shim_path),
            target_path: display_path(&target_path),
            installed,
            on_path,
            conflict,
            path_entry: display_path(&install_dir),
            shell_command: shell_command(&install_dir),
            path_configured: path_persisted(&install_dir, on_path),
        })
    }

    #[cfg(unix)]
    fn write_shim(shim_path: &Path, target_path: &Path) -> Result<(), String> {
        std::os::unix::fs::symlink(target_path, shim_path)
            .map_err(|e| format!("Could not create CLI symlink: {e}"))
    }

    #[cfg(windows)]
    fn write_shim(shim_path: &Path, target_path: &Path) -> Result<(), String> {
        let target = windows_command_path(target_path);
        let target =
            windows_env_prefixed_path(&target, |name| env::var(name).ok()).unwrap_or(target);
        let contents = format!(
            r#"@echo off
"{target}" %*
"#
        );
        fs::write(shim_path, contents).map_err(|e| format!("Could not write CLI shim: {e}"))
    }

    pub(crate) fn install() -> Result<CliInstallStatus, String> {
        let install_dir = install_dir()?;
        let shim_path = shim_path()?;
        let target_path = target_path()?;

        if !target_path.exists() {
            return Err(format!(
                "Bundled CLI binary not found at {}",
                display_path(&target_path)
            ));
        }

        fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Could not create CLI directory: {e}"))?;

        if path_is_present(&shim_path) {
            // Repoint our own shim and any other Cap-managed one; only refuse
            // to clobber a genuinely foreign file.
            if !shim_points_to(&shim_path, &target_path)? && !shim_is_cap_managed(&shim_path) {
                return Err(format!(
                    "{} already exists and is not managed by Cap",
                    display_path(&shim_path)
                ));
            }

            match fs::remove_file(&shim_path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Could not replace CLI shim: {e}")),
            }
        }

        write_shim(&shim_path, &target_path)?;

        let mut status = status()?;
        if !status.on_path && ensure_path_persisted(&install_dir) {
            status.path_configured = true;
        }
        Ok(status)
    }

    #[cfg(unix)]
    fn ensure_path_persisted(install_dir: &Path) -> bool {
        if env::var_os("CAP_NO_MODIFY_PATH").is_some() {
            return false;
        }
        let Some(home) = dirs::home_dir() else {
            return false;
        };
        let needle = display_path(install_dir);
        if profile_mentions_dir(&home, &needle) {
            return true;
        }
        let shell = env::var("SHELL").unwrap_or_default();
        let shell_name = Path::new(&shell)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        append_path_export(&shell_profile(&home, shell_name), &needle)
    }

    #[cfg(windows)]
    fn ensure_path_persisted(install_dir: &Path) -> bool {
        if env::var_os("CAP_NO_MODIFY_PATH").is_some() {
            return false;
        }
        let dir = display_path(install_dir).replace('\'', "''");
        let script = format!(
            "$d = '{dir}'; \
             $u = [Environment]::GetEnvironmentVariable('Path', 'User'); \
             $e = if ($u) {{ $u -split ';' }} else {{ @() }}; \
             if ($e -notcontains $d) {{ \
             $n = if ($u) {{ \"$d;$u\" }} else {{ $d }}; \
             [Environment]::SetEnvironmentVariable('Path', $n, 'User') }}"
        );
        let mut command = powershell_command();
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    fn path_persisted(install_dir: &Path, on_path: bool) -> bool {
        on_path
            || dirs::home_dir()
                .is_some_and(|home| profile_mentions_dir(&home, &display_path(install_dir)))
    }

    #[cfg(windows)]
    fn path_persisted(install_dir: &Path, on_path: bool) -> bool {
        on_path || windows_user_path_contains(install_dir)
    }

    #[cfg(windows)]
    fn windows_user_path_contains(install_dir: &Path) -> bool {
        let mut command = powershell_command();
        let Ok(output) = command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Environment]::GetEnvironmentVariable('Path', 'User')",
            ])
            .output()
        else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        let needle = display_path(install_dir);
        let needle = needle.trim();
        String::from_utf8_lossy(&output.stdout)
            .split(';')
            .any(|entry| entry.trim().eq_ignore_ascii_case(needle))
    }

    #[cfg(windows)]
    fn powershell_command() -> std::process::Command {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let mut command = std::process::Command::new("powershell");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(unix)]
    fn shell_profile(home: &Path, shell_name: &str) -> PathBuf {
        match shell_name {
            "zsh" => home.join(".zshrc"),
            "bash" => home.join(".bashrc"),
            "" if home.join(".zshrc").exists() => home.join(".zshrc"),
            _ => home.join(".profile"),
        }
    }

    #[cfg(unix)]
    fn profile_mentions_dir(home: &Path, needle: &str) -> bool {
        [".zshrc", ".bashrc", ".bash_profile", ".profile"]
            .iter()
            .any(|file| fs::read_to_string(home.join(file)).is_ok_and(|c| c.contains(needle)))
    }

    #[cfg(unix)]
    fn append_path_export(profile: &Path, install_dir: &str) -> bool {
        use std::io::Write;
        let line = format!("export PATH=\"{install_dir}:$PATH\"");
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(profile)
            .and_then(|mut file| writeln!(file, "\n# Added by Cap\n{line}"))
            .is_ok()
    }

    pub(crate) fn uninstall() -> Result<CliInstallStatus, String> {
        let shim_path = shim_path()?;
        let target_path = target_path()?;

        if shim_points_to(&shim_path, &target_path)? {
            fs::remove_file(&shim_path).map_err(|e| format!("Could not remove CLI shim: {e}"))?;
        }

        status()
    }

    #[cfg(all(test, unix))]
    mod tests {
        use super::*;

        #[test]
        fn shell_profile_selection() {
            let home = Path::new("/home/u");
            assert_eq!(shell_profile(home, "zsh"), home.join(".zshrc"));
            assert_eq!(shell_profile(home, "bash"), home.join(".bashrc"));
            assert_eq!(shell_profile(home, "fish"), home.join(".profile"));
        }

        #[test]
        fn cap_managed_shim_detection() {
            let dir =
                std::env::temp_dir().join(format!("cap-gpui-cli-test-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let shim = dir.join(SHIM_NAME);

            // A symlink to a cap-cli binary is Cap-managed even when it points
            // at a different install (the target need not exist).
            std::os::unix::fs::symlink("/elsewhere/Cap.app/Contents/MacOS/cap-cli", &shim).unwrap();
            assert!(shim_is_cap_managed(&shim));

            // A symlink to anything else is not.
            fs::remove_file(&shim).unwrap();
            std::os::unix::fs::symlink("/bin/ls", &shim).unwrap();
            assert!(!shim_is_cap_managed(&shim));

            // Nor is a regular file, so install refuses to clobber it.
            fs::remove_file(&shim).unwrap();
            fs::write(&shim, b"#!/bin/sh\n").unwrap();
            assert!(!shim_is_cap_managed(&shim));

            let _ = fs::remove_dir_all(&dir);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// gpui keystroke names against the `KeyboardEvent.code` strings hotkeys
    /// written by the Tauri app carry.
    #[test]
    fn keystrokes_map_to_w3c_codes() {
        assert_eq!(hotkey_code_for_key("a").as_deref(), Some("KeyA"));
        assert_eq!(hotkey_code_for_key("Z").as_deref(), Some("KeyZ"));
        assert_eq!(hotkey_code_for_key("4").as_deref(), Some("Digit4"));
        assert_eq!(hotkey_code_for_key("f5").as_deref(), Some("F5"));
        assert_eq!(hotkey_code_for_key("f12").as_deref(), Some("F12"));
        assert_eq!(hotkey_code_for_key("space").as_deref(), Some("Space"));
        assert_eq!(hotkey_code_for_key("enter").as_deref(), Some("Enter"));
        assert_eq!(hotkey_code_for_key(",").as_deref(), Some("Comma"));
        assert_eq!(hotkey_code_for_key("up").as_deref(), Some("ArrowUp"));
        // Unbindable keys are consumed but never stored.
        assert_eq!(hotkey_code_for_key("fn"), None);
        assert_eq!(hotkey_code_for_key("escape"), None);
    }

    /// Every code the capture can produce parses as a `global_hotkey` `Code`.
    /// This is the shared-store guarantee: the Tauri `HotkeysStore` fails to
    /// deserialize wholesale on one unknown code, losing every binding, so a
    /// code this page writes must always be one that side can read back.
    #[test]
    fn every_producible_code_parses_for_the_tauri_app() {
        let mut keys: Vec<String> = Vec::new();
        for c in 'a'..='z' {
            keys.push(c.to_string());
        }
        for c in '0'..='9' {
            keys.push(c.to_string());
        }
        for c in [',', '.', '/', ';', '\'', '[', ']', '\\', '-', '=', '`'] {
            keys.push(c.to_string());
        }
        // gpui function keys stop at f19 on Apple keyboards; f20 is the
        // largest either side can see.
        for n in 1..=20 {
            keys.push(format!("f{n}"));
        }
        for named in [
            "space",
            "enter",
            "tab",
            "backspace",
            "delete",
            "up",
            "down",
            "left",
            "right",
            "home",
            "end",
            "pageup",
            "pagedown",
        ] {
            keys.push(named.to_string());
        }

        for key in keys {
            let Some(code) = hotkey_code_for_key(&key) else {
                panic!("{key} should map to a code");
            };
            assert!(
                global_hotkey::hotkey::Code::from_str(&code).is_ok(),
                "{key} produced {code}, which global_hotkey cannot parse"
            );
        }
    }

    #[test]
    fn hotkey_chips_render_in_macos_modifier_order() {
        let hotkey = Hotkey {
            code: "KeyS".into(),
            meta: true,
            ctrl: false,
            alt: true,
            shift: true,
        };
        assert_eq!(
            hotkey_display_keys(&hotkey),
            ["meta", "alt", "shift", "KeyS"]
        );
    }

    /// The switch-back target matches how this binary was started: the `.app`
    /// it is staged inside beats everything, a cargo `target/` path means the
    /// dev harness (never the installed app), and only a bare binary from
    /// neither falls through to `/Applications`.
    #[test]
    fn the_classic_target_matches_the_launch_context() {
        assert_eq!(
            classic_target_for_exe(std::path::Path::new(
                "/Applications/Cap.app/Contents/MacOS/cap-gpui"
            )),
            Some(ClassicTarget::Bundle(std::path::PathBuf::from(
                "/Applications/Cap.app"
            )))
        );
        assert_eq!(
            classic_target_for_exe(std::path::Path::new(
                "/Users/x/Cap/apps/desktop-gpui/target/debug/cap-gpui"
            )),
            Some(ClassicTarget::DevSupervisor)
        );
        // A dev binary staged inside a bundle is still that bundle's.
        assert_eq!(
            classic_target_for_exe(std::path::Path::new(
                "/Users/x/Cap/target/debug/bundle/osx/Cap.app/Contents/MacOS/cap-gpui"
            )),
            Some(ClassicTarget::Bundle(std::path::PathBuf::from(
                "/Users/x/Cap/target/debug/bundle/osx/Cap.app"
            )))
        );
    }

    /// The takeover's whole timeline, read off its one clock.
    #[test]
    fn the_takeover_counts_down_while_the_lines_fade() {
        // The number is up from the first frame and never reaches zero.
        assert_eq!(takeover_frame(0.).2, SWITCH_COUNTDOWN_FROM);
        assert_eq!(takeover_frame(1000.).2, SWITCH_COUNTDOWN_FROM - 1);
        assert_eq!(takeover_frame(SWITCH_TAKEOVER_MS as f32 - 1.).2, 1);
        assert_eq!(takeover_frame(SWITCH_TAKEOVER_MS as f32).2, 1);

        // First line, faded in over its lead, and out again as its slot ends.
        let (index, alpha, _) = takeover_frame(0.);
        assert_eq!(index, 0);
        assert_eq!(alpha, 0.);
        assert_eq!(takeover_frame(SWITCH_FADE_MS).1, 1.);
        assert_eq!(takeover_frame(SWITCH_SENTENCE_MS as f32 - 1.).1.round(), 0.);

        // The last line holds rather than blanking while the number finishes.
        let (index, alpha, _) = takeover_frame(SWITCH_TAKEOVER_MS as f32 - 1.);
        assert_eq!(index, SWITCH_SENTENCES.len() - 1);
        assert_eq!(alpha, 1.);
    }

    /// `conditionAppliesToTrigger` / `actionAppliesToTrigger` against the
    /// tables in `utils/automations.ts`.
    #[test]
    fn applicability_matches_the_web_tables() {
        assert!(condition_applies_to_trigger(
            ConditionType::CaptureTargetIs,
            Trigger::ScreenshotTaken
        ));
        assert!(!condition_applies_to_trigger(
            ConditionType::CaptureTargetIs,
            Trigger::StudioRecordingFinished
        ));
        assert!(condition_applies_to_trigger(
            ConditionType::DurationAtLeast,
            Trigger::StudioRecordingFinished
        ));
        assert!(!condition_applies_to_trigger(
            ConditionType::DurationAtLeast,
            Trigger::InstantRecordingFinished
        ));
        // `organizationIs` maps to `null` and never applies.
        for trigger in ALL_TRIGGERS {
            assert!(!condition_applies_to_trigger(
                ConditionType::OrganizationIs,
                trigger
            ));
        }

        assert!(action_applies_to_trigger(
            ActionType::CopyToClipboard,
            Trigger::ScreenshotTaken
        ));
        assert!(!action_applies_to_trigger(
            ActionType::CopyToClipboard,
            Trigger::StudioRecordingFinished
        ));
        assert!(action_applies_to_trigger(
            ActionType::SkipEditor,
            Trigger::StudioRecordingFinished
        ));
        assert!(!action_applies_to_trigger(
            ActionType::SkipEditor,
            Trigger::UploadCompleted
        ));
        // notify/runCommand/webhook always apply.
        assert!(action_applies_to_trigger(
            ActionType::Notify,
            Trigger::RecordingStarted
        ));
        assert!(action_applies_to_trigger(
            ActionType::Webhook,
            Trigger::RecordingStarted
        ));
        assert!(!action_applies_to_trigger(
            ActionType::Upload,
            Trigger::RecordingStarted
        ));
    }

    /// `ruleSummary` / `autoRuleName` / `ruleDisplayName`.
    #[test]
    fn rule_names_match_the_web_strings() {
        let mut rule = create_empty_rule();
        assert_eq!(rule_summary(&rule), "Screenshot taken → Copy to clipboard");
        assert_eq!(auto_rule_name(&rule), "Screenshot → Clipboard");
        assert_eq!(rule_display_name(&rule), "Screenshot → Clipboard");

        rule.name = "  My rule  ".to_string();
        assert_eq!(rule_display_name(&rule), "My rule");

        rule.actions.clear();
        assert_eq!(rule_summary(&rule), "Screenshot taken → no actions yet");
        assert_eq!(auto_rule_name(&rule), "Screenshot automation");
    }

    #[test]
    fn export_defaults_match_the_web_profile() {
        let Action::Export {
            profile,
            destination,
        } = default_action(ActionType::Export)
        else {
            panic!("not an export action");
        };
        assert_eq!(profile.format, ExportFormat::Mp4);
        assert_eq!(profile.fps, 30);
        assert_eq!(profile.resolution_base.x, 1920);
        assert_eq!(profile.compression, Some(AutomationExportCompression::Web));
        assert_eq!(destination, ExportDestination::ProjectFolder);
        assert_eq!(resolution_value(&profile), "1080p");
    }

    /// `formatBytes` in google-drive-config.tsx.
    #[test]
    fn bytes_format_like_the_web_helper() {
        assert_eq!(format_bytes(None), None);
        assert_eq!(format_bytes(Some("nope")), None);
        assert_eq!(format_bytes(Some("0")).as_deref(), Some("0 B"));
        assert_eq!(format_bytes(Some("512")).as_deref(), Some("512 B"));
        assert_eq!(format_bytes(Some("2048")).as_deref(), Some("2.0 KB"));
        assert_eq!(format_bytes(Some("1073741824")).as_deref(), Some("1.0 GB"));
        assert_eq!(format_bytes(Some("16106127360")).as_deref(), Some("15 GB"));
    }

    #[test]
    fn secs_render_without_a_trailing_zero() {
        assert_eq!(format_secs(5.), "5");
        assert_eq!(format_secs(300.), "300");
        assert_eq!(format_secs(2.5), "2.5");
    }

    #[test]
    fn changelog_dates_render_like_to_locale_date_string() {
        assert_eq!(changelog_date("2026-08-17T10:30:00.000Z"), "8/17/2026");
        // An unparseable date falls back to the raw string.
        assert_eq!(changelog_date("soon"), "soon");
    }

    #[test]
    fn markdown_reduces_to_clean_paragraphs() {
        let paragraphs = markdown_paragraphs(
            "## What's new\n\nWe **shipped** a thing, see [the docs](https://cap.so/docs).\n\n\
             ![screenshot](https://cap.so/img.png)\n\nAnd `another` line.",
        );
        assert_eq!(paragraphs.len(), 3);
        assert!(paragraphs[0].heading);
        assert_eq!(paragraphs[0].text, "What's new");
        assert_eq!(paragraphs[1].text, "We shipped a thing, see the docs.");
        assert_eq!(paragraphs[2].text, "And another line.");
    }

    #[test]
    fn the_eight_templates_build_the_web_rules() {
        assert_eq!(TEMPLATES.len(), 8);
        let ids: Vec<&str> = TEMPLATES.iter().map(|template| template.id).collect();
        assert_eq!(
            ids,
            [
                "copy-screenshot",
                "ocr-screenshot",
                "save-screenshot",
                "reveal-screenshot",
                "export-studio",
                "upload-share",
                "notify-upload",
                "webhook-share"
            ]
        );
        let webhook = (TEMPLATES[7].build)();
        assert_eq!(webhook.trigger, Trigger::InstantRecordingFinished);
        assert!(matches!(
            &webhook.actions[0],
            Action::Webhook { body_template: Some(body), method, .. }
                if body == r#"{"text":"{share_link}"}"# && method == "POST"
        ));
        // Every template rule gets a fresh id and starts enabled.
        let a = (TEMPLATES[0].build)();
        let b = (TEMPLATES[0].build)();
        assert_ne!(a.id, b.id);
        assert!(a.enabled && a.conditions.is_empty());
    }
}
