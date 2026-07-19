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
