use std::{
    path::Path,
    process::{Command, Output},
};

use serde_json::Value;

fn cap() -> Command {
    Command::new(env!("CARGO_BIN_EXE_cap"))
}

fn run(args: &[&str]) -> Output {
    cap()
        .args(args)
        .output()
        .expect("failed to spawn cap binary")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn parse_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "stdout was not valid JSON: {e}\n--- stdout ---\n{}\n--- stderr ---\n{}",
            stdout(output),
            stderr(output)
        )
    })
}

#[test]
fn help_succeeds_and_lists_commands() {
    let output = run(&["--help"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let text = stdout(&output);
    for command in [
        "export",
        "record",
        "targets",
        "doctor",
        "version",
        "project",
        "recordings",
        "upload",
        "update",
        "screenshot",
    ] {
        assert!(text.contains(command), "help missing '{command}':\n{text}");
    }
}

#[test]
fn subcommand_help_succeeds() {
    for command in [
        "export",
        "record",
        "project",
        "targets",
        "doctor",
        "desktop",
        "recordings",
        "upload",
        "update",
        "screenshot",
    ] {
        let output = run(&[command, "--help"]);
        assert!(
            output.status.success(),
            "`cap {command} --help` failed: {}",
            stderr(&output)
        );
    }
}

#[test]
fn unknown_command_fails() {
    let output = run(&["definitely-not-a-command"]);
    assert!(!output.status.success());
}

#[test]
fn version_json_is_parseable() {
    let output = run(&["version", "--format", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["name"], "cap");
    assert!(json["version"].is_string());
    assert!(json["platform"]["os"].is_string());
    assert!(json["distribution"].is_string());
}

#[test]
fn doctor_json_is_parseable() {
    let output = run(&["doctor", "--format", "json"]);
    // doctor may report failing checks; it should still emit valid JSON and exit 0.
    let json = parse_json(&output);
    assert_eq!(json["version"]["name"], "cap");
    assert!(json["checks"].is_array());
    assert!(json["ok"].is_boolean());
    assert!(json["permissions"].is_object());
}

#[test]
fn completions_generate_for_each_shell() {
    for shell in ["bash", "zsh", "fish", "powershell"] {
        let output = run(&["completions", shell]);
        assert!(
            output.status.success(),
            "completions for {shell} failed: {}",
            stderr(&output)
        );
        assert!(!output.stdout.is_empty(), "completions for {shell} empty");
    }
}

#[test]
fn targets_screens_json_is_parseable() {
    let output = run(&["targets", "screens", "--format", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json.is_array(), "expected a JSON array of screens");
}

#[test]
fn targets_all_json_is_parseable() {
    let output = run(&["targets", "--format", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json["screens"].is_array());
    assert!(json["windows"].is_array());
    assert!(json["cameras"].is_array());
}

#[test]
fn targets_format_before_subcommand_is_rejected() {
    // `--format` before the subcommand must not be silently ignored; clap rejects the conflict.
    let output = run(&["targets", "--format", "json", "screens"]);
    assert!(!output.status.success());
}

#[test]
fn record_requires_duration_when_non_interactive() {
    // The test harness gives the child a non-TTY stdin, so recording without --duration must error
    // rather than stop instantly on EOF.
    let output = run(&["record"]);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("--duration") || stderr(&output).contains("interactive"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn version_text_reports_distribution() {
    let output = run(&["version"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert!(stdout(&output).contains("distribution:"));
}

#[test]
fn desktop_status_json_is_parseable() {
    let output = run(&["desktop", "status", "--format", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json["installed"].is_boolean());
    assert!(json["onPath"].is_boolean());
    assert!(json["shimPath"].is_string());
}

#[test]
fn project_inspect_missing_fails() {
    let output = run(&[
        "project",
        "inspect",
        "/this/path/does/not/exist.cap",
        "--format",
        "json",
    ]);
    assert!(!output.status.success());
    assert!(stderr(&output).to_lowercase().contains("failed to load"));
}

#[test]
fn project_validate_missing_meta_reports_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let output = run(&[
        "project",
        "validate",
        dir.path().to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert_eq!(json["valid"], false);
    assert!(json["error"].is_string());
}

#[test]
fn project_validate_complete_project_is_valid() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    let content = project.join("content");
    std::fs::create_dir_all(&content).unwrap();
    std::fs::write(content.join("display.mp4"), b"fake").unwrap();
    write_single_segment_meta(&project);

    let output = run(&[
        "project",
        "validate",
        project.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["valid"], true);
    assert_eq!(json["recordingType"], "studio");
}

#[test]
fn project_validate_detects_missing_media() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    std::fs::create_dir_all(&project).unwrap();
    write_single_segment_meta(&project);

    let output = run(&[
        "project",
        "validate",
        project.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert_eq!(json["valid"], false);
    let missing = json["missing"].as_array().unwrap();
    assert!(!missing.is_empty(), "expected missing media files");
}

#[test]
fn project_validate_rejects_in_progress_zero_segment_studio_project() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    std::fs::create_dir_all(&project).unwrap();
    let meta = serde_json::json!({
        "platform": "Linux",
        "pretty_name": "Broken Linux Recording",
        "sharing": null,
        "segments": [],
        "status": { "status": "InProgress" }
    });
    std::fs::write(
        project.join("recording-meta.json"),
        serde_json::to_vec_pretty(&meta).unwrap(),
    )
    .unwrap();

    let output = run(&[
        "project",
        "validate",
        project.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert_eq!(json["valid"], false);
    assert!(json["error"].is_string());
    let problems = json["problems"].as_array().unwrap();
    assert!(
        problems.iter().any(|problem| problem
            .as_str()
            .is_some_and(|value| value.contains("no segments"))),
        "expected no-segments validation problem: {json}"
    );
}

#[test]
fn project_inspect_complete_project_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    let content = project.join("content");
    std::fs::create_dir_all(&content).unwrap();
    std::fs::write(content.join("display.mp4"), b"fake").unwrap();
    write_single_segment_meta(&project);

    let output = run(&[
        "project",
        "inspect",
        project.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["meta"]["pretty_name"], "Test Project");
}

#[test]
fn record_rejects_non_positive_duration() {
    let output = run(&["record", "--duration", "0"]);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("Duration") || stdout(&output).contains("Duration"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn record_rejects_zero_fps() {
    let output = run(&["record", "--fps", "0", "--duration", "1"]);
    assert!(!output.status.success());
}

#[test]
fn export_rejects_settings_json_with_flags() {
    let output = run(&[
        "export",
        "/tmp/whatever.cap",
        "--settings-json",
        "{\"format\":\"Mp4\"}",
        "--fps",
        "30",
    ]);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("cannot be combined"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn export_rejects_quality_with_gif() {
    let output = run(&[
        "export",
        "/tmp/whatever.cap",
        "--format",
        "gif",
        "--quality",
        "web",
    ]);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("only supported for"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn export_rejects_bad_resolution() {
    let output = run(&[
        "export",
        "/tmp/whatever.cap",
        "--resolution",
        "not-a-resolution",
    ]);
    assert!(!output.status.success());
    assert!(
        stderr(&output).to_lowercase().contains("resolution"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn export_rejects_duplicate_output() {
    let output = run(&[
        "export",
        "/tmp/whatever.cap",
        "/tmp/out1.mp4",
        "--output",
        "/tmp/out2.mp4",
    ]);
    assert!(!output.status.success());
}

#[test]
fn targets_mics_json_is_parseable() {
    let output = run(&["targets", "mics", "--format", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json.is_array(), "expected a JSON array of mics");
}

#[test]
fn targets_all_json_includes_mics() {
    let output = run(&["targets", "--format", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json["mics"].is_array());
}

#[test]
fn recordings_list_empty_dir_is_empty_json() {
    let dir = tempfile::tempdir().unwrap();
    let output = run(&[
        "recordings",
        "list",
        "--dir",
        dir.path().to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json.as_array().map(|a| a.len()), Some(0));
}

#[test]
fn project_config_set_then_get_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    write_single_segment_meta(&project);

    let set = run(&[
        "project",
        "config",
        "set",
        project.to_str().unwrap(),
        "--settings-json",
        "{}",
    ]);
    assert!(set.status.success(), "stderr: {}", stderr(&set));
    assert!(project.join("project-config.json").exists());

    let get = run(&[
        "project",
        "config",
        "get",
        project.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(get.status.success(), "stderr: {}", stderr(&get));
    let json = parse_json(&get);
    assert!(json.is_object(), "expected a project config object");
}

#[test]
fn project_config_get_without_file_returns_default() {
    // Instant / un-edited projects have no project-config.json; `config get` should still succeed
    // with the effective default config rather than erroring.
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    write_single_segment_meta(&project);

    let output = run(&[
        "project",
        "config",
        "get",
        project.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json.is_object(), "expected a default project config object");
}

#[test]
fn export_missing_project_emits_json_error_event() {
    let output = run(&["export", "/this/path/does/not/exist.cap", "--progress-json"]);
    assert!(!output.status.success());
    // The NDJSON stream must end with a machine-readable terminal error rather than just stopping.
    // The `error` field is uniform across every JSON-emitting command (the `type` tag stays Error).
    let json = parse_json(&output);
    assert_eq!(json["type"], "Error");
    assert!(json["error"].is_string());
}

#[test]
fn export_global_json_implies_progress_stream() {
    // `--json` (global) must behave like --progress-json/--completion-json so the agent's universal
    // reflex works on export too; failure still ends with a terminal Error event.
    let output = run(&["export", "/this/path/does/not/exist.cap", "--json"]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert_eq!(json["type"], "Error");
    assert!(json["error"].is_string());
}

#[test]
fn export_preview_missing_project_emits_json_error() {
    let output = run(&[
        "export-preview",
        "/this/path/does/not/exist.cap",
        "--frame-time",
        "0",
        "--settings-json",
        "{}",
    ]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert!(json["error"].is_string());
}

#[test]
fn record_no_target_json_emits_error_event() {
    // --duration satisfies the non-interactive guard, so this fails on target resolution and must
    // report that failure as a JSON event on stdout.
    let output = run(&["record", "--duration", "1", "--format", "json"]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert_eq!(json["type"], "error");
    assert!(json["error"].is_string());
}

#[test]
fn global_json_flag_works_before_subcommand() {
    // The order-insensitive global --json is the headline agent ergonomic: it must parse in front of
    // the verb and force JSON output the same as a trailing `--format json`.
    let output = run(&["--json", "version"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["name"], "cap");
}

#[test]
fn guide_json_is_parseable_and_self_describing() {
    let output = run(&["guide", "--json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["binary"], "cap");
    assert!(json["schemaVersion"].is_number());
    assert!(json["commands"].is_array());
    assert!(json["env"].is_array());
    assert!(json["outputConvention"].is_object());
}

#[test]
fn record_status_empty_is_json_array() {
    let output = run(&["record", "status", "--json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json.is_array(), "expected a JSON array of sessions");
}

#[test]
fn record_stop_unknown_id_fails_with_json_error() {
    let output = run(&["record", "stop", "--id", "does-not-exist", "--json"]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert_eq!(json["type"], "error");
    assert!(json["error"].is_string());
}

#[test]
fn doctor_exits_zero_even_when_checks_fail() {
    // doctor is a report, not a gate: agents branch on `ok`/`captureReady`, so it must exit 0.
    let output = run(&["doctor", "--json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json["ok"].is_boolean());
    assert!(json["captureReady"].is_boolean());
}

#[test]
fn doctor_check_ids_are_the_pinned_vocabulary() {
    let output = run(&["doctor", "--json"]);
    let json = parse_json(&output);
    let ids: Vec<&str> = json["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["ffmpeg", "screenRecordingPermission", "cliInstall"]);
}

#[test]
fn clean_error_has_no_debug_quotes() {
    // main() must print `error: <message>` (not the default `Error: "debug-quoted"`); a leading
    // `Error: "` would mean agents scraping stderr get stray quotes/escapes.
    let output = run(&["record", "--duration", "1"]);
    assert!(!output.status.success());
    let err = stderr(&output);
    assert!(err.contains("error:"), "stderr: {err}");
    assert!(!err.contains("Error: \""), "stderr had debug quotes: {err}");
}

#[test]
fn upload_missing_file_emits_json_error() {
    // Whether auth comes from CAP_API_KEY, the desktop login, or is absent, uploading a path that
    // does not exist must fail with a machine-readable error before any network call.
    let output = run(&["upload", "/tmp/does-not-exist-cap.mp4", "--format", "json"]);
    assert!(!output.status.success());
    let json = parse_json(&output);
    assert!(json["error"].is_string());
}

#[test]
fn auth_status_json_reports_source() {
    let output = run(&["auth", "status", "--json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert!(json["authenticated"].is_boolean());
    // source is one of env|desktop|none; server is always reported.
    assert!(json["source"].is_string());
    assert!(json["server"].is_string());
}

fn write_single_segment_meta(project: &Path) {
    std::fs::create_dir_all(project).unwrap();
    let meta = serde_json::json!({
        "pretty_name": "Test Project",
        "display": { "path": "content/display.mp4", "fps": 30 }
    });
    std::fs::write(
        project.join("recording-meta.json"),
        serde_json::to_vec_pretty(&meta).unwrap(),
    )
    .unwrap();
}
