use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

struct MockHost {
    caps: Vec<Capability>,
    actions_run: Mutex<Vec<String>>,
}

impl MockHost {
    fn new(caps: Vec<Capability>) -> Self {
        Self {
            caps,
            actions_run: Mutex::new(Vec::new()),
        }
    }

    fn actions_run(&self) -> Vec<String> {
        self.actions_run.lock().unwrap().clone()
    }

    fn record(&self, name: &str) {
        self.actions_run.lock().unwrap().push(name.to_string());
    }
}

impl AutomationHost for MockHost {
    fn capabilities(&self) -> &[Capability] {
        &self.caps
    }

    async fn copy_to_clipboard(
        &self,
        _ctx: &TriggerContext,
        source: &ClipboardSource,
    ) -> Result<(), String> {
        self.record(&format!("copy_to_clipboard:{source:?}"));
        Ok(())
    }

    async fn save_to_location(
        &self,
        _ctx: &TriggerContext,
        dir: &str,
        tmpl: Option<&str>,
    ) -> Result<(), String> {
        self.record(&format!("save_to_location:{dir}:{tmpl:?}"));
        Ok(())
    }

    async fn export(
        &self,
        _ctx: &TriggerContext,
        _profile: &ExportProfile,
        _dest: &ExportDestination,
    ) -> Result<(), String> {
        self.record("export");
        Ok(())
    }

    async fn upload(
        &self,
        _ctx: &TriggerContext,
        _org: Option<&str>,
        _copy: bool,
        _open: bool,
    ) -> Result<(), String> {
        self.record("upload");
        Ok(())
    }

    async fn reveal_in_file_manager(&self, _ctx: &TriggerContext) -> Result<(), String> {
        self.record("reveal");
        Ok(())
    }

    async fn open_file(&self, _ctx: &TriggerContext) -> Result<(), String> {
        self.record("open_file");
        Ok(())
    }

    async fn run_command(
        &self,
        _ctx: &TriggerContext,
        prog: &str,
        _args: &[String],
        _cwd: Option<&str>,
        _env: &HashMap<String, String>,
        _shell: bool,
    ) -> Result<(), String> {
        self.record(&format!("run_command:{prog}"));
        Ok(())
    }

    async fn webhook(
        &self,
        _ctx: &TriggerContext,
        url: &str,
        _method: &str,
        _headers: &HashMap<String, String>,
        _body: Option<&str>,
    ) -> Result<(), String> {
        self.record(&format!("webhook:{url}"));
        Ok(())
    }

    async fn recognize_text_to_clipboard(&self, _ctx: &TriggerContext) -> Result<(), String> {
        self.record("ocr");
        Ok(())
    }

    async fn notify(&self, _ctx: &TriggerContext, title: &str, body: &str) -> Result<(), String> {
        self.record(&format!("notify:{title}:{body}"));
        Ok(())
    }

    async fn open_editor(&self, _ctx: &TriggerContext) -> Result<(), String> {
        self.record("open_editor");
        Ok(())
    }

    async fn apply_preset(&self, _ctx: &TriggerContext, name: &str) -> Result<(), String> {
        self.record(&format!("apply_preset:{name}"));
        Ok(())
    }

    async fn delete_local_files(&self, _ctx: &TriggerContext) -> Result<(), String> {
        self.record("delete_local_files");
        Ok(())
    }
}

fn screenshot_copy_rule() -> AutomationRule {
    AutomationRule {
        id: "rule-1".to_string(),
        name: "Auto-copy screenshot".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![],
        actions: vec![
            Action::CopyToClipboard {
                source: ClipboardSource::Raw,
            },
            Action::Notify {
                title_template: "Screenshot".to_string(),
                body_template: "Copied to clipboard".to_string(),
            },
        ],
    }
}

fn studio_export_rule() -> AutomationRule {
    AutomationRule {
        id: "rule-2".to_string(),
        name: "Auto-export studio".to_string(),
        enabled: true,
        trigger: Trigger::StudioRecordingFinished,
        match_mode: MatchMode::All,
        conditions: vec![Condition::DurationAtLeast { secs: 5.0 }],
        actions: vec![Action::Export {
            profile: ExportProfile {
                format: ExportFormat::Mp4,
                fps: 60,
                resolution_base: cap_project::XY { x: 1920, y: 1080 },
                compression: Some(AutomationExportCompression::Web),
                preset_name: None,
            },
            destination: ExportDestination::ProjectFolder,
        }],
    }
}

#[test]
fn evaluate_matches_trigger_and_returns_actions() {
    let store = AutomationsStore {
        version: 1,
        rules: vec![screenshot_copy_rule(), studio_export_rule()],
    };

    let matched = evaluate(&store, &Trigger::ScreenshotTaken, &TriggerContext::new());
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].0, "rule-1");
    assert_eq!(matched[0].1.len(), 2);
}

#[test]
fn evaluate_skips_disabled_rules() {
    let mut rule = screenshot_copy_rule();
    rule.enabled = false;
    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    let matched = evaluate(&store, &Trigger::ScreenshotTaken, &TriggerContext::new());
    assert!(matched.is_empty());
}

#[test]
fn evaluate_skips_wrong_trigger() {
    let store = AutomationsStore {
        version: 1,
        rules: vec![screenshot_copy_rule()],
    };

    let matched = evaluate(
        &store,
        &Trigger::StudioRecordingFinished,
        &TriggerContext::new(),
    );
    assert!(matched.is_empty());
}

#[test]
fn condition_duration_at_least() {
    let store = AutomationsStore {
        version: 1,
        rules: vec![studio_export_rule()],
    };

    let short_ctx = TriggerContext::new().with_duration(3.0);
    let long_ctx = TriggerContext::new().with_duration(10.0);

    let matched_short = evaluate(&store, &Trigger::StudioRecordingFinished, &short_ctx);
    assert!(matched_short.is_empty());

    let matched_long = evaluate(&store, &Trigger::StudioRecordingFinished, &long_ctx);
    assert_eq!(matched_long.len(), 1);
}

#[test]
fn condition_capture_target() {
    let rule = AutomationRule {
        id: "rule-target".to_string(),
        name: "Window only".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![Condition::CaptureTargetIs {
            target: CaptureTargetKind::Window,
        }],
        actions: vec![Action::CopyToClipboard {
            source: ClipboardSource::Raw,
        }],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    let display_ctx = TriggerContext::new().with_capture_target(CaptureTargetKind::Display);
    let window_ctx = TriggerContext::new().with_capture_target(CaptureTargetKind::Window);

    assert!(evaluate(&store, &Trigger::ScreenshotTaken, &display_ctx).is_empty());
    assert_eq!(
        evaluate(&store, &Trigger::ScreenshotTaken, &window_ctx).len(),
        1
    );
}

#[test]
fn condition_window_title_contains() {
    let rule = AutomationRule {
        id: "rule-title".to_string(),
        name: "Slack screenshots".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![Condition::WindowTitleContains {
            pattern: "slack".to_string(),
        }],
        actions: vec![Action::CopyToClipboard {
            source: ClipboardSource::Raw,
        }],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    let no_title = TriggerContext::new();
    let slack_ctx = TriggerContext::new().with_window_title("Slack - #general".to_string());
    let vscode_ctx = TriggerContext::new().with_window_title("VS Code".to_string());

    assert!(evaluate(&store, &Trigger::ScreenshotTaken, &no_title).is_empty());
    assert_eq!(
        evaluate(&store, &Trigger::ScreenshotTaken, &slack_ctx).len(),
        1
    );
    assert!(evaluate(&store, &Trigger::ScreenshotTaken, &vscode_ctx).is_empty());
}

#[test]
fn match_mode_any_matches_on_first_true() {
    let rule = AutomationRule {
        id: "rule-any".to_string(),
        name: "Display or window".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::Any,
        conditions: vec![
            Condition::CaptureTargetIs {
                target: CaptureTargetKind::Display,
            },
            Condition::CaptureTargetIs {
                target: CaptureTargetKind::Window,
            },
        ],
        actions: vec![Action::CopyToClipboard {
            source: ClipboardSource::Raw,
        }],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    let area_ctx = TriggerContext::new().with_capture_target(CaptureTargetKind::Area);
    let display_ctx = TriggerContext::new().with_capture_target(CaptureTargetKind::Display);

    assert!(evaluate(&store, &Trigger::ScreenshotTaken, &area_ctx).is_empty());
    assert_eq!(
        evaluate(&store, &Trigger::ScreenshotTaken, &display_ctx).len(),
        1
    );
}

#[test]
fn has_skip_editor_detects_skip_action() {
    let rule = AutomationRule {
        id: "headless".to_string(),
        name: "Headless screenshot".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![],
        actions: vec![
            Action::CopyToClipboard {
                source: ClipboardSource::Raw,
            },
            Action::SkipEditor,
        ],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    assert!(has_skip_editor(
        &store,
        &Trigger::ScreenshotTaken,
        &TriggerContext::new()
    ));
    assert!(!has_skip_editor(
        &store,
        &Trigger::StudioRecordingFinished,
        &TriggerContext::new()
    ));
}

#[tokio::test]
async fn run_executes_actions_in_order() {
    let host = MockHost::new(vec![Capability::CopyToClipboard, Capability::Notify]);

    let store = AutomationsStore {
        version: 1,
        rules: vec![screenshot_copy_rule()],
    };

    let results = run(
        &host,
        &store,
        &Trigger::ScreenshotTaken,
        &TriggerContext::new(),
    )
    .await;

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].action_results.len(), 2);
    assert!(results[0].action_results.iter().all(|r| r.success));

    let actions = host.actions_run();
    assert_eq!(actions[0], "copy_to_clipboard:Raw");
    assert_eq!(actions[1], "notify:Screenshot:Copied to clipboard");
}

#[tokio::test]
async fn run_skips_unsupported_capabilities() {
    let host = MockHost::new(vec![Capability::CopyToClipboard]);

    let store = AutomationsStore {
        version: 1,
        rules: vec![screenshot_copy_rule()],
    };

    let results = run(
        &host,
        &store,
        &Trigger::ScreenshotTaken,
        &TriggerContext::new(),
    )
    .await;

    assert_eq!(results[0].action_results.len(), 2);
    assert!(results[0].action_results[0].success);
    assert!(!results[0].action_results[1].success);

    let actions = host.actions_run();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0], "copy_to_clipboard:Raw");
}

#[tokio::test]
async fn skip_editor_action_is_noop_and_never_opens_editor() {
    let rule = AutomationRule {
        id: "headless".to_string(),
        name: "Headless screenshot".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![],
        actions: vec![
            Action::CopyToClipboard {
                source: ClipboardSource::Raw,
            },
            Action::SkipEditor,
        ],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    let host = MockHost::new(vec![Capability::CopyToClipboard, Capability::OpenEditor]);
    let results = run(
        &host,
        &store,
        &Trigger::ScreenshotTaken,
        &TriggerContext::new(),
    )
    .await;

    assert!(results[0].action_results.iter().all(|r| r.success));
    let actions = host.actions_run();
    assert_eq!(actions, vec!["copy_to_clipboard:Raw".to_string()]);
    assert!(!actions.iter().any(|a| a == "open_editor"));
}

#[test]
fn serialize_roundtrip() {
    let store = AutomationsStore {
        version: 1,
        rules: vec![screenshot_copy_rule(), studio_export_rule()],
    };

    let json = serde_json::to_string_pretty(&store).unwrap();
    let parsed: AutomationsStore = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.rules.len(), 2);
    assert_eq!(parsed.version, 1);
}

#[test]
fn serialize_all_condition_and_action_shapes_roundtrip() {
    use std::collections::HashMap;

    let rule = AutomationRule {
        id: "everything".to_string(),
        name: "All shapes".to_string(),
        enabled: true,
        trigger: Trigger::StudioRecordingFinished,
        match_mode: MatchMode::Any,
        conditions: vec![
            Condition::CaptureTargetIs {
                target: CaptureTargetKind::Window,
            },
            Condition::RecordingModeIs {
                mode: AutomationRecordingMode::Studio,
            },
            Condition::DurationAtLeast { secs: 5.0 },
            Condition::DurationAtMost { secs: 600.0 },
            Condition::WindowTitleContains {
                pattern: "slack".to_string(),
            },
            Condition::OrganizationIs {
                id: "org_1".to_string(),
            },
        ],
        actions: vec![
            Action::CopyToClipboard {
                source: ClipboardSource::Rendered,
            },
            Action::SaveToLocation {
                dir: "/tmp/cap".to_string(),
                filename_template: Some("{date}-{window}".to_string()),
            },
            Action::Export {
                profile: ExportProfile {
                    format: ExportFormat::Mp4,
                    fps: 60,
                    resolution_base: cap_project::XY { x: 1920, y: 1080 },
                    compression: Some(AutomationExportCompression::Web),
                    preset_name: Some("My Preset".to_string()),
                },
                destination: ExportDestination::CustomPath {
                    dir: "/tmp/out".to_string(),
                },
            },
            Action::Upload {
                organization_id: Some("org_1".to_string()),
                copy_link: true,
                open_in_browser: false,
            },
            Action::RevealInFileManager,
            Action::OpenFile,
            Action::RunCommand {
                program: "echo".to_string(),
                args: vec!["hi".to_string()],
                cwd: None,
                env: HashMap::new(),
                use_shell: false,
            },
            Action::Webhook {
                url: "https://example.com/hook".to_string(),
                method: "POST".to_string(),
                headers: HashMap::new(),
                body_template: Some("{share_link}".to_string()),
            },
            Action::RecognizeTextToClipboard,
            Action::Notify {
                title_template: "Done".to_string(),
                body_template: "Recording finished".to_string(),
            },
            Action::OpenEditor,
            Action::SkipEditor,
            Action::ApplyPreset {
                name: "My Preset".to_string(),
            },
            Action::DeleteLocalFiles,
        ],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    let json = serde_json::to_value(&store).unwrap();
    let conditions = &json["rules"][0]["conditions"];
    assert_eq!(conditions[0]["type"], "captureTargetIs");
    assert_eq!(conditions[0]["target"], "window");
    assert_eq!(conditions[1]["type"], "recordingModeIs");
    assert_eq!(conditions[1]["mode"], "studio");

    let actions = &json["rules"][0]["actions"];
    assert_eq!(actions[0]["type"], "copyToClipboard");
    assert_eq!(actions[0]["source"], "rendered");
    assert_eq!(actions[4]["type"], "revealInFileManager");

    // Struct-variant fields must serialize camelCase to match the desktop+CLI frontends; serde's
    // enum-level rename_all does not cover variant fields, so each multi-word variant carries its own.
    assert_eq!(actions[1]["type"], "saveToLocation");
    assert!(actions[1].get("filenameTemplate").is_some());
    assert!(actions[1].get("filename_template").is_none());
    assert!(actions[3].get("organizationId").is_some());
    assert!(actions[3].get("copyLink").is_some());
    assert!(actions[3].get("openInBrowser").is_some());
    assert!(actions[6].get("useShell").is_some());
    assert!(actions[7].get("bodyTemplate").is_some());
    assert!(actions[9].get("titleTemplate").is_some());

    let parsed: AutomationsStore = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.rules.len(), 1);
    assert_eq!(parsed.rules[0].conditions.len(), 6);
    assert_eq!(parsed.rules[0].actions.len(), 14);
}

#[test]
fn load_store_from_json_extracts_automations_key() {
    let store = AutomationsStore {
        version: 1,
        rules: vec![screenshot_copy_rule()],
    };

    let wrapper = serde_json::json!({
        "general_settings": {},
        "automations": store,
    });

    let loaded = load_store_from_json(&wrapper).unwrap();
    assert_eq!(loaded.rules.len(), 1);
    assert_eq!(loaded.rules[0].id, "rule-1");
}

#[test]
fn load_store_from_json_returns_none_on_missing_key() {
    let wrapper = serde_json::json!({
        "general_settings": {},
    });
    assert!(load_store_from_json(&wrapper).is_none());
}

fn desktop_capabilities() -> Vec<Capability> {
    vec![
        Capability::CopyToClipboard,
        Capability::SaveToLocation,
        Capability::Export,
        Capability::Upload,
        Capability::RevealInFileManager,
        Capability::OpenFile,
        Capability::RunCommand,
        Capability::Webhook,
        Capability::RecognizeText,
        Capability::Notify,
        Capability::OpenEditor,
        Capability::ApplyPreset,
        Capability::DeleteLocalFiles,
    ]
}

fn cli_capabilities() -> Vec<Capability> {
    vec![
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

// Both surfaces share the same engine + store, so they must match the same rules and run the same
// actions in the same order — the only difference being that surface-specific actions (clipboard on the
// CLI) are skipped, never silently reordered or dropped.
#[tokio::test]
async fn desktop_and_cli_parity_on_screenshot_rule() {
    let rule = AutomationRule {
        id: "parity".to_string(),
        name: "Auto-handle screenshot".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![Condition::CaptureTargetIs {
            target: CaptureTargetKind::Window,
        }],
        actions: vec![
            Action::SaveToLocation {
                dir: "/tmp/shots".to_string(),
                filename_template: None,
            },
            Action::CopyToClipboard {
                source: ClipboardSource::Raw,
            },
            Action::RunCommand {
                program: "true".to_string(),
                args: vec![],
                cwd: None,
                env: HashMap::new(),
                use_shell: false,
            },
        ],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };
    let ctx = TriggerContext::new().with_capture_target(CaptureTargetKind::Window);

    // Both surfaces evaluate to the same matched rule + ordered actions (engine is host-independent).
    let matched = evaluate(&store, &Trigger::ScreenshotTaken, &ctx);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].1.len(), 3);

    let desktop = MockHost::new(desktop_capabilities());
    let desktop_results = run(&desktop, &store, &Trigger::ScreenshotTaken, &ctx).await;
    assert!(desktop_results[0].action_results.iter().all(|r| r.success));
    assert_eq!(
        desktop.actions_run(),
        vec![
            "save_to_location:/tmp/shots:None".to_string(),
            "copy_to_clipboard:Raw".to_string(),
            "run_command:true".to_string(),
        ]
    );

    let cli = MockHost::new(cli_capabilities());
    let cli_results = run(&cli, &store, &Trigger::ScreenshotTaken, &ctx).await;
    // Same three action slots reported, in order; the clipboard one is marked unsupported, not dropped.
    assert_eq!(cli_results[0].action_results.len(), 3);
    assert!(cli_results[0].action_results[0].success);
    assert!(!cli_results[0].action_results[1].success);
    assert!(cli_results[0].action_results[2].success);
    assert_eq!(
        cli.actions_run(),
        vec![
            "save_to_location:/tmp/shots:None".to_string(),
            "run_command:true".to_string(),
        ]
    );
}

#[tokio::test]
async fn skip_editor_runs_without_open_editor_capability() {
    let rule = AutomationRule {
        id: "cli-skip".to_string(),
        name: "Headless".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![],
        actions: vec![Action::SkipEditor],
    };
    let store = AutomationsStore {
        version: 1,
        rules: vec![rule],
    };

    // Host without `OpenEditor` capability, mirroring the CLI. `SkipEditor` must still succeed as a
    // no-op rather than being reported unsupported.
    let host = MockHost::new(vec![Capability::SaveToLocation]);
    let results = run(
        &host,
        &store,
        &Trigger::ScreenshotTaken,
        &TriggerContext::new(),
    )
    .await;

    assert_eq!(results[0].action_results.len(), 1);
    assert!(results[0].action_results[0].success);
    assert!(results[0].action_results[0].error.is_none());
    assert!(host.actions_run().is_empty());
}

#[test]
fn shell_command_line_quotes_args_with_spaces() {
    let line = shell_command_line("echo", &["hello world".to_string(), "plain".to_string()]);
    #[cfg(not(target_os = "windows"))]
    assert_eq!(line, "echo 'hello world' plain");
    #[cfg(target_os = "windows")]
    assert_eq!(line, "echo \"hello world\" plain");
}

#[test]
fn shell_command_line_escapes_embedded_quotes() {
    #[cfg(not(target_os = "windows"))]
    {
        let line = shell_command_line("printf", &["it's".to_string()]);
        assert_eq!(line, "printf 'it'\\''s'");
        assert_eq!(shell_command_line("x", &[String::new()]), "x ''");
    }
    #[cfg(target_os = "windows")]
    {
        let line = shell_command_line("echo", &["a\"b".to_string()]);
        assert_eq!(line, "echo \"a\"\"b\"");
    }
}

#[test]
fn sanitize_filename_component_neutralizes_traversal_and_reserved_chars() {
    assert_eq!(
        sanitize_filename_component("../../etc/passwd"),
        ".._.._etc_passwd"
    );
    assert_eq!(sanitize_filename_component("C:\\Users\\me"), "C__Users_me");
    assert_eq!(
        sanitize_filename_component("Slack | #general"),
        "Slack _ #general"
    );
    assert_eq!(sanitize_filename_component("plain title"), "plain title");
    assert_eq!(sanitize_filename_component("{image_path}"), "_image_path_");
    assert_eq!(sanitize_filename_component("report.  "), "report");
    assert_eq!(
        sanitize_filename_component("trailing dots..."),
        "trailing dots"
    );
    assert_eq!(
        sanitize_filename_component(&"a".repeat(200))
            .chars()
            .count(),
        128
    );
    assert_eq!(sanitize_filename_component("..."), "_");
    assert_eq!(sanitize_filename_component("   "), "_");
    assert_eq!(sanitize_filename_component(""), "_");
}

#[test]
fn multiple_rules_same_trigger() {
    let rule1 = AutomationRule {
        id: "a".to_string(),
        name: "Rule A".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![],
        actions: vec![Action::CopyToClipboard {
            source: ClipboardSource::Raw,
        }],
    };
    let rule2 = AutomationRule {
        id: "b".to_string(),
        name: "Rule B".to_string(),
        enabled: true,
        trigger: Trigger::ScreenshotTaken,
        match_mode: MatchMode::All,
        conditions: vec![],
        actions: vec![Action::RevealInFileManager],
    };

    let store = AutomationsStore {
        version: 1,
        rules: vec![rule1, rule2],
    };

    let matched = evaluate(&store, &Trigger::ScreenshotTaken, &TriggerContext::new());
    assert_eq!(matched.len(), 2);
}
