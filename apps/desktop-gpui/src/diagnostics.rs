//! The Feedback page's Diagnostic Report.
//!
//! Two halves, and they run very differently.
//!
//! The A/V sync self-test runs as a **subprocess** -- the `cap` CLI, shipped
//! inside `Cap.app` as the `cap-exporter` sidecar. It cannot run in-process:
//! `cap selftest av-sync` builds its own winit `EventLoop` for the flashing
//! test pattern and needs the process main thread, which gpui owns for the
//! whole life of the app. So this module resolves the binary, drives its
//! `--progress-json` NDJSON stream, and hands the final report back as raw
//! JSON.
//!
//! Around it sits the environment snapshot from `cap_recording::diagnostics`.
//! [`collect_report`] probes displays and disk mounts and can block for the
//! better part of a minute (display enumeration alone is ~37s without screen
//! recording permission), so every entry point here is written to be called
//! from a background thread and never from the UI one.

use std::{
    io::{BufRead as _, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{permissions, store};

/// The rolling log file's prefix. Deliberately *not* the Tauri app's
/// `cap-desktop.log`: both apps write into the same directory on macOS, and a
/// shared prefix would interleave two processes' lines into one file and make
/// either app's "newest log" lookup pick up the other's.
pub const LOG_FILE_PREFIX: &str = "cap-gpui.log";

/// `MAX_SIZE` in `src-tauri/src/logging.rs`.
const MAX_LOG_UPLOAD_BYTES: usize = 1024 * 1024;

/// How much of the self-test's stderr is kept for a failure message.
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// How many diagnostic reports stay on disk.
const KEEP_REPORTS: usize = 5;

/// Seconds of test pattern. The CLI's own default is shorter; 20s is long
/// enough for the drift term to mean something without making the flashing
/// window feel endless.
pub const DEFAULT_DURATION_SECS: u64 = 20;

/// `CAP_GPUI_SELFTEST_BIN`: an explicit path to the `cap` binary, which wins
/// over every probe below. The verification harness sets it; nothing else does.
const SELFTEST_BIN_ENV: &str = "CAP_GPUI_SELFTEST_BIN";

/// The shipping app. The gpui binary is unbundled in dev and carries no
/// sidecar of its own, so it borrows the installed app's -- the same fallback
/// the editor's wallpaper lookup makes.
const INSTALLED_APP: &str = "/Applications/Cap.app";

// ---------------------------------------------------------------------------
// Log file
// ---------------------------------------------------------------------------

/// Where the rolling file log lives.
///
/// macOS uses `~/Library/Logs/so.cap.desktop` -- the same directory the Tauri
/// app writes into, so a user handing over "the Cap logs folder" hands over
/// both apps' logs -- and every other platform uses
/// `<local data>/so.cap.desktop/logs`, matching `main.rs` over there.
pub fn logs_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Logs")
            .join("so.cap.desktop")
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("so.cap.desktop")
            .join("logs")
    }
}

/// `get_latest_log_file` in `src-tauri/src/logging.rs`: the daily appender
/// names files `<prefix>.<date>`, so the newest by modification time is the
/// one being written right now.
fn latest_log_file(dir: &Path) -> Option<PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if !path.is_file() || !path.file_name()?.to_str()?.contains(LOG_FILE_PREFIX) {
                return None;
            }
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((path, modified))
        })
        .collect();
    files.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    files.into_iter().next().map(|(path, _)| path)
}

/// The last ~1MB of the newest log file, with the Tauri app's truncation
/// header. Split out from the IO so the byte arithmetic is testable.
fn log_tail_from(content: &str, file_size: u64, max_bytes: usize) -> String {
    if file_size as usize <= max_bytes {
        return content.to_string();
    }
    let header =
        format!("⚠️ Log file truncated (original size: {file_size} bytes, showing last ~1MB)\n\n");
    let Some(max_content) = max_bytes.checked_sub(header.len()) else {
        return header;
    };
    if content.len() <= max_content {
        return content.to_string();
    }

    let mut start = content.len() - max_content;
    // The cut lands at an arbitrary byte; walk forward to a char boundary
    // before slicing, then forward again to the next line so the upload never
    // opens mid-record.
    while start < content.len() && !content.is_char_boundary(start) {
        start += 1;
    }
    let start = match content[start..].find('\n') {
        Some(offset) => start + offset + 1,
        None => start,
    };
    format!("{header}{}", &content[start..])
}

/// The log text to upload. A missing log file is not an error: the upload is
/// still worth making for its diagnostics, so a placeholder goes up instead.
pub fn log_tail() -> String {
    let dir = logs_dir();
    let Some(path) = latest_log_file(&dir) else {
        return format!(
            "No log file was found in {}. This build may not have written one yet.",
            dir.display()
        );
    };
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    match std::fs::read_to_string(&path) {
        Ok(content) => log_tail_from(&content, size, MAX_LOG_UPLOAD_BYTES),
        Err(error) => format!("Failed to read {}: {error}", path.display()),
    }
}

// ---------------------------------------------------------------------------
// The self-test sidecar
// ---------------------------------------------------------------------------

fn selftest_bin_name() -> &'static str {
    if cfg!(windows) {
        "cap-exporter.exe"
    } else {
        "cap-exporter"
    }
}

fn cap_bin_name() -> &'static str {
    if cfg!(windows) { "cap.exe" } else { "cap" }
}

/// The triple Tauri suffixes the un-bundled sidecar with, spelled the way
/// `src-tauri/src/export.rs` spells it.
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
    } else {
        None
    }
}

/// Every place the `cap` CLI could be, newest-context first.
///
/// 1. Next to this executable, which is where the sidecar sits when the gpui
///    app is staged inside `Cap.app` (`Contents/Resources/gpui/`) *and* where
///    a dev `cargo build` leaves it.
/// 2. `../MacOS` and `../Resources` relative to the executable -- the two
///    places a Tauri bundle puts an `externalBin`.
/// 3. The installed `/Applications/Cap.app`. The gpui dev binary is unbundled
///    and has no sidecar of its own, so it borrows the installed app's, the
///    same way the editor's wallpaper lookup borrows its assets.
/// 4. `target/{debug,release}/cap`, walking up from the working directory --
///    the dev checkout, where the CLI is just another workspace binary.
fn selftest_binary_candidates(
    exe_dir: Option<&Path>,
    installed_app: Option<&Path>,
    cwd: Option<&Path>,
) -> Vec<PathBuf> {
    let triple = current_target_triple();
    let mut candidates = Vec::new();

    let mut push_dir = |dir: &Path| {
        candidates.push(dir.join(selftest_bin_name()));
        if let Some(triple) = triple {
            candidates.push(dir.join(format!(
                "cap-exporter-{triple}{}",
                std::env::consts::EXE_SUFFIX
            )));
        }
        candidates.push(dir.join(cap_bin_name()));
    };

    if let Some(dir) = exe_dir {
        push_dir(dir);
        for sibling in ["../Resources", "../MacOS"] {
            push_dir(&dir.join(sibling));
        }
    }

    if let Some(bundle) = installed_app {
        for sibling in ["Contents/Resources", "Contents/MacOS"] {
            push_dir(&bundle.join(sibling));
        }
    }

    // The dev checkout: `apps/desktop-gpui` is two levels below the repo root
    // and has a `target/` of its own, so every ancestor gets a look.
    //
    // Debug builds only, matching how `src-tauri/src/export.rs` gates its own
    // target/ probes: this walks the working directory, so in a shipped build
    // it would let anyone who can pick the process's cwd -- a shared temp
    // directory, a downloaded folder -- place a `target/debug/cap` for us to
    // execute. A release build has its sidecar next to it or in the bundle.
    if cfg!(debug_assertions)
        && let Some(cwd) = cwd
    {
        for ancestor in cwd.ancestors() {
            for profile in ["debug", "release"] {
                candidates.push(ancestor.join("target").join(profile).join(cap_bin_name()));
            }
        }
    }

    candidates
}

/// The first candidate that exists, or `None`. Callers must degrade: a build
/// with no sidecar next to it still collects an environment report, it just
/// cannot run the sync test.
pub fn resolve_selftest_binary() -> Option<PathBuf> {
    let override_path = std::env::var_os(SELFTEST_BIN_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty());
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let installed = cfg!(target_os = "macos").then(|| Path::new(INSTALLED_APP));
    let cwd = std::env::current_dir().ok();
    resolve_selftest_binary_in(override_path, exe_dir.as_deref(), installed, cwd.as_deref())
}

/// [`resolve_selftest_binary`] with everything it reads off the machine lifted
/// into parameters, so the probe order is testable without mutating
/// process-global state -- and without the tests' answers depending on whether
/// this machine happens to have Cap installed.
fn resolve_selftest_binary_in(
    override_path: Option<PathBuf>,
    exe_dir: Option<&Path>,
    installed_app: Option<&Path>,
    cwd: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = override_path {
        // An override that does not exist is a configuration mistake worth
        // surfacing, not something to silently fall back from.
        return path.is_file().then_some(path);
    }
    selftest_binary_candidates(exe_dir, installed_app, cwd)
        .into_iter()
        .find(|path| path.is_file())
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/// `--mode`: which recording pipelines the test exercises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    Studio,
    Instant,
    Both,
}

impl SyncMode {
    pub const ALL: &'static [Self] = &[Self::Studio, Self::Instant, Self::Both];

    /// The `--mode` value, which is also the `mode` field in every progress
    /// line.
    pub fn flag(self) -> &'static str {
        match self {
            Self::Studio => "studio",
            Self::Instant => "instant",
            Self::Both => "both",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Studio => "Studio",
            Self::Instant => "Instant",
            Self::Both => "Both",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncTestOptions {
    pub mode: SyncMode,
    /// `--mic`: also records the default microphone and checks that it hears
    /// the beeps in time. Studio leg only.
    pub microphone: bool,
    pub duration_secs: u64,
}

impl Default for SyncTestOptions {
    fn default() -> Self {
        Self {
            mode: SyncMode::Both,
            microphone: false,
            duration_secs: DEFAULT_DURATION_SECS,
        }
    }
}

/// `--discard-recordings` is not optional here: this app surfaces the report
/// and never the recording, and the CLI otherwise keeps the recorded project
/// for every non-pass verdict -- including the common `inconclusive` one --
/// with nothing on this side to reveal or delete it.
fn sync_test_args(options: &SyncTestOptions) -> Vec<String> {
    let mut args = vec![
        "selftest".to_string(),
        "av-sync".to_string(),
        "--progress-json".to_string(),
        "--discard-recordings".to_string(),
        "--mode".to_string(),
        options.mode.flag().to_string(),
        "--duration".to_string(),
        options.duration_secs.to_string(),
    ];
    if options.microphone {
        args.push("--mic".to_string());
    }
    args
}

/// Only one diagnostic can run at a time, process-wide: the sync test takes
/// over the screen and the audio device, so a second run would measure the
/// first one. This has to be global rather than per-window -- Settings builds a
/// fresh page state every time it opens, while the run itself is a detached
/// background task that outlives the window.
///
/// The Tauri app guards the same way (`DIAGNOSTIC_RUNNING` in
/// `src-tauri/src/diagnostics.rs`).
static DIAGNOSTIC_RUNNING: AtomicBool = AtomicBool::new(false);

/// Held for the length of one diagnostic run; releases on every exit path,
/// including a dropped run future.
pub struct RunGuard;

impl RunGuard {
    pub fn acquire() -> Result<Self, String> {
        DIAGNOSTIC_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| ALREADY_RUNNING.to_string())
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        DIAGNOSTIC_RUNNING.store(false, Ordering::Release);
    }
}

pub const ALREADY_RUNNING: &str = "A diagnostic is already running.";

/// Kills the self-test if it is dropped before the run's own kill/wait
/// sequence. `std::process::Child` does not kill on drop, and an orphaned
/// self-test owns the screen with a fullscreen flashing window while it is
/// midway through a recording.
struct ChildGuard(std::process::Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        // Both are no-ops once the run has already waited on the child.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// One `{"type":"Stage",..}` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stage {
    pub stage: String,
    pub mode: Option<String>,
}

/// A line off the self-test's stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressLine {
    Stage {
        stage: String,
        mode: Option<String>,
    },
    Report(Value),
    Error(String),
    /// Anything else: a blank line, a log line that escaped stderr, a message
    /// type added after this build. Never fatal -- the stream is forward
    /// compatible by being ignorable.
    Unknown,
}

pub fn parse_progress_line(line: &str) -> ProgressLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ProgressLine::Unknown;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("Stage") => match value.get("stage").and_then(Value::as_str) {
            Some(stage) => ProgressLine::Stage {
                stage: stage.to_string(),
                mode: value
                    .get("mode")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            None => ProgressLine::Unknown,
        },
        Some("Report") => match value.get("report") {
            Some(report) => ProgressLine::Report(report.clone()),
            None => ProgressLine::Unknown,
        },
        Some("Error") => match value.get("error").and_then(Value::as_str) {
            Some(error) => ProgressLine::Error(error.to_string()),
            None => ProgressLine::Unknown,
        },
        _ => ProgressLine::Unknown,
    }
}

/// The three stages the app emits for itself around the subprocess. Not CLI
/// stage names -- the CLI never sends these.
pub const START_STAGE: &str = "starting";
pub const COLLECT_STAGE: &str = "collecting-report";
pub const CANCEL_STAGE: &str = "cancelling";

/// The user-facing words for a stage. The CLI's stage names are stable API but
/// they are not sentences.
pub fn stage_label(stage: &str, mode: Option<&str>) -> String {
    let leg = match mode {
        Some("studio") => " studio",
        Some("instant") => " instant",
        _ => "",
    };
    match stage {
        "collecting" => format!("Preparing the{leg} test..."),
        "recording" => format!("Recording the{leg} test..."),
        "pattern-run" => format!("Playing the test pattern{leg}..."),
        "remuxing" => format!("Finalizing the{leg} recording..."),
        "analyzing" => format!("Analyzing the{leg} recording..."),
        "exporting" => format!("Exporting the{leg} recording..."),
        "done" => "Wrapping up the sync test...".to_string(),
        START_STAGE => "Starting the diagnostic...".to_string(),
        COLLECT_STAGE => "Collecting system information...".to_string(),
        CANCEL_STAGE => "Cancelling...".to_string(),
        other => format!("{other}..."),
    }
}

fn trim_to_tail(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    let start = match text[start..].find('\n') {
        Some(offset) => start + offset + 1,
        None => start,
    };
    text.drain(..start);
}

/// Run `cap selftest av-sync --progress-json` and return the final report.
///
/// **Never call this without the user having asked for it**: the self-test
/// takes the screen over with a fullscreen flashing window and plays 1kHz
/// beeps at output volume.
///
/// The process exits non-zero for a `fail` or `inconclusive` verdict, so the
/// exit status is deliberately not consulted -- a report that arrived is a
/// successful run whatever the code was. `cancel` is polled by a watchdog
/// thread rather than between stdout lines, because a recording leg can go
/// twenty-odd seconds without emitting anything and a Cancel button that takes
/// twenty seconds is not a Cancel button.
pub fn run_sync_test(
    binary: &Path,
    options: &SyncTestOptions,
    cancel: &Arc<AtomicBool>,
    mut on_stage: impl FnMut(Stage),
) -> Result<Value, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }

    // Wrapped before anything else can fail: every early return from here on
    // has to take the child with it.
    let mut child = ChildGuard(
        Command::new(binary)
            .args(sync_test_args(options))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start {}: {error}", binary.display()))?,
    );

    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| "The self-test produced no output stream".to_string())?;
    let stderr = child.0.stderr.take();

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let stderr_reader = stderr.map(|stderr| {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut tail) = tail.lock() {
                    tail.push_str(&line);
                    tail.push('\n');
                    trim_to_tail(&mut tail, STDERR_TAIL_BYTES);
                }
            }
        })
    });

    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog = std::thread::spawn({
        let child = Arc::clone(&child);
        let cancel = Arc::clone(cancel);
        let finished = Arc::clone(&finished);
        move || {
            while !finished.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    if let Ok(mut child) = child.lock() {
                        let _ = child.0.kill();
                    }
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });

    let mut report = None;
    let mut error_line = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        match parse_progress_line(&line) {
            ProgressLine::Stage { stage, mode } => on_stage(Stage { stage, mode }),
            ProgressLine::Report(value) => report = Some(value),
            ProgressLine::Error(error) => error_line = Some(error),
            ProgressLine::Unknown => {}
        }
    }

    // stdout is at EOF, so the child is on its way out either way; releasing
    // the watchdog before touching the lock keeps the two off each other.
    finished.store(true, Ordering::Relaxed);
    let _ = watchdog.join();
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    let status = child
        .lock()
        .map_err(|_| "The self-test process handle was poisoned".to_string())
        .and_then(|mut child| child.0.wait().map_err(|error| error.to_string()));

    if cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    if let Some(report) = report {
        return Ok(report);
    }

    let tail = stderr_tail
        .lock()
        .map(|tail| tail.trim().to_string())
        .unwrap_or_default();
    let status = match status {
        Ok(status) => format!("The self-test exited with {status}"),
        Err(error) => format!("The self-test could not be waited on: {error}"),
    };
    Err(
        [Some(status), error_line, (!tail.is_empty()).then_some(tail)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

pub const CANCELLED: &str = "The diagnostic was cancelled.";

// ---------------------------------------------------------------------------
// The environment report
// ---------------------------------------------------------------------------

/// `permission_status_str` in `src-tauri/src/logging.rs` -- the same four wire
/// strings, so a gpui report and a Tauri one read identically. `NotDetermined`
/// is Tauri's `Empty`, which it spells `not_requested`.
fn permission_status_str(status: permissions::OSPermissionStatus) -> &'static str {
    match status {
        permissions::OSPermissionStatus::NotNeeded => "not_needed",
        permissions::OSPermissionStatus::NotDetermined => "not_requested",
        permissions::OSPermissionStatus::Granted => "granted",
        permissions::OSPermissionStatus::Denied => "denied",
    }
}

fn permissions_snapshot() -> Value {
    let check = permissions::classify(
        permissions::check_raw(),
        permissions::AttemptedFlags::default(),
    );
    json!({
        "screenRecording": permission_status_str(check.screen_recording),
        "camera": permission_status_str(check.camera),
        "microphone": permission_status_str(check.microphone),
        "accessibility": permission_status_str(check.accessibility),
    })
}

/// `redact_url_credentials` in `src-tauri/src/diagnostics.rs`.
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

/// The same fields `settings_snapshot` picks in the Tauri app, read off the
/// store the two apps share. Paths are redacted to `~/..`, and the instance id
/// is read rather than minted -- opening a diagnostic must not write to the
/// shared store.
fn settings_snapshot() -> Value {
    use cap_recording::diagnostics::redact_home_paths;
    use store::SettingsEnum as _;

    let settings = store::GeneralSettings::load();
    let instance_id = store::store_section(store::GENERAL_SETTINGS)
        .get("instanceId")
        .and_then(Value::as_str)
        .map(str::to_string);

    json!({
        "maxFps": settings.max_fps,
        "instantModeMaxResolution": settings.instant_mode_max_resolution,
        "studioRecordingQuality": settings.studio_recording_quality.as_json(),
        "customCursorCapture": settings.custom_cursor_capture,
        "outOfProcessMuxer": settings.out_of_process_muxer,
        "crashRecoveryRecording": settings.crash_recovery_recording,
        "enableNativeCameraPreview": settings.enable_native_camera_preview,
        "recordingsPath": settings.recordings_path.as_deref().map(redact_home_paths),
        "previousRecordingsPaths": settings
            .previous_recordings_paths
            .iter()
            .map(|path| redact_home_paths(path))
            .collect::<Vec<_>>(),
        "updateChannel": settings.update_channel.as_json(),
        "serverUrl": redact_url_credentials(&settings.server_url),
        "instanceId": instance_id,
        "enableTelemetry": settings.enable_telemetry,
        "editorPreviewQuality": settings.editor_preview_quality.as_json(),
        "captureKeyboardEvents": settings.capture_keyboard_events,
    })
}

/// The whole environment snapshot, with an already-run sync test folded in.
///
/// **Blocking, for tens of seconds.** Background executor only.
pub fn collect_report(sync_test: Option<Value>, sync_test_error: Option<String>) -> Value {
    let settings = store::GeneralSettings::load();
    let recordings_dir = crate::recording::recordings_dir();
    let app_version = env!("CARGO_PKG_VERSION");

    let report = cap_recording::diagnostics::collect_report(
        cap_recording::diagnostics::DiagnosticReportArgs {
            flavor: "gpui",
            app_version,
            settings: Some(settings_snapshot()),
            permissions: Some(permissions_snapshot()),
            recordings_dir: Some(recordings_dir.as_path()),
            configured_max_fps: Some(settings.max_fps),
            fragmented_recording: settings.crash_recovery_recording,
            sync_test,
            sync_test_error,
        },
    );

    serde_json::to_value(&report).unwrap_or_else(|error| {
        tracing::warn!("serializing the diagnostic report: {error}");
        Value::Null
    })
}

/// The `diagnostics` form field: the older, narrower shape
/// `/api/desktop/logs` formats into the Discord message. Derived from an
/// already-collected report so nothing is probed twice.
pub fn log_diagnostics_from_report(report: &Value) -> Value {
    let names = |key: &str, field: &str| {
        report
            .get(key)
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get(field).and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    json!({
        "system": report.get("system").cloned().unwrap_or(Value::Null),
        "cameras": names("cameras", "displayName"),
        "microphones": names("microphones", "name"),
        "permissions": report.get("permissions").cloned().unwrap_or(Value::Null),
    })
}

/// The same shape for the plain "Upload Logs" path, which has no report to
/// derive from. Deliberately narrower than [`collect_report`]: this is the
/// exact set of keys the server validates, and it skips the display and disk
/// probes that make the full report take the better part of a minute.
///
/// Still blocking (device enumeration); background executor only.
pub fn collect_log_diagnostics() -> Value {
    let check = permissions::classify(
        permissions::check_raw(),
        permissions::AttemptedFlags::default(),
    );
    let cameras = if check.camera.permitted() {
        cap_recording::diagnostics::collect_cameras()
            .into_iter()
            .map(|camera| camera.display_name)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let microphones = if check.microphone.permitted() {
        cap_recording::diagnostics::collect_microphones()
            .into_iter()
            .map(|mic| mic.name)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    json!({
        "system": serde_json::to_value(cap_recording::diagnostics::collect_diagnostics())
            .unwrap_or(Value::Null),
        "cameras": cameras,
        "microphones": microphones,
        "permissions": permissions_snapshot(),
    })
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

pub fn reports_dir() -> PathBuf {
    store::app_data_dir().join("diagnostics")
}

/// Distinguishes reports written within the same second; paired with the
/// process id in the file name so a fresh launch cannot reuse a number.
static REPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Unix seconds parsed out of one of *our* file names, if it is one.
///
/// Returns `None` for anything else in the directory -- crucially the Tauri
/// app's reports, which share this folder but are stamped `%Y%m%d-%H%M%S`.
/// Those parse as a plain integer (`20260821`) that is three orders of
/// magnitude below a real Unix timestamp, so treating them as a stamp would
/// sort every one of them last and delete them first.
fn report_file_stamp(name: &str) -> Option<u64> {
    let stamp = name
        .strip_prefix("cap-diagnostic-")?
        .strip_suffix(".json")?
        // `<secs>-<pid>-<counter>`: only the seconds order the file.
        .split('-')
        .next()?;
    // A `%Y%m%d` stamp is 8 digits; ours is 10 and will be until 2286.
    if stamp.len() < 10 {
        return None;
    }
    stamp.parse().ok()
}

/// Falls back to modification time for files we cannot date from their name,
/// so a foreign report is ordered honestly instead of being pruned first.
fn report_sort_key(name: &str, path: &Path) -> u64 {
    report_file_stamp(name).unwrap_or_else(|| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_secs())
            .unwrap_or(0)
    })
}

/// Keep the newest `keep` reports. Ordered by the timestamp in the file name
/// rather than by mtime: two reports written in the same second have
/// indistinguishable mtimes on some filesystems, and the name is the thing
/// that actually orders them.
fn prune_reports(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut reports: Vec<_> = entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?;
            if !path.is_file() || !name.starts_with("cap-diagnostic-") || !name.ends_with(".json") {
                return None;
            }
            Some((report_sort_key(name, &path), name.to_string(), path))
        })
        .collect();
    reports.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, _, path) in reports.into_iter().skip(keep) {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), "pruning an old diagnostic report: {error}");
        }
    }
}

/// Write the report next to the store, prune, and hand back the path.
pub fn write_report(report: &Value) -> Result<PathBuf, String> {
    write_report_into(&reports_dir(), report)
}

/// [`write_report`] with the directory lifted into a parameter, so the naming
/// and pruning are testable without writing into the real store.
fn write_report_into(dir: &Path, report: &Value) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create the diagnostics folder: {error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    // A run with no sidecar finishes in well under a second, so two of them
    // would otherwise write the same name and the second would overwrite the
    // first. The prefix and suffix stay exactly as the pruning filter expects.
    let sequence = REPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!(
        "cap-diagnostic-{stamp}-{}-{sequence}.json",
        std::process::id()
    ));
    let json = serde_json::to_string_pretty(report)
        .map_err(|error| format!("Failed to serialize the report: {error}"))?;
    std::fs::write(&path, json)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    prune_reports(dir, KEEP_REPORTS);
    Ok(path)
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// POST the log (and, when there is one, the report) to
/// `/api/desktop/logs`.
///
/// Auth is optional on that route, so a signed-out user can still send a
/// diagnostic -- the bearer token is attached only when there is one, and its
/// absence is not an error.
pub async fn upload_report(
    server_url: String,
    token: Option<String>,
    log: String,
    report: Option<String>,
    diagnostics: Option<String>,
) -> Result<(), String> {
    // Everything leaving the machine goes through the redactor. Logs record
    // whole URLs on failure (reqwest's Display and Debug both append the URL),
    // and an upload failure logs a presigned S3 PUT, whose query string is a
    // live write credential for up to an hour.
    use cap_recording::log_redaction::scrub_log_text;

    let mut form = reqwest::multipart::Form::new()
        .text("log", scrub_log_text(&log))
        .text("os", std::env::consts::OS)
        .text("version", env!("CARGO_PKG_VERSION"));
    if let Some(report) = report {
        form = form.text("report", scrub_log_text(&report));
    }
    if let Some(diagnostics) = diagnostics {
        form = form.text("diagnostics", scrub_log_text(&diagnostics));
    }

    let mut request = reqwest::Client::new()
        .post(format!("{server_url}/api/desktop/logs"))
        .multipart(form);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Failed to upload logs: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Upload failed with status: {}", response.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-gpui-diagnostics-{tag}-{}-{:?}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn progress_lines_parse_into_their_four_shapes() {
        assert_eq!(
            parse_progress_line(r#"{"type":"Stage","stage":"recording","mode":"studio"}"#),
            ProgressLine::Stage {
                stage: "recording".to_string(),
                mode: Some("studio".to_string()),
            }
        );
        // The final stage carries a null mode.
        assert_eq!(
            parse_progress_line(r#"{"type":"Stage","stage":"done","mode":null}"#),
            ProgressLine::Stage {
                stage: "done".to_string(),
                mode: None,
            }
        );
        assert_eq!(
            parse_progress_line(r#"{"type":"Report","report":{"verdict":"pass"}}"#),
            ProgressLine::Report(json!({ "verdict": "pass" }))
        );
        assert_eq!(
            parse_progress_line(r#"{"type":"Error","error":"no display"}"#),
            ProgressLine::Error("no display".to_string())
        );
    }

    /// Nothing on that pipe is allowed to be fatal: a blank line, a stray log
    /// line, a message type from a newer CLI, or a required field missing.
    #[test]
    fn unparseable_progress_lines_are_ignored_not_fatal() {
        for line in [
            "",
            "  ",
            "INFO recording started",
            "{not json",
            r#"{"type":"Heartbeat","at":1}"#,
            r#"{"stage":"recording"}"#,
            // Required fields missing or of the wrong type.
            r#"{"type":"Stage","mode":"studio"}"#,
            r#"{"type":"Stage","stage":7}"#,
            r#"{"type":"Report"}"#,
            r#"{"type":"Error"}"#,
            r#"{"type":"Error","error":{"message":"x"}}"#,
        ] {
            assert_eq!(
                parse_progress_line(line),
                ProgressLine::Unknown,
                "expected {line:?} to be ignored"
            );
        }
    }

    #[test]
    fn the_cli_arguments_follow_the_options() {
        assert_eq!(
            sync_test_args(&SyncTestOptions::default()),
            [
                "selftest",
                "av-sync",
                "--progress-json",
                "--discard-recordings",
                "--mode",
                "both",
                "--duration",
                "20"
            ]
        );
        assert_eq!(
            sync_test_args(&SyncTestOptions {
                mode: SyncMode::Instant,
                microphone: true,
                duration_secs: 5,
            }),
            [
                "selftest",
                "av-sync",
                "--progress-json",
                "--discard-recordings",
                "--mode",
                "instant",
                "--duration",
                "5",
                "--mic"
            ]
        );
    }

    /// The app never surfaces the recorded project, so every run asks the CLI
    /// to discard it; without this a non-pass verdict leaves a full screen
    /// recording in temp that nothing here ever cleans up.
    #[test]
    fn every_run_discards_the_recording() {
        for mode in SyncMode::ALL {
            let args = sync_test_args(&SyncTestOptions {
                mode: *mode,
                ..SyncTestOptions::default()
            });
            assert!(
                args.iter().any(|arg| arg == "--discard-recordings"),
                "{mode:?} did not discard its recording"
            );
        }
    }

    /// Two runs must not be able to overlap: the second would take the screen
    /// and the audio device out from under the first.
    #[test]
    fn the_run_guard_admits_one_diagnostic_at_a_time() {
        let first = RunGuard::acquire().expect("the first run takes the guard");
        assert_eq!(RunGuard::acquire().err().as_deref(), Some(ALREADY_RUNNING));
        drop(first);
        // Released on drop, including the drop of an abandoned run future.
        let second = RunGuard::acquire().expect("the guard is free once released");
        drop(second);
        assert!(RunGuard::acquire().is_ok());
    }

    /// The override wins over every probe, and an override pointing at
    /// nothing resolves to nothing rather than silently falling through to
    /// some other build's binary.
    #[test]
    fn the_sidecar_override_wins_and_does_not_fall_through() {
        let dir = temp_dir("override");
        let binary = dir.join("cap");
        std::fs::write(&binary, b"#!/bin/sh\n").unwrap();
        // A bundle whose sidecar would otherwise win.
        let bundle = dir.join("Cap.app");
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(
            bundle.join("Contents/MacOS").join(selftest_bin_name()),
            b"installed",
        )
        .unwrap();

        assert_eq!(
            resolve_selftest_binary_in(Some(binary.clone()), None, Some(&bundle), None),
            Some(binary)
        );
        assert_eq!(
            resolve_selftest_binary_in(Some(dir.join("missing")), None, Some(&bundle), None),
            None
        );
        // Nothing anywhere is `None`, not a panic and not a guess.
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            resolve_selftest_binary_in(None, Some(&empty), None, Some(&empty)),
            None
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The order the run has to follow: the binary shipped next to this build,
    /// then the installed app, then the dev checkout. `cap-exporter` beats a
    /// bare `cap` inside the same directory.
    #[test]
    fn the_sidecar_probe_walks_from_this_build_outwards() {
        let root = temp_dir("probe");
        let exe_dir = root.join("Cap.app/Contents/Resources/gpui");
        let bundle = root.join("Installed.app");
        let installed = bundle.join("Contents/MacOS");
        let target = root.join("target/debug");
        for dir in [&exe_dir, &installed, &target] {
            std::fs::create_dir_all(dir).unwrap();
        }

        // Only the dev checkout has one.
        std::fs::write(target.join(cap_bin_name()), b"dev").unwrap();
        assert_eq!(
            resolve_selftest_binary_in(None, Some(&exe_dir), Some(&bundle), Some(&root)),
            Some(target.join(cap_bin_name()))
        );

        // The installed app beats the dev checkout.
        std::fs::write(installed.join(selftest_bin_name()), b"installed").unwrap();
        assert_eq!(
            resolve_selftest_binary_in(None, Some(&exe_dir), Some(&bundle), Some(&root)),
            Some(installed.join(selftest_bin_name()))
        );

        // A binary next to this build beats both, and the sidecar name beats
        // the bare `cap` in the same folder.
        std::fs::write(exe_dir.join(cap_bin_name()), b"adjacent").unwrap();
        assert_eq!(
            resolve_selftest_binary_in(None, Some(&exe_dir), Some(&bundle), Some(&root)),
            Some(exe_dir.join(cap_bin_name()))
        );
        std::fs::write(exe_dir.join(selftest_bin_name()), b"sidecar").unwrap();
        assert_eq!(
            resolve_selftest_binary_in(None, Some(&exe_dir), Some(&bundle), Some(&root)),
            Some(exe_dir.join(selftest_bin_name()))
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// The bundle layout: an app-staged build finds the sidecar one directory
    /// up, in `Contents/MacOS`, where Tauri puts an `externalBin`.
    #[test]
    fn the_sidecar_probe_looks_into_the_bundle_siblings() {
        let root = temp_dir("bundle");
        let contents = root.join("Cap.app/Contents");
        let exe_dir = contents.join("Resources");
        let macos = contents.join("MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(macos.join(selftest_bin_name()), b"sidecar").unwrap();

        assert_eq!(
            resolve_selftest_binary_in(None, Some(&exe_dir), None, None),
            Some(exe_dir.join("../MacOS").join(selftest_bin_name()))
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn only_the_five_newest_reports_survive() {
        let dir = temp_dir("prune");
        // Real unix-second stamps: a shorter number is not one of ours, and
        // `report_file_stamp` deliberately declines to read it as seconds.
        for stamp in [1_755_780_000_u64, 1_755_780_001, 1_755_780_002] {
            std::fs::write(dir.join(format!("cap-diagnostic-{stamp}.json")), b"{}").unwrap();
        }
        for stamp in [
            1_755_780_003_u64,
            1_755_780_004,
            1_755_780_005,
            1_755_780_006,
        ] {
            std::fs::write(dir.join(format!("cap-diagnostic-{stamp}.json")), b"{}").unwrap();
        }
        // Files that are not reports are never touched.
        std::fs::write(dir.join("notes.txt"), b"keep me").unwrap();

        prune_reports(&dir, KEEP_REPORTS);

        let mut left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "cap-diagnostic-1755780002.json",
                "cap-diagnostic-1755780003.json",
                "cap-diagnostic-1755780004.json",
                "cap-diagnostic-1755780005.json",
                "cap-diagnostic-1755780006.json",
                "notes.txt",
            ]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Reports written in the same second get different names, and the
    /// uniquifier does not disturb the ordering the pruning reads off the name.
    #[test]
    fn reports_in_the_same_second_do_not_collide() {
        let dir = temp_dir("collide");
        let first = write_report_into(&dir, &json!({ "first": true })).unwrap();
        let second = write_report_into(&dir, &json!({ "second": true })).unwrap();

        assert_ne!(first, second);
        assert!(first.exists() && second.exists());
        for path in [&first, &second] {
            let name = path.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with("cap-diagnostic-") && name.ends_with(".json"));
        }
        // Both parse back to the same second, so pruning still orders by time
        // first and falls back to the name.
        let stamp = |path: &Path| report_file_stamp(path.file_name().unwrap().to_str().unwrap());
        assert_eq!(stamp(&first), stamp(&second));
        assert!(stamp(&first).is_some_and(|secs| secs > 0));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The Tauri app writes its reports into this same folder with a
    /// `%Y%m%d-%H%M%S` stamp. Parsed as an integer that is `20260821` -- three
    /// orders of magnitude below a real Unix timestamp -- so treating it as
    /// one would sort every Tauri report last and prune it first.
    #[test]
    fn the_other_apps_reports_are_not_pruned_first() {
        let dir = temp_dir("foreign");
        let foreign = dir.join("cap-diagnostic-20260821-143000.json");
        std::fs::write(&foreign, "{}").unwrap();
        let ours = write_report_into(&dir, &json!({ "ours": true })).unwrap();

        assert_eq!(
            report_file_stamp("cap-diagnostic-20260821-143000.json"),
            None,
            "a foreign stamp must not be read as unix seconds"
        );

        let foreign_key = report_sort_key("cap-diagnostic-20260821-143000.json", &foreign);
        let ours_key = report_sort_key(ours.file_name().unwrap().to_str().unwrap(), &ours);
        assert!(
            foreign_key.abs_diff(ours_key) < 60,
            "a foreign report falls back to mtime and sorts alongside ours, \
             not at the bottom (foreign {foreign_key}, ours {ours_key})"
        );

        prune_reports(&dir, KEEP_REPORTS);
        assert!(foreign.exists(), "pruning deleted the other app's report");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_short_log_is_uploaded_whole() {
        let content = "line one\nline two\n";
        assert_eq!(log_tail_from(content, content.len() as u64, 1024), content);
    }

    /// Over the cap, the tail keeps the header, stays under it, and opens on a
    /// record boundary rather than mid-line.
    #[test]
    fn a_long_log_is_truncated_to_its_tail_on_a_line_boundary() {
        let content: String = (0..500).map(|index| format!("line {index}\n")).collect();
        let tail = log_tail_from(&content, content.len() as u64, 200);

        assert!(tail.starts_with("⚠️ Log file truncated (original size:"));
        assert!(tail.len() <= 200, "tail was {} bytes", tail.len());
        assert!(tail.ends_with("line 499\n"));
        let body = tail.split("\n\n").nth(1).unwrap();
        assert!(
            body.starts_with("line "),
            "the tail opened mid-record: {body:?}"
        );
    }

    /// A multi-byte character straddling the cut must not panic the slice.
    #[test]
    fn truncation_survives_a_cut_inside_a_character() {
        let content: String = (0..200).map(|index| format!("café {index} ✅\n")).collect();
        let tail = log_tail_from(&content, content.len() as u64, 300);
        assert!(tail.ends_with("✅\n"));
    }

    #[test]
    fn stage_labels_read_as_sentences() {
        assert_eq!(
            stage_label("recording", Some("studio")),
            "Recording the studio test..."
        );
        assert_eq!(
            stage_label("analyzing", Some("instant")),
            "Analyzing the instant recording..."
        );
        assert_eq!(stage_label("done", None), "Wrapping up the sync test...");
        assert_eq!(stage_label(START_STAGE, None), "Starting the diagnostic...");
        assert_eq!(
            stage_label(COLLECT_STAGE, None),
            "Collecting system information..."
        );
        assert_eq!(stage_label(CANCEL_STAGE, Some("studio")), "Cancelling...");
        // An unknown stage still says something rather than nothing.
        assert_eq!(stage_label("uploading", None), "uploading...");
    }

    #[test]
    fn urls_keep_their_host_and_lose_their_credentials() {
        assert_eq!(
            redact_url_credentials("https://cap.so"),
            "https://cap.so".to_string()
        );
        assert_eq!(
            redact_url_credentials("https://user:pass@cap.so/api"),
            "https://***@cap.so/api".to_string()
        );
    }

    #[test]
    fn the_upload_diagnostics_are_derived_from_the_report() {
        let report = json!({
            "system": { "macosVersion": { "displayName": "macOS 26.0" } },
            "cameras": [{ "displayName": "FaceTime HD" }, { "deviceId": "x" }],
            "microphones": [{ "name": "MacBook Pro Microphone" }],
            "permissions": { "screenRecording": "granted" },
        });
        assert_eq!(
            log_diagnostics_from_report(&report),
            json!({
                "system": { "macosVersion": { "displayName": "macOS 26.0" } },
                "cameras": ["FaceTime HD"],
                "microphones": ["MacBook Pro Microphone"],
                "permissions": { "screenRecording": "granted" },
            })
        );
        // A report missing every key still produces the shape the server
        // validates.
        assert_eq!(
            log_diagnostics_from_report(&json!({})),
            json!({
                "system": null,
                "cameras": [],
                "microphones": [],
                "permissions": null,
            })
        );
    }
}
