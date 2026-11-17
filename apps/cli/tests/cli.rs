use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::Path,
    process::{Command, Output, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
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

#[tokio::test]
async fn organization_operations_validate_wait_timeouts_before_submitting() {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    for (arguments, method, path, body) in [
        (
            vec!["organizations", "delete", "org_test"],
            "DELETE",
            "/api/v1/organizations/org_test",
            serde_json::json!({}),
        ),
        (
            vec!["organizations", "domain", "remove", "org_test"],
            "DELETE",
            "/api/v1/organizations/org_test/domain",
            serde_json::json!({}),
        ),
        (
            vec!["organizations", "domain", "verify", "org_test"],
            "POST",
            "/api/v1/organizations/org_test/domain/verify",
            serde_json::json!({}),
        ),
        (
            vec![
                "organizations",
                "domain",
                "set",
                "org_test",
                "clips.example.com",
            ],
            "PUT",
            "/api/v1/organizations/org_test/domain",
            serde_json::json!({"domain": "clips.example.com"}),
        ),
    ] {
        for (wait, timeout, expected_requests) in [
            (true, "0", 0),
            (true, "86401", 0),
            (true, "86400", 2),
            (false, "0", 1),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (sender, receiver) = mpsc::channel();
            let server = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut reader = tokio::io::BufReader::new(&mut stream);
                    let mut request = String::new();
                    reader.read_line(&mut request).await.unwrap();
                    let mut length = 0;
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).await.unwrap();
                        if header == "\r\n" {
                            break;
                        }
                        if let Some((name, value)) = header.split_once(':')
                            && name.eq_ignore_ascii_case("content-length")
                        {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                    }
                    let mut bytes = vec![0; length];
                    reader.read_exact(&mut bytes).await.unwrap();
                    let state = if request.starts_with("GET ") {
                        "succeeded"
                    } else {
                        "queued"
                    };
                    sender.send((request, bytes)).unwrap();
                    let response = serde_json::json!({"id": "op_test", "state": state}).to_string();
                    stream
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                                response.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
            });
            let mut args = arguments.clone();
            args.extend(["--yes", "--json", "--timeout", timeout]);
            if wait {
                args.push("--wait");
            }
            let output = tokio::task::spawn_blocking(move || {
                cap()
                    .args(args)
                    .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
                    .env("CAP_SERVER_URL", format!("http://{address}"))
                    .output()
                    .expect("failed to spawn cap binary")
            })
            .await
            .unwrap();
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
            let requests = receiver.try_iter().collect::<Vec<_>>();
            assert_eq!(requests.len(), expected_requests, "{arguments:?} {timeout}");
            if expected_requests == 0 {
                assert!(!output.status.success());
                let error = parse_json(&output);
                assert_eq!(error["code"], "INVALID_REQUEST");
                assert_eq!(
                    error["message"],
                    "--timeout must be between 1 and 86400 seconds"
                );
                assert_eq!(error["error"], error["message"]);
                assert!(
                    stderr(&output)
                        .contains("INVALID_REQUEST: --timeout must be between 1 and 86400 seconds")
                );
                continue;
            }
            assert!(output.status.success(), "{}", stderr(&output));
            assert_eq!(requests[0].0, format!("{method} {path} HTTP/1.1\r\n"));
            assert_eq!(
                serde_json::from_slice::<Value>(&requests[0].1).unwrap(),
                body
            );
            if wait {
                assert_eq!(requests[1].0, "GET /api/v1/operations/op_test HTTP/1.1\r\n");
            }
            let value = parse_json(&output);
            assert_eq!(value["id"], "op_test");
            assert_eq!(value["state"], if wait { "succeeded" } else { "queued" });
        }
    }
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
        "caps",
        "account",
        "organizations",
        "library",
        "notifications",
        "analytics",
        "developers",
        "jobs",
        "mcp",
        "agents",
    ] {
        assert!(text.contains(command), "help missing '{command}':\n{text}");
    }
}

#[test]
fn no_args_prints_branded_intro() {
    let output = run(&[]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert!(stderr(&output).is_empty(), "stderr: {}", stderr(&output));
    let text = stdout(&output);
    assert!(text.contains("██████████████████"), "stdout: {text}");
    assert!(text.contains("/ ___|__ _ _ __"), "stdout: {text}");
    assert!(text.contains("cap record start --screen <id> --detach"));
    assert!(text.contains("cap --help"));
}

#[test]
fn no_args_json_is_parseable() {
    let output = run(&["--json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["name"], "cap");
    assert!(json["commands"].is_array());
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
        "caps",
        "account",
        "organizations",
        "library",
        "notifications",
        "analytics",
        "developers",
        "jobs",
        "mcp",
        "agents",
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
fn project_commands_report_duration_for_readable_media() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    write_test_media(&project.join("content/display.mp4"));
    write_single_segment_meta(&project);

    for command in ["validate", "inspect"] {
        let output = run(&[
            "project",
            command,
            project.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(
            output.status.success(),
            "{command} stderr: {}",
            stderr(&output)
        );
        let json = parse_json(&output);
        let duration = json["durationSeconds"]
            .as_f64()
            .unwrap_or_else(|| panic!("{command} did not report durationSeconds: {json}"));
        assert!(
            (duration - 1.0).abs() < 0.25,
            "{command} reported unexpected duration {duration}"
        );
    }
}

#[test]
fn project_commands_omit_duration_for_unreadable_media() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("recording.cap");
    let content = project.join("content");
    std::fs::create_dir_all(&content).unwrap();
    std::fs::write(content.join("display.mp4"), b"fake").unwrap();
    write_single_segment_meta(&project);

    for command in ["validate", "inspect"] {
        let output = run(&[
            "project",
            command,
            project.to_str().unwrap(),
            "--format",
            "json",
        ]);
        assert!(
            output.status.success(),
            "{command} stderr: {}",
            stderr(&output)
        );
        let json = parse_json(&output);
        assert!(
            json.get("durationSeconds").is_none(),
            "{command} reported a duration for unreadable media: {json}"
        );
    }
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
fn record_validation_failures_emit_json_error_events() {
    for command in [
        &["record"][..],
        &["record", "start"][..],
        &["record", "start", "--detach"][..],
    ] {
        for json_flag in [&["--json"][..], &["--format", "json"][..]] {
            for (params, expected_error) in [
                (&["--duration", "0"][..], "Duration"),
                (&["--duration", "NaN"][..], "Duration"),
                (&["--duration", "inf"][..], "Duration"),
                (&["--fps", "0", "--duration", "1"][..], "--fps"),
                (&["--duration", "1"][..], "No target specified"),
            ] {
                let mut args = command.to_vec();
                args.extend_from_slice(json_flag);
                args.extend_from_slice(params);
                let output = run(&args);
                assert_eq!(output.status.code(), Some(1), "args: {args:?}");
                let json = parse_json(&output);
                assert_eq!(json["type"], "error", "args: {args:?}");
                let error = json["error"].as_str().expect("expected an error message");
                assert!(error.contains(expected_error), "args: {args:?}: {error}");
                assert!(stderr(&output).contains(error), "args: {args:?}");
            }
        }
    }
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
fn export_several_projects_requires_output_directory() {
    let output = run(&["export", "/tmp/whatever.cap", "/tmp/also.cap"]);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("output directory"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn export_batch_reports_every_failed_project() {
    let dir = tempfile::tempdir().unwrap();
    let output = run(&[
        "export",
        "/tmp/whatever.cap",
        "/tmp/also.cap",
        "-o",
        dir.path().to_str().unwrap(),
    ]);
    assert!(!output.status.success());
    let text = stderr(&output);
    assert_eq!(
        text.matches("Failed to export ").count(),
        2,
        "stderr: {text}"
    );
}

#[test]
fn export_batch_json_streams_file_events_and_summary() {
    let dir = tempfile::tempdir().unwrap();
    let output = run(&[
        "export",
        "/tmp/whatever.cap",
        "/tmp/also.cap",
        "-o",
        dir.path().to_str().unwrap(),
        "--json",
    ]);
    assert!(!output.status.success());
    let text = stdout(&output);
    for event in ["\"FileStarted\"", "\"FileFailed\"", "\"BatchCompleted\""] {
        assert!(text.contains(event), "stdout missing {event}: {text}");
    }
    let last = text.lines().last().unwrap_or_default();
    assert!(last.contains("\"Error\""), "last line: {last}");
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

#[cfg(target_os = "linux")]
#[test]
fn recordings_list_follows_desktop_storage_unless_dir_is_explicit() {
    let root = tempfile::tempdir().unwrap();
    let app_data = root.path().join("so.cap.desktop");
    let default = app_data.join("recordings");
    let current = root.path().join("custom");
    let previous = root.path().join("previous");
    for dir in [&default, &current, &previous] {
        write_single_segment_meta(&dir.join("example.cap"));
    }
    std::fs::write(
        app_data.join("store"),
        serde_json::to_vec(&serde_json::json!({
            "general_settings": {
                "recordingsPath": current,
                "previousRecordingsPaths": [previous, current]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let list = |dir: Option<&Path>| {
        let mut command = cap();
        command
            .env("XDG_DATA_HOME", root.path())
            .args(["recordings", "list", "--json"]);
        if let Some(dir) = dir {
            command.arg("--dir").arg(dir);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "stderr: {}", stderr(&output));
        parse_json(&output)
    };

    assert_eq!(list(None).as_array().unwrap().len(), 3);
    let explicit = list(Some(&current));
    assert_eq!(explicit.as_array().unwrap().len(), 1);
    assert_eq!(
        explicit[0]["path"],
        current.join("example.cap").to_str().unwrap()
    );
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
    let expected_json =
        serde_json::to_string(&cap_project::ProjectConfiguration::default()).unwrap();
    assert_eq!(json, serde_json::from_str::<Value>(&expected_json).unwrap());
}

#[test]
fn project_config_commands_reject_directories_without_recordings() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("not-a-recording.cap");
    std::fs::create_dir(&project).unwrap();

    for command in ["get", "set"] {
        let mut args = vec!["project", "config", command, project.to_str().unwrap()];
        if command == "set" {
            args.extend(["--settings-json", "{}"]);
        }
        args.push("--json");

        let output = run(&args);
        assert!(!output.status.success(), "{command} unexpectedly succeeded");
        assert!(parse_json(&output)["error"].is_string());
    }

    assert!(!project.join("project-config.json").exists());
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
    assert_eq!(json["schemaVersion"], 3);
    assert!(json["commands"].is_array());
    assert!(json["env"].is_array());
    assert!(json["outputConvention"].is_object());
    let commands = serde_json::to_string(&json["commands"]).unwrap();
    assert!(commands.contains("caps unlock"));
    assert!(commands.contains("caps comments|reactions|update|sharing"));
    assert!(commands.contains("caps import loom"));
    assert!(commands.contains("account get|update|image|referrals|sign-out-all"));
    assert!(commands.contains(
        "organizations create|update|icon|shareable-icon|settings|invite|member|domain|delete"
    ));
    assert!(commands.contains("organizations billing get|checkout|portal"));
    assert!(commands.contains("organizations storage list|s3|provider|google-drive"));
    assert!(commands.contains("developers list|get|create|update|delete"));
}

#[test]
fn dashboard_parity_help_exposes_secure_command_trees() {
    for args in [
        &["account", "image", "--help"][..],
        &["account", "referrals", "--help"][..],
        &["organizations", "billing", "--help"][..],
        &["organizations", "storage", "--help"][..],
        &["organizations", "storage", "s3", "--help"][..],
        &["organizations", "storage", "google-drive", "--help"][..],
        &["organizations", "invite", "add", "--help"][..],
        &["developers", "credits", "--help"][..],
        &["developers", "videos", "--help"][..],
        &["developers", "videos", "upload", "--help"][..],
        &["developers", "transcripts", "--help"][..],
        &["developers", "transcripts", "create", "--help"][..],
        &["developers", "transcripts", "text", "--help"][..],
        &["developers", "transactions", "--help"][..],
        &["library", "folders", "public-page", "--help"][..],
        &["library", "folders", "logo", "--help"][..],
        &["library", "spaces", "public-page", "--help"][..],
        &["library", "spaces", "logo", "--help"][..],
        &["caps", "import", "loom", "--help"][..],
    ] {
        let output = run(args);
        assert!(output.status.success(), "stderr: {}", stderr(&output));
    }

    let output = run(&["organizations", "storage", "s3", "set", "--help"]);
    let help = stdout(&output).to_lowercase();
    assert!(!help.contains("access-key"));
    assert!(!help.contains("secret-access"));

    let output = run(&["organizations", "invite", "add", "--help"]);
    assert!(stdout(&output).contains("--no-email"));
}

#[test]
fn non_interactive_s3_requires_secure_credential_input() {
    let output = cap()
        .args([
            "organizations",
            "storage",
            "s3",
            "set",
            "org_synthetic",
            "--bucket",
            "synthetic",
            "--yes",
            "--format",
            "json",
        ])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("--credentials-stdin or --reuse-credentials"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn caps_help_lists_the_agent_interface() {
    let output = run(&["caps", "--help"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let text = stdout(&output);
    for command in [
        "list",
        "get",
        "context",
        "status",
        "wait",
        "transcript",
        "download",
        "process",
        "transcript-replace",
        "duplicate",
        "delete",
        "password",
        "unlock",
        "comments",
        "reactions",
        "update",
        "sharing",
    ] {
        assert!(
            text.contains(command),
            "caps help missing {command}:\n{text}"
        );
    }
    for args in [
        &["caps", "comments", "--help"][..],
        &["caps", "reactions", "--help"][..],
        &["caps", "sharing", "--help"][..],
    ] {
        let output = run(args);
        assert!(output.status.success(), "stderr: {}", stderr(&output));
    }
}

#[test]
fn agent_content_mutations_require_explicit_confirmation() {
    for args in [
        vec!["caps", "comments", "add", "cap_synthetic", "hello"],
        vec![
            "caps",
            "comments",
            "reply",
            "cap_synthetic",
            "comment_synthetic",
            "hello",
        ],
        vec!["caps", "reactions", "add", "cap_synthetic", "thumbs-up"],
        vec![
            "caps",
            "update",
            "cap_synthetic",
            "--title",
            "Synthetic title",
        ],
        vec!["caps", "sharing", "set", "cap_synthetic", "--public"],
    ] {
        let output = cap()
            .args(args)
            .arg("--format")
            .arg("json")
            .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(parse_json(&output)["code"], "INVALID_REQUEST");
    }
}

#[test]
fn sharing_requires_one_visibility_flag() {
    let output = run(&["caps", "sharing", "set", "cap_synthetic"]);
    assert_eq!(output.status.code(), Some(2));
    let output = run(&[
        "caps",
        "sharing",
        "set",
        "cap_synthetic",
        "--public",
        "--private",
    ]);
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn agent_installer_dry_run_is_machine_readable() {
    let output = run(&[
        "agents",
        "install",
        "--target",
        "codex",
        "--component",
        "all",
        "--dry-run",
        "--yes",
        "--format",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["target"], "codex");
    assert_eq!(json["dryRun"], true);
    assert_eq!(json["applied"], false);
    assert_eq!(json["changes"].as_array().map(Vec::len), Some(2));
}

#[test]
fn new_commands_emit_json_errors_for_local_format_flag() {
    let caps_output = cap()
        .args(["caps", "get", "!", "--format", "json"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .output()
        .unwrap();
    assert_eq!(caps_output.status.code(), Some(1));
    assert_eq!(parse_json(&caps_output)["code"], "INVALID_REQUEST");

    let auth_output = run(&["auth", "login", "--timeout", "0", "--format", "json"]);
    assert_eq!(auth_output.status.code(), Some(1));
    assert!(parse_json(&auth_output)["error"].is_string());

    let home = tempfile::tempdir().unwrap();
    let installer_output = cap()
        .args([
            "agents",
            "install",
            "--target",
            "codex",
            "--component",
            "skill",
            "--format",
            "json",
        ])
        .env("HOME", home.path())
        .env("CODEX_HOME", home.path().join(".codex"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(installer_output.status.code(), Some(1));
    assert!(parse_json(&installer_output)["error"].is_string());
}

#[test]
fn mcp_stdout_is_protocol_only_and_exposes_expected_tools() {
    let mut command = cap();
    command
        .args(["mcp", "serve"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .env("CAP_SERVER_URL", "http://127.0.0.1:9")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("failed to start MCP server");
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "cap-test", "version": "1" }
            }
        })
    )
    .unwrap();
    stdin.flush().unwrap();
    let initialize = receiver.recv_timeout(Duration::from_secs(10));
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        })
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        })
    )
    .unwrap();
    stdin.flush().unwrap();
    let tools = receiver.recv_timeout(Duration::from_secs(10));
    let _ = child.kill();
    let _ = child.wait();

    let initialize: Value = serde_json::from_str(&initialize.unwrap().unwrap()).unwrap();
    assert_eq!(initialize["id"], 1);
    assert_eq!(initialize["result"]["serverInfo"]["name"], "cap");
    let tools: Value = serde_json::from_str(&tools.unwrap().unwrap()).unwrap();
    assert_eq!(tools["id"], 2);
    let tool_list = tools["result"]["tools"].as_array().unwrap();
    let tool = |name: &str| {
        tool_list
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("missing MCP tool {name}"))
    };
    assert_eq!(tool("caps_list")["annotations"]["idempotentHint"], true);
    assert_eq!(
        tool("caps_import_loom")["annotations"]["idempotentHint"],
        false
    );
    for tool in tool_list {
        if tool["annotations"]["readOnlyHint"] == false {
            assert_eq!(
                tool["annotations"]["idempotentHint"], false,
                "mutating MCP tool {} must not claim cross-invocation idempotency",
                tool["name"]
            );
        }
    }
    let serialized = serde_json::to_string(tool_list).unwrap();
    for name in [
        "caps_list",
        "caps_get",
        "caps_context",
        "caps_wait",
        "caps_import_loom",
        "caps_comment",
        "caps_reply",
        "caps_react",
        "caps_update_title",
        "caps_set_visibility",
        "account_referrals_open",
        "organizations_list",
        "organization_create",
        "organization_billing_checkout",
        "organization_billing_portal",
        "organization_storage_provider_set",
        "organization_google_drive_connect",
        "organization_google_drive_folders",
        "organization_google_drive_location_set",
        "organization_google_drive_disconnect",
        "organization_update",
        "organization_settings_update",
        "organization_invite_add",
        "organization_member_role",
        "organization_member_seat",
        "organization_delete",
        "organization_domain_set",
        "organization_domain_remove",
        "organization_domain_verify",
        "collection_public_page_update",
        "developer_apps_list",
        "developer_videos_list",
        "developer_transactions_list",
        "developer_video_delete",
        "developer_video_upload",
        "developer_transcript_create",
        "developer_transcript_get",
        "developer_transcript_wait",
        "developer_transcripts_list",
        "developer_transcript_delete",
        "developer_app_update",
        "developer_domain_add",
        "developer_auto_top_up_update",
        "developer_credits_checkout",
    ] {
        assert!(serialized.contains(name), "missing MCP tool {name}");
    }
    assert!(!serialized.to_lowercase().contains("password"));
    assert!(!serialized.contains("access_key_id"));
    assert!(!serialized.contains("secret_access_key"));
    assert!(!serialized.contains("image_data"));
}

#[test]
fn mcp_cancellation_stops_wait_polling() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let server_url = format!("http://{}", listener.local_addr().unwrap());
    let request_count = Arc::new(AtomicUsize::new(0));
    let server_request_count = request_count.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            server_request_count.fetch_add(1, Ordering::SeqCst);
            let body = r#"{"transcript":{"status":"processing"},"ai":{"status":"processing"}}"#;
            write!(
				stream,
				"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
				body.len(),
				body
			)
			.unwrap();
            stream.flush().unwrap();
        }
    });

    let mut command = cap();
    command
        .args(["mcp", "serve"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .env("CAP_SERVER_URL", server_url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("failed to start MCP server");
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut stdin = child.stdin.take().unwrap();
    for message in [
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "cap-test", "version": "1" }
            }
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "caps_wait",
                "arguments": { "cap": "cap_synthetic", "timeout_seconds": 60 }
            }
        }),
    ] {
        writeln!(stdin, "{message}").unwrap();
    }
    stdin.flush().unwrap();
    let initialize: Value = serde_json::from_str(
        &receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(initialize["id"], 1);
    for _ in 0..50 {
        if request_count.load(Ordering::SeqCst) > 0 {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    for message in [
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": 3, "reason": "test" }
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/list",
            "params": {}
        }),
    ] {
        writeln!(stdin, "{message}").unwrap();
    }
    stdin.flush().unwrap();
    let mut list_response = None;
    for _ in 0..3 {
        let response: Value = serde_json::from_str(
            &receiver
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        if response["id"] == 4 {
            list_response = Some(response);
            break;
        }
    }
    thread::sleep(Duration::from_millis(750));
    let _ = child.kill();
    let _ = child.wait();
    assert!(list_response.is_some());
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
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
    #[cfg(target_os = "macos")]
    assert_eq!(
        ids,
        [
            "ffmpeg",
            "screenRecordingPermission",
            "screenCaptureKit",
            "cliInstall"
        ]
    );

    #[cfg(not(target_os = "macos"))]
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

#[test]
fn auth_status_recognizes_agent_environment_credentials() {
    let output = cap()
        .args(["auth", "status", "--json"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_agent_status")
        .env("CAP_SERVER_URL", "http://127.0.0.1:9876")
        .output()
        .unwrap();
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["authenticated"], false);
    assert_eq!(json["credentialPresent"], true);
    assert_eq!(json["serverVerified"], false);
    assert_eq!(json["verificationStatus"], "unavailable");
    assert_eq!(json["source"], "env");
    assert_eq!(json["server"], "http://127.0.0.1:9876");
    assert!(!stdout(&output).contains("cap_cli_synthetic_agent_status"));
}

#[test]
fn auth_status_verifies_agent_credentials_with_the_server() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let server_url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let length = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..length]);
        assert!(request.starts_with("GET /api/v1/auth/status HTTP/1.1"));
        assert!(request.contains("authorization: Bearer cap_cli_synthetic_agent_status"));
        let body = r#"{"authenticated":true,"tokenKind":"agent","expiresAt":"2027-01-01T00:00:00.000Z","scopes":["caps:read"],"requestId":"request-test"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let output = cap()
        .args(["auth", "status", "--json"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_agent_status")
        .env("CAP_SERVER_URL", server_url)
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json = parse_json(&output);
    assert_eq!(json["authenticated"], true);
    assert_eq!(json["credentialPresent"], true);
    assert_eq!(json["serverVerified"], true);
    assert_eq!(json["verificationStatus"], "verified");
    assert_eq!(json["expiresAt"], "2027-01-01T00:00:00.000Z");
    assert_eq!(json["scopes"], serde_json::json!(["caps:read"]));
    assert!(!stdout(&output).contains("cap_cli_synthetic_agent_status"));
}

#[test]
fn agent_credentials_reject_insecure_remote_servers() {
    let output = cap()
        .args(["caps", "list", "--json"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_agent_status")
        .env("CAP_SERVER_URL", "http://example.com")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("require HTTPS"));
}

#[test]
fn auth_login_defaults_to_the_creator_profile() {
    let output = run(&["auth", "login", "--help"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert!(stdout(&output).contains("[default: creator]"));
}

fn write_test_media(path: &Path) {
    use ffmpeg::format::Pixel;
    ffmpeg::init().unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut output = ffmpeg::format::output(path).unwrap();
    let codec = ffmpeg::encoder::find(ffmpeg::codec::Id::MPEG4).unwrap();
    let mut encoder = ffmpeg::codec::Context::new_with_codec(codec)
        .encoder()
        .video()
        .unwrap();
    encoder.set_width(32);
    encoder.set_height(32);
    encoder.set_format(Pixel::YUV420P);
    encoder.set_time_base((1, 30));
    encoder.set_frame_rate(Some((30, 1)));
    encoder.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
    let mut encoder = encoder.open_as(codec).unwrap();
    output.add_stream(codec).unwrap().set_parameters(&encoder);
    output.write_header().unwrap();
    let output_time_base = output.stream(0).unwrap().time_base();
    {
        let mut drain = |encoder: &mut ffmpeg::encoder::video::Encoder, finished: bool| loop {
            let mut packet = ffmpeg::Packet::empty();
            match encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    packet.set_stream(0);
                    packet.rescale_ts((1, 30), output_time_base);
                    packet.write_interleaved(&mut output).unwrap();
                }
                Err(ffmpeg::Error::Other { errno })
                    if !finished && errno == ffmpeg::ffi::EAGAIN =>
                {
                    break;
                }
                Err(ffmpeg::Error::Eof) if finished => break,
                Err(error) => panic!("test media encoding failed: {error}"),
            }
        };
        for index in 0..30 {
            let mut frame = ffmpeg::frame::Video::new(Pixel::YUV420P, 32, 32);
            frame.data_mut(0).fill(32 + index as u8);
            frame.data_mut(1).fill(128);
            frame.data_mut(2).fill(128);
            frame.set_pts(Some(index));
            encoder.send_frame(&frame).unwrap();
            drain(&mut encoder, false);
        }
        encoder.send_eof().unwrap();
        drain(&mut encoder, true);
    }
    output.write_trailer().unwrap();
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

#[test]
fn caps_json_errors_include_the_standard_error_field() {
    for flags in [&["--json"][..], &["--format", "json"][..]] {
        let output = cap()
            .args(["caps", "get", "!"])
            .args(flags)
            .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
            .env("CAP_SERVER_URL", "http://127.0.0.1:9")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let error = parse_json(&output);
        assert_eq!(error["error"], "Cap ID contains invalid characters");
        assert_eq!(error["message"], "Cap ID contains invalid characters");
        assert_eq!(error["code"], "INVALID_REQUEST");
        assert_eq!(error["retryable"], false);
    }
}

const INFRA_APP: &str = "app000000000001";
const INFRA_VIDEO: &str = "vid000000000001";
const INFRA_DASH_VIDEO: &str = "-Vid0000000dash";
const INFRA_FAILED_VIDEO: &str = "vidfailed000001";
const INFRA_SLOW_VIDEO: &str = "vidslow00000001";
const INFRA_STALLED_VIDEO: &str = "vidstall0000001";
const INFRA_STALLED_TRANSCRIPT: &str = "trstall00000001";
const INFRA_STALL: Duration = Duration::from_secs(4);
const INFRA_TRANSCRIPT: &str = "tr0000000000001";
const INFRA_DASH_TRANSCRIPT: &str = "-EDG5hrbuAwXDNY";
const INFRA_FAILED_TRANSCRIPT: &str = "trfailed0000001";
const INFRA_NO_SCOPE_TOKEN: &str = "cap_cli_synthetic_no_scope_token";
const INFRA_APP_NOT_FOUND: &str =
    "Developer app not found. Run `cap developers list` to see your apps.";
const INFRA_SCOPE_HINT: &str = "Run `cap auth login --profile full` and approve it in the browser, or create a CLI API key with the full profile in Cap under Settings, Account and set it as CAP_AGENT_TOKEN.";

#[derive(Default)]
struct InfraStubState {
    requests: Vec<String>,
    reads: std::collections::HashMap<String, usize>,
}

struct InfraStub {
    url: String,
    state: Arc<std::sync::Mutex<InfraStubState>>,
}

impl InfraStub {
    fn requests(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }

    fn writes(&self) -> Vec<String> {
        self.requests()
            .into_iter()
            .filter(|request| !request.starts_with("GET "))
            .collect()
    }
}

fn infra_error(status: u16, code: &str, message: &str) -> (u16, Value) {
    (
        status,
        serde_json::json!({
            "code": code,
            "message": message,
            "retryable": false,
            "retryAfterMs": null,
            "requestId": "req_stub",
        }),
    )
}

fn infra_video(base: &str, id: &str, status: &str) -> Value {
    let ready = status == "ready";
    let playback = format!("{base}/api/developer/playback/pb-{id}");
    let file = |name: &str| {
        if ready {
            Value::String(format!("{playback}/{name}"))
        } else {
            Value::Null
        }
    };
    serde_json::json!({
        "id": id,
        "appId": INFRA_APP,
        "externalUserId": null,
        "name": "demo",
        "status": status,
        "errorReason": if status == "errored" {
            Value::String("The file could not be decoded".to_string())
        } else {
            Value::Null
        },
        "playbackId": format!("pb-{id}"),
        "durationSeconds": 1.0,
        "width": 32,
        "height": 32,
        "fps": 30,
        "maxResolutionTier": "1080p",
        "renditions": if ready {
            serde_json::json!([{
                "name": "360p",
                "width": 32,
                "height": 32,
                "bitrate": 400_000,
                "bytes": 50_000,
                "codecs": "avc1.64001f",
            }])
        } else {
            serde_json::json!([])
        },
        "transcriptionStatus": null,
        "hlsUrl": file("master.m3u8"),
        "mp4Url": file("video.mp4"),
        "posterUrl": file("poster.jpg"),
        "shareUrl": format!("{base}/dev/pb-{id}"),
        "embedUrl": format!("{base}/dev/pb-{id}/embed"),
        "createdAt": "2026-11-12T10:00:00.000Z",
        "updatedAt": "2026-11-12T10:00:09.000Z",
    })
}

fn infra_transcript(id: &str, status: &str) -> Value {
    let failed = status == "error";
    serde_json::json!({
        "id": id,
        "appId": INFRA_APP,
        "status": status,
        "name": "talk",
        "sourceType": "url",
        "sourceUrl": "https://example.com/talk.mp3",
        "durationSeconds": if status == "complete" { serde_json::json!(11.75) } else { Value::Null },
        "language": if status == "complete" { serde_json::json!("en") } else { Value::Null },
        "wordCount": if status == "complete" { serde_json::json!(5) } else { Value::Null },
        "costMicroCredits": if status == "complete" { 33 } else { 0 },
        "errorCode": if failed { serde_json::json!("source_unreachable") } else { Value::Null },
        "errorMessage": if failed { serde_json::json!("The URL answered 404") } else { Value::Null },
        "externalUserId": null,
        "createdAt": "2026-11-12T10:00:00.000Z",
        "updatedAt": "2026-11-12T10:00:06.000Z",
        "completedAt": if status == "complete" {
            serde_json::json!("2026-11-12T10:00:06.000Z")
        } else {
            Value::Null
        },
    })
}

fn infra_capabilities() -> Value {
    let action = serde_json::json!({
        "allowed": true,
        "reason": null,
        "requiredScopes": ["developer:write"],
        "confirmation": "user",
        "sideEffect": "write",
        "idempotencyRequired": true,
        "asynchronous": false,
    });
    serde_json::json!({
        "read": action,
        "update": action,
        "rotateSecrets": action,
        "purchaseCredits": action,
        "deleteVideos": action,
        "uploadVideos": action,
        "transcribe": action,
        "deleteTranscripts": action,
    })
}

fn infra_respond(
    state: &mut InfraStubState,
    base: &str,
    method: &str,
    target: &str,
    authorization: &str,
    body: &[u8],
) -> (u16, Value) {
    let path = target.split('?').next().unwrap_or_default();
    if method == "PUT" && path == "/upload/object" {
        return (200, Value::Null);
    }
    let Some(route) = path.strip_prefix("/api/v1/developer/apps") else {
        return infra_error(404, "NOT_FOUND", "No such route");
    };
    if authorization.ends_with(INFRA_NO_SCOPE_TOKEN) {
        let scope = if method == "GET" {
            "developer:read"
        } else {
            "developer:write"
        };
        let (status, mut error) = infra_error(
            403,
            "FORBIDDEN",
            &format!("The {scope} permission is required. {INFRA_SCOPE_HINT}"),
        );
        error["hint"] = Value::String(INFRA_SCOPE_HINT.to_string());
        error["requiredScopes"] = serde_json::json!([scope]);
        return (status, error);
    }
    if route.is_empty() {
        return (
            200,
            serde_json::json!({
                "apps": [{
                    "id": INFRA_APP,
                    "name": "Console checks agent",
                    "environment": "development",
                    "logoUrl": null,
                    "createdAt": "2026-11-01T00:00:00.000Z",
                    "updatedAt": "2026-11-01T00:00:00.000Z",
                }],
                "capabilities": infra_capabilities(),
                "requestId": "req_stub",
            }),
        );
    }
    let segments = route.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if segments.first() != Some(&INFRA_APP) {
        return infra_error(404, "NOT_FOUND", INFRA_APP_NOT_FOUND);
    }
    let mutation = |kind: &str, id: &str, action: &str| {
        (
            200,
            serde_json::json!({
                "resource": { "type": kind, "id": id, "revision": null },
                "action": action,
                "requestId": "req_stub",
            }),
        )
    };
    let reads = |state: &mut InfraStubState, key: &str| {
        let count = state.reads.entry(key.to_string()).or_default();
        *count += 1;
        *count
    };
    match (method, &segments[1..]) {
        ("GET", ["context"]) => (
            200,
            serde_json::json!({
                "app": {
                    "id": INFRA_APP,
                    "name": "Console checks agent",
                    "environment": "development",
                    "logoUrl": null,
                    "createdAt": "2026-11-01T00:00:00.000Z",
                    "updatedAt": "2026-11-01T00:00:00.000Z",
                    "capabilities": infra_capabilities(),
                },
                "domains": [{
                    "id": "dom000000000001",
                    "domain": "https://app.example.com",
                    "createdAt": "2026-11-01T00:00:00.000Z",
                }],
                "keys": [
                    {
                        "id": "key1",
                        "keyType": "public",
                        "keyPrefix": "cpk_abcdefgh",
                        "lastUsedAt": null,
                        "revokedAt": null,
                        "createdAt": "2026-11-01T00:00:00.000Z",
                    },
                    {
                        "id": "key0",
                        "keyType": "secret",
                        "keyPrefix": "csk_oldoldol",
                        "lastUsedAt": null,
                        "revokedAt": "2026-11-02T00:00:00.000Z",
                        "createdAt": "2026-11-01T00:00:00.000Z",
                    },
                ],
                "usage": { "videoCount": 2, "storageMinutes": 0.2 },
                "credits": {
                    "balanceMicroCredits": 999_868,
                    "autoTopUpEnabled": false,
                    "autoTopUpThresholdMicroCredits": 0,
                    "autoTopUpAmountCents": 0,
                    "cardSaved": false,
                },
                "billingHint": null,
                "billing": {
                    "standing": { "state": "active", "pausesAt": null },
                    "upload": {
                        "allowed": true,
                        "reason": null,
                        "requiredMicroCredits": 4,
                        "shortfallMicroCredits": 0,
                        "message": null,
                    },
                    "storage": {
                        "minutesByTier": { "1080p": 0.2, "1440p": 0, "2160p": 0 },
                        "dailyMicroCredits": 1,
                        "monthlyMicroCredits": 17,
                    },
                },
                "requestId": "req_stub",
            }),
        ),
        ("GET", ["videos"]) => (
            200,
            serde_json::json!({
                "videos": [
                    infra_video(base, INFRA_VIDEO, "ready"),
                    infra_video(base, INFRA_SLOW_VIDEO, "processing"),
                ],
                "capabilities": infra_capabilities(),
                "nextCursor": null,
                "requestId": "req_stub",
            }),
        ),
        ("POST", ["videos"]) => {
            let payload: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let id = match payload.get("name").and_then(Value::as_str) {
                Some("fails") => INFRA_FAILED_VIDEO,
                Some("slow") => INFRA_SLOW_VIDEO,
                _ => INFRA_VIDEO,
            };
            (
                200,
                serde_json::json!({
                    "video": {
                        "id": id,
                        "appId": INFRA_APP,
                        "name": "demo",
                        "playbackId": format!("pb-{id}"),
                    },
                    "upload": {
                        "method": "PUT",
                        "url": format!("{base}/upload/object"),
                        "headers": { "Content-Type": "video/mp4" },
                        "expiresAt": "2026-11-12T11:00:00.000Z",
                    },
                    "requestId": "req_stub",
                }),
            )
        }
        ("POST", ["videos", id, "complete"]) => (
            200,
            serde_json::json!({
                "video": infra_video(base, id, "processing"),
                "requestId": "req_stub",
            }),
        ),
        ("GET", ["videos", id]) => {
            let status = match *id {
                INFRA_FAILED_VIDEO => "errored",
                INFRA_SLOW_VIDEO => "processing",
                INFRA_VIDEO => {
                    if reads(state, id) % 2 == 1 {
                        "processing"
                    } else {
                        "ready"
                    }
                }
                INFRA_DASH_VIDEO | INFRA_STALLED_VIDEO => "ready",
                _ => {
                    return infra_error(404, "NOT_FOUND", "Video not found in this developer app");
                }
            };
            (
                200,
                serde_json::json!({
                    "video": infra_video(base, id, status),
                    "requestId": "req_stub",
                }),
            )
        }
        ("DELETE", ["videos", id]) => mutation("developer_video", id, "deleted"),
        ("GET", ["transcripts"]) => (
            200,
            serde_json::json!({
                "transcripts": [infra_transcript(INFRA_TRANSCRIPT, "complete")],
                "nextCursor": null,
                "requestId": "req_stub",
            }),
        ),
        ("POST", ["transcripts"]) => {
            let payload: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let missing = payload
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| url.contains("missing"));
            let id = if missing {
                INFRA_FAILED_TRANSCRIPT
            } else {
                INFRA_TRANSCRIPT
            };
            (
                200,
                serde_json::json!({
                    "transcript": infra_transcript(id, "queued"),
                    "upload": null,
                    "requestId": "req_stub",
                }),
            )
        }
        ("GET", ["transcripts", id]) => {
            let status = match *id {
                INFRA_FAILED_TRANSCRIPT => "error",
                INFRA_TRANSCRIPT => {
                    if reads(state, id) % 2 == 1 {
                        "queued"
                    } else {
                        "complete"
                    }
                }
                INFRA_DASH_TRANSCRIPT | INFRA_STALLED_TRANSCRIPT => "complete",
                _ => {
                    return infra_error(
                        404,
                        "NOT_FOUND",
                        "Transcript not found in this developer app",
                    );
                }
            };
            (
                200,
                serde_json::json!({
                    "transcript": infra_transcript(id, status),
                    "text": if status == "complete" {
                        serde_json::json!("Cap Infra turns speech into text.")
                    } else {
                        Value::Null
                    },
                    "segments": null,
                    "requestId": "req_stub",
                }),
            )
        }
        ("DELETE", ["transcripts", id]) => mutation("developer_transcript", id, "deleted"),
        ("GET", ["transactions"]) => (
            200,
            serde_json::json!({
                "transactions": [{
                    "id": "txn1",
                    "type": "transcription",
                    "amountMicroCredits": -33,
                    "balanceAfterMicroCredits": 999_868,
                    "referenceId": INFRA_TRANSCRIPT,
                    "referenceType": "developer_transcript",
                    "createdAt": "2026-11-12T10:00:06.000Z",
                }],
                "nextCursor": null,
                "requestId": "req_stub",
            }),
        ),
        ("DELETE", []) => mutation("developer_app", INFRA_APP, "deleted"),
        ("POST", ["keys", "rotate"]) => mutation("developer_app", INFRA_APP, "rotated"),
        ("DELETE", ["domains", id]) => mutation("developer_domain", id, "deleted"),
        _ => infra_error(404, "NOT_FOUND", "No such route"),
    }
}

fn start_infra_stub() -> InfraStub {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(std::sync::Mutex::new(InfraStubState::default()));
    let server_state = state.clone();
    let base = url.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let state = server_state.clone();
            let base = base.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    return;
                }
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let target = parts.next().unwrap_or_default().to_string();
                let mut length = 0_usize;
                let mut authorization = String::new();
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap_or(0);
                        } else if name.eq_ignore_ascii_case("authorization") {
                            authorization = value.trim().to_string();
                        }
                    }
                }
                let mut body = vec![0; length];
                if reader.read_exact(&mut body).is_err() {
                    return;
                }
                if target.contains("stall") {
                    thread::sleep(INFRA_STALL);
                }
                let (status, value) = {
                    let mut state = state.lock().unwrap();
                    state.requests.push(format!("{method} {target}"));
                    infra_respond(&mut state, &base, &method, &target, &authorization, &body)
                };
                let payload = if value.is_null() {
                    String::new()
                } else {
                    value.to_string()
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} Stub\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = stream.flush();
            });
        }
    });
    InfraStub { url, state }
}

fn infra_cap(stub: &InfraStub, args: &[&str]) -> Output {
    cap()
        .args(args)
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .env("CAP_SERVER_URL", &stub.url)
        .stdin(Stdio::null())
        .output()
        .expect("failed to spawn cap binary")
}

fn single_json_error(output: &Output) -> Value {
    assert!(!output.status.success(), "expected a failure");
    let value = parse_json(output);
    assert!(value.is_object(), "stdout must be one JSON object");
    assert!(value["error"].is_string());
    assert!(value["code"].is_string());
    assert_eq!(value["error"], value["message"]);
    value
}

#[test]
fn developer_journey_runs_without_the_dashboard_in_json_and_text() {
    let directory = tempfile::tempdir().unwrap();
    let media = directory.path().join("demo.mp4");
    write_test_media(&media);
    let media = media.to_str().unwrap();

    for json in [true, false] {
        let stub = start_infra_stub();
        let run = |args: &[&str]| {
            let mut args = args.to_vec();
            if json {
                args.push("--json");
            }
            let output = infra_cap(&stub, &args);
            assert!(
                output.status.success(),
                "cap {args:?} failed: {}",
                stderr(&output)
            );
            println!("$ cap {}\n{}", args.join(" "), stdout(&output));
            output
        };

        let apps = parse_json(&run(&["developers", "list"]));
        assert_eq!(apps["apps"][0]["id"], INFRA_APP);
        assert!(apps["apps"][0].get("capabilities").is_none());

        let uploaded = parse_json(&run(&[
            "developers",
            "videos",
            "upload",
            INFRA_APP,
            media,
            "--wait",
            "--yes",
        ]));
        assert_eq!(uploaded["video"]["id"], INFRA_VIDEO);
        assert_eq!(uploaded["video"]["status"], "ready");
        let share = format!("{}/dev/pb-{INFRA_VIDEO}", stub.url);
        assert_eq!(uploaded["video"]["shareUrl"], share.as_str());
        assert_eq!(
            uploaded["video"]["embedUrl"],
            format!("{share}/embed").as_str()
        );
        assert!(uploaded["video"]["hlsUrl"].is_string());
        assert!(uploaded["video"]["mp4Url"].is_string());
        assert_eq!(uploaded["video"]["durationSeconds"], 1.0);
        assert_eq!(uploaded["video"]["width"], 32);

        let fetched = parse_json(&run(&[
            "developers",
            "videos",
            "get",
            INFRA_APP,
            INFRA_VIDEO,
        ]));
        assert_eq!(fetched["video"]["playbackId"], format!("pb-{INFRA_VIDEO}"));

        let waited = parse_json(&run(&[
            "developers",
            "videos",
            "wait",
            INFRA_APP,
            INFRA_VIDEO,
        ]));
        assert_eq!(waited["video"]["status"], "ready");

        let listed = parse_json(&run(&["developers", "videos", "list", INFRA_APP]));
        assert_eq!(listed["videos"][0]["status"], "ready");
        assert_eq!(listed["videos"][1]["status"], "processing");
        assert!(listed["videos"][0]["playbackId"].is_string());
        assert!(listed["videos"][0]["shareUrl"].is_string());

        let created = run(&[
            "developers",
            "transcripts",
            "create",
            INFRA_APP,
            "--url",
            "https://example.com/talk.mp3",
            "--wait",
            "--yes",
        ]);
        let text = run(&[
            "developers",
            "transcripts",
            "text",
            INFRA_APP,
            INFRA_DASH_TRANSCRIPT,
        ]);
        if json {
            assert_eq!(parse_json(&created)["transcript"]["status"], "complete");
            assert_eq!(
                parse_json(&text)["text"],
                "Cap Infra turns speech into text."
            );
        } else {
            assert_eq!(stdout(&created), "Cap Infra turns speech into text.\n");
            assert_eq!(stdout(&text), "Cap Infra turns speech into text.\n");
        }

        let usage = parse_json(&run(&["developers", "usage", INFRA_APP]));
        assert_eq!(usage["usage"]["videoCount"], 2);
        assert_eq!(usage["credits"]["balanceMicroCredits"], 999_868);
        assert_eq!(usage["billing"]["upload"]["allowed"], true);
        assert!(usage.get("keys").is_none());

        let transactions = parse_json(&run(&["developers", "transactions", INFRA_APP]));
        assert_eq!(
            transactions["transactions"][0]["referenceId"],
            INFRA_TRANSCRIPT
        );

        let requests = stub.requests();
        assert!(requests.contains(&format!("POST /api/v1/developer/apps/{INFRA_APP}/videos")));
        assert!(requests.contains(&"PUT /upload/object".to_string()));
        assert!(requests.contains(&format!(
            "POST /api/v1/developer/apps/{INFRA_APP}/videos/{INFRA_VIDEO}/complete"
        )));
    }
}

#[test]
fn developer_failures_print_one_json_object_on_stdout() {
    let stub = start_infra_stub();
    let directory = tempfile::tempdir().unwrap();
    let media = directory.path().join("demo.mp4");
    write_test_media(&media);
    let media = media.to_str().unwrap();

    let unconfirmed = infra_cap(&stub, &["developers", "delete", INFRA_APP, "--json"]);
    assert_eq!(unconfirmed.status.code(), Some(1));
    let error = single_json_error(&unconfirmed);
    assert_eq!(error["code"], "APPROVAL_REQUIRED");
    assert!(error["hint"].as_str().unwrap().contains("--yes"));

    for args in [
        vec!["developers", "get", "nosuchapp123456"],
        vec!["developers", "usage", "nosuchapp123456"],
        vec!["developers", "videos", "list", "nosuchapp123456"],
        vec![
            "developers",
            "videos",
            "get",
            "nosuchapp123456",
            INFRA_VIDEO,
        ],
        vec!["developers", "transactions", "nosuchapp123456"],
        vec!["developers", "transcripts", "list", "nosuchapp123456"],
        vec!["developers", "delete", "nosuchapp123456", "--yes"],
        vec!["developers", "delete", "nosuchapp123456", "--dry-run"],
        vec![
            "developers",
            "videos",
            "delete",
            "nosuchapp123456",
            INFRA_VIDEO,
            "--yes",
        ],
    ] {
        let mut args = args;
        args.push("--json");
        let output = infra_cap(&stub, &args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        let error = single_json_error(&output);
        assert_eq!(error["code"], "NOT_FOUND", "{args:?}");
        assert_eq!(error["message"], INFRA_APP_NOT_FOUND, "{args:?}");
        assert_eq!(error["requestId"], "req_stub", "{args:?}");
    }

    let no_scope = cap()
        .args(["developers", "list", "--json"])
        .env("CAP_AGENT_TOKEN", INFRA_NO_SCOPE_TOKEN)
        .env("CAP_SERVER_URL", &stub.url)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let error = single_json_error(&no_scope);
    assert_eq!(error["code"], "FORBIDDEN");
    assert_eq!(error["hint"], INFRA_SCOPE_HINT);
    assert_eq!(error["requestId"], "req_stub");
    let no_scope_text = cap()
        .args(["developers", "list"])
        .env("CAP_AGENT_TOKEN", INFRA_NO_SCOPE_TOKEN)
        .env("CAP_SERVER_URL", &stub.url)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(no_scope_text.stdout.is_empty());
    assert!(stderr(&no_scope_text).contains("cap auth login --profile full"));

    let failed_transcript = infra_cap(
        &stub,
        &[
            "developers",
            "transcripts",
            "create",
            INFRA_APP,
            "--url",
            "https://example.com/missing.mp3",
            "--wait",
            "--yes",
            "--json",
        ],
    );
    let error = single_json_error(&failed_transcript);
    assert_eq!(error["code"], "TRANSCRIPT_FAILED");
    assert_eq!(error["transcriptId"], INFRA_FAILED_TRANSCRIPT);
    assert!(error["message"].as_str().unwrap().contains("404"));

    let failed_upload = infra_cap(
        &stub,
        &[
            "developers",
            "videos",
            "upload",
            INFRA_APP,
            media,
            "--name",
            "fails",
            "--wait",
            "--yes",
            "--json",
        ],
    );
    let error = single_json_error(&failed_upload);
    assert_eq!(error["code"], "VIDEO_FAILED");
    assert_eq!(error["videoId"], INFRA_FAILED_VIDEO);
    assert_eq!(error["message"], "The file could not be decoded");

    let timed_out = infra_cap(
        &stub,
        &[
            "developers",
            "videos",
            "upload",
            INFRA_APP,
            media,
            "--name",
            "slow",
            "--wait",
            "--timeout-seconds",
            "1",
            "--yes",
            "--json",
        ],
    );
    let error = single_json_error(&timed_out);
    assert_eq!(error["code"], "NOT_READY");
    assert_eq!(error["retryable"], true);
    assert_eq!(error["videoId"], INFRA_SLOW_VIDEO);
    assert_eq!(error["status"], "processing");
    assert!(error["hint"].as_str().unwrap().contains(&format!(
        "cap developers videos wait {INFRA_APP} {INFRA_SLOW_VIDEO}"
    )));
    let timed_out_text = infra_cap(
        &stub,
        &[
            "developers",
            "videos",
            "wait",
            INFRA_APP,
            INFRA_SLOW_VIDEO,
            "--timeout-seconds",
            "1",
        ],
    );
    assert_eq!(timed_out_text.status.code(), Some(1));
    assert!(timed_out_text.stdout.is_empty());
    assert!(stderr(&timed_out_text).contains(&format!("videoId: {INFRA_SLOW_VIDEO}")));

    let bad_limit = infra_cap(
        &stub,
        &[
            "developers",
            "videos",
            "list",
            INFRA_APP,
            "--limit",
            "0",
            "--json",
        ],
    );
    assert_eq!(single_json_error(&bad_limit)["code"], "INVALID_REQUEST");

    let local_format = infra_cap(
        &stub,
        &["developers", "get", "nosuchapp123456", "--format", "json"],
    );
    assert_eq!(single_json_error(&local_format)["code"], "NOT_FOUND");

    let usage = infra_cap(&stub, &["developers", "videos", "get", INFRA_APP, "--json"]);
    assert_eq!(usage.status.code(), Some(2));
    let error = single_json_error(&usage);
    assert_eq!(error["code"], "USAGE");
    assert!(error["message"].as_str().unwrap().contains("<VIDEO>"));

    let unknown = infra_cap(&stub, &["developers", "videos", "status", "--json"]);
    assert_eq!(unknown.status.code(), Some(2));
    assert_eq!(single_json_error(&unknown)["code"], "USAGE");

    let unreachable = cap()
        .args(["developers", "list", "--json"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .env("CAP_SERVER_URL", "http://127.0.0.1:9")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let error = single_json_error(&unreachable);
    assert_eq!(error["code"], "TEMPORARY_UNAVAILABLE");
    assert_eq!(error["retryable"], true);
    assert!(error["hint"].is_string());
}

#[test]
fn commands_without_their_own_json_errors_still_print_one() {
    let output = cap()
        .args(["account", "get", "--json"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .env("CAP_SERVER_URL", "http://127.0.0.1:9")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let error = single_json_error(&output);
    assert_eq!(error["code"], "TEMPORARY_UNAVAILABLE");

    let text = cap()
        .args(["account", "get"])
        .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
        .env("CAP_SERVER_URL", "http://127.0.0.1:9")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(text.status.code(), Some(1));
    assert!(text.stdout.is_empty());
}

#[test]
fn developer_ids_that_begin_with_a_dash_are_read_as_values() {
    let stub = start_infra_stub();
    for args in [
        vec![
            "developers",
            "transcripts",
            "wait",
            INFRA_APP,
            INFRA_DASH_TRANSCRIPT,
            "--json",
        ],
        vec![
            "developers",
            "transcripts",
            "wait",
            "--json",
            INFRA_APP,
            INFRA_DASH_TRANSCRIPT,
        ],
        vec![
            "developers",
            "transcripts",
            "get",
            INFRA_APP,
            INFRA_DASH_TRANSCRIPT,
            "--segments",
            "--json",
        ],
        vec![
            "developers",
            "transcripts",
            "text",
            INFRA_APP,
            INFRA_DASH_TRANSCRIPT,
            "--json",
        ],
        vec![
            "developers",
            "transcripts",
            "delete",
            INFRA_APP,
            INFRA_DASH_TRANSCRIPT,
            "--yes",
            "--json",
        ],
        vec![
            "developers",
            "videos",
            "get",
            INFRA_APP,
            INFRA_DASH_VIDEO,
            "--json",
        ],
        vec![
            "developers",
            "videos",
            "wait",
            INFRA_APP,
            INFRA_DASH_VIDEO,
            "--timeout-seconds",
            "5",
            "--json",
        ],
        vec![
            "developers",
            "videos",
            "delete",
            INFRA_APP,
            INFRA_DASH_VIDEO,
            "--yes",
            "--json",
        ],
        vec![
            "developers",
            "videos",
            "get",
            INFRA_APP,
            "-hAbc0000000001",
            "--json",
        ],
        vec![
            "developers",
            "videos",
            "get",
            INFRA_APP,
            "--Abc0000000001",
            "--json",
        ],
    ] {
        let output = infra_cap(&stub, &args);
        let value = parse_json(&output);
        let id = args[4.min(args.len() - 1)];
        if id.contains("Abc") {
            assert_eq!(value["code"], "NOT_FOUND", "{args:?}");
            assert_eq!(value["message"], "Video not found in this developer app");
        } else {
            assert!(output.status.success(), "{args:?}: {}", stderr(&output));
        }
    }
    let requests = stub.requests();
    for expected in [
        format!("GET /api/v1/developer/apps/{INFRA_APP}/transcripts/{INFRA_DASH_TRANSCRIPT}"),
        format!(
            "GET /api/v1/developer/apps/{INFRA_APP}/transcripts/{INFRA_DASH_TRANSCRIPT}?include=segments"
        ),
        format!("DELETE /api/v1/developer/apps/{INFRA_APP}/transcripts/{INFRA_DASH_TRANSCRIPT}"),
        format!("GET /api/v1/developer/apps/{INFRA_APP}/videos/{INFRA_DASH_VIDEO}"),
        format!("DELETE /api/v1/developer/apps/{INFRA_APP}/videos/{INFRA_DASH_VIDEO}"),
        format!("GET /api/v1/developer/apps/{INFRA_APP}/videos/-hAbc0000000001"),
        format!("GET /api/v1/developer/apps/{INFRA_APP}/videos/--Abc0000000001"),
    ] {
        assert!(requests.contains(&expected), "missing request {expected}");
    }
}

#[test]
fn developer_dry_runs_show_the_target_and_change_nothing() {
    let stub = start_infra_stub();
    let preview = |args: &[&str]| {
        let mut args = args.to_vec();
        args.extend(["--dry-run", "--json"]);
        let output = infra_cap(&stub, &args);
        assert!(output.status.success(), "{args:?}: {}", stderr(&output));
        let value = parse_json(&output);
        assert_eq!(value["dryRun"], true);
        value
    };

    let app = preview(&["developers", "delete", INFRA_APP]);
    assert_eq!(app["action"], "delete_developer_app");
    assert_eq!(app["target"]["name"], "Console checks agent");
    assert_eq!(app["target"]["videoCount"], 2);
    assert_eq!(app["target"]["domainCount"], 1);
    assert_eq!(
        app["target"]["activeKeys"],
        serde_json::json!([{ "keyType": "public", "keyPrefix": "cpk_abcdefgh" }])
    );

    let keys = preview(&["developers", "keys", "rotate", INFRA_APP]);
    assert_eq!(keys["action"], "rotate_developer_keys");
    assert_eq!(keys["target"]["activeKeys"][0]["keyPrefix"], "cpk_abcdefgh");

    let video = preview(&[
        "developers",
        "videos",
        "delete",
        INFRA_APP,
        INFRA_DASH_VIDEO,
    ]);
    assert_eq!(video["target"]["videoId"], INFRA_DASH_VIDEO);
    assert_eq!(video["target"]["status"], "ready");
    assert!(stub.requests().contains(&format!(
        "GET /api/v1/developer/apps/{INFRA_APP}/videos/{INFRA_DASH_VIDEO}?restart=false"
    )));

    let transcript = preview(&[
        "developers",
        "transcripts",
        "delete",
        INFRA_APP,
        INFRA_DASH_TRANSCRIPT,
    ]);
    assert_eq!(transcript["target"]["transcriptId"], INFRA_DASH_TRANSCRIPT);

    for domain in ["dom000000000001", "https://app.example.com"] {
        let removal = preview(&["developers", "domains", "remove", INFRA_APP, domain]);
        assert_eq!(removal["target"]["domainId"], "dom000000000001");
        assert_eq!(removal["target"]["domain"], "https://app.example.com");
    }
    assert_eq!(stub.writes(), Vec::<String>::new());

    let by_origin = infra_cap(
        &stub,
        &[
            "developers",
            "domains",
            "remove",
            INFRA_APP,
            "https://app.example.com",
            "--yes",
            "--json",
        ],
    );
    assert!(by_origin.status.success(), "{}", stderr(&by_origin));
    assert_eq!(
        stub.writes(),
        vec![format!(
            "DELETE /api/v1/developer/apps/{INFRA_APP}/domains/dom000000000001"
        )]
    );
}

#[test]
fn upload_help_points_at_the_developer_upload() {
    let top = stdout(&run(&["--help"]));
    assert!(top.contains("personal Cap library"));
    assert!(top.contains("Cap Infra"));
    let upload = stdout(&run(&["upload", "--help"]));
    assert!(upload.contains("personal Cap library"));
    assert!(upload.contains("cap developers videos upload"));
    let developers = stdout(&run(&["developers", "--help"]));
    assert!(developers.contains("Cap Infra"));
    assert!(developers.contains("100,000 micro-credits are $1"));
    for line in developers
        .lines()
        .skip_while(|line| !line.starts_with("Commands:"))
        .skip(1)
        .take_while(|line| !line.trim().is_empty())
    {
        let mut words = line.split_whitespace();
        let name = words.next().unwrap_or_default();
        assert!(
            words.next().is_some(),
            "`cap developers {name}` has no description"
        );
    }
}

struct McpSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: mpsc::Receiver<std::io::Result<String>>,
    next_id: u64,
}

impl McpSession {
    fn start(server_url: &str) -> Self {
        let mut child = cap()
            .args(["mcp", "serve"])
            .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
            .env("CAP_SERVER_URL", server_url)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to start MCP server");
        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take().unwrap();
        let mut session = Self {
            child,
            stdin,
            lines,
            next_id: 1,
        };
        session.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "cap-test", "version": "1" }
            }),
        );
        writeln!(
            session.stdin,
            "{}",
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {}
            })
        )
        .unwrap();
        session
    }

    fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(
            self.stdin,
            "{}",
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        )
        .unwrap();
        self.stdin.flush().unwrap();
        id
    }

    fn notify(&mut self, method: &str, params: Value) {
        writeln!(
            self.stdin,
            "{}",
            serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
        )
        .unwrap();
        self.stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> (Value, usize) {
        let id = self.send(method, params);
        self.receive(id)
    }

    fn notification(&mut self, method: &str) -> Value {
        loop {
            let line = self
                .lines
                .recv_timeout(Duration::from_secs(20))
                .expect("MCP server sent no notification")
                .unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["method"] == method {
                return value;
            }
        }
    }

    fn receive(&mut self, id: u64) -> (Value, usize) {
        loop {
            let line = self
                .lines
                .recv_timeout(Duration::from_secs(20))
                .expect("MCP server did not answer")
                .unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["id"] == id {
                return (value, line.len());
            }
        }
    }

    fn call(&mut self, name: &str, arguments: Value) -> (Value, usize) {
        let (response, bytes) = self.request(
            "tools/call",
            serde_json::json!({ "name": name, "arguments": arguments }),
        );
        (response["result"].clone(), bytes)
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn mcp_payload(result: &Value) -> Value {
    let content = result["content"].as_array().expect("tool result content");
    assert_eq!(content.len(), 1, "the payload must be returned once");
    assert!(
        result.get("structuredContent").is_none(),
        "the payload must not be repeated as structured content"
    );
    serde_json::from_str(content[0]["text"].as_str().unwrap()).unwrap()
}

#[test]
fn mcp_developer_tools_finish_the_job_and_return_each_result_once() {
    let stub = start_infra_stub();
    let directory = tempfile::tempdir().unwrap();
    let media = directory.path().join("demo.mp4");
    write_test_media(&media);
    let mut session = McpSession::start(&stub.url);

    let (tools, _) = session.request("tools/list", serde_json::json!({}));
    let tools = tools["result"]["tools"].as_array().unwrap().clone();
    let developer_tools = tools
        .iter()
        .filter(|tool| tool["name"].as_str().unwrap().starts_with("developer_"))
        .collect::<Vec<_>>();
    for name in ["developer_video_get", "developer_video_wait"] {
        assert!(
            developer_tools.iter().any(|tool| tool["name"] == name),
            "missing MCP tool {name}"
        );
    }
    for tool in &developer_tools {
        if let Some(properties) = tool["inputSchema"]["properties"].as_object() {
            for (argument, schema) in properties {
                assert!(
                    schema["description"].is_string(),
                    "{}.{argument} has no description",
                    tool["name"]
                );
            }
        }
    }

    let (listed, bytes) = session.call(
        "developer_videos_list",
        serde_json::json!({ "app_id": INFRA_APP }),
    );
    assert_eq!(listed["isError"], false);
    let payload = mcp_payload(&listed);
    assert_eq!(payload["videos"][0]["status"], "ready");
    assert!(payload["videos"][0]["playbackId"].is_string());
    assert!(payload["videos"][0].get("capabilities").is_none());
    println!("developer_videos_list response for 2 videos: {bytes} bytes");

    let (uploaded, _) = session.call(
        "developer_video_upload",
        serde_json::json!({
            "app_id": INFRA_APP,
            "file_path": media.to_str().unwrap(),
            "wait": true,
            "confirmed": true,
        }),
    );
    assert_eq!(uploaded["isError"], false, "{uploaded}");
    let payload = mcp_payload(&uploaded);
    assert_eq!(payload["video"]["status"], "ready");
    assert!(payload["video"]["shareUrl"].is_string());

    let (fetched, _) = session.call(
        "developer_video_get",
        serde_json::json!({ "app_id": INFRA_APP, "video_id": INFRA_DASH_VIDEO }),
    );
    assert_eq!(mcp_payload(&fetched)["video"]["id"], INFRA_DASH_VIDEO);

    let (failed, _) = session.call(
        "developer_video_wait",
        serde_json::json!({ "app_id": INFRA_APP, "video_id": INFRA_FAILED_VIDEO }),
    );
    assert_eq!(failed["isError"], true);
    let error = mcp_payload(&failed);
    assert_eq!(error["code"], "VIDEO_FAILED");
    assert_eq!(error["videoId"], INFRA_FAILED_VIDEO);

    let (timed_out, _) = session.call(
        "developer_video_wait",
        serde_json::json!({
            "app_id": INFRA_APP,
            "video_id": INFRA_SLOW_VIDEO,
            "timeout_seconds": 1,
        }),
    );
    let error = mcp_payload(&timed_out);
    assert_eq!(error["code"], "NOT_READY");
    assert_eq!(error["videoId"], INFRA_SLOW_VIDEO);

    let (failed_transcript, _) = session.call(
        "developer_transcript_create",
        serde_json::json!({
            "app_id": INFRA_APP,
            "url": "https://example.com/missing.mp3",
            "wait": true,
            "confirmed": true,
        }),
    );
    let error = mcp_payload(&failed_transcript);
    assert_eq!(error["code"], "TRANSCRIPT_FAILED");
    assert_eq!(error["transcriptId"], INFRA_FAILED_TRANSCRIPT);

    let (missing_app, _) = session.call(
        "developer_videos_list",
        serde_json::json!({ "app_id": "nosuchapp123456" }),
    );
    assert_eq!(missing_app["isError"], true);
    assert_eq!(mcp_payload(&missing_app)["message"], INFRA_APP_NOT_FOUND);

    let writes_before = stub.writes().len();
    let (preview, _) = session.call(
        "developer_app_delete",
        serde_json::json!({ "app_id": INFRA_APP, "dry_run": true }),
    );
    let payload = mcp_payload(&preview);
    assert_eq!(payload["dryRun"], true);
    assert_eq!(payload["target"]["videoCount"], 2);
    let (refused, _) = session.call(
        "developer_app_delete",
        serde_json::json!({ "app_id": INFRA_APP }),
    );
    assert_eq!(mcp_payload(&refused)["code"], "APPROVAL_REQUIRED");
    assert_eq!(stub.writes().len(), writes_before);
}

#[test]
fn developer_waits_stop_at_their_deadline() {
    let stub = start_infra_stub();
    let answered = |id: &str| {
        stub.requests()
            .iter()
            .filter(|request| request.starts_with("GET ") && request.ends_with(id))
            .count()
    };

    for (kind, id, id_key) in [
        ("videos", INFRA_STALLED_VIDEO, "videoId"),
        ("transcripts", INFRA_STALLED_TRANSCRIPT, "transcriptId"),
    ] {
        let output = infra_cap(
            &stub,
            &[
                "developers",
                kind,
                "wait",
                INFRA_APP,
                id,
                "--timeout-seconds",
                "1",
                "--json",
            ],
        );
        assert_eq!(
            answered(id),
            0,
            "the {kind} wait outlived its 1 second limit and saw the late answer"
        );
        assert_eq!(output.status.code(), Some(1), "{kind}");
        let error = single_json_error(&output);
        assert_eq!(error["code"], "NOT_READY", "{kind}");
        assert_eq!(error["retryable"], true, "{kind}");
        assert_eq!(error[id_key], id, "{kind}");
        assert!(error.get("status").is_none(), "{kind}");
    }

    let output = infra_cap(
        &stub,
        &[
            "developers",
            "videos",
            "wait",
            INFRA_APP,
            INFRA_SLOW_VIDEO,
            "--timeout-seconds",
            "2",
            "--json",
        ],
    );
    let polls = answered(INFRA_SLOW_VIDEO);
    assert!(
        (1..=3).contains(&polls),
        "a 2 second wait polls at 0, 0.5 and 1.5 seconds, not {polls} times"
    );
    let error = single_json_error(&output);
    assert_eq!(error["code"], "NOT_READY");
    assert_eq!(error["videoId"], INFRA_SLOW_VIDEO);
    assert_eq!(error["status"], "processing");
    assert!(error["hint"].as_str().unwrap().contains(&format!(
        "cap developers videos wait {INFRA_APP} {INFRA_SLOW_VIDEO}"
    )));

    for _ in 0..200 {
        if answered(INFRA_STALLED_VIDEO) == 1 {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(answered(INFRA_STALLED_VIDEO), 1);
    let mut session = McpSession::start(&stub.url);
    let (result, _) = session.call(
        "developer_video_wait",
        serde_json::json!({
            "app_id": INFRA_APP,
            "video_id": INFRA_STALLED_VIDEO,
            "timeout_seconds": 1,
        }),
    );
    assert_eq!(
        answered(INFRA_STALLED_VIDEO),
        1,
        "the MCP wait outlived its 1 second limit and saw the late answer"
    );
    assert_eq!(result["isError"], true);
    let error = mcp_payload(&result);
    assert_eq!(error["code"], "NOT_READY");
    assert_eq!(error["videoId"], INFRA_STALLED_VIDEO);
}

#[test]
fn account_command_failures_keep_their_typed_fields_in_json() {
    let unreachable = |args: &[&str]| {
        cap()
            .args(args)
            .env("CAP_AGENT_TOKEN", "cap_cli_synthetic_test_token")
            .env("CAP_SERVER_URL", "http://127.0.0.1:9")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    };
    for args in [
        vec!["account", "get", "--json"],
        vec!["organizations", "list", "--json"],
        vec!["library", "folders", "list", "org_test", "--json"],
        vec!["notifications", "list", "--json"],
        vec!["jobs", "get", "op_test", "--json"],
    ] {
        let output = unreachable(&args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        let error = single_json_error(&output);
        assert_eq!(error["code"], "TEMPORARY_UNAVAILABLE", "{args:?}");
        assert_eq!(error["retryable"], true, "{args:?}");
        assert_eq!(error["retryAfterMs"], 500, "{args:?}");
        assert!(error["hint"].is_string(), "{args:?}");
    }

    let stub = start_infra_stub();
    let missing = infra_cap(&stub, &["organizations", "get", "org_missing", "--json"]);
    let error = single_json_error(&missing);
    assert_eq!(error["code"], "NOT_FOUND");
    assert_eq!(error["retryable"], false);
    assert_eq!(error["requestId"], "req_stub");

    let local = unreachable(&["organizations", "update", "org_test", "--yes", "--json"]);
    let error = single_json_error(&local);
    assert_eq!(error["retryable"], false);
    assert!(!error["message"].as_str().unwrap().is_empty());
}

#[test]
fn mcp_upload_announces_the_video_id_before_a_cancelled_wait() {
    let stub = start_infra_stub();
    let directory = tempfile::tempdir().unwrap();
    let media = directory.path().join("demo.mp4");
    write_test_media(&media);
    let mut session = McpSession::start(&stub.url);

    let id = session.send(
        "tools/call",
        serde_json::json!({
            "name": "developer_video_upload",
            "arguments": {
                "app_id": INFRA_APP,
                "file_path": media.to_str().unwrap(),
                "name": "slow",
                "wait": true,
                "confirmed": true,
            },
            "_meta": { "progressToken": "upload-1" },
        }),
    );
    let progress = session.notification("notifications/progress");
    assert_eq!(progress["params"]["progressToken"], "upload-1");
    let message = progress["params"]["message"].as_str().unwrap();
    assert!(message.contains(INFRA_SLOW_VIDEO), "{message}");
    assert!(message.contains("developer_video_wait"), "{message}");

    session.notify(
        "notifications/cancelled",
        serde_json::json!({ "requestId": id, "reason": "test" }),
    );
    let (tools, _) = session.request("tools/list", serde_json::json!({}));
    assert!(tools["result"]["tools"].is_array());
    thread::sleep(Duration::from_millis(1_500));
    let polls = |stub: &InfraStub| {
        stub.requests()
            .iter()
            .filter(|request| request.ends_with(INFRA_SLOW_VIDEO))
            .count()
    };
    let after_cancel = polls(&stub);
    thread::sleep(Duration::from_millis(1_500));
    assert_eq!(polls(&stub), after_cancel, "the wait kept polling");

    let (resumed, _) = session.call(
        "developer_video_get",
        serde_json::json!({ "app_id": INFRA_APP, "video_id": INFRA_SLOW_VIDEO }),
    );
    assert_eq!(mcp_payload(&resumed)["video"]["status"], "processing");
}
