use cap_project::{
    InstantRecordingMeta, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
};
use cap_recording::{
    CameraFeed, MicrophoneFeed,
    feeds::{camera, microphone},
    instant_recording,
    screen_capture::ScreenCaptureTarget,
    studio_recording::{self, ActorHandle as StudioActorHandle},
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
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::AsyncBufReadExt;
use uuid::Uuid;

use crate::{
    OutputFormat, resolve_format,
    session::{self, Session, SessionStatus},
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
    /// Path to save the '.cap' project to (defaults to <recordingId>.cap in the working directory)
    #[arg(long)]
    path: Option<PathBuf>,
    /// Maximum fps to record at (clamped to 1-120; camera recordings follow the desktop camera cap)
    #[arg(long)]
    fps: Option<u32>,
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
        if let Some(duration) = self.duration {
            args.push("--duration".to_string());
            args.push(duration.to_string());
        }
        args
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
        self.params.validate()?;
        if self.detach {
            run_detached(self.params, format).await
        } else {
            run_foreground(self.params, format).await
        }
    }
}

async fn run_foreground(params: RecordParams, format: OutputFormat) -> Result<(), String> {
    match foreground_inner(params, format).await {
        Ok(()) => Ok(()),
        Err(error) => {
            if format == OutputFormat::Json {
                let _ = write_json_line(&RecordEvent::Error { error: &error });
            }
            Err(error)
        }
    }
}

async fn foreground_inner(params: RecordParams, format: OutputFormat) -> Result<(), String> {
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
        let _ = actor.stop().await;
        return Err(error);
    }

    if params.duration.is_none() && interactive && format == OutputFormat::Text {
        println!("Press Enter to stop (or send SIGINT/SIGTERM)");
    }

    let completed = finalize(actor, params.duration, interactive, None).await?;
    crate::automation::run_recording_finished(
        completed.project_path(),
        automation_mode(params.mode),
    )
    .await;
    emit_stopped(format, &completed)
}

fn automation_mode(mode: RecordMode) -> cap_automation::AutomationRecordingMode {
    match mode {
        RecordMode::Studio => cap_automation::AutomationRecordingMode::Studio,
        RecordMode::Instant => cap_automation::AutomationRecordingMode::Instant,
    }
}

async fn run_detached(params: RecordParams, format: OutputFormat) -> Result<(), String> {
    match detached_inner(params, format).await {
        Ok(()) => Ok(()),
        Err(error) => {
            if format == OutputFormat::Json {
                let _ = write_json_line(&RecordEvent::Error { error: &error });
            }
            Err(error)
        }
    }
}

async fn detached_inner(params: RecordParams, format: OutputFormat) -> Result<(), String> {
    let recording_id = new_recording_id();
    // Validate the target up front so a bad --screen/--window fails fast with a clear message rather
    // than surfacing later from the background worker's log.
    resolve_target(&params)?;

    let path = resolve_path(&params, &recording_id)?;
    let path = if path.is_absolute() {
        path
    } else {
        current_dir()
            .map_err(|e| format!("Could not determine current directory: {e}"))?
            .join(path)
    };

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
    session::write_session(&Session {
        recording_id: recording_id.to_string(),
        pid: std::process::id(),
        path: path.clone(),
        status: SessionStatus::Recording,
        started_at,
        recording_meta_exists: None,
        error: None,
    })?;

    let stop_path = session::stop_file(recording_id)?;
    let completed = finalize(actor, params.duration, false, Some(&stop_path)).await?;
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
    })
}

impl RecordStopArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let format = resolve_format(json, self.format);
        match self.run_inner(format).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if format == OutputFormat::Json {
                    let _ = write_json_line(&RecordEvent::Error { error: &error });
                }
                Err(error)
            }
        }
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), String> {
        let session = resolve_session(self.id.as_deref(), self.path.as_deref())?;
        let id = session.recording_id.clone();

        if session.status == SessionStatus::Stopped {
            emit_record_event(
                format,
                &RecordEvent::Stopped {
                    path: &session.path.display().to_string(),
                    recording_meta_exists: session.recording_meta_exists.unwrap_or(true),
                },
            )?;
            session::cleanup(&id);
            return Ok(());
        }

        session::request_stop(&id)?;
        // The stop file is the authoritative cross-platform stop signal; only also SIGTERM a live pid
        // so a recycled pid belonging to an unrelated process is never signalled.
        if session::process_alive(session.pid) {
            session::terminate(session.pid);
        }

        let deadline = Instant::now() + Duration::from_secs_f64(self.timeout.max(0.0));
        loop {
            let current = session::read_session(&id).unwrap_or_else(|_| session.clone());
            match current.status {
                SessionStatus::Stopped => {
                    emit_record_event(
                        format,
                        &RecordEvent::Stopped {
                            path: &current.path.display().to_string(),
                            recording_meta_exists: current.recording_meta_exists.unwrap_or(true),
                        },
                    )?;
                    session::cleanup(&id);
                    return Ok(());
                }
                SessionStatus::Error => {
                    session::cleanup(&id);
                    return Err(current
                        .error
                        .unwrap_or_else(|| "recording failed".to_string()));
                }
                SessionStatus::Recording => {}
            }

            if !session::process_alive(current.pid) {
                // The worker died without flipping its status. Trust the on-disk recording-meta.json
                // as the source of truth for whether the .cap finalized.
                let recording_meta_exists = current.path.join("recording-meta.json").exists();
                session::cleanup(&id);
                return if recording_meta_exists {
                    emit_record_event(
                        format,
                        &RecordEvent::Stopped {
                            path: &current.path.display().to_string(),
                            recording_meta_exists: true,
                        },
                    )
                } else {
                    Err("recording process exited without finalizing the recording".to_string())
                };
            }

            if Instant::now() >= deadline {
                return Err(format!(
                    "timed out after {}s waiting for recording '{id}' to stop",
                    self.timeout
                ));
            }

            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
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

    let mut active: Vec<Session> = sessions
        .into_iter()
        .filter(|s| s.status == SessionStatus::Recording)
        .collect();
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
}

pub fn status(format: OutputFormat) -> Result<(), String> {
    let rows: Vec<SessionStatusRow> = session::list_sessions()?
        .into_iter()
        .map(|s| SessionStatusRow {
            alive: s.status == SessionStatus::Recording && session::process_alive(s.pid),
            recording_id: s.recording_id,
            pid: s.pid,
            path: s.path,
            status: s.status,
            started_at: s.started_at,
        })
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
                    SessionStatus::Recording if row.alive => "recording",
                    SessionStatus::Recording => "recording (process gone)",
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

enum ActorHandle {
    Studio(StudioActorHandle),
    Instant(instant_recording::ActorHandle),
}

impl ActorHandle {
    async fn stop(&self) -> Result<CompletedRecording, String> {
        match self {
            Self::Studio(actor) => actor
                .stop()
                .await
                .map(Box::new)
                .map(CompletedRecording::Studio)
                .map_err(|e| e.to_string()),
            Self::Instant(actor) => actor
                .stop()
                .await
                .map(CompletedRecording::Instant)
                .map_err(|e| e.to_string()),
        }
    }
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
    let mut studio_builder = studio_recording::Actor::builder(path.clone(), target.clone())
        .with_system_audio(params.system_audio);
    let mut instant_builder =
        instant_recording::Actor::builder(path, target).with_system_audio(params.system_audio);
    let mut camera_active = false;

    // Feeds must be locked and attached before build(); the lock keeps the device open for the whole
    // recording, so the feed actor handle itself does not need to be retained.
    if let Some(device_id) = params.camera.as_deref() {
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
        let available = MicrophoneFeed::list();
        if !available.contains_key(mic_name) {
            let names: Vec<&str> = available.keys().map(String::as_str).collect();
            return Err(format!(
                "Microphone '{mic_name}' not found. Available: {names:?} (see `cap targets mics`)"
            ));
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

    match params.mode {
        RecordMode::Studio => {
            let builder = cap_recording::RecordingDefaults::default().apply_to_studio_builder(
                studio_builder,
                camera_active,
                params.fps,
            );

            builder
                .build(
                    #[cfg(target_os = "macos")]
                    Some(cap_recording::SendableShareableContent::from(
                        cidre::sc::ShareableContent::current()
                            .await
                            .map_err(|e| format!("Failed to read shareable content: {e}"))?,
                    )),
                )
                .await
                .map(ActorHandle::Studio)
                .map_err(|e| e.to_string())
        }
        RecordMode::Instant => {
            let mut builder = instant_builder;
            builder = builder.with_max_output_size(
                cap_recording::RecordingDefaults::default().instant_mode_max_resolution,
            );
            if let Some(fps) = params.fps {
                builder = builder.with_max_fps(fps);
            }

            builder
                .build(
                    #[cfg(target_os = "macos")]
                    Some(cap_recording::SendableShareableContent::from(
                        cidre::sc::ShareableContent::current()
                            .await
                            .map_err(|e| format!("Failed to read shareable content: {e}"))?,
                    )),
                )
                .await
                .map(ActorHandle::Instant)
                .map_err(|e| e.to_string())
        }
    }
}

/// Wait for the stop trigger, then finalize the recording. A panic between start and stop would
/// otherwise drop the actor without writing recording-meta.json (`ActorHandle` has no `Drop`),
/// leaving an unrecoverable .cap; catch it and best-effort finalize so the recording is recoverable.
///
/// Studio recordings are fragmented for crash recovery, so a graceful stop leaves the display track
/// as a directory of fragments with status `NeedsRemux`. We then run the shared
/// `RecoveryManager::remux_if_needed` — the same remux the desktop runs after stop — so the `.cap`
/// is immediately exportable instead of `cap export`/`cap upload` failing to open a fragment
/// directory as a video.
async fn finalize(
    actor: ActorHandle,
    duration: Option<f64>,
    interactive: bool,
    stop_file: Option<&Path>,
) -> Result<CompletedRecording, String> {
    let outcome = std::panic::AssertUnwindSafe(async {
        wait_for_stop(duration, interactive, stop_file).await;
        actor.stop().await.map_err(|e| e.to_string())
    })
    .catch_unwind()
    .await;

    let completed = match outcome {
        Ok(Ok(completed)) => completed,
        Ok(Err(error)) => return Err(error),
        Err(_) => actor
            .stop()
            .await
            .map_err(|e| format!("recording panicked; finalize failed: {e}"))?,
    };

    finalize_completed(completed).await
}

async fn finalize_completed(completed: CompletedRecording) -> Result<CompletedRecording, String> {
    match &completed {
        CompletedRecording::Studio(recording) => {
            let project_path = recording.project_path.clone();
            tokio::task::spawn_blocking(move || {
                cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
            })
            .await
            .map_err(|e| format!("recording finalize task failed: {e}"))?
            .map_err(|e| format!("Failed to remux recording: {e}"))?;
        }
        CompletedRecording::Instant(recording) => {
            finalize_instant_output(recording.project_path.clone()).await?;
            persist_instant_recording_meta(recording)?;
        }
    }

    Ok(completed)
}

async fn finalize_instant_output(project_path: PathBuf) -> Result<(), String> {
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
    tokio::task::spawn_blocking(move || {
        cap_recording::recovery::RecoveryManager::finalize_instant_output(
            &display_dir,
            &audio_dir,
            &output_path,
        )
    })
    .await
    .map_err(|e| format!("instant recording finalize task failed: {e}"))?
    .map_err(|e| format!("Failed to finalize instant recording: {e}"))?;

    Ok(())
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

fn emit_stopped(format: OutputFormat, completed: &CompletedRecording) -> Result<(), String> {
    let recording_meta_exists = completed
        .project_path()
        .join("recording-meta.json")
        .exists();
    emit_record_event(
        format,
        &RecordEvent::Stopped {
            path: &completed.project_path().display().to_string(),
            recording_meta_exists,
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
    },
    Error {
        error: &'a str,
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
                } => {
                    println!("Recording stopped: {path}");
                    if !recording_meta_exists {
                        println!("warning: recording-meta.json was not written");
                    }
                }
                RecordEvent::Error { error } => println!("Recording error: {error}"),
            }
            Ok(())
        }
        OutputFormat::Json => write_json_line(event),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        })
        .unwrap();
        assert_eq!(stopped["type"], "stopped");
        assert_eq!(stopped["recordingMetaExists"], true);
        assert!(stopped.get("recording_meta_exists").is_none());
    }
}
