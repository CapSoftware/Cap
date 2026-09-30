use crate::{ArcLock, general_settings::GeneralSettingsStore, permissions};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;
use tokio::io::AsyncBufReadExt;
use tracing::{error, info, warn};

/// Reports are written next to the logs so support can ask for them by name.
const REPORTS_DIR_NAME: &str = "diagnostics";
const REPORTS_TO_KEEP: usize = 5;
const SYNC_TEST_STDERR_TAIL_LIMIT: usize = 40;
/// The full report always lands on disk; only the copy handed back to the
/// webview is trimmed, so a pathological run can't wedge the settings window.
const MAX_INLINE_REPORT_BYTES: usize = 2 * 1024 * 1024;
const MIN_SYNC_TEST_SECS: u32 = 14;
const MAX_SYNC_TEST_SECS: u32 = 120;

/// Only one diagnostic can run at a time: the sync test takes over the screen
/// and the audio device, so a second run would measure the first one.
static DIAGNOSTIC_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticOptions {
    pub include_sync_test: bool,
    /// `studio`, `instant` or `both`.
    pub mode: String,
    pub duration_secs: Option<u32>,
    pub include_microphone: bool,
    pub mic_name: Option<String>,
    pub skip_export: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRunResult {
    pub report_path: String,
    pub verdict: Option<String>,
    pub summary: Option<String>,
    pub sync_test_error: Option<String>,
    pub report_json: String,
}

/// `phase` is `sync-test`, `collecting` or `done`; `stage`/`mode` are only set
/// for `sync-test` and carry the CLI's stage names verbatim.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticProgress {
    pub phase: String,
    pub stage: Option<String>,
    pub mode: Option<String>,
}

impl DiagnosticProgress {
    fn phase(phase: &str) -> Self {
        Self {
            phase: phase.to_string(),
            stage: None,
            mode: None,
        }
    }
}

/// The subset of `cap selftest av-sync --progress-json` NDJSON we act on.
/// Lines with an unknown `type` (or no `type` at all) are ignored so the CLI
/// can add message kinds without breaking older apps.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
enum SyncTestMessage {
    Stage {
        stage: String,
        #[serde(default)]
        mode: Option<String>,
    },
    Report {
        report: serde_json::Value,
    },
    Error {
        error: String,
    },
}

fn parse_sync_test_line(line: &str) -> Option<SyncTestMessage> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str(line).ok()
}

fn normalize_mode(mode: &str) -> Result<&'static str, String> {
    match mode {
        "studio" => Ok("studio"),
        "instant" => Ok("instant"),
        "both" => Ok("both"),
        other => Err(format!("Unknown sync test mode '{other}'")),
    }
}

struct RunGuard;

impl RunGuard {
    fn acquire() -> Result<Self, String> {
        DIAGNOSTIC_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "A diagnostic is already running".to_string())
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        DIAGNOSTIC_RUNNING.store(false, Ordering::Release);
    }
}

/// The argv for one sync-test run, without the binary itself.
///
/// `--discard-recordings` is not optional here: the app surfaces the report and
/// never the recording, and the CLI otherwise keeps the recorded project for
/// every non-pass verdict -- including the common `inconclusive` one -- with
/// nothing on this side to reveal or delete it.
fn sync_test_args(options: &DiagnosticOptions, mode: &str) -> Vec<String> {
    let mut args = vec![
        "selftest".to_string(),
        "av-sync".to_string(),
        "--mode".to_string(),
        mode.to_string(),
        "--progress-json".to_string(),
        "--discard-recordings".to_string(),
    ];

    if let Some(duration) = options.duration_secs {
        args.push("--duration".to_string());
        args.push(
            duration
                .clamp(MIN_SYNC_TEST_SECS, MAX_SYNC_TEST_SECS)
                .to_string(),
        );
    }

    if options.include_microphone {
        args.push("--mic".to_string());
        if let Some(name) = options.mic_name.as_deref().filter(|n| !n.is_empty()) {
            args.push("--mic-name".to_string());
            args.push(name.to_string());
        }
    }

    if options.skip_export {
        args.push("--skip-export".to_string());
    }

    args
}

async fn collect_sync_test_stderr_tail(stderr: tokio::process::ChildStderr) -> Vec<String> {
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    let mut tail = Vec::new();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if cfg!(debug_assertions) {
                    info!(line = %line, "Sync test stderr");
                }
                tail.push(line);
                if tail.len() > SYNC_TEST_STDERR_TAIL_LIMIT {
                    tail.remove(0);
                }
            }
            Ok(None) => break,
            Err(e) => {
                tail.push(format!("failed reading stderr: {e}"));
                break;
            }
        }
    }

    tail
}

/// Drives `cap selftest av-sync` in the exporter sidecar. The verdict lives in
/// the `Report` message, never in the exit code: the CLI exits non-zero for
/// fail/inconclusive runs that still produced a full report.
async fn run_sync_test(
    app: &AppHandle,
    options: &DiagnosticOptions,
) -> Result<serde_json::Value, String> {
    let mode = normalize_mode(&options.mode)?;
    // The sync test lives in the `cap` CLI, shipped as the `cap-exporter`
    // sidecar; a dev build without the sidecar has no way to run it.
    let bin_path = crate::export::resolve_exporter_binary()
        .map_err(|e| format!("Sync test helper unavailable: {e}"))?;

    let mut command = tokio::process::Command::new(&bin_path);
    command
        .args(sync_test_args(options, mode))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Every early return below (a stdout read error, most of all) would
        // otherwise orphan a process that owns the screen with a fullscreen
        // flashing window and is midway through a recording.
        .kill_on_drop(true);
    crate::export::configure_exporter_command(&mut command);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start sync test '{}': {e}", bin_path.display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sync test stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Sync test stderr was not captured".to_string())?;
    let stderr_task = tokio::spawn(collect_sync_test_stderr_tail(stderr));

    let mut report = None;
    let mut reported_error = None;
    let mut stdout_lines = tokio::io::BufReader::new(stdout).lines();

    while let Some(line) = stdout_lines
        .next_line()
        .await
        .map_err(|e| format!("Failed reading sync test stdout: {e}"))?
    {
        match parse_sync_test_line(&line) {
            Some(SyncTestMessage::Stage { stage, mode }) => {
                DiagnosticProgress {
                    phase: "sync-test".to_string(),
                    stage: Some(stage),
                    mode,
                }
                .emit(app)
                .ok();
            }
            Some(SyncTestMessage::Report { report: value }) => report = Some(value),
            Some(SyncTestMessage::Error { error }) => reported_error = Some(error),
            None => {}
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed waiting for sync test: {e}"))?;
    let stderr_tail = stderr_task.await.unwrap_or_default();

    if let Some(report) = report {
        return Ok(report);
    }

    if let Some(error) = reported_error {
        return Err(error);
    }

    let tail = stderr_tail.join("\n");
    Err(format!(
        "Sync test exited with status {status} without producing a report.\n{tail}"
    ))
}

/// Strip credentials from a configured server URL without hiding the host,
/// which is the part support needs to know about.
fn redact_url_credentials(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let (authority, path) = rest.split_at(authority_end);
    match authority.rsplit_once('@') {
        Some((_, host)) => format!("{scheme}://***@{host}{path}"),
        None => url.to_string(),
    }
}

fn settings_snapshot(settings: &GeneralSettingsStore) -> serde_json::Value {
    use cap_recording::diagnostics::redact_home_paths;

    serde_json::json!({
        "maxFps": settings.max_fps,
        "instantModeMaxResolution": settings.instant_mode_max_resolution,
        "studioRecordingQuality": settings.studio_recording_quality,
        "customCursorCapture": settings.custom_cursor_capture,
        "outOfProcessMuxer": settings.out_of_process_muxer,
        "crashRecoveryRecording": settings.crash_recovery_recording,
        "enableNativeCameraPreview": settings.enable_native_camera_preview,
        "recordingsPath": settings
            .recordings_path
            .as_deref()
            .map(redact_home_paths),
        "previousRecordingsPaths": settings
            .previous_recordings_paths
            .iter()
            .map(|p| redact_home_paths(p))
            .collect::<Vec<_>>(),
        "updateChannel": settings.update_channel,
        "serverUrl": redact_url_credentials(&settings.server_url),
        "instanceId": settings.instance_id,
        "enableTelemetry": settings.enable_telemetry,
        "editorPreviewQuality": settings.editor_preview_quality,
        "captureKeyboardEvents": settings.capture_keyboard_events,
    })
}

fn permissions_snapshot() -> serde_json::Value {
    let check = permissions::do_permissions_check(false);
    serde_json::json!({
        "screenRecording": crate::logging::permission_status_str(&check.screen_recording),
        "camera": crate::logging::permission_status_str(&check.camera),
        "microphone": crate::logging::permission_status_str(&check.microphone),
        "accessibility": crate::logging::permission_status_str(&check.accessibility),
    })
}

fn reports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?
        .join(REPORTS_DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create diagnostics folder: {e}"))?;
    Ok(dir)
}

/// Keep the newest `keep` reports. Ties on modification time fall back to the
/// (timestamped) file name so the order is deterministic.
fn prune_reports(dir: &Path, keep: usize) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("Failed to read diagnostics folder: {e}"))?;

    let mut reports: Vec<(std::time::SystemTime, std::ffi::OsString, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let name = path.file_name()?.to_owned();
            let name_str = name.to_str()?;
            if !path.is_file()
                || !name_str.starts_with("cap-diagnostic-")
                || !name_str.ends_with(".json")
            {
                return None;
            }
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, name, path))
        })
        .collect();

    reports.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));

    for (_, _, path) in reports.into_iter().skip(keep) {
        if let Err(e) = std::fs::remove_file(&path) {
            warn!(path = %path.display(), error = %e, "Failed to prune old diagnostic report");
        }
    }

    Ok(())
}

/// The webview only ever renders a preview, so the two unbounded arrays are the
/// first thing to go when a report is huge.
fn truncate_for_ui(report: &serde_json::Value) -> serde_json::Value {
    let mut trimmed = report.clone();

    if let Some(obj) = trimmed.as_object_mut() {
        obj.insert(
            "recentRecordings".to_string(),
            serde_json::Value::Array(Vec::new()),
        );

        if let Some(sync_test) = obj.get_mut("syncTest").and_then(|v| v.as_object_mut()) {
            for key in ["recording", "microphone", "export", "instant"] {
                if let Some(measurement) = sync_test.get_mut(key).and_then(|v| v.as_object_mut()) {
                    measurement.insert("events".to_string(), serde_json::Value::Array(Vec::new()));
                }
            }
        }

        obj.insert(
            "truncatedForPreview".to_string(),
            serde_json::Value::Bool(true),
        );
    }

    trimmed
}

fn resolve_within(dir: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("Diagnostics folder unavailable: {e}"))?;
    let candidate = candidate
        .canonicalize()
        .map_err(|e| format!("Diagnostic report not found: {e}"))?;

    if !candidate.starts_with(&dir) {
        return Err("Diagnostic report is outside the diagnostics folder".to_string());
    }

    Ok(candidate)
}

fn validate_report_path(app: &AppHandle, report_path: &str) -> Result<PathBuf, String> {
    resolve_within(&reports_dir(app)?, Path::new(report_path))
}

#[tauri::command]
#[specta::specta]
pub async fn run_diagnostic(
    app: AppHandle,
    options: DiagnosticOptions,
) -> Result<DiagnosticRunResult, String> {
    if options.include_sync_test {
        // Validate before taking the guard so a bad mode is a plain error.
        normalize_mode(&options.mode)?;
    }

    let _guard = RunGuard::acquire()?;

    {
        let app_lock = app.state::<ArcLock<crate::App>>();
        let state = app_lock.read().await;
        if matches!(
            state.recording_state,
            crate::RecordingState::Active(_) | crate::RecordingState::Pending { .. }
        ) {
            return Err("Stop the current recording before running a diagnostic".to_string());
        }
    }

    let mut sync_test = None;
    let mut sync_test_error = None;

    if options.include_sync_test {
        match run_sync_test(&app, &options).await {
            Ok(report) => sync_test = Some(report),
            Err(e) => {
                // An unrunnable sync test still leaves a useful environment
                // report, so the run continues with the reason recorded.
                error!(error = %e, "Sync test failed; continuing with environment report");
                sync_test_error = Some(e);
            }
        }
    }

    DiagnosticProgress::phase("collecting").emit(&app).ok();

    let settings = GeneralSettingsStore::get(&app)
        .map_err(|e| warn!("Failed to read general settings for diagnostic: {e}"))
        .ok()
        .flatten();
    let recordings_dir = GeneralSettingsStore::recordings_dir(&app);
    let configured_max_fps = settings.as_ref().map(|s| s.max_fps);
    let fragmented_recording = settings
        .as_ref()
        .map(|s| s.crash_recovery_recording)
        .unwrap_or(cap_recording::DEFAULT_CRASH_RECOVERY_RECORDING);
    let settings_json = settings.as_ref().map(settings_snapshot);
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let sync_test_error_for_report = sync_test_error.clone();

    // `collect_report` probes displays and disk mounts; both can block for tens
    // of seconds, so it never runs on the async runtime's cooperative threads.
    let report = tokio::task::spawn_blocking(move || {
        cap_recording::diagnostics::collect_report(
            cap_recording::diagnostics::DiagnosticReportArgs {
                flavor: "tauri",
                app_version: &app_version,
                settings: settings_json,
                permissions: Some(permissions_snapshot()),
                recordings_dir: Some(recordings_dir.as_path()),
                configured_max_fps,
                fragmented_recording,
                sync_test,
                sync_test_error: sync_test_error_for_report,
            },
        )
    })
    .await
    .map_err(|e| format!("Failed to collect diagnostic report: {e}"))?;

    let verdict = report
        .sync_test
        .as_ref()
        .and_then(|v| v.get("verdict"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let summary = report
        .sync_test
        .as_ref()
        .and_then(|v| v.get("summary"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let report_value = serde_json::to_value(&report)
        .map_err(|e| format!("Failed to serialize diagnostic report: {e}"))?;
    let report_json = serde_json::to_string_pretty(&report_value)
        .map_err(|e| format!("Failed to serialize diagnostic report: {e}"))?;

    let dir = reports_dir(&app)?;
    let report_path = dir.join(format!(
        "cap-diagnostic-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    std::fs::write(&report_path, &report_json)
        .map_err(|e| format!("Failed to write diagnostic report: {e}"))?;
    prune_reports(&dir, REPORTS_TO_KEEP).ok();

    let report_json = if report_json.len() > MAX_INLINE_REPORT_BYTES {
        serde_json::to_string_pretty(&truncate_for_ui(&report_value)).unwrap_or(report_json)
    } else {
        report_json
    };

    DiagnosticProgress::phase("done").emit(&app).ok();

    Ok(DiagnosticRunResult {
        report_path: report_path.display().to_string(),
        verdict,
        summary,
        sync_test_error,
        report_json,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn upload_diagnostic_report(app: AppHandle, report_path: String) -> Result<(), String> {
    let path = validate_report_path(&app, &report_path)?;
    let report = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read diagnostic report: {e}"))?;

    crate::logging::upload_log_file_inner(&app, Some(report)).await
}

#[tauri::command]
#[specta::specta]
pub async fn reveal_diagnostic_report(app: AppHandle, report_path: String) -> Result<(), String> {
    let path = validate_report_path(&app, &report_path)?;

    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("Failed to reveal diagnostic report: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cap-diagnostics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_stage_lines() {
        assert_eq!(
            parse_sync_test_line(r#"{"type":"Stage","stage":"recording","mode":"studio"}"#),
            Some(SyncTestMessage::Stage {
                stage: "recording".to_string(),
                mode: Some("studio".to_string()),
            })
        );
        assert_eq!(
            parse_sync_test_line(r#"{"type":"Stage","stage":"done","mode":null}"#),
            Some(SyncTestMessage::Stage {
                stage: "done".to_string(),
                mode: None,
            })
        );
    }

    #[test]
    fn parses_report_and_error_lines() {
        let report = parse_sync_test_line(r#"{"type":"Report","report":{"verdict":"pass"}}"#);
        let Some(SyncTestMessage::Report { report }) = report else {
            panic!("expected a report message");
        };
        assert_eq!(report["verdict"], "pass");

        assert_eq!(
            parse_sync_test_line(r#"{"type":"Error","error":"no display"}"#),
            Some(SyncTestMessage::Error {
                error: "no display".to_string()
            })
        );
    }

    #[test]
    fn ignores_unknown_and_malformed_lines() {
        assert_eq!(parse_sync_test_line(r#"{"type":"Heartbeat","at":1}"#), None);
        assert_eq!(parse_sync_test_line("not json at all"), None);
        assert_eq!(parse_sync_test_line("{}"), None);
        assert_eq!(parse_sync_test_line("   "), None);
        // A stage message missing its required field is dropped, not fatal.
        assert_eq!(parse_sync_test_line(r#"{"type":"Stage"}"#), None);
    }

    fn options(mode: &str) -> DiagnosticOptions {
        DiagnosticOptions {
            include_sync_test: true,
            mode: mode.to_string(),
            duration_secs: None,
            include_microphone: false,
            mic_name: None,
            skip_export: false,
        }
    }

    /// The app never surfaces the recorded project, so it always asks the CLI
    /// to discard it -- otherwise every non-pass verdict leaves a full screen
    /// recording in temp that nothing here ever cleans up.
    #[test]
    fn the_sync_test_always_discards_recordings() {
        assert_eq!(
            sync_test_args(&options("both"), "both"),
            [
                "selftest",
                "av-sync",
                "--mode",
                "both",
                "--progress-json",
                "--discard-recordings",
            ]
        );

        let full = DiagnosticOptions {
            duration_secs: Some(500),
            include_microphone: true,
            mic_name: Some("Studio Mic".to_string()),
            skip_export: true,
            ..options("studio")
        };
        assert_eq!(
            sync_test_args(&full, "studio"),
            [
                "selftest",
                "av-sync",
                "--mode",
                "studio",
                "--progress-json",
                "--discard-recordings",
                // Out-of-range durations are clamped, as they always were.
                "--duration",
                "120",
                "--mic",
                "--mic-name",
                "Studio Mic",
                "--skip-export",
            ]
        );

        // An empty mic name is not passed as a flag value.
        let empty_name = DiagnosticOptions {
            include_microphone: true,
            mic_name: Some(String::new()),
            ..options("instant")
        };
        assert!(
            !sync_test_args(&empty_name, "instant")
                .iter()
                .any(|arg| arg == "--mic-name")
        );
    }

    #[test]
    fn normalizes_known_modes_only() {
        assert_eq!(normalize_mode("both"), Ok("both"));
        assert_eq!(normalize_mode("studio"), Ok("studio"));
        assert_eq!(normalize_mode("instant"), Ok("instant"));
        assert!(normalize_mode("Studio").is_err());
        assert!(normalize_mode("").is_err());
    }

    #[test]
    fn resolve_within_accepts_files_in_the_dir() {
        let root = temp_dir();
        let dir = root.join("diagnostics");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cap-diagnostic-1.json");
        std::fs::write(&file, "{}").unwrap();

        let resolved = resolve_within(&dir, &file).unwrap();
        assert_eq!(resolved, file.canonicalize().unwrap());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_within_rejects_escapes() {
        let root = temp_dir();
        let dir = root.join("diagnostics");
        std::fs::create_dir_all(&dir).unwrap();
        let outside = root.join("secret.json");
        std::fs::write(&outside, "{}").unwrap();

        // Traversal out of the diagnostics folder.
        assert!(resolve_within(&dir, &dir.join("../secret.json")).is_err());
        // An absolute path elsewhere on disk.
        assert!(resolve_within(&dir, &outside).is_err());
        // A file that does not exist at all.
        assert!(resolve_within(&dir, &dir.join("missing.json")).is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prunes_to_the_newest_reports() {
        let dir = temp_dir();
        for i in 0..8 {
            std::fs::write(
                dir.join(format!("cap-diagnostic-2026010{i}-120000.json")),
                "{}",
            )
            .unwrap();
        }
        // Unrelated files are never touched.
        std::fs::write(dir.join("notes.txt"), "keep me").unwrap();
        std::fs::write(dir.join("cap-diagnostic-partial.txt"), "keep me").unwrap();

        prune_reports(&dir, 5).unwrap();

        let mut remaining: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("cap-diagnostic-") && n.ends_with(".json"))
            .collect();
        remaining.sort();

        assert_eq!(remaining.len(), 5);
        assert!(remaining.contains(&"cap-diagnostic-20260107-120000.json".to_string()));
        assert!(!remaining.contains(&"cap-diagnostic-20260100-120000.json".to_string()));
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("cap-diagnostic-partial.txt").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn redacts_only_url_credentials() {
        assert_eq!(
            redact_url_credentials("https://cap.so"),
            "https://cap.so".to_string()
        );
        assert_eq!(
            redact_url_credentials("https://user:pass@self.hosted/cap"),
            "https://***@self.hosted/cap".to_string()
        );
        assert_eq!(redact_url_credentials("not a url"), "not a url".to_string());
    }

    #[test]
    fn truncate_for_ui_drops_unbounded_arrays() {
        let report = serde_json::json!({
            "recentRecordings": [{ "id": "a" }],
            "syncTest": {
                "verdict": "pass",
                "recording": { "medianOffsetMs": 1.0, "events": [1, 2, 3] },
                "studioError": null,
            },
        });

        let trimmed = truncate_for_ui(&report);

        assert_eq!(trimmed["recentRecordings"].as_array().unwrap().len(), 0);
        assert_eq!(
            trimmed["syncTest"]["recording"]["events"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(trimmed["syncTest"]["verdict"], "pass");
        assert_eq!(trimmed["syncTest"]["recording"]["medianOffsetMs"], 1.0);
        assert_eq!(trimmed["truncatedForPreview"], true);
    }
}
