use super::*;
use crate::i18n::tr;
use cap_automation::{AutomationRule, MatchMode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn rule(id: &str, trigger: Trigger, enabled: bool, actions: Vec<Action>) -> AutomationRule {
    AutomationRule {
        id: id.to_string(),
        name: id.to_string(),
        enabled,
        trigger,
        match_mode: MatchMode::All,
        conditions: Vec::new(),
        actions,
    }
}

fn store(rules: Vec<AutomationRule>) -> AutomationsStore {
    AutomationsStore { version: 1, rules }
}

fn export_action() -> Action {
    Action::Export {
        profile: ExportProfile {
            format: ExportFormat::Mp4,
            fps: 30,
            resolution_base: cap_project::XY { x: 1920, y: 1080 },
            compression: Some(AutomationExportCompression::Web),
            preset_name: None,
        },
        destination: ExportDestination::ProjectFolder,
    }
}

fn save_action(dir: &Path) -> Action {
    Action::SaveToLocation {
        dir: dir.to_string_lossy().to_string(),
        filename_template: None,
    }
}

const PLAYABLE_MP4: &[u8] =
    include_bytes!("../../../media-server/src/__tests__/fixtures/test-no-audio.mp4");

fn succeeded(action: &Action) -> Option<PrecedingAction<'_>> {
    Some(PrecedingAction {
        action,
        succeeded: true,
    })
}

#[test]
fn rules_saved_by_the_settings_page_keep_their_enabled_state() {
    let dir = tempfile::tempdir().unwrap();
    let store_path = dir.path().join("store");
    std::fs::write(&store_path, "{}").unwrap();
    crate::store::set_test_tauri_store_path(Some(store_path));
    let saved: crate::store::AutomationsStore = serde_json::from_value(serde_json::json!({
        "version": 1,
        "rules": [
            { "id": "off", "name": "Off", "enabled": false, "trigger": "studioRecordingFinished",
              "actions": [{ "type": "deleteLocalFiles" }] },
            { "id": "on", "name": "On", "trigger": "screenshotTaken",
              "actions": [{ "type": "copyToClipboard", "source": "raw" }] }
        ]
    }))
    .unwrap();
    assert!(crate::store::set_automations(&saved));

    let parsed = parse_store(crate::store::automations_value().unwrap()).unwrap();
    crate::store::set_test_tauri_store_path(None);

    assert_eq!(parsed.rules.len(), 2);
    assert!(!parsed.rules[0].enabled);
    assert!(parsed.rules[1].enabled);
    assert!(!has_enabled_rule(&parsed, Trigger::StudioRecordingFinished));
    assert!(has_enabled_rule(&parsed, Trigger::ScreenshotTaken));
    assert!(
        cap_automation::evaluate(
            &parsed,
            &Trigger::StudioRecordingFinished,
            &TriggerContext::new()
        )
        .is_empty()
    );
}

/// The store as the 0.6.0 app wrote it (`automations` in the Tauri store):
/// the compress-then-delete rule a user reported, a disabled rule, and every
/// field spelled the way that app's settings page saved it.
#[test]
fn rules_saved_by_the_previous_app_still_run() {
    let saved = serde_json::json!({
        "version": 1,
        "rules": [
            {
                "id": "6f0c5f0e-1d6b-4d0e-9a39-0d6f5d1f2a10",
                "name": "Compress and clean up",
                "enabled": true,
                "trigger": "studioRecordingFinished",
                "matchMode": "all",
                "conditions": [{ "type": "durationAtLeast", "secs": 2 }],
                "actions": [
                    {
                        "type": "export",
                        "profile": {
                            "format": "mp4",
                            "fps": 30,
                            "resolutionBase": { "x": 1280, "y": 720 },
                            "compression": "potato",
                            "presetName": null
                        },
                        "destination": { "customPath": { "dir": "/Users/someone/Compressed" } }
                    },
                    { "type": "deleteLocalFiles" }
                ]
            },
            {
                "id": "b8e1",
                "name": "",
                "enabled": false,
                "trigger": "screenshotTaken",
                "matchMode": "any",
                "conditions": [
                    { "type": "captureTargetIs", "target": "window" },
                    { "type": "windowTitleContains", "pattern": "Figma" }
                ],
                "actions": [
                    { "type": "saveToLocation", "dir": "/Users/someone/Shots", "filenameTemplate": "{date}-{window}" },
                    { "type": "upload", "organizationId": null, "copyLink": true, "openInBrowser": false },
                    { "type": "webhook", "url": "https://example.com/hook", "method": "POST", "headers": {}, "bodyTemplate": null },
                    { "type": "runCommand", "program": "echo", "args": ["hi"], "cwd": null, "env": {}, "useShell": false },
                    { "type": "notify", "titleTemplate": "Cap", "bodyTemplate": "" },
                    { "type": "copyToClipboard", "source": "rendered" },
                    { "type": "applyPreset", "name": "Square" },
                    { "type": "revealInFileManager" }, { "type": "openFile" }, { "type": "openEditor" },
                    { "type": "skipEditor" }, { "type": "recognizeTextToClipboard" }
                ]
            }
        ]
    });
    let parsed = parse_store(saved).unwrap();
    assert!(has_enabled_rule(&parsed, Trigger::StudioRecordingFinished));
    assert!(!has_enabled_rule(&parsed, Trigger::ScreenshotTaken));
    assert!(rules_use_duration(
        &parsed,
        Trigger::StudioRecordingFinished
    ));

    let ctx = TriggerContext::new()
        .with_project_path(PathBuf::from("/r/a.cap"))
        .with_recording_mode(AutomationRecordingMode::Studio)
        .with_duration(5.0);
    let matched = cap_automation::evaluate(&parsed, &Trigger::StudioRecordingFinished, &ctx);
    assert_eq!(matched.len(), 1);
    let actions = &matched[0].1;
    match &actions[0] {
        Action::Export {
            profile,
            destination,
        } => {
            assert_eq!(profile.resolution_base.x, 1280);
            assert_eq!(
                profile.compression,
                Some(AutomationExportCompression::Potato)
            );
            assert_eq!(
                destination,
                &ExportDestination::CustomPath {
                    dir: "/Users/someone/Compressed".into()
                }
            );
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(actions[1], Action::DeleteLocalFiles));
    assert!(
        cap_automation::evaluate(
            &parsed,
            &Trigger::StudioRecordingFinished,
            &TriggerContext::new().with_duration(1.0)
        )
        .is_empty()
    );
    assert_eq!(parsed.rules[1].actions.len(), 12);

    assert!(parse_store(serde_json::json!({ "rules": "not a list" })).is_none());
}

#[test]
fn no_rules_means_nothing_listens() {
    let empty = AutomationsStore::default();
    for trigger in [
        Trigger::ScreenshotTaken,
        Trigger::StudioRecordingFinished,
        Trigger::InstantRecordingFinished,
        Trigger::RecordingStarted,
        Trigger::UploadCompleted,
        Trigger::VideoImported,
        Trigger::RecordingDeleted,
    ] {
        assert!(!has_enabled_rule(&empty, trigger));
    }
    let other = store(vec![rule(
        "a",
        Trigger::ScreenshotTaken,
        true,
        vec![Action::OpenFile],
    )]);
    assert!(!has_enabled_rule(&other, Trigger::StudioRecordingFinished));
}

#[test]
fn an_event_is_held_only_while_its_rules_run() {
    let events: &'static RunningEvents = Box::leak(Box::new(RunningEvents::new()));
    let shot = event_key(Path::new("/shots/a.cap/original.png"));

    let first = events
        .claim(Trigger::ScreenshotTaken, shot.clone())
        .unwrap();
    assert!(
        events
            .claim(Trigger::ScreenshotTaken, shot.clone())
            .is_none()
    );
    let other_trigger = events
        .claim(Trigger::UploadCompleted, shot.clone())
        .unwrap();
    let other_path = events
        .claim(Trigger::ScreenshotTaken, "/shots/b.cap/original.png".into())
        .unwrap();

    drop(first);
    let reused_path = events.claim(Trigger::ScreenshotTaken, shot.clone());
    assert!(reused_path.is_some());
    drop((reused_path, other_trigger, other_path));
    assert!(events.lock().is_empty());
}

#[test]
fn skip_editor_and_open_editor_rules_override_the_setting() {
    use crate::store::PostStudioBehaviour;
    let project = Path::new("/recordings/a.cap");
    let skip = store(vec![rule(
        "skip",
        Trigger::StudioRecordingFinished,
        true,
        vec![Action::SkipEditor],
    )]);
    assert_eq!(
        studio_editor_behaviour_for(
            &skip,
            project,
            Duration::from_secs(4),
            PostStudioBehaviour::OpenEditor
        ),
        PostStudioBehaviour::DoNothing
    );

    let open = store(vec![rule(
        "open",
        Trigger::StudioRecordingFinished,
        true,
        vec![Action::OpenEditor],
    )]);
    assert_eq!(
        studio_editor_behaviour_for(
            &open,
            project,
            Duration::from_secs(4),
            PostStudioBehaviour::ShowOverlay
        ),
        PostStudioBehaviour::OpenEditor
    );

    let mut disabled = skip.clone();
    disabled.rules[0].enabled = false;
    assert_eq!(
        studio_editor_behaviour_for(
            &disabled,
            project,
            Duration::from_secs(4),
            PostStudioBehaviour::OpenEditor
        ),
        PostStudioBehaviour::OpenEditor
    );

    let mut long_only = skip;
    long_only.rules[0].conditions = vec![Condition::DurationAtLeast { secs: 60.0 }];
    assert_eq!(
        studio_editor_behaviour_for(
            &long_only,
            project,
            Duration::from_secs(4),
            PostStudioBehaviour::OpenEditor
        ),
        PostStudioBehaviour::OpenEditor
    );
    assert_eq!(
        studio_editor_behaviour_for(
            &long_only,
            project,
            Duration::from_secs(90),
            PostStudioBehaviour::OpenEditor
        ),
        PostStudioBehaviour::DoNothing
    );
}

#[test]
fn rules_choose_the_screenshot_editor_and_skip_wins() {
    let ctx = TriggerContext::new().with_capture_target(CaptureTargetKind::Window);
    let open = rule(
        "open",
        Trigger::ScreenshotTaken,
        true,
        vec![Action::OpenEditor],
    );
    let skip = rule(
        "skip",
        Trigger::ScreenshotTaken,
        true,
        vec![Action::SkipEditor],
    );
    let mut disabled_skip = skip.clone();
    disabled_skip.enabled = false;

    assert_eq!(
        editor_choice(&store(vec![]), Trigger::ScreenshotTaken, &ctx),
        None
    );
    assert_eq!(
        editor_choice(&store(vec![open.clone()]), Trigger::ScreenshotTaken, &ctx),
        Some(true)
    );
    assert_eq!(
        editor_choice(
            &store(vec![open.clone(), skip]),
            Trigger::ScreenshotTaken,
            &ctx
        ),
        Some(false)
    );
    assert_eq!(
        editor_choice(
            &store(vec![open.clone(), disabled_skip]),
            Trigger::ScreenshotTaken,
            &ctx
        ),
        Some(true)
    );
    let studio = |actions: Vec<Action>| {
        editor_choice(
            &store(vec![rule(
                "r",
                Trigger::StudioRecordingFinished,
                true,
                actions,
            )]),
            Trigger::StudioRecordingFinished,
            &TriggerContext::new(),
        )
    };
    let compress = Action::Export {
        profile: ExportProfile {
            format: ExportFormat::Mp4,
            fps: 30,
            resolution_base: cap_project::XY { x: 1280, y: 720 },
            compression: Some(AutomationExportCompression::Potato),
            preset_name: None,
        },
        destination: ExportDestination::CustomPath {
            dir: "/exports".into(),
        },
    };
    assert_eq!(
        studio(vec![compress, Action::DeleteLocalFiles]),
        Some(false)
    );
    assert_eq!(
        studio(vec![
            save_action(Path::new("/shots")),
            Action::DeleteLocalFiles
        ]),
        Some(false)
    );
    assert_eq!(studio(vec![Action::DeleteLocalFiles]), None);
    assert_eq!(
        studio(vec![export_action(), Action::DeleteLocalFiles]),
        None
    );
    assert_eq!(
        studio(vec![Action::DeleteLocalFiles, Action::OpenEditor]),
        Some(true)
    );
}

#[tokio::test]
async fn waiting_on_an_event_returns_once_its_rules_finish() {
    let events: &'static RunningEvents = Box::leak(Box::new(RunningEvents::new()));
    let project = event_key(Path::new("/recordings/a.cap"));
    let wait = |trigger, key: String| {
        tokio::time::timeout(Duration::from_millis(50), async move {
            events.finished(trigger, &key).await
        })
    };

    assert!(
        wait(Trigger::StudioRecordingFinished, project.clone())
            .await
            .is_ok()
    );
    let running = events
        .claim(Trigger::StudioRecordingFinished, project.clone())
        .unwrap();
    assert!(
        wait(Trigger::StudioRecordingFinished, project.clone())
            .await
            .is_err()
    );
    assert!(
        wait(Trigger::UploadCompleted, project.clone())
            .await
            .is_ok()
    );
    assert!(
        wait(
            Trigger::StudioRecordingFinished,
            event_key(Path::new("/recordings/b.cap"))
        )
        .await
        .is_ok()
    );

    let waiter = tokio::spawn(wait(Trigger::StudioRecordingFinished, project.clone()));
    tokio::task::yield_now().await;
    drop(running);
    assert!(waiter.await.unwrap().is_ok());
}

#[test]
fn only_a_screenshot_rule_that_can_delete_drops_the_overlay_card() {
    let ctx = TriggerContext::new().with_capture_target(CaptureTargetKind::Window);
    let deletes =
        |rules: Vec<AutomationRule>| rules_delete(&store(rules), Trigger::ScreenshotTaken, &ctx);
    let shot = |id: &str, enabled: bool, actions: Vec<Action>| {
        rule(id, Trigger::ScreenshotTaken, enabled, actions)
    };
    let save_then_delete = vec![save_action(Path::new("/shots")), Action::DeleteLocalFiles];

    assert!(!deletes(vec![]));
    assert!(deletes(vec![shot("save", true, save_then_delete.clone())]));
    assert!(!deletes(vec![shot("off", false, save_then_delete.clone())]));
    assert!(!deletes(vec![shot(
        "lone",
        true,
        vec![Action::DeleteLocalFiles]
    )]));
    assert!(!deletes(vec![shot("open", true, vec![Action::OpenEditor])]));
    assert!(!deletes(vec![rule(
        "studio",
        Trigger::StudioRecordingFinished,
        true,
        save_then_delete,
    )]));
}

#[tokio::test]
async fn open_editor_leaves_an_editor_choice_already_made_alone() {
    for trigger in [Trigger::StudioRecordingFinished, Trigger::ScreenshotTaken] {
        let host = GpuiAutomationHost::for_trigger(trigger);
        assert_eq!(
            host.open_editor(&TriggerContext::new().with_project_path("/r/a.cap".into()))
                .await,
            Ok(())
        );
    }
    let gone = tempfile::tempdir().unwrap().path().join("deleted.cap");
    let host = GpuiAutomationHost::for_trigger(Trigger::RecordingDeleted);
    assert_eq!(
        host.open_editor(&TriggerContext::new().with_project_path(gone))
            .await,
        Err("The recording no longer exists".to_string())
    );
}

#[test]
fn delete_is_refused_without_a_successful_verified_action_before_it() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("rec.cap");
    std::fs::create_dir(&project).unwrap();
    let outside = root.path().join("rec.mp4");
    std::fs::write(&outside, PLAYABLE_MP4).unwrap();
    let export = export_action();

    assert!(verify_before_delete(&project, None, Some(&outside), None, None).is_err());

    let notify = Action::Notify {
        title_template: "t".into(),
        body_template: "b".into(),
    };
    let error =
        verify_before_delete(&project, succeeded(&notify), Some(&outside), None, None).unwrap_err();
    assert!(error.contains("notify"), "{error}");

    let failed = Some(PrecedingAction {
        action: &export,
        succeeded: false,
    });
    let error = verify_before_delete(&project, failed, Some(&outside), None, None).unwrap_err();
    assert!(error.contains("did not succeed"), "{error}");

    assert!(verify_before_delete(&project, succeeded(&export), None, None, None).is_err());

    assert_eq!(
        verify_before_delete(&project, succeeded(&export), Some(&outside), None, None),
        Ok(())
    );
    let save = save_action(root.path());
    let written = file_fingerprint(&outside).unwrap();
    assert_eq!(
        verify_before_delete(
            &project,
            succeeded(&save),
            Some(&outside),
            Some(&outside),
            Some(&written)
        ),
        Ok(())
    );
}

#[test]
fn delete_is_refused_when_the_export_is_not_playable_or_the_copy_is_short() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("rec.cap");
    std::fs::create_dir(&project).unwrap();
    let export = export_action();

    let truncated = root.path().join("truncated.mp4");
    std::fs::write(&truncated, &PLAYABLE_MP4[..PLAYABLE_MP4.len() / 3]).unwrap();
    let error = verify_before_delete(&project, succeeded(&export), Some(&truncated), None, None)
        .unwrap_err();
    assert!(error.contains("not a playable video"), "{error}");

    let text = root.path().join("notes.mp4");
    std::fs::write(&text, b"not a video at all").unwrap();
    let error =
        verify_before_delete(&project, succeeded(&export), Some(&text), None, None).unwrap_err();
    assert!(error.contains("not a playable video"), "{error}");

    let source = root.path().join("original.png");
    std::fs::write(&source, b"0123456789").unwrap();
    let short = root.path().join("copy.png");
    std::fs::write(&short, b"01234").unwrap();
    let save = save_action(root.path());
    let written = file_fingerprint(&short).unwrap();
    let error = verify_before_delete(
        &project,
        succeeded(&save),
        Some(&short),
        Some(&source),
        Some(&written),
    )
    .unwrap_err();
    assert!(error.contains("5 bytes but the original is 10"), "{error}");
    assert!(
        verify_before_delete(
            &project,
            succeeded(&save),
            Some(&short),
            None,
            Some(&written)
        )
        .is_err()
    );
}

#[test]
fn delete_is_refused_when_the_output_is_missing_empty_or_inside_the_recording() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("rec.cap");
    std::fs::create_dir_all(project.join("output")).unwrap();
    let export = export_action();

    let missing = root.path().join("missing.mp4");
    let error =
        verify_before_delete(&project, succeeded(&export), Some(&missing), None, None).unwrap_err();
    assert!(error.contains("could not be checked"), "{error}");

    let empty = root.path().join("empty.mp4");
    std::fs::write(&empty, b"").unwrap();
    let error =
        verify_before_delete(&project, succeeded(&export), Some(&empty), None, None).unwrap_err();
    assert!(error.contains("missing or empty"), "{error}");

    let a_directory = root.path().join("folder.mp4");
    std::fs::create_dir(&a_directory).unwrap();
    assert!(
        verify_before_delete(&project, succeeded(&export), Some(&a_directory), None, None).is_err()
    );

    let inside = project.join("output").join("result.mp4");
    std::fs::write(&inside, PLAYABLE_MP4).unwrap();
    let error =
        verify_before_delete(&project, succeeded(&export), Some(&inside), None, None).unwrap_err();
    assert!(error.contains("inside the folder"), "{error}");
}

fn recording_project(root: &Path) -> PathBuf {
    let project = root.join("rec.cap");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("recording-meta.json"), b"{}").unwrap();
    project
}

#[tokio::test]
async fn delete_never_touches_a_recording_still_being_recorded() {
    let root = tempfile::tempdir().unwrap();
    let project = recording_project(root.path());
    let _live = crate::library::RecordingInProgress::begin(&project);
    let host = GpuiAutomationHost::default();
    let ctx = TriggerContext::new().with_project_path(project.clone());
    assert_eq!(
        host.delete_local_files(&ctx).await,
        Err(tr::dialog::delete_recording::recording_active().to_string())
    );
    assert!(project.join("recording-meta.json").is_file());
}

#[tokio::test]
async fn delete_never_touches_a_recording_open_in_an_editor() {
    let root = tempfile::tempdir().unwrap();
    let project = recording_project(root.path());
    let _editor =
        crate::library::ProjectOpenInEditor::begin(&project.canonicalize().unwrap()).unwrap();
    let host = GpuiAutomationHost::default();
    let ctx = TriggerContext::new().with_project_path(project.clone());
    assert_eq!(
        host.delete_local_files(&ctx).await,
        Err(tr::dialog::delete_recording::open_in_editor().to_string())
    );
    assert!(project.join("recording-meta.json").is_file());
}

#[tokio::test]
async fn delete_never_touches_a_recording_whose_upload_has_not_finished() {
    let root = tempfile::tempdir().unwrap();
    let project = recording_project(root.path());
    crate::upload::queue::record_capture(
        &project,
        &cap_project::VideoUploadInfo {
            id: "video".into(),
            link: "https://cap.invalid/s/video".into(),
            config: cap_project::S3UploadMeta { id: "video".into() },
        },
        true,
        true,
    )
    .unwrap();
    let host = GpuiAutomationHost::default();
    let ctx = TriggerContext::new().with_project_path(project.clone());
    let error = host.delete_local_files(&ctx).await.unwrap_err();
    assert!(error.contains("upload has not finished"), "{error}");
    assert!(project.join("recording-meta.json").is_file());
}

#[tokio::test]
async fn delete_outside_the_recordings_library_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let project = recording_project(root.path());
    let host = GpuiAutomationHost::default();
    let ctx = TriggerContext::new().with_project_path(project.clone());
    assert!(host.delete_local_files(&ctx).await.is_err());
    assert!(project.join("recording-meta.json").is_file());
}

/// Automations run on the app runtime, whose 16 MiB workers hold the
/// export's debug-build future; libtest's 2 MiB thread does not.
#[test]
fn a_failed_export_keeps_the_recording() {
    let runtime = crate::app_runtime();
    runtime
        .block_on(runtime.spawn(failed_export_keeps_the_recording()))
        .unwrap();
    runtime.shutdown_background();
}

async fn failed_export_keeps_the_recording() {
    let root = tempfile::tempdir().unwrap();
    let project = recording_project(root.path());
    let rules = store(vec![rule(
        "compress-then-delete",
        Trigger::StudioRecordingFinished,
        true,
        vec![export_action(), Action::DeleteLocalFiles],
    )]);
    let host = GpuiAutomationHost::default();
    let results = cap_automation::run(
        &host,
        &rules,
        &Trigger::StudioRecordingFinished,
        &TriggerContext::new().with_project_path(project.clone()),
    )
    .await;
    let actions = &results[0].action_results;
    assert!(!actions[0].success);
    assert!(!actions[1].success);
    assert!(
        actions[1]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("did not succeed")),
        "{:?}",
        actions[1].error
    );
    assert!(project.join("recording-meta.json").is_file());
}

#[tokio::test]
async fn save_to_location_copies_the_capture_and_is_what_delete_checks() {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("shot.cap");
    std::fs::create_dir(&bundle).unwrap();
    let image = bundle.join("original.png");
    std::fs::write(&image, b"png bytes").unwrap();
    let destination = root.path().join("saved");
    let ctx = TriggerContext::new()
        .with_project_path(bundle.clone())
        .with_image_path(image.clone())
        .with_window_title("Notes/Plan: Q4".to_string());

    let host = GpuiAutomationHost::default();
    host.save_to_location(&ctx, &destination.to_string_lossy(), Some("{window}.png"))
        .await
        .unwrap();
    let saved = destination.join("Notes_Plan_ Q4.png");
    assert_eq!(std::fs::read(&saved).unwrap(), b"png bytes");
    assert_eq!(host.last_output().as_deref(), Some(saved.as_path()));
    let save = save_action(&destination);
    assert_eq!(
        verify_before_delete(
            &bundle,
            succeeded(&save),
            host.last_output().as_deref(),
            Some(&image),
            host.output().and_then(|output| output.written).as_ref(),
        ),
        Ok(())
    );

    let into_bundle = GpuiAutomationHost::default();
    into_bundle
        .save_to_location(&ctx, &bundle.join("copies").to_string_lossy(), None)
        .await
        .unwrap();
    assert!(
        verify_before_delete(
            &bundle,
            succeeded(&save),
            into_bundle.last_output().as_deref(),
            Some(&image),
            into_bundle
                .output()
                .and_then(|output| output.written)
                .as_ref(),
        )
        .is_err()
    );

    let no_source = GpuiAutomationHost::default();
    assert!(
        no_source
            .save_to_location(
                &TriggerContext::new().with_project_path(bundle),
                &destination.to_string_lossy(),
                None
            )
            .await
            .is_err()
    );
    assert_eq!(no_source.last_output(), None);
}

#[tokio::test]
async fn saving_onto_the_capture_itself_never_truncates_it() {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("shot.cap");
    std::fs::create_dir(&bundle).unwrap();
    let image = bundle.join("original.png");
    std::fs::write(&image, b"png bytes").unwrap();
    let ctx = TriggerContext::new()
        .with_project_path(bundle.clone())
        .with_image_path(image.clone());
    let host = GpuiAutomationHost::default();

    host.save_to_location(&ctx, &bundle.to_string_lossy(), None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&image).unwrap(), b"png bytes");

    let aliases = root.path().join("aliases");
    std::fs::create_dir(&aliases).unwrap();
    std::fs::hard_link(&image, aliases.join("original.png")).unwrap();
    host.save_to_location(&ctx, &aliases.to_string_lossy(), None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&image).unwrap(), b"png bytes");

    #[cfg(unix)]
    {
        let links = root.path().join("links");
        std::fs::create_dir(&links).unwrap();
        std::os::unix::fs::symlink(&image, links.join("original.png")).unwrap();
        host.save_to_location(&ctx, &links.to_string_lossy(), None)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&image).unwrap(), b"png bytes");
        let save = save_action(&links);
        assert!(
            verify_before_delete(
                &bundle,
                succeeded(&save),
                host.last_output().as_deref(),
                Some(&image),
                host.output().and_then(|output| output.written).as_ref(),
            )
            .is_err(),
            "a link back into the capture is not a copy"
        );
    }
}

/// Saving with no filename template keeps the capture's own name, and every
/// capture is called `original.png`, so a second save beside the first must
/// take a new name instead of replacing it.
#[tokio::test]
async fn a_second_save_never_overwrites_the_first() {
    let root = tempfile::tempdir().unwrap();
    let saved = root.path().join("saved");
    let mut copies = Vec::new();
    for (index, bytes) in [b"first capture".as_slice(), b"second"]
        .into_iter()
        .enumerate()
    {
        let bundle = root.path().join(format!("shot-{index}.cap"));
        std::fs::create_dir(&bundle).unwrap();
        let image = bundle.join("original.png");
        std::fs::write(&image, bytes).unwrap();
        let ctx = TriggerContext::new()
            .with_project_path(bundle.clone())
            .with_image_path(image.clone());
        let host = GpuiAutomationHost::default();
        host.save_to_location(&ctx, &saved.to_string_lossy(), None)
            .await
            .unwrap();
        let save = save_action(&saved);
        assert_eq!(
            verify_before_delete(
                &bundle,
                succeeded(&save),
                host.last_output().as_deref(),
                Some(&image),
                host.output().and_then(|output| output.written).as_ref(),
            ),
            Ok(())
        );
        copies.push(host.last_output().unwrap());
    }
    assert_eq!(
        copies,
        vec![saved.join("original.png"), saved.join("original (1).png")]
    );
    assert_eq!(std::fs::read(&copies[0]).unwrap(), b"first capture");
    assert_eq!(std::fs::read(&copies[1]).unwrap(), b"second");
}

/// The delete checks the file this run wrote, so a copy replaced or edited
/// after the save, or one that was already there, never lets the capture go.
#[tokio::test]
async fn delete_is_refused_when_the_saved_copy_is_not_the_one_this_run_wrote() {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("shot.cap");
    std::fs::create_dir(&bundle).unwrap();
    let image = bundle.join("original.png");
    std::fs::write(&image, b"png bytes").unwrap();
    let saved = root.path().join("saved");
    let ctx = TriggerContext::new()
        .with_project_path(bundle.clone())
        .with_image_path(image.clone());
    let save = save_action(&saved);
    let check = |host: &GpuiAutomationHost| {
        verify_before_delete(
            &bundle,
            succeeded(&save),
            host.last_output().as_deref(),
            Some(&image),
            host.output().and_then(|output| output.written).as_ref(),
        )
    };

    let replaced = GpuiAutomationHost::default();
    replaced
        .save_to_location(&ctx, &saved.to_string_lossy(), None)
        .await
        .unwrap();
    let copy = replaced.last_output().unwrap();
    let other = root.path().join("other.png");
    std::fs::write(&other, b"png bytes").unwrap();
    // Same length and modified time as the copy, so only file identity
    // (inode, or the NTFS file index on Windows) can tell them apart.
    let copy_modified = std::fs::metadata(&copy).unwrap().modified().unwrap();
    std::fs::File::options()
        .write(true)
        .open(&other)
        .unwrap()
        .set_modified(copy_modified)
        .unwrap();
    std::fs::rename(&other, &copy).unwrap();
    let error = check(&replaced).unwrap_err();
    assert!(
        error.contains("changed after this rule saved it"),
        "{error}"
    );

    let edited = GpuiAutomationHost::default();
    edited
        .save_to_location(&ctx, &saved.to_string_lossy(), None)
        .await
        .unwrap();
    std::fs::write(edited.last_output().unwrap(), b"png bytes and more").unwrap();
    assert!(check(&edited).is_err());

    let unwritten = GpuiAutomationHost::default();
    unwritten.remember_output(copy);
    let error = check(&unwritten).unwrap_err();
    assert!(error.contains("not written by this rule"), "{error}");
}

#[tokio::test]
async fn unused_names_count_up_past_files_folders_and_links() {
    let root = tempfile::tempdir().unwrap();
    let wanted = root.path().join("clip.mp4");
    std::fs::write(&wanted, b"earlier export").unwrap();
    std::fs::create_dir(root.path().join("clip (1).mp4")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        root.path().join("nowhere"),
        root.path().join("clip (2).mp4"),
    )
    .unwrap();
    let reserved = reserve_unused_path(&wanted).await.unwrap();
    #[cfg(unix)]
    assert_eq!(reserved, root.path().join("clip (3).mp4"));
    #[cfg(not(unix))]
    assert_eq!(reserved, root.path().join("clip (2).mp4"));
    assert_eq!(std::fs::read(&wanted).unwrap(), b"earlier export");
    assert_eq!(std::fs::metadata(&reserved).unwrap().len(), 0);
    assert_eq!(
        numbered_path(Path::new("/saved/README"), 2),
        PathBuf::from("/saved/README (2)")
    );
}

/// A screenshot's upload-completed rules see the screenshot: Open editor
/// opens the screenshot editor, and Upload reuses the link it just got.
#[tokio::test]
async fn upload_completed_for_a_screenshot_keeps_its_image() {
    let root = tempfile::tempdir().unwrap();
    let bundle = root.path().join("shot.cap");
    std::fs::create_dir(&bundle).unwrap();
    let image = bundle.join("original.png");
    std::fs::write(&image, b"png bytes").unwrap();
    let ctx = upload_context(
        bundle.clone(),
        Some(image.clone()),
        Some("https://cap.invalid/s/shot".into()),
        Some("shot".into()),
    );
    assert_eq!(ctx.image_path.as_deref(), Some(image.as_path()));
    assert!(matches!(
        editor_request(&ctx),
        Ok(UiRequest::OpenScreenshotEditor(path)) if path == image
    ));
    let host = GpuiAutomationHost::for_trigger(Trigger::UploadCompleted);
    assert_eq!(host.upload(&ctx, None, false, false).await, Ok(()));

    let recording = recording_project(root.path());
    let ctx = upload_context(recording.clone(), None, None, None);
    assert!(matches!(
        editor_request(&ctx),
        Ok(UiRequest::OpenEditor(path)) if path == recording
    ));
}

/// Delete-after-upload waits on this: a hold taken at Stop stays until the
/// last one is dropped, and a waiter wakes only then.
#[tokio::test]
async fn instant_rules_hold_the_folder_the_queue_resolves() {
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("recordings");
    let project = real.join("instant.cap");
    std::fs::create_dir_all(&project).unwrap();
    #[cfg(unix)]
    let recorded_to = {
        let link = root.path().join("linked-recordings");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        link.join("instant.cap")
    };
    #[cfg(not(unix))]
    let recorded_to = project.clone();
    let queued = project.canonicalize().unwrap();
    assert_ne!(recorded_to, queued);

    let hold = InstantRulesHold::take(&recorded_to);
    assert!(instant_rules_running(&queued));
    let waiter = tokio::spawn({
        let queued = queued.clone();
        async move { instant_rules_finished(&queued).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiter.is_finished());
    drop(hold);
    tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .unwrap()
        .unwrap();
    assert!(!instant_rules_running(&queued));
}

#[tokio::test]
async fn instant_rules_hold_the_folder_until_every_hold_is_released() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("instant.cap");
    assert!(!instant_rules_running(&project));
    instant_rules_finished(&project).await;

    let first = InstantRulesHold::take(&project);
    let second = InstantRulesHold::take(&project);
    assert!(instant_rules_running(&project));
    let waiter = tokio::spawn({
        let project = project.clone();
        async move { instant_rules_finished(&project).await }
    });
    drop(first);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiter.is_finished());
    assert!(instant_rules_running(&project));
    drop(second);
    tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .unwrap()
        .unwrap();
    assert!(!instant_rules_running(&project));
}

#[tokio::test]
async fn a_folder_left_blank_or_relative_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let image = root.path().join("original.png");
    std::fs::write(&image, b"png bytes").unwrap();
    let ctx = TriggerContext::new().with_image_path(image);
    let host = GpuiAutomationHost::default();
    for dir in ["", "  ", "relative/folder"] {
        assert_eq!(
            host.save_to_location(&ctx, dir, None).await,
            Err("Choose a folder for this action".to_string())
        );
        assert_eq!(host.last_output(), None);
    }

    let project = root.path().join("rec.cap");
    std::fs::create_dir(&project).unwrap();
    let error = host
        .export(
            &TriggerContext::new().with_project_path(project),
            &ExportProfile {
                format: ExportFormat::Mp4,
                fps: 30,
                resolution_base: cap_project::XY { x: 1920, y: 1080 },
                compression: None,
                preset_name: None,
            },
            &ExportDestination::CustomPath {
                dir: "exports".into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error, "Choose a folder for this action");
}

#[test]
fn a_studio_recording_is_rendered_before_upload_only_when_it_has_no_export() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("rec.cap");
    std::fs::create_dir(&project).unwrap();
    assert!(!needs_render_before_upload(&project));

    std::fs::write(
        project.join("recording-meta.json"),
        r#"{"pretty_name":"rec","sharing":null,"display":{"path":"content/display.mp4","fps":30}}"#,
    )
    .unwrap();
    let meta = cap_project::RecordingMeta::load_for_project(&project).unwrap();
    assert!(meta.studio_meta().is_some());
    assert!(needs_render_before_upload(&project));

    let output = meta.output_path();
    std::fs::create_dir_all(output.parent().unwrap()).unwrap();
    std::fs::write(&output, b"rendered").unwrap();
    assert!(!needs_render_before_upload(&project));

    let profile = upload_render_profile();
    assert_eq!(profile.format, ExportFormat::Mp4);
    assert_eq!(
        export_output_path(&project, profile.format, &ExportDestination::ProjectFolder),
        None
    );
}

#[test]
fn export_destination_and_compression_match_the_previous_app() {
    let project = Path::new("/recordings/My Recording.cap");
    assert_eq!(
        export_output_path(
            project,
            ExportFormat::Mp4,
            &ExportDestination::ProjectFolder
        ),
        None
    );
    assert_eq!(
        export_output_path(
            project,
            ExportFormat::Gif,
            &ExportDestination::CustomPath {
                dir: "/exports".into()
            }
        ),
        Some(PathBuf::from("/exports/My Recording.gif"))
    );
    assert_eq!(
        export_output_path(
            project,
            ExportFormat::Mov,
            &ExportDestination::CustomPath {
                dir: "/exports".into()
            }
        ),
        Some(PathBuf::from("/exports/My Recording.mov"))
    );
    assert!(matches!(
        export_compression(None),
        cap_export::mp4::ExportCompression::Web
    ));
    assert!(matches!(
        export_compression(Some(AutomationExportCompression::Potato)),
        cap_export::mp4::ExportCompression::Potato
    ));
    assert!(matches!(
        export_compression(Some(AutomationExportCompression::Maximum)),
        cap_export::mp4::ExportCompression::Maximum
    ));
    assert!(matches!(
        export_compression(Some(AutomationExportCompression::Social)),
        cap_export::mp4::ExportCompression::Social
    ));
}

#[test]
fn clipboard_copies_the_capture_and_refuses_an_unrendered_screenshot() {
    let screenshot = TriggerContext::new()
        .with_project_path(PathBuf::from("shot.cap"))
        .with_image_path(PathBuf::from("shot.cap/original.png"));
    assert_eq!(
        clipboard_image(&screenshot, ClipboardSource::Raw),
        Ok(PathBuf::from("shot.cap/original.png"))
    );
    assert!(clipboard_image(&screenshot, ClipboardSource::Rendered).is_err());

    let rendered = TriggerContext::new()
        .with_image_path(PathBuf::from("shot.cap/original.png"))
        .with_output_path(PathBuf::from("rendered.png"));
    assert_eq!(
        clipboard_image(&rendered, ClipboardSource::Rendered),
        Ok(PathBuf::from("rendered.png"))
    );
    assert!(clipboard_image(&TriggerContext::new(), ClipboardSource::Raw).is_err());
}

#[test]
fn templates_and_environment_carry_the_event() {
    let ctx = TriggerContext::new()
        .with_project_path(PathBuf::from("/r/a.cap"))
        .with_share_link("https://cap.so/s/abc".to_string());
    assert_eq!(
        apply_body_template("{project_path} {share_link} {image_path}", &ctx),
        "/r/a.cap https://cap.so/s/abc {image_path}"
    );
    assert_eq!(
        context_env(&ctx),
        vec![
            ("CAP_PROJECT_PATH", "/r/a.cap".to_string()),
            ("CAP_SHARE_LINK", "https://cap.so/s/abc".to_string()),
        ]
    );
    let date = apply_filename_template("{date}", &ctx);
    assert_eq!(date.len(), 10);
}

#[cfg(unix)]
#[tokio::test]
async fn run_command_passes_the_event_and_reports_failure() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("ran");
    let ctx = TriggerContext::new().with_project_path(PathBuf::from("/r/a.cap"));
    let host = GpuiAutomationHost::default();
    host.run_command(
        &ctx,
        "sh",
        &[
            "-c".to_string(),
            format!("printf %s \"$CAP_PROJECT_PATH\" > '{}'", marker.display()),
        ],
        None,
        &HashMap::new(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "/r/a.cap");

    let error = host
        .run_command(&ctx, "false", &[], None, &HashMap::new(), false)
        .await
        .unwrap_err();
    assert!(error.starts_with("Command exited"), "{error}");
}

async fn one_http_response(status: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            request.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&request);
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end]
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= head_end + 4 + length || read == 0 {
                    break;
                }
            }
        }
        socket
            .write_all(
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        String::from_utf8_lossy(&request).to_string()
    });
    (url, server)
}

#[tokio::test(flavor = "multi_thread")]
async fn webhook_sends_the_event_and_reports_a_bad_status() {
    let ctx = TriggerContext::new()
        .with_project_path(PathBuf::from("/r/a.cap"))
        .with_share_link("https://cap.so/s/abc".to_string());
    let host = GpuiAutomationHost::default();

    let (url, server) = one_http_response("200 OK").await;
    host.webhook(&ctx, &url, "POST", &HashMap::new(), None)
        .await
        .unwrap();
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /hook"), "{request}");
    assert!(
        request.contains(r#""share_link":"https://cap.so/s/abc""#),
        "{request}"
    );

    let (url, server) = one_http_response("500 Internal Server Error").await;
    let error = host
        .webhook(&ctx, &url, "PUT", &HashMap::new(), Some("{project_path}"))
        .await
        .unwrap_err();
    assert!(error.contains("500"), "{error}");
    let request = server.await.unwrap();
    assert!(request.starts_with("PUT /hook"), "{request}");
    assert!(request.ends_with("/r/a.cap"), "{request}");
}

#[tokio::test]
async fn apply_preset_writes_the_named_preset_and_reports_a_missing_one() {
    let root = tempfile::tempdir().unwrap();
    let store_path = root.path().join("store");
    std::fs::write(
        &store_path,
        serde_json::to_vec(&serde_json::json!({
            "presets": { "presets": [ { "name": "Square", "config": serde_json::to_value(
                cap_project::ProjectConfiguration {
                    aspect_ratio: Some(cap_project::AspectRatio::Square),
                    ..Default::default()
                }
            ).unwrap() } ] }
        }))
        .unwrap(),
    )
    .unwrap();
    crate::store::set_test_tauri_store_path(Some(store_path));
    let project = root.path().join("rec.cap");
    std::fs::create_dir(&project).unwrap();
    let ctx = TriggerContext::new().with_project_path(project.clone());
    let host = GpuiAutomationHost::default();

    let missing = host.apply_preset(&ctx, "Vertical").await;
    let applied = write_preset(&project, &preset_config("Square").unwrap());
    let gone = host
        .apply_preset(
            &TriggerContext::new().with_project_path(root.path().join("deleted.cap")),
            "Square",
        )
        .await;
    crate::store::set_test_tauri_store_path(None);

    assert_eq!(missing, Err("Preset 'Vertical' not found".to_string()));
    assert_eq!(gone, Err("The recording no longer exists".to_string()));
    assert!(!root.path().join("deleted.cap").exists());
    applied.unwrap();
    let written = cap_project::ProjectConfiguration::load(&project).unwrap();
    assert!(matches!(
        written.aspect_ratio,
        Some(cap_project::AspectRatio::Square)
    ));
}

#[test]
fn notifications_fill_the_event_into_both_templates() {
    let ctx = TriggerContext::new()
        .with_share_link("https://cap.so/s/abc".to_string())
        .with_window_title("Notes/Plan".to_string());
    let (title, body) = notification_text(&ctx, "Cap: {window}", "Ready at {share_link}");
    assert_eq!(title, "Cap: Notes_Plan");
    assert_eq!(body, "Ready at https://cap.so/s/abc");
    assert!(
        GpuiAutomationHost::default()
            .capabilities()
            .contains(&Capability::Notify)
    );
}

#[tokio::test]
async fn text_recognition_is_not_run_yet() {
    let host = GpuiAutomationHost::default();
    let ctx = TriggerContext::new().with_image_path(PathBuf::from("shot.png"));
    assert!(host.recognize_text_to_clipboard(&ctx).await.is_err());
    assert!(!host.capabilities().contains(&Capability::RecognizeText));
}
