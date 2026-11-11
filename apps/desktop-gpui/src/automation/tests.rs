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
fn one_event_runs_its_rules_once() {
    let fired = FiredEvents::new();
    let project = Path::new("/recordings/a.cap");
    assert!(fired.claim(Trigger::StudioRecordingFinished, project));
    assert!(!fired.claim(Trigger::StudioRecordingFinished, project));
    assert!(fired.claim(Trigger::UploadCompleted, project));
    assert!(fired.claim(
        Trigger::StudioRecordingFinished,
        Path::new("/recordings/b.cap")
    ));

    for index in 0..REMEMBERED_EVENTS {
        assert!(fired.claim(
            Trigger::RecordingStarted,
            &PathBuf::from(format!("/r/{index}.cap"))
        ));
    }
    assert!(fired.claim(Trigger::StudioRecordingFinished, project));
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
fn delete_is_refused_without_a_successful_verified_action_before_it() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("rec.cap");
    std::fs::create_dir(&project).unwrap();
    let outside = root.path().join("rec.mp4");
    std::fs::write(&outside, b"exported bytes").unwrap();
    let export = export_action();

    assert!(verify_before_delete(&project, None, Some(&outside)).is_err());

    let notify = Action::Notify {
        title_template: "t".into(),
        body_template: "b".into(),
    };
    let error = verify_before_delete(&project, succeeded(&notify), Some(&outside)).unwrap_err();
    assert!(error.contains("notify"), "{error}");

    let failed = Some(PrecedingAction {
        action: &export,
        succeeded: false,
    });
    let error = verify_before_delete(&project, failed, Some(&outside)).unwrap_err();
    assert!(error.contains("did not succeed"), "{error}");

    assert!(verify_before_delete(&project, succeeded(&export), None).is_err());

    assert_eq!(
        verify_before_delete(&project, succeeded(&export), Some(&outside)),
        Ok(())
    );
    let save = save_action(root.path());
    assert_eq!(
        verify_before_delete(&project, succeeded(&save), Some(&outside)),
        Ok(())
    );
}

#[test]
fn delete_is_refused_when_the_output_is_missing_empty_or_inside_the_recording() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("rec.cap");
    std::fs::create_dir_all(project.join("output")).unwrap();
    let export = export_action();

    let missing = root.path().join("missing.mp4");
    let error = verify_before_delete(&project, succeeded(&export), Some(&missing)).unwrap_err();
    assert!(error.contains("could not be checked"), "{error}");

    let empty = root.path().join("empty.mp4");
    std::fs::write(&empty, b"").unwrap();
    let error = verify_before_delete(&project, succeeded(&export), Some(&empty)).unwrap_err();
    assert!(error.contains("missing or empty"), "{error}");

    let a_directory = root.path().join("folder.mp4");
    std::fs::create_dir(&a_directory).unwrap();
    assert!(verify_before_delete(&project, succeeded(&export), Some(&a_directory)).is_err());

    let inside = project.join("output").join("result.mp4");
    std::fs::write(&inside, b"exported bytes").unwrap();
    let error = verify_before_delete(&project, succeeded(&export), Some(&inside)).unwrap_err();
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

#[tokio::test]
async fn a_failed_export_keeps_the_recording() {
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
        .with_image_path(image)
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
        verify_before_delete(&bundle, succeeded(&save), host.last_output().as_deref()),
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
            into_bundle.last_output().as_deref()
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
    let applied = host.apply_preset(&ctx, "Square").await;
    crate::store::set_test_tauri_store_path(None);

    assert_eq!(missing, Err("Preset 'Vertical' not found".to_string()));
    applied.unwrap();
    let written = cap_project::ProjectConfiguration::load(&project).unwrap();
    assert!(matches!(
        written.aspect_ratio,
        Some(cap_project::AspectRatio::Square)
    ));
}

#[tokio::test]
async fn actions_cap_cannot_run_yet_fail_without_side_effects() {
    let host = GpuiAutomationHost::default();
    let ctx = TriggerContext::new().with_image_path(PathBuf::from("shot.png"));
    assert!(host.notify(&ctx, "t", "b").await.is_err());
    assert!(host.recognize_text_to_clipboard(&ctx).await.is_err());
    assert!(!host.capabilities().contains(&Capability::Notify));
    assert!(!host.capabilities().contains(&Capability::RecognizeText));
}
