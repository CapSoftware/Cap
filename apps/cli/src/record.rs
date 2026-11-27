use cap_project::{
    InstantRecordingMeta, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    StudioRecordingStatus,
};
use cap_recording::{
    CameraFeed, DoneFut, MicrophoneFeed, PipelineStoppedByUser,
    feeds::{camera, microphone},
    instant_recording,
    recovery::RecoveryManager,
    screen_capture::{ScreenCaptureTarget, frame_accounting::ScreenFrameTotals},
    studio_recording::{self, ActorHandle as StudioActorHandle},
    upload_resume::UploadLock,
};
use cap_utils::disk_space::{
    self, DiskSpaceStatus, FinalizationKind, RecordingStorage, RecordingStorageMonitor,
};
use clap::{Args, ValueEnum};
use futures::FutureExt;
use kameo::Actor as _;
use scap_targets::{DisplayId, WindowId};
use serde::Serialize;
use std::{
    env::current_dir,
    io::IsTerminal,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::io::AsyncBufReadExt;
use tracing::debug;
use uuid::Uuid;

use crate::{
    OutputFormat, resolve_format,
    session::{self, Session, SessionStatus, StopReason},
    write_json, write_json_line,
};

/// Recording inputs shared between the foreground recorder, the `--detach` parent, and the
/// re-exec'd background worker. Kept in one struct so the worker can be invoked with exactly the
/// flags the parent received (see [`RecordParams::to_cli_args`]).
#[derive(Args, Clone)]
pub struct RecordParams {
    #[command(flatten)]
    target: RecordTargets,
    /// Recording mode to use
    #[arg(long, value_enum, default_value_t = RecordMode::Studio)]
    mode: RecordMode,
    /// Capture from the camera with this device id (see `cap targets cameras`)
    #[arg(long)]
    camera: Option<String>,
    /// Capture from the microphone with this device name (see `cap targets mics`)
    #[arg(long)]
    mic: Option<String>,
    /// Whether to capture system audio
    #[arg(long)]
    system_audio: bool,
    #[arg(
        long,
        help = "New '.cap' project path (defaults to <recordingId>.cap in the working directory). The path must not already exist, including an empty directory."
    )]
    path: Option<PathBuf>,
    /// Maximum fps to record at, never above the display's refresh rate (Studio 1-240 on macOS and 1-120 elsewhere, Instant 1-120; camera recordings follow the desktop camera cap)
    #[arg(long)]
    fps: Option<u32>,
    /// Studio screen video bitrate in Mbps, replacing the quality preset's target (2-400)
    #[arg(long, value_name = "MBPS")]
    video_bitrate: Option<f64>,
    /// Stop automatically after N seconds
    #[arg(long)]
    duration: Option<f64>,
}

impl RecordParams {
    fn validate(&self) -> Result<(), String> {
        if self.duration.is_some_and(|duration| {
            // `> u64::MAX` would panic in `Duration::from_secs_f64` (used by `wait_for_stop`).
            !duration.is_finite() || duration <= 0.0 || duration > u64::MAX as f64
        }) {
            return Err("Duration must be a positive, finite number of seconds".to_string());
        }
        if self.fps == Some(0) {
            return Err("--fps must be greater than 0".to_string());
        }
        if let Some(mbps) = self.video_bitrate {
            if self.mode != RecordMode::Studio {
                return Err("--video-bitrate only applies to Studio recordings".to_string());
            }
            let min = cap_recording::MIN_STUDIO_VIDEO_BITRATE as f64 / 1_000_000.0;
            let max = cap_recording::MAX_STUDIO_VIDEO_BITRATE as f64 / 1_000_000.0;
            if !mbps.is_finite() || !(min..=max).contains(&mbps) {
                return Err(format!(
                    "--video-bitrate must be between {min} and {max} Mbps"
                ));
            }
        }
        Ok(())
    }

    fn to_cli_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(id) = &self.target.screen {
            args.push("--screen".to_string());
            args.push(id.to_string());
        }
        if let Some(id) = &self.target.window {
            args.push("--window".to_string());
            args.push(id.to_string());
        }
        args.push("--mode".to_string());
        args.push(self.mode.to_string());
        if let Some(camera) = &self.camera {
            args.push("--camera".to_string());
            args.push(camera.clone());
        }
        if let Some(mic) = &self.mic {
            args.push("--mic".to_string());
            args.push(mic.clone());
        }
        if self.system_audio {
            args.push("--system-audio".to_string());
        }
        if let Some(path) = &self.path {
            args.push("--path".to_string());
            args.push(path.display().to_string());
        }
        if let Some(fps) = self.fps {
            args.push("--fps".to_string());
            args.push(fps.to_string());
        }
        if let Some(mbps) = self.video_bitrate {
            args.push("--video-bitrate".to_string());
            args.push(mbps.to_string());
        }
        if let Some(duration) = self.duration {
            args.push("--duration".to_string());
            args.push(duration.to_string());
        }
        args
    }
}

fn video_bitrate_bps(mbps: f64) -> u32 {
    (mbps * 1_000_000.0).round() as u32
}

pub(crate) const LOW_STORAGE_EXIT_CODE: i32 = 3;
pub(crate) const CAPTURE_FAILED_EXIT_CODE: i32 = 4;
const LOW_STORAGE_CODE: &str = "lowStorage";
const CAPTURE_FAILED_CODE: &str = "captureFailed";
const STORAGE_POLL_INTERVAL: Duration = Duration::from_secs(2);

static EARLY_STOP: AtomicU8 = AtomicU8::new(0);

fn note_early_stop(reason: StopReason) {
    EARLY_STOP.store(
        match reason {
            StopReason::LowStorage => 1,
            StopReason::CaptureFailed => 2,
        },
        Ordering::SeqCst,
    );
}

fn early_stop() -> Option<StopReason> {
    match EARLY_STOP.load(Ordering::SeqCst) {
        1 => Some(StopReason::LowStorage),
        2 => Some(StopReason::CaptureFailed),
        _ => None,
    }
}

pub(crate) fn failure_exit_code() -> i32 {
    match early_stop() {
        Some(StopReason::LowStorage) => LOW_STORAGE_EXIT_CODE,
        Some(StopReason::CaptureFailed) => CAPTURE_FAILED_EXIT_CODE,
        None => 1,
    }
}

fn low_storage_error_code() -> Option<&'static str> {
    early_stop().map(|reason| match reason {
        StopReason::LowStorage => LOW_STORAGE_CODE,
        StopReason::CaptureFailed => CAPTURE_FAILED_CODE,
    })
}

/// A Studio recording whose capture failed part way is marked Failed with its
/// media kept. The desktop editor salvages such a project when the user opens
/// it; the CLI has no editor, so the recording that just failed and an explicit
/// export run the same salvage. Recordings still saving in this process are
/// skipped by `inspect_recording`.
pub(crate) fn salvage_failed_studio(project_path: &Path) -> Result<bool, String> {
    let Ok(meta) = RecordingMeta::load_for_project(project_path) else {
        return Ok(false);
    };
    if !meta
        .studio_meta()
        .is_some_and(|studio| matches!(studio.status(), StudioRecordingStatus::Failed { .. }))
    {
        return Ok(false);
    }
    let Some(incomplete) = RecoveryManager::inspect_recording(project_path) else {
        return Ok(false);
    };
    if incomplete.recoverable_segments.is_empty() {
        return Ok(false);
    }
    if let Ok(storage) = disk_space::recording_storage(project_path, FinalizationKind::Studio)
        && !storage.can_finalize()
    {
        return Err(format!(
            "Not enough free space to recover the recording: {} MB free, about {} MB needed. Its files are kept at {}",
            mib(storage.available_bytes),
            mib(storage
                .finalization_bytes()
                .saturating_add(disk_space::RECORDING_DISK_RESERVE_BYTES / 2)),
            project_path.display()
        ));
    }
    RecoveryManager::salvage(&incomplete)
        .map(|_| true)
        .map_err(|error| {
            format!(
                "Could not recover the recording: {error}. Its files are kept at {}",
                project_path.display()
            )
        })
}

fn mib(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

fn ensure_storage_to_start(path: &Path) -> Result<(), String> {
    let probe = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let available_bytes = match disk_space::free_bytes_for_path(&probe) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "Could not check free space before recording");
            return Ok(());
        }
    };
    let storage = RecordingStorage {
        available_bytes,
        recording_bytes: 0,
        finalization_copies: 3,
    };
    if storage.status() != DiskSpaceStatus::Exhausted {
        return Ok(());
    }
    note_early_stop(StopReason::LowStorage);
    Err(format!(
        "Not enough free space to record: {} MB free on the drive for {}. Cap keeps {} MB free so a recording can always be saved. Free up space or pass a --path on another drive",
        mib(available_bytes),
        path.display(),
        mib(disk_space::RECORDING_DISK_RESERVE_BYTES)
    ))
}

fn early_stop_message(reason: StopReason, path: &Path) -> String {
    match reason {
        StopReason::LowStorage => format!(
            "Recording stopped early because the drive is almost full. Everything captured so far was saved to {}",
            path.display()
        ),
        StopReason::CaptureFailed => format!(
            "Recording stopped early because capture failed. Everything captured before the failure was saved to {}",
            path.display()
        ),
    }
}

/// Resolves once free space falls to the point where saving the recording
/// would no longer fit, using the same rule and cadence as the desktop app.
async fn watch_storage(
    project_path: PathBuf,
    mode: RecordMode,
    mut on_warning: impl FnMut(bool, RecordingStorage),
) {
    let kind = match mode {
        RecordMode::Studio => FinalizationKind::Studio,
        RecordMode::Instant => FinalizationKind::Instant,
    };
    let mut monitor = RecordingStorageMonitor::new(kind);
    let mut warning = false;
    let mut check_failed = false;
    loop {
        tokio::time::sleep(STORAGE_POLL_INTERVAL).await;
        let path = project_path.clone();
        let (next_monitor, result) = match tokio::task::spawn_blocking(move || {
            let result = monitor.sample(&path);
            (monitor, result)
        })
        .await
        {
            Ok(sampled) => sampled,
            Err(error) => {
                tracing::warn!(%error, "Recording storage check stopped");
                return std::future::pending().await;
            }
        };
        monitor = next_monitor;
        let storage = match result {
            Ok(storage) => {
                check_failed = false;
                storage
            }
            Err(error) => {
                if !check_failed {
                    tracing::warn!(%error, "Could not check recording storage");
                    check_failed = true;
                }
                continue;
            }
        };
        let status = storage.status();
        if let Some(low) = storage_warning_change(warning, status) {
            warning = low;
            log_storage(
                storage,
                if low {
                    "Recording storage is low; stopping soon to save the recording"
                } else {
                    "Recording storage warning cleared"
                },
            );
            on_warning(low, storage);
        }
        if status == DiskSpaceStatus::Exhausted {
            log_storage(
                storage,
                "Recording storage is low; stopping to save the recording",
            );
            return;
        }
    }
}

fn storage_warning_change(warning: bool, status: DiskSpaceStatus) -> Option<bool> {
    let low = status != DiskSpaceStatus::Ok;
    (low != warning).then_some(low)
}

fn log_storage(storage: RecordingStorage, event: &'static str) {
    tracing::warn!(
        available_bytes = storage.available_bytes,
        recording_bytes = storage.recording_bytes,
        finalization_bytes = storage.finalization_bytes(),
        "{event}"
    );
}

fn storage_event(low: bool, storage: RecordingStorage) -> RecordEvent<'static> {
    RecordEvent::Storage {
        status: if low { "low" } else { "ok" },
        available_bytes: storage.available_bytes,
        recording_bytes: storage.recording_bytes,
        reserved_bytes: storage
            .finalization_bytes()
            .saturating_add(disk_space::RECORDING_DISK_RESERVE_BYTES),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum RecordMode {
    Studio,
    Instant,
}

impl std::fmt::Display for RecordMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Studio => f.write_str("studio"),
            Self::Instant => f.write_str("instant"),
        }
    }
}

#[derive(Args)]
pub struct RecordStart {
    #[command(flatten)]
    params: RecordParams,
    /// Record in the background and return immediately; stop later with `cap record stop`
    #[arg(long)]
    detach: bool,
    /// Output format for status events
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

/// Hidden worker entrypoint. `cap record start --detach` re-execs the binary as
/// `cap record __session-run` so the recording outlives the parent process.
#[derive(Args)]
pub struct SessionRunArgs {
    #[command(flatten)]
    params: RecordParams,
    #[arg(long)]
    session_id: String,
}

#[derive(Args)]
pub struct RecordStopArgs {
    /// recordingId returned by `cap record start --detach`
    #[arg(long)]
    id: Option<String>,
    /// The '.cap' project path of the recording to stop (alternative to --id)
    #[arg(long)]
    path: Option<PathBuf>,
    /// Seconds to wait for the recording to finalize before giving up
    #[arg(long, default_value_t = 30.0)]
    timeout: f64,
    /// Output format for status events
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

impl RecordStart {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let format = resolve_format(json, self.format);
        match self.run_inner(format).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if format == OutputFormat::Json {
                    let _ = write_json_line(&RecordEvent::Error {
                        error: &error,
                        code: low_storage_error_code(),
                    });
                }
                Err(error)
            }
        }
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), String> {
        self.params.validate()?;
        if self.detach {
            run_detached(self.params, format).await
        } else {
            run_foreground(self.params, format).await
        }
    }
}

async fn run_foreground(params: RecordParams, format: OutputFormat) -> Result<(), String> {
    let interactive = std::io::stdin().is_terminal();

    // Without --duration the recorder blocks for a stop signal. A non-interactive caller (agent, CI,
    // /dev/null stdin) hits EOF immediately and would otherwise produce a ~0s recording that exits
    // successfully. Require an explicit duration, or point them at the detached lifecycle.
    if params.duration.is_none() && !interactive {
        return Err(
            "Recording without --duration requires an interactive terminal; pass --duration <seconds>, \
             or use `cap record start --detach` and stop it later with `cap record stop`"
                .to_string(),
        );
    }

    let recording_id = new_recording_id();
    let target = resolve_target(&params)?;
    let path = resolve_path(&params, &recording_id)?;
    ensure_storage_to_start(&path)?;
    let actor = start_recording(&params, target, path.clone()).await?;
    let path_display = path.display().to_string();

    // The recording is now writing to disk, so every path from here must finalize the actor.
    if let Err(error) = emit_record_event(
        format,
        &RecordEvent::Started {
            recording_id: &recording_id,
            pid: std::process::id(),
            path: &path_display,
        },
    ) {
        if let Ok(completed) = actor.stop().await {
            let _ = finalize_completed(completed).await;
        }
        return Err(error);
    }

    if params.duration.is_none() && interactive && format == OutputFormat::Text {
        println!("Press Enter to stop (or send SIGINT/SIGTERM)");
    }

    let storage = watch_storage(path.clone(), params.mode, |low, storage| {
        let _ = emit_record_event(format, &storage_event(low, storage));
    });
    let (completed, stop_reason) =
        match finalize(actor, params.duration, interactive, None, storage).await {
            Ok(finalized) => finalized,
            Err(error) => {
                let path = salvage_after_capture_failure(params.mode, path, error).await?;
                emit_record_event(
                    format,
                    &RecordEvent::Stopped {
                        path: &path.display().to_string(),
                        recording_meta_exists: path.join("recording-meta.json").exists(),
                        screen_frames: None,
                        reason: Some(StopReason::CaptureFailed),
                    },
                )?;
                return Err(early_stop_message(StopReason::CaptureFailed, &path));
            }
        };
    crate::automation::run_recording_finished(
        completed.project_path(),
        automation_mode(params.mode),
    )
    .await;
    emit_stopped(format, &completed, stop_reason)?;
    match stop_reason {
        Some(reason) => Err(early_stop_message(reason, completed.project_path())),
        None => Ok(()),
    }
}

fn automation_mode(mode: RecordMode) -> cap_automation::AutomationRecordingMode {
    match mode {
        RecordMode::Studio => cap_automation::AutomationRecordingMode::Studio,
        RecordMode::Instant => cap_automation::AutomationRecordingMode::Instant,
    }
}

async fn run_detached(params: RecordParams, format: OutputFormat) -> Result<(), String> {
    let recording_id = new_recording_id();
    let path = resolve_path(&params, &recording_id)?;
    let path = if path.is_absolute() {
        path
    } else {
        current_dir()
            .map_err(|e| format!("Could not determine current directory: {e}"))?
            .join(path)
    };

    if path.to_str().is_none() {
        return Err("Detached recording paths must be valid UTF-8; choose a different path or working directory".to_string());
    }

    // Validate before spawning so target errors do not surface only in the worker log.
    resolve_target(&params)?;
    ensure_storage_to_start(&path)?;

    let exe =
        std::env::current_exe().map_err(|e| format!("Could not locate the cap executable: {e}"))?;

    let sessions_dir = session::sessions_dir()?;
    std::fs::create_dir_all(&sessions_dir)
        .map_err(|e| format!("Could not create sessions dir: {e}"))?;
    let log_path = session::log_file(&recording_id)?;
    let log = std::fs::File::create(&log_path)
        .map_err(|e| format!("Could not create session log {}: {e}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("Could not prepare session log: {e}"))?;

    let mut worker_params = params.clone();
    worker_params.path = Some(path.clone());

    let mut command = std::process::Command::new(&exe);
    command
        .arg("record")
        .arg("__session-run")
        .arg("--session-id")
        .arg(&recording_id)
        .args(worker_params.to_cli_args())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    // Detach from the parent so closing the parent's shell/pipeline does not signal the recording
    // worker. On unix this means a new process group; on Windows, no console + a new process group so
    // a Ctrl-C / console-close in the launching terminal does not reach the worker.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("Could not start the recording worker: {e}"))?;
    let pid = child.id();

    let session = wait_for_session_ready(&recording_id, child).await?;

    if let Err(error) = emit_record_event(
        format,
        &RecordEvent::Started {
            recording_id: &recording_id,
            pid,
            path: &session.path.display().to_string(),
        },
    ) {
        // The worker is already recording in its own process group. If we cannot hand the caller the
        // recordingId it could never stop it, so tear the recording down rather than leak an orphan.
        let _ = session::request_stop(&recording_id);
        if session::process_alive(pid) {
            session::terminate(pid);
        }
        return Err(format!(
            "{error}; background recording {recording_id} was stopped because its start event could not be delivered"
        ));
    }

    Ok(())
}

async fn wait_for_session_ready(
    recording_id: &str,
    mut child: std::process::Child,
) -> Result<Session, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            // The worker has provably exited. A clean `Stopped` is success (a short `--duration` run can
            // finish before the parent's first poll); a leftover `Recording` means it died mid-recording
            // without finalizing, so fall through to the error rather than report a healthy start.
            if let Ok(session) = session::read_session(recording_id) {
                match session.status {
                    SessionStatus::Stopped => return Ok(session),
                    SessionStatus::Error => {
                        return Err(session
                            .error
                            .unwrap_or_else(|| "recording worker failed to start".to_string()));
                    }
                    SessionStatus::Recording if session::process_alive(session.pid) => {
                        return Ok(session);
                    }
                    SessionStatus::Recording => {}
                }
            }
            let log = session::log_file(recording_id)
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            return Err(format!(
                "recording worker exited before finalizing the recording ({status}); see {log}"
            ));
        }

        if let Ok(session) = session::read_session(recording_id) {
            match session.status {
                SessionStatus::Recording | SessionStatus::Stopped => return Ok(session),
                SessionStatus::Error => {
                    let _ = child.kill();
                    return Err(session
                        .error
                        .unwrap_or_else(|| "recording failed to start".to_string()));
                }
            }
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err("timed out waiting for the recording to start".to_string());
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

impl SessionRunArgs {
    pub async fn run(self) -> Result<(), String> {
        let recording_id = self.session_id;
        match session_worker(self.params, &recording_id).await {
            Ok(()) => Ok(()),
            Err(error) => {
                // Record the failure so the parent (`record start`) and `record stop` can surface it
                // instead of an opaque exit. Reuse the startedAt/path the worker may already have
                // written for the Recording session so the Error row keeps the real start time, which
                // `record status` sorts by.
                let prior = session::read_session(&recording_id).ok();
                let _ = session::write_session(&Session {
                    pid: std::process::id(),
                    path: prior.as_ref().map(|s| s.path.clone()).unwrap_or_default(),
                    status: SessionStatus::Error,
                    started_at: prior
                        .as_ref()
                        .and_then(|s| s.started_at)
                        .or_else(session::now_unix),
                    recording_meta_exists: None,
                    error: Some(error.clone()),
                    stop_reason: None,
                    storage_low: prior.as_ref().is_some_and(|s| s.storage_low),
                    recording_id,
                });
                Err(error)
            }
        }
    }
}

async fn session_worker(params: RecordParams, recording_id: &str) -> Result<(), String> {
    let target = resolve_target(&params)?;
    let path = params
        .path
        .clone()
        .ok_or_else(|| "internal: detached worker started without --path".to_string())?;
    let actor = start_recording(&params, target, path.clone()).await?;

    // Stamp the start time once; reusing it for the Stopped write keeps `startedAt` meaning the start
    // (not the stop), which `list_sessions` relies on to sort recordings newest-first.
    let started_at = session::now_unix();
    let recording_session = |storage_low| Session {
        recording_id: recording_id.to_string(),
        pid: std::process::id(),
        path: path.clone(),
        status: SessionStatus::Recording,
        started_at,
        recording_meta_exists: None,
        error: None,
        stop_reason: None,
        storage_low,
    };
    session::write_session(&recording_session(false))?;

    let stop_path = session::stop_file(recording_id)?;
    let storage = watch_storage(path.clone(), params.mode, |low, _| {
        if let Err(error) = session::write_session(&recording_session(low)) {
            tracing::warn!(%error, "Could not record the storage warning in the session");
        }
    });
    let (completed, stop_reason) =
        match finalize(actor, params.duration, false, Some(&stop_path), storage).await {
            Ok(finalized) => finalized,
            Err(error) => {
                let path = salvage_after_capture_failure(params.mode, path.clone(), error).await?;
                return session::write_session(&Session {
                    recording_id: recording_id.to_string(),
                    pid: std::process::id(),
                    recording_meta_exists: Some(path.join("recording-meta.json").exists()),
                    path,
                    status: SessionStatus::Stopped,
                    started_at,
                    error: None,
                    stop_reason: Some(StopReason::CaptureFailed),
                    storage_low: false,
                });
            }
        };
    crate::automation::run_recording_finished(
        completed.project_path(),
        automation_mode(params.mode),
    )
    .await;
    let recording_meta_exists = completed
        .project_path()
        .join("recording-meta.json")
        .exists();

    session::write_session(&Session {
        recording_id: recording_id.to_string(),
        pid: std::process::id(),
        path: completed.project_path().to_path_buf(),
        status: SessionStatus::Stopped,
        started_at,
        recording_meta_exists: Some(recording_meta_exists),
        error: None,
        stop_reason,
        storage_low: stop_reason.is_some(),
    })
}

impl RecordStopArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let format = resolve_format(json, self.format);
        match self.run_inner(format).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if format == OutputFormat::Json {
                    let _ = write_json_line(&RecordEvent::Error {
                        error: &error,
                        code: low_storage_error_code(),
                    });
                }
                Err(error)
            }
        }
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), String> {
        let timeout = stop_timeout(self.timeout)?;
        let session = resolve_session(self.id.as_deref(), self.path.as_deref())?;
        let id = session.recording_id.clone();

        if session.status == SessionStatus::Stopped {
            return finish_stopped_session(format, &session);
        }

        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| "--timeout is too large".to_string())?;
        session::request_stop(&id)?;

        loop {
            let current = session::read_session(&id).unwrap_or_else(|_| session.clone());
            match current.status {
                SessionStatus::Stopped => {
                    return finish_stopped_session(format, &current);
                }
                SessionStatus::Error => {
                    cleanup_session(&id, &current.path);
                    return Err(current
                        .error
                        .unwrap_or_else(|| "recording failed".to_string()));
                }
                SessionStatus::Recording => {}
            }

            if !session::process_alive(current.pid) {
                let recording_meta_exists = current.path.join("recording-meta.json").exists();
                if !recording_meta_exists {
                    return fail_dead_session(
                        current,
                        "recording process exited without finalizing the recording".to_string(),
                    );
                }

                if let Err(error) = crate::project::validate_project(&current.path) {
                    return fail_dead_session(current, error);
                }

                cleanup_session(&id, &current.path);
                return emit_record_event(
                    format,
                    &RecordEvent::Stopped {
                        path: &current.path.display().to_string(),
                        recording_meta_exists: true,
                        screen_frames: None,
                        reason: None,
                    },
                );
            }

            if Instant::now() >= deadline {
                if session::process_alive(current.pid) {
                    session::terminate(current.pid);
                }
                return Err(format!(
                    "timed out after {}s waiting for recording '{id}' to stop",
                    self.timeout
                ));
            }

            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
}

/// Salvages the Studio recording whose capture just failed, the way the
/// desktop editor does when the failed recording is opened. Returns the
/// original error when there was nothing to salvage or the salvage failed.
async fn salvage_after_capture_failure(
    mode: RecordMode,
    path: PathBuf,
    error: String,
) -> Result<PathBuf, String> {
    if mode != RecordMode::Studio {
        return Err(error);
    }
    let project = path.clone();
    match tokio::task::spawn_blocking(move || salvage_failed_studio(&project)).await {
        Ok(Ok(true)) => {
            tracing::warn!(%error, path = %path.display(), "Recording capture failed; recovered what was captured");
            note_early_stop(StopReason::CaptureFailed);
            Ok(path)
        }
        Ok(Ok(false)) => Err(error),
        Ok(Err(salvage)) => Err(format!("{error}. {salvage}")),
        Err(join) => Err(format!("{error}. Recovery task failed: {join}")),
    }
}

fn finish_stopped_session(format: OutputFormat, session: &Session) -> Result<(), String> {
    emit_record_event(
        format,
        &RecordEvent::Stopped {
            path: &session.path.display().to_string(),
            recording_meta_exists: session.recording_meta_exists.unwrap_or(true),
            screen_frames: None,
            reason: session.stop_reason,
        },
    )?;
    cleanup_session(&session.recording_id, &session.path);
    match session.stop_reason {
        Some(reason) => {
            note_early_stop(reason);
            Err(early_stop_message(reason, &session.path))
        }
        None => Ok(()),
    }
}

fn stop_timeout(timeout: f64) -> Result<Duration, String> {
    Duration::try_from_secs_f64(timeout)
        .map_err(|_| "--timeout must be finite, non-negative, and representable".to_string())
}

fn cleanup_session(id: &str, project_path: &Path) {
    if let Err(error) = session::archive_log(id, project_path) {
        debug!("{error}");
    }
    session::cleanup(id);
}

fn fail_dead_session(session: Session, error: String) -> Result<(), String> {
    let _ = session::write_session(&Session {
        status: SessionStatus::Error,
        error: Some(error.clone()),
        ..session
    });
    Err(error)
}

fn resolve_session(id: Option<&str>, path: Option<&Path>) -> Result<Session, String> {
    if let Some(id) = id {
        return session::read_session(id);
    }

    let sessions = session::list_sessions()?;

    if let Some(path) = path {
        let wanted = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        return sessions
            .into_iter()
            .find(|s| {
                s.path == path
                    || std::fs::canonicalize(&s.path).is_ok_and(|resolved| resolved == wanted)
            })
            .ok_or_else(|| format!("No recording session found for path {}", path.display()));
    }

    select_active_session(sessions)
}

fn select_active_session(sessions: Vec<Session>) -> Result<Session, String> {
    let (mut active, inactive): (Vec<Session>, Vec<Session>) = sessions
        .into_iter()
        .filter(|s| s.status == SessionStatus::Recording)
        .partition(|session| session::process_alive(session.pid));
    if active.is_empty() {
        active = inactive;
    }
    match active.len() {
        0 => Err(
            "No active recording sessions. Start one with `cap record start --detach`".to_string(),
        ),
        1 => Ok(active.remove(0)),
        _ => {
            let ids: Vec<&str> = active.iter().map(|s| s.recording_id.as_str()).collect();
            Err(format!(
                "Multiple active recordings; pass --id <recordingId>. Active: {ids:?}"
            ))
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusRow {
    recording_id: String,
    pid: u32,
    path: PathBuf,
    status: SessionStatus,
    alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_reason: Option<StopReason>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    storage_low: bool,
}

pub fn status(format: OutputFormat) -> Result<(), String> {
    let rows: Vec<SessionStatusRow> = session::list_sessions()?
        .into_iter()
        .map(session_status_row)
        .collect();

    match format {
        OutputFormat::Json => write_json(&rows),
        OutputFormat::Text => {
            if rows.is_empty() {
                println!("No recording sessions");
                return Ok(());
            }
            for row in &rows {
                let status = match row.status {
                    SessionStatus::Recording => "recording",
                    SessionStatus::Stopped => "stopped",
                    SessionStatus::Error => "error",
                };
                println!(
                    "{}  [{status}]  pid {}  {}",
                    row.recording_id,
                    row.pid,
                    row.path.display()
                );
            }
            Ok(())
        }
    }
}

fn session_status_row(session: Session) -> SessionStatusRow {
    let alive = session.status == SessionStatus::Recording && session::process_alive(session.pid);
    session_status_row_with_alive(session, alive)
}

fn session_status_row_with_alive(session: Session, alive: bool) -> SessionStatusRow {
    let process_gone = session.status == SessionStatus::Recording && !alive;
    let status = if process_gone {
        SessionStatus::Error
    } else {
        session.status
    };
    let error = if process_gone {
        Some("recording process is not running".to_string())
    } else {
        session.error
    };

    SessionStatusRow {
        recording_id: session.recording_id,
        pid: session.pid,
        path: session.path,
        status,
        alive,
        started_at: session.started_at,
        error,
        stop_reason: session.stop_reason,
        storage_low: session.storage_low,
    }
}

enum ActorHandle {
    Studio(StudioActorHandle),
    Instant {
        actor: instant_recording::ActorHandle,
        _upload_lock: UploadLock,
    },
}

impl ActorHandle {
    fn done_fut(&self) -> DoneFut {
        match self {
            Self::Studio(actor) => actor.done_fut(),
            Self::Instant { actor, .. } => actor.done_fut(),
        }
    }

    async fn stop(&self) -> Result<CompletedRecording, String> {
        match self {
            #[cfg(windows)]
            Self::Studio(actor) => {
                let outcome = actor.stop_with_outcome().await;
                let outcome = match outcome.finishing.clone() {
                    Some(finishing) => wait_for_studio_finish(finishing).await,
                    None => outcome,
                };
                outcome.result.map(Box::new).map(CompletedRecording::Studio)
            }
            #[cfg(not(windows))]
            Self::Studio(actor) => actor
                .stop()
                .await
                .map(Box::new)
                .map(CompletedRecording::Studio)
                .map_err(|e| format!("{e:#}")),
            Self::Instant { actor, .. } => actor
                .stop()
                .await
                .map(CompletedRecording::Instant)
                .map_err(|e| format!("{e:#}")),
        }
    }
}

/// How long `cap record` waits for Studio tracks still finishing after the
/// stop limit before it exits and leaves the recording to recovery.
#[cfg(windows)]
const STUDIO_FINISH_WAIT: Duration = Duration::from_secs(120);

#[cfg(windows)]
static STUDIO_STILL_FINISHING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
async fn wait_for_studio_finish(
    finishing: studio_recording::StudioFinishing,
) -> studio_recording::StudioStopOutcome {
    let path = finishing.project_path().display().to_string();
    eprintln!(
        "Recording is still finishing; waiting up to {}s for it to save: {path}",
        STUDIO_FINISH_WAIT.as_secs()
    );
    match tokio::time::timeout(STUDIO_FINISH_WAIT, finishing.wait()).await {
        Ok(outcome) => {
            if outcome.result.is_ok() {
                eprintln!("Recording finished saving: {path}");
            }
            outcome
        }
        Err(_) => {
            STUDIO_STILL_FINISHING.store(true, std::sync::atomic::Ordering::SeqCst);
            studio_recording::StudioStopOutcome {
                capture_stopped: false,
                result: Err(format!(
                    "Recording is still finishing after {}s. Nothing was discarded; it will be recovered when it is next exported (cap export \"{path}\") or opened in Cap",
                    STUDIO_FINISH_WAIT.as_secs()
                )),
                finishing: None,
            }
        }
    }
}

/// Ends the process after `report` once `cap record` has given up waiting
/// for Studio tracks still finishing. A writer still blocked in the OS keeps
/// both the runtime and the normal process exit waiting on it, so the process
/// terminates outright; the files are left in the state crash recovery
/// expects.
#[cfg(windows)]
pub(crate) fn terminate_if_studio_still_finishing(report: impl FnOnce()) {
    if !STUDIO_STILL_FINISHING.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    report();
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    unsafe {
        let _ = windows::Win32::System::Threading::TerminateProcess(
            windows::Win32::System::Threading::GetCurrentProcess(),
            1,
        );
    }
    std::process::exit(1);
}

enum CompletedRecording {
    Studio(Box<studio_recording::CompletedRecording>),
    Instant(instant_recording::CompletedRecording),
}

impl CompletedRecording {
    fn project_path(&self) -> &Path {
        match self {
            Self::Studio(recording) => &recording.project_path,
            Self::Instant(recording) => &recording.project_path,
        }
    }
}

async fn start_recording(
    params: &RecordParams,
    target: ScreenCaptureTarget,
    path: PathBuf,
) -> Result<ActorHandle, String> {
    #[cfg(target_os = "macos")]
    let target_for_shareable_content = target.clone();
    let camera_only_target = matches!(target, ScreenCaptureTarget::CameraOnly);
    let mut studio_builder = studio_recording::Actor::builder(path.clone(), target.clone())
        .with_system_audio(params.system_audio);
    let mut instant_builder = instant_recording::Actor::builder(path.clone(), target)
        .with_system_audio(params.system_audio);
    let mut camera_active = false;
    let camera_recorded =
        !(cfg!(target_os = "macos") && params.mode == RecordMode::Instant && !camera_only_target);

    // Feeds must be locked and attached before build(); the lock keeps the device open for the whole
    // recording, so the feed actor handle itself does not need to be retained.
    // macOS Instant recordings capture only the screen (the desktop app's camera bubble is part of
    // the screen), so a camera opened here would run for the whole recording without being recorded.
    if params.camera.is_some() && !camera_recorded {
        eprintln!(
            "warning: --camera is ignored for Instant recordings on macOS; the camera is only recorded in Studio mode"
        );
    }

    if let Some(device_id) = params.camera.as_deref().filter(|_| camera_recorded) {
        let info = cap_camera::list_cameras()
            .find(|c| c.device_id() == device_id)
            .ok_or_else(|| {
                let available: Vec<String> = cap_camera::list_cameras()
                    .map(|c| c.device_id().to_string())
                    .collect();
                format!(
                    "Camera with id '{device_id}' not found. Available device ids: {available:?} \
                     (see `cap targets cameras`)"
                )
            })?;
        let id = camera::DeviceOrModelID::from_info(&info);

        let camera_feed = CameraFeed::spawn(CameraFeed::default());
        camera_feed
            .ask(camera::SetInput { id, settings: None })
            .await
            .map_err(|e| format!("Failed to set camera input: {e}"))?
            .await
            .map_err(|e| format!("Camera failed to connect: {e}"))?;
        let lock = camera_feed
            .ask(camera::Lock)
            .await
            .map_err(|e| format!("Failed to lock camera feed: {e}"))?;
        let lock = Arc::new(lock);
        studio_builder = studio_builder.with_camera_feed(lock.clone());
        instant_builder = instant_builder.with_camera_feed(lock);
        camera_active = true;
    }

    if let Some(mic_name) = params.mic.as_deref() {
        // Listed devices keep their inputs open (on Linux the sound card itself),
        // so the list goes before the microphone is opened.
        {
            let available = MicrophoneFeed::list();
            if !available.contains_key(mic_name) {
                let names: Vec<&str> = available.keys().map(String::as_str).collect();
                return Err(format!(
                    "Microphone '{mic_name}' not found. Available: {names:?} (see `cap targets mics`)"
                ));
            }
        }

        let (error_tx, _error_rx) = flume::bounded(16);
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
        mic_feed
            .ask(microphone::SetInput {
                label: mic_name.to_string(),
                settings: None,
            })
            .await
            .map_err(|e| format!("Failed to set mic input: {e}"))?
            .await
            .map_err(|e| format!("Mic failed to connect: {e}"))?;
        // The stream needs a moment to warm up before locking on slower devices.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let lock = mic_feed
            .ask(microphone::Lock)
            .await
            .map_err(|e| format!("Failed to lock mic feed: {e}"))?;
        let lock = Arc::new(lock);
        studio_builder = studio_builder.with_mic_feed(lock.clone());
        instant_builder = instant_builder.with_mic_feed(lock);
    }

    let upload_lock = prepare_recording_project(
        &path,
        params.mode,
        params.mic.is_some() || params.system_audio,
    )?;

    match params.mode {
        RecordMode::Studio => {
            let builder = cap_recording::RecordingDefaults::default()
                .apply_to_studio_builder(studio_builder, camera_active, params.fps)
                .with_video_bitrate(params.video_bitrate.map(video_bitrate_bps));

            builder
                .build(
                    #[cfg(target_os = "macos")]
                    Some(
                        acquire_shareable_content_for_target(&target_for_shareable_content).await?,
                    ),
                )
                .await
                .map(ActorHandle::Studio)
                .map_err(|e| e.to_string())
        }
        RecordMode::Instant => {
            let upload_lock = upload_lock
                .ok_or_else(|| "Instant recording project ownership is unavailable".to_string())?;
            let mut builder = instant_builder;
            #[cfg(target_os = "linux")]
            if camera_active {
                builder = builder.with_linux_camera_composition();
            }
            builder = builder.with_max_output_size(
                cap_recording::RecordingDefaults::default().instant_mode_max_resolution,
            );
            if let Some(fps) = params.fps {
                builder = builder.with_max_fps(fps);
            }
            // As in the desktop app: the screen and audio tracks both start at
            // the gate's arm time, so a microphone that is ready late does not
            // move all audio early. The CLI has no start cue to wait for.
            let start_gate = cap_recording::RecordingStartGate::new();
            builder = builder.with_start_gate(start_gate.clone());

            let actor = builder
                .build(
                    #[cfg(target_os = "macos")]
                    Some(
                        acquire_shareable_content_for_target(&target_for_shareable_content).await?,
                    ),
                )
                .await
                .map_err(|e| e.to_string())?;
            start_gate.arm();
            Ok(ActorHandle::Instant {
                actor,
                _upload_lock: upload_lock,
            })
        }
    }
}

#[cfg(target_os = "macos")]
async fn acquire_shareable_content_for_target(
    target: &ScreenCaptureTarget,
) -> Result<cap_recording::SendableShareableContent, String> {
    let mut available_display_ids = Vec::new();

    for attempt in 0..3 {
        let shareable_content = read_shareable_content().await?;
        available_display_ids = shareable_content_display_ids(&shareable_content);

        if !shareable_content_missing_target_display(target, &shareable_content) {
            return Ok(shareable_content);
        }

        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    let requested_display = target
        .display()
        .map(|display| display.id().to_string())
        .unwrap_or_else(|| "none".to_string());
    Err(format!(
        "ScreenCaptureKit shareable content missing target display {requested_display}. Available display ids: {available_display_ids:?}"
    ))
}

#[cfg(target_os = "macos")]
async fn read_shareable_content() -> Result<cap_recording::SendableShareableContent, String> {
    let content = cidre::sc::ShareableContent::current()
        .await
        .map_err(|e| format!("Failed to read shareable content: {e}"))?;
    if !content.displays().is_empty() {
        return Ok(cap_recording::SendableShareableContent::from(content));
    }

    let process_content = cidre::sc::ShareableContent::current_process()
        .await
        .map_err(|e| format!("Failed to read current-process shareable content: {e}"))?;
    if !process_content.displays().is_empty() {
        return Ok(cap_recording::SendableShareableContent::from(
            process_content,
        ));
    }

    Ok(cap_recording::SendableShareableContent::from(content))
}

#[cfg(target_os = "macos")]
fn shareable_content_missing_target_display(
    target: &ScreenCaptureTarget,
    shareable_content: &cap_recording::SendableShareableContent,
) -> bool {
    match target.display() {
        Some(display) => display
            .raw_handle()
            .as_sc(shareable_content.retained())
            .is_none(),
        None => false,
    }
}

#[cfg(target_os = "macos")]
fn shareable_content_display_ids(
    shareable_content: &cap_recording::SendableShareableContent,
) -> Vec<String> {
    shareable_content
        .retained()
        .displays()
        .iter()
        .map(|display| display.display_id().0.to_string())
        .collect()
}

/// Wait for the stop trigger, then finalize the recording. A panic between start and stop would
/// otherwise drop the actor without writing recording-meta.json (`ActorHandle` has no `Drop`),
/// leaving an unrecoverable .cap; catch it and best-effort finalize so the recording is recoverable.
///
/// Studio recordings are fragmented while recording, so a graceful stop finalizes those fragments
/// before the `.cap` is returned.
async fn finalize(
    actor: ActorHandle,
    duration: Option<f64>,
    interactive: bool,
    stop_file: Option<&Path>,
    storage: impl Future<Output = ()>,
) -> Result<(CompletedRecording, Option<StopReason>), String> {
    let outcome = std::panic::AssertUnwindSafe(async {
        finalize_after_stop_trigger(
            actor.done_fut().map(|result| match result {
                Err(error) if error.is_caused_by::<PipelineStoppedByUser>() => Ok(()),
                result => result.map_err(|error| error.to_string()),
            }),
            async {
                tokio::select! {
                    biased;
                    _ = wait_for_stop(duration, interactive, stop_file) => None,
                    _ = storage => {
                        note_early_stop(StopReason::LowStorage);
                        Some(StopReason::LowStorage)
                    }
                }
            },
            async { finalize_completed(actor.stop().await?).await },
        )
        .await
    })
    .catch_unwind()
    .await;

    match outcome {
        Ok(result) => result,
        Err(_) => {
            let completed = actor
                .stop()
                .await
                .map_err(|e| format!("recording panicked; finalize failed: {e}"))?;
            let stop_reason = early_stop();
            Ok((finalize_completed(completed).await?, stop_reason))
        }
    }
}

async fn finalize_after_stop_trigger<T>(
    capture_done: impl Future<Output = Result<(), String>>,
    stop_requested: impl Future<Output = Option<StopReason>>,
    finalize: impl Future<Output = Result<T, String>>,
) -> Result<(T, Option<StopReason>), String> {
    let capture_result = tokio::select! {
        biased;
        result = capture_done => result.map(|()| None),
        stop_reason = stop_requested => Ok(stop_reason),
    };
    let finalized = finalize.await;
    let stop_reason = capture_result?;
    Ok((finalized?, stop_reason))
}

async fn finalize_completed(
    mut completed: CompletedRecording,
) -> Result<CompletedRecording, String> {
    match &mut completed {
        CompletedRecording::Studio(recording) => {
            let project_path = recording.project_path.clone();
            tokio::task::spawn_blocking(move || {
                cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
            })
            .await
            .map_err(|e| format!("recording finalize task failed: {e}"))?
            .map_err(|e| format!("Failed to finalize recording: {e}"))?;
        }
        CompletedRecording::Instant(recording) => {
            finalize_instant_output(recording).await?;
            persist_instant_recording_meta(recording)?;
        }
    }

    Ok(completed)
}

async fn finalize_instant_output(
    recording: &mut instant_recording::CompletedRecording,
) -> Result<(), String> {
    let completion = recording.clean_completion.take();
    let project_path = recording.project_path.clone();
    let output_path = project_path.join("content/output.mp4");
    let audio_dir = project_path.join("content/audio");
    if std::fs::metadata(&output_path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
        && !audio_dir.exists()
    {
        return Ok(());
    }

    let display_dir = project_path.join("content/display");
    tokio::task::spawn_blocking(move || match completion {
        Some(completion) => {
            cap_recording::recovery::RecoveryManager::finalize_completed_instant_output(
                &display_dir,
                &audio_dir,
                &output_path,
                completion,
            )
        }
        None => cap_recording::recovery::RecoveryManager::finalize_instant_output(
            &display_dir,
            &audio_dir,
            &output_path,
        ),
    })
    .await
    .map_err(|e| format!("instant recording finalize task failed: {e}"))?
    .map_err(|e| format!("Failed to finalize instant recording: {e}"))?;

    Ok(())
}

fn prepare_recording_project(
    path: &Path,
    mode: RecordMode,
    required_audio: bool,
) -> Result<Option<UploadLock>, String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create recording parent directory: {error}"))?;
    }
    std::fs::create_dir(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "Recording project already exists; choose a fresh --path".to_string()
        } else {
            format!("Failed to reserve recording project directory: {error}")
        }
    })?;
    if mode == RecordMode::Studio {
        return Ok(None);
    }
    let upload_lock = UploadLock::acquire(path)
        .map_err(|error| format!("Failed to reserve Instant recording ownership: {error}"))?;
    let content = path.join("content");
    std::fs::create_dir(&content)
        .map_err(|error| format!("Failed to create recording content directory: {error}"))?;
    if required_audio {
        // Recovery treats this directory as required-audio intent, even before audio setup succeeds.
        std::fs::create_dir(content.join("audio"))
            .map_err(|error| format!("Failed to preserve recording audio requirement: {error}"))?;
    }

    RecordingMeta {
        platform: Some(Platform::default()),
        project_path: path.to_path_buf(),
        pretty_name: path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Cap Recording")
            .to_string(),
        sharing: None,
        inner: RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true }),
        upload: None,
    }
    .save_for_project()
    .map_err(|error| format!("Failed to save initial instant recording meta: {error}"))?;
    Ok(Some(upload_lock))
}

fn persist_instant_recording_meta(
    recording: &instant_recording::CompletedRecording,
) -> Result<(), String> {
    let pretty_name = recording
        .project_path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Cap Recording")
        .to_string();
    let meta = match &recording.meta {
        InstantRecordingMeta::Complete { .. } => recording.meta.clone(),
        InstantRecordingMeta::InProgress { .. } => InstantRecordingMeta::Failed {
            error: "instant recording stopped before completion".to_string(),
        },
        InstantRecordingMeta::Failed { .. } => recording.meta.clone(),
    };

    RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording.project_path.clone(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Instant(meta),
        upload: None,
    }
    .save_for_project()
    .map_err(|e| format!("Failed to save instant recording meta: {e}"))?;

    ProjectConfiguration::default()
        .write(&recording.project_path)
        .map_err(|e| format!("Failed to save instant project config: {e}"))
}

fn emit_stopped(
    format: OutputFormat,
    completed: &CompletedRecording,
    reason: Option<StopReason>,
) -> Result<(), String> {
    let recording_meta_exists = completed
        .project_path()
        .join("recording-meta.json")
        .exists();
    emit_record_event(
        format,
        &RecordEvent::Stopped {
            path: &completed.project_path().display().to_string(),
            recording_meta_exists,
            screen_frames: match completed {
                CompletedRecording::Studio(recording) => recording.screen_frames,
                CompletedRecording::Instant(_) => None,
            },
            reason,
        },
    )
}

fn new_recording_id() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn resolve_path(params: &RecordParams, recording_id: &str) -> Result<PathBuf, String> {
    match &params.path {
        Some(path) => Ok(path.clone()),
        None => current_dir()
            .map_err(|e| format!("Could not determine current directory: {e}"))
            .map(|dir| dir.join(format!("{recording_id}.cap"))),
    }
}

fn resolve_target(params: &RecordParams) -> Result<ScreenCaptureTarget, String> {
    match (&params.target.screen, &params.target.window) {
        (Some(id), _) => cap_recording::screen_capture::list_displays()
            .into_iter()
            .find(|s| &s.0.id == id)
            .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
            .ok_or_else(|| {
                let available: Vec<String> = cap_recording::screen_capture::list_displays()
                    .into_iter()
                    .map(|(s, _)| s.id.to_string())
                    .collect();
                format!(
                    "Screen with id '{id}' not found. Available screen ids: {available:?} \
                     (see `cap targets screens`)"
                )
            }),
        (_, Some(id)) => cap_recording::screen_capture::list_windows()
            .into_iter()
            .find(|s| &s.0.id == id)
            .map(|(s, _)| ScreenCaptureTarget::Window { id: s.id })
            .ok_or_else(|| {
                format!(
                    "Window with id '{id}' not found. Run `cap targets windows` to list window ids"
                )
            }),
        _ => Err(
            "No target specified; pass --screen <id> or --window <id> (see `cap targets`)"
                .to_string(),
        ),
    }
}

/// Block until the recording should stop: the duration elapses, the user presses Enter (interactive
/// only), the process receives SIGINT/SIGTERM, or a detached worker's stop file appears. Every branch
/// resolves so the caller can finalize the recording gracefully instead of being killed mid-write.
async fn wait_for_stop(duration: Option<f64>, interactive: bool, stop_file: Option<&Path>) {
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();

    tokio::select! {
        _ = async {
            match duration {
                Some(d) => tokio::time::sleep(Duration::from_secs_f64(d)).await,
                None => std::future::pending::<()>().await,
            }
        } => {}
        _ = async {
            if duration.is_none() && interactive {
                let _ = tokio::io::BufReader::new(tokio::io::stdin())
                    .read_line(&mut String::new())
                    .await;
            } else {
                std::future::pending::<()>().await;
            }
        } => {}
        _ = tokio::signal::ctrl_c() => {}
        _ = async {
            #[cfg(unix)]
            if let Some(term) = term.as_mut() {
                term.recv().await;
                return;
            }
            std::future::pending::<()>().await;
        } => {}
        _ = async {
            match stop_file {
                Some(path) => loop {
                    if session::stop_requested(path) {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                },
                None => std::future::pending::<()>().await,
            }
        } => {}
    }
}

#[derive(Args, Clone)]
struct RecordTargets {
    /// ID of the screen to capture
    #[arg(long, group = "target")]
    screen: Option<DisplayId>,
    /// ID of the window to capture
    #[arg(long, group = "target")]
    window: Option<WindowId>,
}

// `rename_all` only renames the variant tags (started/stopped/error); `rename_all_fields` is what
// camelCases the fields inside each variant (recordingId, recordingMetaExists) — without it they leak
// as snake_case and break the camelCase contract the rest of the CLI and the docs promise.
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum RecordEvent<'a> {
    Started {
        recording_id: &'a str,
        pid: u32,
        path: &'a str,
    },
    Stopped {
        path: &'a str,
        recording_meta_exists: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        screen_frames: Option<ScreenFrameTotals>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<StopReason>,
    },
    Storage {
        status: &'static str,
        available_bytes: u64,
        recording_bytes: u64,
        reserved_bytes: u64,
    },
    Error {
        error: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'static str>,
    },
}

fn emit_record_event(format: OutputFormat, event: &RecordEvent<'_>) -> Result<(), String> {
    match format {
        OutputFormat::Text => {
            match event {
                RecordEvent::Started {
                    recording_id,
                    pid,
                    path,
                } => println!("Recording started: {path} (id {recording_id}, pid {pid})"),
                RecordEvent::Stopped {
                    path,
                    recording_meta_exists,
                    screen_frames,
                    ..
                } => {
                    println!("Recording stopped: {path}");
                    if !recording_meta_exists {
                        println!("warning: recording-meta.json was not written");
                    }
                    if let Some(frames) = screen_frames {
                        println!(
                            "Screen frames: {} written, {} lost of {} on screen ({:.2}%)",
                            frames.written,
                            frames.lost(),
                            frames.displayed,
                            frames.lost_pct()
                        );
                    }
                }
                RecordEvent::Storage {
                    status,
                    available_bytes,
                    ..
                } => {
                    if *status == "low" {
                        println!(
                            "warning: the drive is almost full ({} MB free); the recording will stop by itself before it runs out",
                            mib(*available_bytes)
                        );
                    } else {
                        println!("Drive space recovered ({} MB free)", mib(*available_bytes));
                    }
                }
                RecordEvent::Error { error, .. } => println!("Recording error: {error}"),
            }
            Ok(())
        }
        OutputFormat::Json => write_json_line(event),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn studio_params(mode: RecordMode, video_bitrate: Option<f64>) -> RecordParams {
        RecordParams {
            target: RecordTargets {
                screen: None,
                window: None,
            },
            mode,
            camera: None,
            mic: None,
            system_audio: false,
            path: None,
            fps: None,
            video_bitrate,
            duration: None,
        }
    }

    #[test]
    fn video_bitrate_is_validated_and_forwarded_for_studio_only() {
        assert!(studio_params(RecordMode::Studio, None).validate().is_ok());
        for mbps in [2.0, 12.5, 30.0, 400.0] {
            let params = studio_params(RecordMode::Studio, Some(mbps));
            assert!(params.validate().is_ok(), "{mbps}");
            let args = params.to_cli_args();
            let flag = args
                .iter()
                .position(|arg| arg == "--video-bitrate")
                .unwrap();
            assert_eq!(args[flag + 1].parse::<f64>().unwrap(), mbps);
        }
        for mbps in [0.0, 1.9, 400.5, f64::NAN, f64::INFINITY] {
            assert!(
                studio_params(RecordMode::Studio, Some(mbps))
                    .validate()
                    .is_err(),
                "{mbps}"
            );
        }
        let instant = studio_params(RecordMode::Instant, Some(30.0)).validate();
        assert!(instant.unwrap_err().contains("Studio"));
        assert!(
            !studio_params(RecordMode::Studio, None)
                .to_cli_args()
                .contains(&"--video-bitrate".to_string())
        );
        assert_eq!(video_bitrate_bps(12.5), 12_500_000);
        assert_eq!(video_bitrate_bps(400.0), 400_000_000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detached_recording_rejects_non_utf8_path_before_starting() {
        use std::os::unix::ffi::OsStringExt;

        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join(std::ffi::OsString::from_vec(b"capture-\xff.cap".to_vec()));
        let params = RecordParams {
            target: RecordTargets {
                screen: None,
                window: None,
            },
            mode: RecordMode::Studio,
            camera: None,
            mic: None,
            system_audio: false,
            path: Some(path.clone()),
            fps: None,
            video_bitrate: None,
            duration: None,
        };

        let error = run_detached(params.clone(), OutputFormat::Text)
            .await
            .unwrap_err();
        assert!(error.contains("valid UTF-8"), "{error}");
        assert!(!path.exists());

        let mut valid_params = params;
        valid_params.path = Some(root.path().join("capture-记录.cap"));
        let error = run_detached(valid_params, OutputFormat::Text)
            .await
            .unwrap_err();
        assert!(error.contains("No target specified"), "{error}");
    }

    #[tokio::test]
    async fn invalid_microphone_does_not_reserve_recording_path() {
        let root = tempfile::tempdir().unwrap();
        for mode in [RecordMode::Studio, RecordMode::Instant] {
            let path = root.path().join(format!("{mode}.cap"));
            let params = RecordParams {
                target: RecordTargets {
                    screen: None,
                    window: None,
                },
                mode,
                camera: None,
                mic: Some(format!("missing-microphone-{}", Uuid::new_v4())),
                system_audio: false,
                path: Some(path.clone()),
                fps: None,
                video_bitrate: None,
                duration: Some(1.0),
            };

            for _ in 0..2 {
                let error = start_recording(&params, ScreenCaptureTarget::CameraOnly, path.clone())
                    .await
                    .err()
                    .unwrap();
                assert!(error.contains("Microphone 'missing-microphone-"), "{error}");
                assert!(
                    !path.exists(),
                    "failed {mode} startup reserved {}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn stop_timeout_accepts_zero_and_rejects_invalid_timeouts() {
        assert_eq!(stop_timeout(0.0).unwrap(), Duration::ZERO);
        assert_eq!(stop_timeout(1.5).unwrap(), Duration::from_millis(1500));
        for timeout in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::MAX] {
            assert!(stop_timeout(timeout).is_err(), "timeout: {timeout}");
        }
    }

    #[tokio::test]
    async fn invalid_stop_timeout_is_rejected_before_session_lookup() {
        let args = RecordStopArgs {
            id: Some(format!("missing-{}", Uuid::new_v4())),
            path: None,
            timeout: -1.0,
            format: OutputFormat::Text,
        };
        let error = args.run_inner(OutputFormat::Text).await.unwrap_err();
        assert!(error.contains("--timeout"), "{error}");
    }

    #[test]
    fn instant_project_is_discoverable_before_capture_with_required_audio_intent() {
        let root = tempfile::tempdir().unwrap();
        for required_audio in [false, true] {
            let project = root
                .path()
                .join("nested")
                .join(format!("{required_audio}.cap"));
            let _ownership =
                prepare_recording_project(&project, RecordMode::Instant, required_audio).unwrap();

            let meta = RecordingMeta::load_for_project(&project).unwrap();
            assert!(matches!(
                meta.inner,
                RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true })
            ));
            assert_eq!(meta.project_path, project);
            assert_eq!(meta.pretty_name, required_audio.to_string());
            assert!(meta.platform.is_some());
            assert!(meta.sharing.is_none());
            assert!(meta.upload.is_none());
            assert!(project.join("content").is_dir());
            assert_eq!(project.join("content/audio").is_dir(), required_audio);
            assert!(!project.join("content/output.mp4").exists());
            assert!(!project.join("project-config.json").exists());
        }
    }

    #[test]
    fn recording_project_reservation_preserves_existing_recording_bytes_in_both_modes() {
        let root = tempfile::tempdir().unwrap();
        for mode in [RecordMode::Studio, RecordMode::Instant] {
            let project = root.path().join(format!("{mode}.cap"));
            let _ownership =
                prepare_recording_project(&project, RecordMode::Instant, false).unwrap();
            let mut meta = RecordingMeta::load_for_project(&project).unwrap();
            meta.inner = RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
                fps: 30,
                sample_rate: None,
            });
            meta.save_for_project().unwrap();
            let original_meta = std::fs::read(project.join("recording-meta.json")).unwrap();
            let output = project.join("content/output.mp4");
            std::fs::write(&output, b"existing recording media").unwrap();

            let error = prepare_recording_project(&project, mode, true)
                .err()
                .unwrap();
            assert!(error.contains("choose a fresh --path"));
            assert_eq!(
                std::fs::read(project.join("recording-meta.json")).unwrap(),
                original_meta
            );
            assert_eq!(std::fs::read(output).unwrap(), b"existing recording media");
            assert!(!project.join("content/audio").exists());
        }
    }

    #[test]
    fn studio_project_is_reserved_before_engine_initialization() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("nested/recording.cap");
        assert!(
            prepare_recording_project(&project, RecordMode::Studio, true)
                .unwrap()
                .is_none()
        );
        assert!(project.is_dir());
        assert_eq!(std::fs::read_dir(project).unwrap().count(), 0);
    }

    #[test]
    fn recording_project_reservation_rejects_existing_empty_directory_and_file() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("empty.cap");
        std::fs::create_dir(&directory).unwrap();
        for mode in [RecordMode::Studio, RecordMode::Instant] {
            assert!(prepare_recording_project(&directory, mode, false).is_err());
            assert!(prepare_recording_project(&directory.join("."), mode, false).is_err());
        }
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);

        let file = root.path().join("file.cap");
        std::fs::write(&file, b"preserve this file").unwrap();
        for mode in [RecordMode::Studio, RecordMode::Instant] {
            assert!(prepare_recording_project(&file, mode, false).is_err());
        }
        assert_eq!(std::fs::read(file).unwrap(), b"preserve this file");
    }

    #[cfg(unix)]
    #[test]
    fn recording_project_reservation_rejects_live_and_dangling_symlinks() {
        let root = tempfile::tempdir().unwrap();
        for dangling in [false, true] {
            let target = root.path().join(format!("target-{dangling}"));
            if !dangling {
                std::fs::create_dir(&target).unwrap();
                std::fs::write(target.join("original"), b"original media").unwrap();
            }
            let project = root.path().join(format!("link-{dangling}.cap"));
            std::os::unix::fs::symlink(&target, &project).unwrap();

            for mode in [RecordMode::Studio, RecordMode::Instant] {
                assert!(prepare_recording_project(&project, mode, true).is_err());
            }
            assert_eq!(std::fs::read_link(&project).unwrap(), target);
            if dangling {
                assert!(!target.exists());
            } else {
                assert_eq!(std::fs::read_dir(&target).unwrap().count(), 1);
                assert_eq!(
                    std::fs::read(target.join("original")).unwrap(),
                    b"original media"
                );
            }
        }
    }

    #[test]
    fn concurrent_instant_project_reservations_have_one_owner() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("recording.cap");
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let project = project.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    prepare_recording_project(&project, RecordMode::Instant, true)
                })
            })
            .collect();
        let successful = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(Result::is_ok)
            .count();

        assert_eq!(successful, 1);
        assert!(project.join("content/audio").is_dir());
        let meta = RecordingMeta::load_for_project(&project).unwrap();
        assert!(matches!(
            meta.inner,
            RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true })
        ));
    }

    #[test]
    fn incomplete_instant_project_never_validates_as_stopped_with_existing_output() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("recording.cap");
        let _ownership = prepare_recording_project(&project, RecordMode::Instant, false).unwrap();
        std::fs::write(project.join("content/output.mp4"), b"unvalidated media").unwrap();
        let mut meta = RecordingMeta::load_for_project(&project).unwrap();
        for state in [
            InstantRecordingMeta::InProgress { recording: true },
            InstantRecordingMeta::InProgress { recording: false },
            InstantRecordingMeta::Failed {
                error: "capture failed".to_string(),
            },
        ] {
            meta.inner = RecordingMetaInner::Instant(state);
            meta.save_for_project().unwrap();
            assert!(crate::project::validate_project(&project).is_err());
        }
    }

    #[test]
    fn live_instant_project_excludes_repair_until_ownership_is_released() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("recording.cap");
        let ownership = prepare_recording_project(&project, RecordMode::Instant, false)
            .unwrap()
            .unwrap();
        assert!(RecordingMeta::load_for_project(&project).is_ok());
        assert!(matches!(
            UploadLock::acquire(&project),
            Err(cap_recording::upload_resume::UploadLockError::Busy)
        ));

        drop(ownership);
        let recovered = UploadLock::acquire(&project).unwrap();
        assert_eq!(recovered.project_path(), project.canonicalize().unwrap());
    }

    #[tokio::test]
    async fn capture_failure_finalizes_without_waiting_for_stop_request() {
        let finalized = std::cell::Cell::new(false);
        let result = finalize_after_stop_trigger(
            std::future::ready(Err("capture window disappeared".to_string())),
            std::future::pending(),
            async {
                finalized.set(true);
                Err::<(), _>("display".to_string())
            },
        )
        .await;

        assert!(finalized.get());
        assert_eq!(result.unwrap_err(), "capture window disappeared");
    }

    #[tokio::test]
    async fn stop_request_finalizes_while_capture_is_running() {
        let result = finalize_after_stop_trigger(
            std::future::pending(),
            std::future::ready(None),
            std::future::ready(Ok(42)),
        )
        .await;

        assert_eq!(result.unwrap(), (42, None));
    }

    #[tokio::test]
    async fn low_storage_stop_finalizes_and_reports_its_reason() {
        let result = finalize_after_stop_trigger(
            std::future::pending(),
            std::future::ready(Some(StopReason::LowStorage)),
            std::future::ready(Ok(42)),
        )
        .await;

        assert_eq!(result.unwrap(), (42, Some(StopReason::LowStorage)));
    }

    #[tokio::test]
    async fn completed_capture_finalizes_without_stop_request() {
        let result = finalize_after_stop_trigger(
            std::future::ready(Ok(())),
            std::future::pending(),
            std::future::ready(Ok(42)),
        )
        .await;

        assert_eq!(result.unwrap(), (42, None));
    }

    #[tokio::test]
    async fn finalization_error_is_returned_after_stop_request() {
        let result = finalize_after_stop_trigger(
            std::future::pending(),
            std::future::ready(None),
            std::future::ready(Err::<(), _>("failed to finalize recording".to_string())),
        )
        .await;

        assert_eq!(result.unwrap_err(), "failed to finalize recording");
    }

    #[test]
    fn record_event_fields_are_camel_case() {
        let started = serde_json::to_value(RecordEvent::Started {
            recording_id: "abc",
            pid: 1,
            path: "p",
        })
        .unwrap();
        assert_eq!(started["type"], "started");
        assert_eq!(started["recordingId"], "abc");
        assert!(started.get("recording_id").is_none());

        let stopped = serde_json::to_value(RecordEvent::Stopped {
            path: "p",
            recording_meta_exists: true,
            screen_frames: None,
            reason: None,
        })
        .unwrap();
        assert_eq!(stopped["type"], "stopped");
        assert_eq!(stopped["recordingMetaExists"], true);
        assert!(stopped.get("recording_meta_exists").is_none());
        assert!(stopped.get("screenFrames").is_none());
        assert!(stopped.get("reason").is_none());

        let low_storage = serde_json::to_value(RecordEvent::Stopped {
            path: "p",
            recording_meta_exists: true,
            screen_frames: None,
            reason: Some(StopReason::LowStorage),
        })
        .unwrap();
        assert_eq!(low_storage["reason"], "lowStorage");

        let capture_failed = serde_json::to_value(RecordEvent::Stopped {
            path: "p",
            recording_meta_exists: true,
            screen_frames: None,
            reason: Some(StopReason::CaptureFailed),
        })
        .unwrap();
        assert_eq!(capture_failed["reason"], "captureFailed");

        let storage = serde_json::to_value(storage_event(
            true,
            RecordingStorage {
                available_bytes: 3_000,
                recording_bytes: 100,
                finalization_copies: 3,
            },
        ))
        .unwrap();
        assert_eq!(storage["type"], "storage");
        assert_eq!(storage["status"], "low");
        assert_eq!(storage["availableBytes"], 3_000);
        assert_eq!(storage["recordingBytes"], 100);
        assert_eq!(
            storage["reservedBytes"],
            300 + disk_space::RECORDING_DISK_RESERVE_BYTES
        );

        let error = serde_json::to_value(RecordEvent::Error {
            error: "e",
            code: None,
        })
        .unwrap();
        assert_eq!(error, serde_json::json!({"type": "error", "error": "e"}));
        let coded = serde_json::to_value(RecordEvent::Error {
            error: "e",
            code: Some(LOW_STORAGE_CODE),
        })
        .unwrap();
        assert_eq!(coded["code"], "lowStorage");

        let counted = serde_json::to_value(RecordEvent::Stopped {
            path: "p",
            recording_meta_exists: true,
            screen_frames: Some(ScreenFrameTotals {
                displayed: 2400,
                written: 2390,
                lost_in_capture: 10,
                ..Default::default()
            }),
            reason: None,
        })
        .unwrap();
        assert_eq!(counted["screenFrames"]["displayed"], 2400);
        assert_eq!(counted["screenFrames"]["lostInCapture"], 10);
    }

    #[test]
    fn dead_recording_session_reports_error_status() {
        let row = session_status_row_with_alive(
            Session {
                recording_id: "abc".to_string(),
                pid: 123,
                path: PathBuf::from("recording.cap"),
                status: SessionStatus::Recording,
                started_at: Some(1),
                recording_meta_exists: None,
                error: None,
                stop_reason: None,
                storage_low: false,
            },
            false,
        );

        assert!(matches!(row.status, SessionStatus::Error));
        assert!(!row.alive);
        assert_eq!(
            row.error.as_deref(),
            Some("recording process is not running")
        );
    }

    #[test]
    fn storage_warning_is_reported_once_and_before_a_stop() {
        assert_eq!(storage_warning_change(false, DiskSpaceStatus::Ok), None);
        assert_eq!(
            storage_warning_change(false, DiskSpaceStatus::Low),
            Some(true)
        );
        assert_eq!(storage_warning_change(true, DiskSpaceStatus::Low), None);
        assert_eq!(
            storage_warning_change(false, DiskSpaceStatus::Exhausted),
            Some(true)
        );
        assert_eq!(
            storage_warning_change(true, DiskSpaceStatus::Exhausted),
            None
        );
        assert_eq!(
            storage_warning_change(true, DiskSpaceStatus::Ok),
            Some(false)
        );
    }

    #[test]
    fn low_storage_session_round_trips_and_older_sessions_still_load() {
        let stopped = Session {
            recording_id: "abc".to_string(),
            pid: 123,
            path: PathBuf::from("recording.cap"),
            status: SessionStatus::Stopped,
            started_at: Some(1),
            recording_meta_exists: Some(true),
            error: None,
            stop_reason: Some(StopReason::LowStorage),
            storage_low: true,
        };
        let json = serde_json::to_value(&stopped).unwrap();
        assert_eq!(json["stopReason"], "lowStorage");
        assert_eq!(json["storageLow"], true);
        let loaded: Session = serde_json::from_value(json).unwrap();
        assert_eq!(loaded.stop_reason, Some(StopReason::LowStorage));
        assert!(loaded.storage_low);
        let row = serde_json::to_value(session_status_row_with_alive(loaded, false)).unwrap();
        assert_eq!(row["stopReason"], "lowStorage");
        assert_eq!(row["storageLow"], true);

        let older: Session = serde_json::from_value(serde_json::json!({
            "recordingId": "abc",
            "pid": 123,
            "path": "recording.cap",
            "status": "stopped",
            "recordingMetaExists": true,
        }))
        .unwrap();
        assert_eq!(older.stop_reason, None);
        assert!(!older.storage_low);
        let row = serde_json::to_value(session_status_row_with_alive(older, false)).unwrap();
        assert!(row.get("stopReason").is_none());
        assert!(row.get("storageLow").is_none());
    }

    #[test]
    fn start_is_refused_only_when_free_space_is_at_the_save_reserve() {
        let directory = tempfile::tempdir().unwrap();
        let free = disk_space::free_bytes_for_path(directory.path()).unwrap();
        let path = directory.path().join("recording.cap");
        let result = ensure_storage_to_start(&path);
        if free > disk_space::RECORDING_DISK_RESERVE_BYTES {
            assert!(result.is_ok());
            assert!(!path.exists());
        } else {
            assert!(
                result
                    .unwrap_err()
                    .contains("Not enough free space to record")
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stale_sessions_do_not_hide_the_only_running_recording() {
        let mut worker = std::process::Command::new("/bin/true").spawn().unwrap();
        let dead_pid = worker.id();
        worker.wait().unwrap();
        assert!(!session::process_alive(dead_pid));
        let interrupted = Session {
            recording_id: "interrupted".to_string(),
            pid: dead_pid,
            path: PathBuf::from("interrupted.cap"),
            status: SessionStatus::Recording,
            started_at: Some(1),
            recording_meta_exists: None,
            error: None,
            stop_reason: None,
            storage_low: false,
        };
        let current = Session {
            recording_id: "current".to_string(),
            pid: std::process::id(),
            path: PathBuf::from("current.cap"),
            ..interrupted.clone()
        };
        let selected = select_active_session(vec![interrupted.clone(), current.clone()]).unwrap();
        assert_eq!(selected.recording_id, "current");
        let selected = select_active_session(vec![interrupted]).unwrap();
        assert_eq!(selected.recording_id, "interrupted");
        let other = Session {
            recording_id: "other".to_string(),
            ..current.clone()
        };
        assert!(
            select_active_session(vec![current, other])
                .err()
                .unwrap()
                .contains("Multiple active recordings")
        );
    }
}
