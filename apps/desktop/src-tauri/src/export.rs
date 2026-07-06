use crate::editor_window::{OptionalWindowEditorInstance, WindowEditorInstance};
use crate::{FramesRendered, get_video_metadata};
use cap_export::{ExporterBase, make_cursor_only_project};
use cap_project::{RecordingMeta, XY};
use cap_rendering::{
    FrameRenderer, ProjectRecordingsMeta, ProjectUniforms, RenderSegment, RenderVideoConstants,
    RendererLayers, ZoomTransformTimeline,
};
use futures::FutureExt;
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, LazyLock, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncBufReadExt;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, instrument, warn};

fn panic_message(panic: Box<dyn Any + Send>) -> String {
    if let Some(msg) = panic.downcast_ref::<&str>() {
        msg.to_string()
    } else if let Some(msg) = panic.downcast_ref::<String>() {
        msg.clone()
    } else {
        "unknown panic".to_string()
    }
}

fn export_panic_error(panic: Box<dyn Any + Send>) -> String {
    let panic_msg = panic_message(panic);
    error!(
        target: "cap_desktop_export",
        panic = %panic_msg,
        "export command panicked"
    );
    sentry::capture_message(
        &format!("Export command panicked: {panic_msg}"),
        sentry::Level::Error,
    );
    "Export failed unexpectedly".to_string()
}

#[cfg(all(windows, not(debug_assertions)))]
async fn run_export_command<T, F, Fut>(make_future: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, String>> + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();

    // Windows release builds can stack-overflow in Tauri's IPC command entry before the save
    // dialog or exporter sidecar starts. Keep the export future off that command-entry stack.
    std::thread::Builder::new()
        .name("cap-export-command".to_string())
        .stack_size(EXPORT_COMMAND_THREAD_STACK_SIZE)
        .spawn(move || {
            let result = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime.block_on(async move {
                    match AssertUnwindSafe(make_future()).catch_unwind().await {
                        Ok(result) => result,
                        Err(panic) => Err(export_panic_error(panic)),
                    }
                }),
                Err(err) => Err(format!("Failed to build export command runtime: {err}")),
            };

            let _ = tx.send(result);
        })
        .map_err(|err| format!("Failed to spawn export command thread: {err}"))?;

    rx.await
        .map_err(|err| format!("Export command thread stopped: {err}"))?
}

#[cfg(not(all(windows, not(debug_assertions))))]
async fn run_export_command<T, F, Fut>(make_future: F) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    match AssertUnwindSafe(make_future()).catch_unwind().await {
        Ok(result) => result,
        Err(panic) => Err(export_panic_error(panic)),
    }
}

async fn run_protected_export(
    project_path: &Path,
    settings: &ExportSettings,
    progress: ExportProgress,
    force_ffmpeg: bool,
    cancel_token: CancellationToken,
) -> Result<PathBuf, String> {
    match AssertUnwindSafe(do_export(
        project_path,
        settings,
        progress,
        force_ffmpeg,
        cancel_token,
    ))
    .catch_unwind()
    .await
    {
        Ok(result) => result,
        Err(panic) => {
            let panic_msg = panic_message(panic);
            error!(
                target: "cap_desktop_export",
                panic = %panic_msg,
                "export task panicked"
            );
            sentry::capture_message(
                &format!("Export task panicked: {panic_msg}"),
                sentry::Level::Error,
            );
            Err("Export failed unexpectedly".to_string())
        }
    }
}

const EXPORTER_STDERR_TAIL_LIMIT: usize = 80;
const EXPORT_PROGRESS_FORWARD_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
#[cfg(all(windows, not(debug_assertions)))]
const EXPORT_COMMAND_THREAD_STACK_SIZE: usize = 16 * 1024 * 1024;
static ACTIVE_EXPORT_SESSIONS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_EXPORT_CANCELLATIONS: LazyLock<Mutex<HashMap<String, ActiveExportCancellation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static ACTIVE_EXPORT_WINDOW_SESSIONS: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_EXPORT_COMMAND_ID: AtomicUsize = AtomicUsize::new(1);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ExportSidecarMessage {
    Progress {
        rendered_count: u32,
        total_frames: u32,
    },
    Completed {
        path: PathBuf,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExportWorkerMode {
    HardwareOptimized,
    SoftwareSafe,
}

impl ExportWorkerMode {
    fn force_ffmpeg_decoder(self, requested: bool) -> bool {
        requested || matches!(self, Self::SoftwareSafe)
    }

    fn is_software_safe(self) -> bool {
        matches!(self, Self::SoftwareSafe)
    }
}

#[derive(Clone)]
struct ExportProgress(tauri::ipc::Channel<FramesRendered>);

struct ExportSaveDialogRequest {
    app: tauri::AppHandle,
    file_name: String,
    file_type: String,
}

impl ExportProgress {
    fn send(&self, progress: FramesRendered) -> bool {
        self.0.send(progress).is_ok()
    }
}

struct ExportProgressForwarder {
    progress: ExportProgress,
    last_emit_at: Option<std::time::Instant>,
}

impl ExportProgressForwarder {
    fn new(progress: ExportProgress) -> Self {
        Self {
            progress,
            last_emit_at: None,
        }
    }

    fn send(&mut self, rendered_count: u32, total_frames: u32) -> bool {
        let now = std::time::Instant::now();
        let should_emit = rendered_count == 0
            || rendered_count >= total_frames
            || self
                .last_emit_at
                .is_none_or(|last| now.duration_since(last) >= EXPORT_PROGRESS_FORWARD_INTERVAL);

        if !should_emit {
            return true;
        }

        self.last_emit_at = Some(now);
        self.progress.send(FramesRendered {
            rendered_count,
            total_frames,
        })
    }
}

struct ActiveExportCancellation {
    token: CancellationToken,
    window_label: Option<String>,
}

struct ExportCancellationGuard {
    export_id: String,
    token: CancellationToken,
}

impl ExportCancellationGuard {
    fn new(export_id: String, window_label: Option<String>) -> Self {
        let token = CancellationToken::new();
        active_export_cancellations().insert(
            export_id.clone(),
            ActiveExportCancellation {
                token: token.clone(),
                window_label,
            },
        );

        Self { export_id, token }
    }

    fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for ExportCancellationGuard {
    fn drop(&mut self) {
        active_export_cancellations().remove(&self.export_id);
    }
}

fn active_export_cancellations() -> MutexGuard<'static, HashMap<String, ActiveExportCancellation>> {
    match ACTIVE_EXPORT_CANCELLATIONS.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    }
}

fn active_export_window_sessions() -> MutexGuard<'static, HashMap<String, usize>> {
    match ACTIVE_EXPORT_WINDOW_SESSIONS.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    }
}

fn next_export_command_id(prefix: &str) -> String {
    let id = NEXT_EXPORT_COMMAND_ID.fetch_add(1, Ordering::AcqRel);
    format!("{prefix}-{id}")
}

fn cancel_export_by_id(export_id: &str) -> bool {
    let cancellations = active_export_cancellations();
    if let Some(active_export) = cancellations.get(export_id) {
        active_export.token.cancel();
        return true;
    }

    false
}

pub fn cancel_exports_for_window(window_label: &str) {
    let tokens = {
        let cancellations = active_export_cancellations();
        cancellations
            .values()
            .filter(|active_export| active_export.window_label.as_deref() == Some(window_label))
            .map(|active_export| active_export.token.clone())
            .collect::<Vec<_>>()
    };

    for token in &tokens {
        token.cancel();
    }

    let released_sessions = release_export_sessions_for_window(window_label);

    if !tokens.is_empty() || released_sessions > 0 {
        info!(
            window = window_label,
            cancelled_count = tokens.len(),
            released_sessions,
            "Cancelled window exports"
        );
    }
}

pub fn cancel_all_exports() {
    let tokens = {
        let cancellations = active_export_cancellations();
        cancellations
            .values()
            .map(|active_export| active_export.token.clone())
            .collect::<Vec<_>>()
    };

    for token in &tokens {
        token.cancel();
    }

    let released_sessions = release_all_window_export_sessions();

    if !tokens.is_empty() || released_sessions > 0 {
        info!(
            cancelled_count = tokens.len(),
            released_sessions, "Cancelled active exports"
        );
    }
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub fn cancel_export(export_id: String) -> bool {
    cancel_export_by_id(&export_id)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window))]
pub fn cancel_current_window_exports(window: tauri::Window) {
    cancel_exports_for_window(window.label());
}

fn retain_export_session() {
    let active_exports = ACTIVE_EXPORT_SESSIONS.fetch_add(1, Ordering::AcqRel) + 1;
    info!(active_exports, "Export session guard started");
}

fn release_export_session() {
    let mut current = ACTIVE_EXPORT_SESSIONS.load(Ordering::Acquire);
    loop {
        if current == 0 {
            tracing::warn!("Export session guard release requested with no active exports");
            return;
        }

        match ACTIVE_EXPORT_SESSIONS.compare_exchange(
            current,
            current - 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {
                info!(
                    active_exports = current - 1,
                    "Export session guard released"
                );
                return;
            }
            Err(next) => current = next,
        }
    }
}

pub fn export_session_active() -> bool {
    ACTIVE_EXPORT_SESSIONS.load(Ordering::Acquire) > 0
}

fn retain_export_session_for_window(window_label: &str) {
    retain_export_session();
    let mut sessions = active_export_window_sessions();
    *sessions.entry(window_label.to_string()).or_insert(0) += 1;
}

fn release_export_session_for_window(window_label: &str) {
    let should_release = {
        let mut sessions = active_export_window_sessions();
        if let Some(count) = sessions.get_mut(window_label) {
            *count -= 1;
            if *count == 0 {
                sessions.remove(window_label);
            }
            true
        } else {
            false
        }
    };

    if should_release {
        release_export_session();
    } else {
        tracing::warn!(
            window = window_label,
            "Export session guard release requested with no active window export"
        );
    }
}

fn release_export_sessions_for_window(window_label: &str) -> usize {
    let count = active_export_window_sessions()
        .remove(window_label)
        .unwrap_or(0);

    for _ in 0..count {
        release_export_session();
    }

    count
}

fn release_all_window_export_sessions() -> usize {
    let count = active_export_window_sessions()
        .drain()
        .map(|(_, count)| count)
        .sum::<usize>();

    for _ in 0..count {
        release_export_session();
    }

    count
}

#[tauri::command]
#[specta::specta]
pub fn begin_export_session(window: tauri::Window) {
    retain_export_session_for_window(window.label());
}

#[tauri::command]
#[specta::specta]
pub fn end_export_session(window: tauri::Window) {
    release_export_session_for_window(window.label());
}

struct ExportSessionGuard;

impl ExportSessionGuard {
    fn new() -> Self {
        retain_export_session();
        Self
    }
}

impl Drop for ExportSessionGuard {
    fn drop(&mut self) {
        release_export_session();
    }
}

#[cfg(windows)]
fn configure_exporter_command(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_exporter_command(_command: &mut tokio::process::Command) {}

async fn run_out_of_process_export(
    project_path: &Path,
    settings: &ExportSettings,
    progress: ExportProgress,
    force_ffmpeg: bool,
    cancel_token: CancellationToken,
) -> Result<PathBuf, String> {
    let mode = initial_export_worker_mode();
    match run_out_of_process_export_attempt(
        project_path,
        settings,
        progress.clone(),
        force_ffmpeg,
        mode,
        cancel_token.clone(),
    )
    .await
    {
        Ok(path) => Ok(path),
        Err(e) if e != "Export cancelled" && !mode.is_software_safe() => {
            error!(
                error = %e,
                "Export worker failed, retrying with software rendering and encoding"
            );
            run_out_of_process_export_attempt(
                project_path,
                settings,
                progress,
                force_ffmpeg,
                ExportWorkerMode::SoftwareSafe,
                cancel_token,
            )
            .await
        }
        Err(e) => Err(e),
    }
}

fn initial_export_worker_mode() -> ExportWorkerMode {
    if should_start_export_worker_in_software_safe_mode() {
        ExportWorkerMode::SoftwareSafe
    } else {
        ExportWorkerMode::HardwareOptimized
    }
}

async fn run_out_of_process_export_attempt(
    project_path: &Path,
    settings: &ExportSettings,
    progress: ExportProgress,
    force_ffmpeg: bool,
    mode: ExportWorkerMode,
    cancel_token: CancellationToken,
) -> Result<PathBuf, String> {
    if cancel_token.is_cancelled() {
        return Err("Export cancelled".to_string());
    }

    let bin_path = resolve_exporter_binary()?;
    let settings_json = serde_json::to_string(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    let force_ffmpeg_decoder = mode.force_ffmpeg_decoder(force_ffmpeg);
    let mut progress_forwarder = ExportProgressForwarder::new(progress);

    info!(
        path = %bin_path.display(),
        project_path = %project_path.display(),
        force_ffmpeg = force_ffmpeg_decoder,
        mode = ?mode,
        "Starting export worker process"
    );

    let mut command = tokio::process::Command::new(&bin_path);
    command
        .arg("export")
        .arg(project_path)
        .arg("--settings-json")
        .arg(settings_json)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    command.arg("--progress-json");

    if force_ffmpeg_decoder {
        command.arg("--force-ffmpeg-decoder");
    }

    if mode.is_software_safe() {
        command.env("CAP_EXPORT_FORCE_SOFTWARE_ENCODER", "1");
        if cfg!(windows) {
            command.env("CAP_RENDER_FORCE_SOFTWARE_ADAPTER", "1");
        }
    }
    configure_exporter_command(&mut command);

    let mut child = command.spawn().map_err(|e| {
        format!(
            "Failed to start export worker '{}': {e}",
            bin_path.display()
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Export worker stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Export worker stderr was not captured".to_string())?;
    let stderr_task = tokio::spawn(collect_exporter_stderr_tail(stderr));

    let mut completed_path = None;
    let mut stdout_lines = tokio::io::BufReader::new(stdout).lines();

    while let Some(line) = tokio::select! {
        line = stdout_lines.next_line() => {
            line.map_err(|e| format!("Failed reading export worker stdout: {e}"))?
        }
        _ = cancel_token.cancelled() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return Err("Export cancelled".to_string());
        }
    } {
        match serde_json::from_str::<ExportSidecarMessage>(&line) {
            Ok(ExportSidecarMessage::Progress {
                rendered_count,
                total_frames,
            }) => {
                if !progress_forwarder.send(rendered_count, total_frames) {
                    let _ = child.kill().await;
                    return Err("Export cancelled".to_string());
                }
            }
            Ok(ExportSidecarMessage::Completed { path }) => {
                completed_path = Some(path);
            }
            Err(e) => {
                error!(
                    line = %line,
                    error = %e,
                    "Ignoring invalid export worker stdout line"
                );
            }
        }
    }

    let status = tokio::select! {
        status = child.wait() => {
            status.map_err(|e| format!("Failed waiting for export worker: {e}"))?
        }
        _ = cancel_token.cancelled() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            return Err("Export cancelled".to_string());
        }
    };
    let stderr_tail = stderr_task.await.unwrap_or_default();

    if !status.success() {
        if let Some(path) = completed_path {
            // A worker can report completion and then abort during Windows GPU/codec teardown.
            // Treat the completed output as authoritative so a post-export sidecar crash does
            // not become a failed export for the user.
            error!(
                status = %status,
                path = %path.display(),
                "Export worker exited unsuccessfully after reporting completion"
            );
            return Ok(path);
        }

        let stderr_tail = stderr_tail.join("\n");
        return Err(format!(
            "Export worker exited with status {status}. Stderr tail:\n{stderr_tail}"
        ));
    }

    completed_path
        .ok_or_else(|| "Export worker finished without reporting an output path".to_string())
}

async fn collect_exporter_stderr_tail(stderr: tokio::process::ChildStderr) -> Vec<String> {
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    let mut tail = Vec::new();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if cfg!(debug_assertions) {
                    info!(line = %line, "Export worker stderr");
                }
                tail.push(line);
                if tail.len() > EXPORTER_STDERR_TAIL_LIMIT {
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

fn resolve_exporter_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    if let Some(dir) = exe.parent() {
        for candidate in adjacent_exporter_binary_candidates(dir) {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for root in std::iter::once(cwd.as_path()).chain(cwd.ancestors()) {
            for candidate in exporter_binary_candidates(root) {
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }

    Err(format!(
        "Export worker binary not found; place {} next to the app executable or build the Tauri sidecar bundle",
        exporter_bin_name()
    ))
}

fn exporter_binary_candidates(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if cfg!(debug_assertions) {
        candidates.extend(debug_exporter_binary_candidates(root));
    }

    candidates.push(
        root.join("apps")
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join(exporter_bin_name()),
    );

    if let Some(target_triple) = current_target_triple() {
        candidates.push(
            root.join("apps")
                .join("desktop")
                .join("src-tauri")
                .join("binaries")
                .join(format!(
                    "cap-exporter-{target_triple}{}",
                    std::env::consts::EXE_SUFFIX
                )),
        );
    }

    candidates
}

fn debug_exporter_binary_candidates(root: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        root.join("target").join("debug").join(exporter_bin_name()),
        root.join("target")
            .join("debug")
            .join(format!("cap{}", std::env::consts::EXE_SUFFIX)),
    ];

    if let Some(target_triple) = current_target_triple() {
        candidates.push(
            root.join("target")
                .join(target_triple)
                .join("debug")
                .join(exporter_bin_name()),
        );
        candidates.push(
            root.join("target")
                .join(target_triple)
                .join("debug")
                .join(format!("cap{}", std::env::consts::EXE_SUFFIX)),
        );
        candidates.push(root.join("target").join("debug").join(format!(
            "cap-exporter-{target_triple}{}",
            std::env::consts::EXE_SUFFIX
        )));
    }

    candidates
}

fn adjacent_exporter_binary_candidates(dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    candidates.push(dir.join(exporter_bin_name()));

    if let Some(target_triple) = current_target_triple() {
        candidates.push(dir.join(format!(
            "cap-exporter-{target_triple}{}",
            std::env::consts::EXE_SUFFIX
        )));
    }

    for subdir in ["../MacOS", "../Resources"] {
        candidates.push(dir.join(subdir).join(exporter_bin_name()));
        if let Some(target_triple) = current_target_triple() {
            candidates.push(dir.join(subdir).join(format!(
                "cap-exporter-{target_triple}{}",
                std::env::consts::EXE_SUFFIX
            )));
        }
    }

    candidates
}

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

fn exporter_bin_name() -> &'static str {
    if cfg!(windows) {
        "cap-exporter.exe"
    } else {
        "cap-exporter"
    }
}

struct ExportActiveGuard<'a>(&'a AtomicBool);

impl Drop for ExportActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
        tracing::info!("Resuming editor preview after export");
    }
}

struct ExportPreviewActiveGuard<'a>(&'a AtomicBool);

impl<'a> ExportPreviewActiveGuard<'a> {
    fn try_new(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self(flag))
            .map_err(|_| "Export preview generation is already in progress".to_string())
    }
}

impl Drop for ExportPreviewActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn wait_for_export_preview_idle_or_cancel(
    flag: &AtomicBool,
    cancel_token: &CancellationToken,
) -> Result<(), String> {
    while flag.load(Ordering::Acquire) {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
            _ = cancel_token.cancelled() => return Err("Export cancelled".to_string()),
        }
    }

    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Type)]
#[serde(tag = "format")]
pub enum ExportSettings {
    Mp4(cap_export::mp4::Mp4ExportSettings),
    Gif(cap_export::gif::GifExportSettings),
    Mov(cap_export::mov::MovExportSettings),
}

impl ExportSettings {
    fn fps(&self) -> u32 {
        match self {
            ExportSettings::Mp4(settings) => settings.fps,
            ExportSettings::Gif(settings) => settings.fps,
            ExportSettings::Mov(settings) => settings.fps,
        }
    }

    fn force_ffmpeg_decoder(&self) -> bool {
        match self {
            ExportSettings::Mp4(settings) => settings.force_ffmpeg_decoder,
            ExportSettings::Gif(_) | ExportSettings::Mov(_) => false,
        }
    }

    fn cursor_only(&self) -> bool {
        match self {
            ExportSettings::Mov(settings) => settings.cursor_only,
            _ => false,
        }
    }
}

fn export_project_config(
    project_config: cap_project::ProjectConfiguration,
    cursor_only: bool,
) -> cap_project::ProjectConfiguration {
    if cursor_only {
        make_cursor_only_project(project_config)
    } else {
        project_config
    }
}

async fn do_export(
    project_path: &Path,
    settings: &ExportSettings,
    progress: ExportProgress,
    force_ffmpeg: bool,
    cancel_token: CancellationToken,
) -> Result<PathBuf, String> {
    if cancel_token.is_cancelled() {
        return Err("Export cancelled".to_string());
    }

    let mut exporter_builder =
        ExporterBase::builder(project_path.to_path_buf()).with_force_ffmpeg_decoder(force_ffmpeg);

    if settings.cursor_only() {
        let meta = RecordingMeta::load_for_project(project_path).map_err(|e| e.to_string())?;
        exporter_builder =
            exporter_builder.with_config(export_project_config(meta.project_config(), true));
    }

    let exporter_base = exporter_builder.build().await.map_err(|e| e.to_string())?;

    let total_frames = exporter_base.total_frames(settings.fps());

    if !progress.send(FramesRendered {
        rendered_count: 0,
        total_frames,
    }) {
        return Err("Export cancelled".to_string());
    }

    match settings {
        ExportSettings::Mp4(mp4_settings) => {
            let progress = progress.clone();
            let cancel_token = cancel_token.clone();
            mp4_settings
                .export(exporter_base, move |frame_index| {
                    if cancel_token.is_cancelled() {
                        return false;
                    }

                    progress.send(FramesRendered {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    })
                })
                .await
        }
        ExportSettings::Gif(gif_settings) => {
            let progress = progress.clone();
            let cancel_token = cancel_token.clone();
            gif_settings
                .export(exporter_base, move |frame_index| {
                    if cancel_token.is_cancelled() {
                        return false;
                    }

                    progress.send(FramesRendered {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    })
                })
                .await
        }
        ExportSettings::Mov(mov_settings) => {
            let progress = progress.clone();
            let cancel_token = cancel_token.clone();
            mov_settings
                .export(exporter_base, move |frame_index| {
                    if cancel_token.is_cancelled() {
                        return false;
                    }

                    progress.send(FramesRendered {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    })
                })
                .await
        }
    }
}

fn is_frame_decode_error(error: &str) -> bool {
    error.contains("Failed to decode video frames")
        || error.contains("Too many consecutive frame failures")
        || error.contains("waiting for frame 0")
}

fn should_force_ffmpeg_export(_project_path: &Path, settings: &ExportSettings) -> bool {
    settings.force_ffmpeg_decoder()
}

fn should_force_ffmpeg_preview() -> bool {
    false
}

fn should_start_export_worker_in_software_safe_mode() -> bool {
    false
}

fn should_use_out_of_process_export() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window, progress, editor))]
pub async fn export_video(
    window: tauri::Window,
    project_path: PathBuf,
    progress: tauri::ipc::Channel<FramesRendered>,
    settings: ExportSettings,
    editor: OptionalWindowEditorInstance,
) -> Result<PathBuf, String> {
    let window_label = window.label().to_string();
    Box::pin(run_export_command(move || async move {
        let cancellation_guard =
            ExportCancellationGuard::new(next_export_command_id("export"), Some(window_label));
        export_video_inner(
            project_path,
            settings,
            editor,
            ExportProgress(progress),
            cancellation_guard.token(),
        )
        .await
    }))
    .await
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window, progress, editor))]
pub async fn export_video_with_id(
    window: tauri::Window,
    project_path: PathBuf,
    progress: tauri::ipc::Channel<FramesRendered>,
    settings: ExportSettings,
    export_id: String,
    editor: OptionalWindowEditorInstance,
) -> Result<PathBuf, String> {
    let window_label = window.label().to_string();
    Box::pin(run_export_command(move || async move {
        let cancellation_guard = ExportCancellationGuard::new(export_id, Some(window_label));
        export_video_inner(
            project_path,
            settings,
            editor,
            ExportProgress(progress),
            cancellation_guard.token(),
        )
        .await
    }))
    .await
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window, progress, editor))]
pub async fn export_video_to_file(
    window: tauri::Window,
    project_path: PathBuf,
    progress: tauri::ipc::Channel<FramesRendered>,
    settings: ExportSettings,
    file_name: String,
    file_type: String,
    editor: OptionalWindowEditorInstance,
) -> Result<PathBuf, String> {
    let app = window.app_handle().clone();
    let window_label = window.label().to_string();
    Box::pin(run_export_command(move || async move {
        let cancellation_guard = ExportCancellationGuard::new(
            next_export_command_id("export-to-file"),
            Some(window_label),
        );
        export_video_to_file_inner(
            project_path,
            settings,
            editor,
            ExportProgress(progress),
            ExportSaveDialogRequest {
                app,
                file_name,
                file_type,
            },
            cancellation_guard.token(),
        )
        .await
    }))
    .await
}

async fn export_video_to_file_inner(
    project_path: PathBuf,
    settings: ExportSettings,
    editor: OptionalWindowEditorInstance,
    progress: ExportProgress,
    save_dialog: ExportSaveDialogRequest,
    cancel_token: CancellationToken,
) -> Result<PathBuf, String> {
    let _session_guard = ExportSessionGuard::new();
    let ExportSaveDialogRequest {
        app,
        file_name,
        file_type,
    } = save_dialog;
    let Some(save_path) = show_export_save_dialog(&app, file_name, file_type).await? else {
        return Err("Save dialog cancelled".to_string());
    };

    info!(path = %save_path.display(), "Export save path selected");

    let output_path =
        export_video_inner(project_path, settings, editor, progress, cancel_token).await?;
    copy_export_to_path(&output_path, &save_path).await?;
    Ok(save_path)
}

async fn export_video_inner(
    project_path: PathBuf,
    settings: ExportSettings,
    editor: OptionalWindowEditorInstance,
    progress: ExportProgress,
    cancel_token: CancellationToken,
) -> Result<PathBuf, String> {
    let _session_guard = ExportSessionGuard::new();
    let force_ffmpeg = should_force_ffmpeg_export(&project_path, &settings);
    info!(
        project_path = %project_path.display(),
        force_ffmpeg,
        settings = ?settings,
        "Starting export"
    );

    let _guard = if let Some(ref ed) = *editor {
        ed.export_active.store(true, Ordering::Release);
        tracing::info!("Pausing editor preview during export");
        Some(ExportActiveGuard(&ed.export_active))
    } else {
        None
    };

    if let Some(ref ed) = *editor {
        wait_for_export_preview_idle_or_cancel(&ed.export_preview_active, &cancel_token).await?;
    }

    let result = if should_use_out_of_process_export() {
        run_out_of_process_export(
            &project_path,
            &settings,
            progress.clone(),
            force_ffmpeg,
            cancel_token.clone(),
        )
        .await
    } else {
        run_protected_export(
            &project_path,
            &settings,
            progress.clone(),
            force_ffmpeg,
            cancel_token.clone(),
        )
        .await
    };

    match result {
        Ok(path) => {
            info!("Exported to {} completed", path.display());
            Ok(path)
        }
        Err(e) if !force_ffmpeg && is_frame_decode_error(&e) => {
            if cancel_token.is_cancelled() {
                return Err("Export cancelled".to_string());
            }

            info!(
                "Export failed with frame decode error, retrying with FFmpeg decoder: {}",
                e
            );

            let retry_result = if should_use_out_of_process_export() {
                run_out_of_process_export(
                    &project_path,
                    &settings,
                    progress,
                    true,
                    cancel_token.clone(),
                )
                .await
            } else {
                run_protected_export(
                    &project_path,
                    &settings,
                    progress,
                    true,
                    cancel_token.clone(),
                )
                .await
            };

            match retry_result {
                Ok(path) => {
                    info!(
                        "Export succeeded with FFmpeg decoder fallback: {}",
                        path.display()
                    );
                    Ok(path)
                }
                Err(retry_e) => {
                    if cancel_token.is_cancelled() || retry_e == "Export cancelled" {
                        return Err("Export cancelled".to_string());
                    }

                    sentry::capture_message(&retry_e, sentry::Level::Error);
                    Err(retry_e)
                }
            }
        }
        Err(e) if cancel_token.is_cancelled() || e == "Export cancelled" => {
            Err("Export cancelled".to_string())
        }
        Err(e) => {
            sentry::capture_message(&e, sentry::Level::Error);
            Err(e)
        }
    }
}

async fn show_export_save_dialog(
    app: &tauri::AppHandle,
    file_name: String,
    file_type: String,
) -> Result<Option<PathBuf>, String> {
    info!(file_name, file_type, "Save file dialog requested");

    let (name, extension) = match file_type.as_str() {
        "mp4" => ("MP4 Video", "mp4"),
        "gif" => ("GIF Image", "gif"),
        "mov" => ("MOV Video", "mov"),
        _ => {
            warn!(file_type, "Invalid export save file dialog type");
            return Err("Invalid file type".to_string());
        }
    };

    info!(file_name, name, extension, "Showing save file dialog");

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save File")
        .set_file_name(file_name)
        .add_filter(name, &[extension])
        .save_file(move |path| {
            let _ = tx.send(path.and_then(|p| p.as_path().map(PathBuf::from)));
        });

    rx.await.map_err(|e| e.to_string()).inspect(|result| {
        info!(path = ?result, "Save file dialog completed");
    })
}

async fn copy_export_to_path(src: &Path, dst: &Path) -> Result<(), String> {
    info!(
        src = %src.display(),
        dst = %dst.display(),
        "Copying exported video to selected path"
    );

    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create export target directory: {e}"))?;
    }

    let bytes = tokio::fs::copy(src, dst)
        .await
        .map_err(|e| format!("Failed to copy exported file: {e}"))?;

    let src_size = tokio::fs::metadata(src)
        .await
        .map_err(|e| format!("Failed to read exported file metadata: {e}"))?
        .len();

    if bytes != src_size {
        let _ = tokio::fs::remove_file(dst).await;
        return Err(format!(
            "Export copy verification failed: copied {bytes} bytes but source is {src_size} bytes"
        ));
    }

    info!(bytes, dst = %dst.display(), "Copied exported video to selected path");
    Ok(())
}

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct ExportEstimates {
    pub duration_seconds: f64,
    pub estimated_time_seconds: f64,
    pub estimated_size_mb: f64,
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_export_estimates(
    path: PathBuf,
    settings: ExportSettings,
) -> Result<ExportEstimates, String> {
    let metadata = get_video_metadata(path.clone()).await?;

    let meta = RecordingMeta::load_for_project(&path).map_err(|e| e.to_string())?;
    let project_config = meta.project_config();
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline.segments.iter().map(|s| s.duration()).sum()
    } else {
        metadata.duration
    };

    let (resolution, fps) = match &settings {
        ExportSettings::Mp4(s) => (s.resolution_base, s.fps),
        ExportSettings::Gif(s) => (s.resolution_base, s.fps),
        ExportSettings::Mov(s) => (s.resolution_base, s.fps),
    };

    let (width, height) = (resolution.x, resolution.y);
    let total_pixels = (width * height) as f64;
    let fps_f64 = fps as f64;
    let total_frames = (duration_seconds * fps_f64).ceil();

    let (estimated_size_mb, estimated_time_seconds) = match &settings {
        ExportSettings::Mp4(mp4_settings) => {
            let bits_per_pixel = mp4_settings.compression.bits_per_pixel() as f64;
            let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
            let video_bitrate = total_pixels * bits_per_pixel * effective_fps;
            let audio_bitrate = 192_000.0;
            let total_bitrate = video_bitrate + audio_bitrate;
            let encoder_efficiency = 0.5;
            let size_mb =
                (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0);

            let effective_render_fps = match (width, height) {
                (w, _) if w >= 3840 => 175.0,
                _ => 290.0,
            };
            let time_estimate = total_frames / effective_render_fps;

            (size_mb, time_estimate)
        }
        ExportSettings::Gif(_) => {
            let bytes_per_frame = total_pixels * 0.5;
            let gif_efficiency = 0.07;
            let size_mb = (bytes_per_frame * gif_efficiency * total_frames) / (1024.0 * 1024.0);

            let frames_per_sec = match (width, height) {
                (w, h) if w <= 1280 && h <= 720 => 10.0,
                (w, h) if w <= 1920 && h <= 1080 => 5.0,
                _ => 2.0,
            };
            let time_estimate = total_frames / frames_per_sec;

            (size_mb, time_estimate)
        }
        ExportSettings::Mov(_) => {
            let size_mb = estimate_cursor_only_size_mb(total_pixels, total_frames);
            let effective_render_fps = match (width, height) {
                (w, _) if w >= 3840 => 140.0,
                _ => 220.0,
            };
            let time_estimate = total_frames / effective_render_fps;

            (size_mb, time_estimate)
        }
    };

    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds,
        estimated_size_mb,
    })
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct ExportPreviewSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
    pub compression_bpp: f32,
    #[serde(default)]
    pub cursor_only: bool,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct ExportPreviewResult {
    pub jpeg_base64: String,
    pub estimated_size_mb: f64,
    pub actual_width: u32,
    pub actual_height: u32,
    pub frame_render_time_ms: f64,
    pub total_frames: u32,
}

fn estimate_cursor_only_size_mb(total_pixels: f64, total_frames: f64) -> f64 {
    let bytes_per_frame = total_pixels * 0.4;
    (bytes_per_frame * total_frames) / (1024.0 * 1024.0)
}

fn bpp_to_jpeg_quality(bpp: f32) -> u8 {
    ((bpp - 0.04) / (0.3 - 0.04) * (95.0 - 40.0) + 40.0).clamp(40.0, 95.0) as u8
}

#[tauri::command]
#[specta::specta]
#[instrument(skip_all)]
pub async fn generate_export_preview(
    project_path: PathBuf,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, String> {
    match AssertUnwindSafe(generate_export_preview_inner(
        project_path,
        frame_time,
        settings,
    ))
    .catch_unwind()
    .await
    {
        Ok(result) => result,
        Err(panic) => {
            let panic_msg = panic_message(panic);
            error!(
                target: "cap_desktop_export",
                panic = %panic_msg,
                "generate_export_preview panicked"
            );
            sentry::capture_message(
                &format!("Export preview panicked: {panic_msg}"),
                sentry::Level::Error,
            );
            Err("Export preview failed unexpectedly".to_string())
        }
    }
}

#[instrument(skip_all)]
async fn generate_export_preview_inner(
    project_path: PathBuf,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use cap_editor::create_segments;
    use std::time::Instant;

    let recording_meta = RecordingMeta::load_for_project(&project_path)
        .map_err(|e| format!("Failed to load recording meta: {e}"))?;

    let cap_project::RecordingMetaInner::Studio(studio_meta) = &recording_meta.inner else {
        return Err("Cannot preview non-studio recordings".to_string());
    };

    let project_config =
        export_project_config(recording_meta.project_config(), settings.cursor_only);

    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta)
            .map_err(|e| format!("Failed to load recordings: {e}"))?,
    );

    let render_constants = Arc::new(
        RenderVideoConstants::new(
            &recordings.segments,
            recording_meta.clone(),
            (**studio_meta).clone(),
        )
        .await
        .map_err(|e| format!("Failed to create render constants: {e}"))?,
    );

    let force_ffmpeg = should_force_ffmpeg_preview();
    info!(
        project_path = %project_path.display(),
        force_ffmpeg,
        "Starting export preview"
    );

    let segments = create_segments(&recording_meta, studio_meta, force_ffmpeg)
        .await
        .map_err(|e| format!("Failed to create segments: {e}"))?;

    let render_segments: Vec<RenderSegment> = segments
        .iter()
        .map(|s| RenderSegment {
            cursor: s.cursor.clone(),
            keyboard: s.keyboard.clone(),
            decoders: s.decoders.clone(),
            render_display: !settings.cursor_only,
        })
        .collect();

    let Some((segment_time, segment)) = project_config.get_segment_time(frame_time) else {
        return Err("Frame time is outside video duration".to_string());
    };

    let render_segment = &render_segments[segment.recording_clip as usize];
    let clip_config = project_config
        .clips
        .iter()
        .find(|v| v.index == segment.recording_clip);

    let render_start = Instant::now();

    let segment_frames = render_segment
        .decoders
        .get_frames(
            segment_time as f32,
            !project_config.camera.hide,
            render_segment.render_display,
            clip_config.map(|v| v.offsets).unwrap_or_default(),
        )
        .await
        .ok_or_else(|| "Failed to decode frame".to_string())?;

    let frame_number = (frame_time * settings.fps as f64).floor() as u32;
    let total_duration = project_config
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(0.0);

    let mut zoom_timeline = ZoomTransformTimeline::from_project(
        &project_config,
        &render_segment.cursor,
        total_duration,
        render_constants.options.screen_size,
    );
    zoom_timeline.ensure_precomputed_until((frame_number as f32 + 1.0) / settings.fps as f32);

    let uniforms = ProjectUniforms::new(
        &render_constants,
        &project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        &render_segment.cursor,
        &segment_frames,
        total_duration,
        &zoom_timeline,
    );

    let mut frame_renderer = FrameRenderer::new(&render_constants);
    let mut layers = RendererLayers::new_with_options(
        &render_constants.device,
        &render_constants.queue,
        render_constants.is_software_adapter,
    );

    let frame = frame_renderer
        .render_immediate(
            segment_frames,
            uniforms,
            &render_segment.cursor,
            render_segment.render_display,
            &mut layers,
        )
        .await
        .map_err(|e| format!("Failed to render frame: {e}"))?;

    let frame_render_time_ms = render_start.elapsed().as_secs_f64() * 1000.0;

    let width = frame.width;
    let height = frame.height;

    let rgb_data: Vec<u8> = frame
        .data
        .chunks(frame.padded_bytes_per_row as usize)
        .flat_map(|row| {
            row[0..(frame.width * 4) as usize]
                .chunks(4)
                .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
        })
        .collect();

    let jpeg_quality = bpp_to_jpeg_quality(settings.compression_bpp);
    let mut jpeg_buffer = Vec::new();
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buffer, jpeg_quality);
        encoder
            .encode(&rgb_data, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
    }

    let jpeg_base64 = STANDARD.encode(&jpeg_buffer);

    let total_pixels = (settings.resolution_base.x * settings.resolution_base.y) as f64;
    let fps_f64 = settings.fps as f64;

    let metadata = get_video_metadata(project_path.clone()).await?;
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline.segments.iter().map(|s| s.duration()).sum()
    } else {
        metadata.duration
    };
    let total_frames = (duration_seconds * fps_f64).ceil() as u32;

    let estimated_size_mb = if settings.cursor_only {
        let total_frames_f64 = (duration_seconds * fps_f64).ceil();
        estimate_cursor_only_size_mb(total_pixels, total_frames_f64)
    } else {
        let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
        let video_bitrate = total_pixels * settings.compression_bpp as f64 * effective_fps;
        let audio_bitrate = 192_000.0;
        let total_bitrate = video_bitrate + audio_bitrate;
        let encoder_efficiency = 0.5;
        (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0)
    };

    Ok(ExportPreviewResult {
        jpeg_base64,
        estimated_size_mb,
        actual_width: width,
        actual_height: height,
        frame_render_time_ms,
        total_frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn export_settings_exposes_force_ffmpeg_for_mp4_only() {
        let mp4_settings = ExportSettings::Mp4(cap_export::mp4::Mp4ExportSettings {
            fps: 30,
            resolution_base: XY { x: 1280, y: 720 },
            compression: cap_export::mp4::ExportCompression::Web,
            custom_bpp: None,
            force_ffmpeg_decoder: true,
            optimize_filesize: false,
        });
        let gif_settings = ExportSettings::Gif(cap_export::gif::GifExportSettings {
            fps: 15,
            resolution_base: XY { x: 1280, y: 720 },
            quality: None,
        });

        assert!(mp4_settings.force_ffmpeg_decoder());
        assert!(!gif_settings.force_ffmpeg_decoder());
    }

    #[test]
    fn frame_decode_error_matcher_includes_initial_frame_timeout() {
        assert!(is_frame_decode_error(
            "Export timed out 3 times consecutively after 120s each waiting for frame 0"
        ));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn recovered_projects_do_not_force_ffmpeg_without_explicit_setting() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path()
                .join(crate::recording::FRAGMENTED_EXPORT_FFMPEG_MARKER),
            b"fragmented-remux",
        )
        .unwrap();

        let gif_settings = ExportSettings::Gif(cap_export::gif::GifExportSettings {
            fps: 15,
            resolution_base: XY { x: 1280, y: 720 },
            quality: None,
        });

        assert!(!should_force_ffmpeg_export(dir.path(), &gif_settings));
    }

    #[test]
    fn exports_do_not_force_ffmpeg_without_explicit_setting() {
        let dir = tempdir().unwrap();

        let gif_settings = ExportSettings::Gif(cap_export::gif::GifExportSettings {
            fps: 15,
            resolution_base: XY { x: 1280, y: 720 },
            quality: None,
        });

        assert!(!should_force_ffmpeg_export(dir.path(), &gif_settings));
    }

    #[test]
    fn export_worker_starts_in_hardware_mode() {
        assert!(!should_start_export_worker_in_software_safe_mode());
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip_all)]
pub async fn generate_export_preview_fast(
    editor: WindowEditorInstance,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, String> {
    match AssertUnwindSafe(generate_export_preview_fast_inner(
        editor, frame_time, settings,
    ))
    .catch_unwind()
    .await
    {
        Ok(result) => result,
        Err(panic) => {
            let panic_msg = panic_message(panic);
            error!(
                target: "cap_desktop_export",
                panic = %panic_msg,
                "generate_export_preview_fast panicked"
            );
            sentry::capture_message(
                &format!("Export preview panicked: {panic_msg}"),
                sentry::Level::Error,
            );
            Err("Export preview failed unexpectedly".to_string())
        }
    }
}

#[instrument(skip_all)]
async fn generate_export_preview_fast_inner(
    editor: WindowEditorInstance,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, String> {
    if editor.export_active.load(Ordering::Acquire) {
        return Err("Export is in progress - preview generation skipped".to_string());
    }

    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::time::Instant;

    let _preview_guard = ExportPreviewActiveGuard::try_new(&editor.export_preview_active)?;

    let project_config = export_project_config(
        editor.project_config.1.borrow().clone(),
        settings.cursor_only,
    );

    let Some((segment_time, segment)) = project_config.get_segment_time(frame_time) else {
        return Err("Frame time is outside video duration".to_string());
    };

    let segment_media = &editor.segment_medias[segment.recording_clip as usize];
    let clip_config = project_config
        .clips
        .iter()
        .find(|v| v.index == segment.recording_clip);

    let render_start = Instant::now();

    let segment_frames = segment_media
        .decoders
        .get_frames(
            segment_time as f32,
            !project_config.camera.hide,
            !settings.cursor_only,
            clip_config.map(|v| v.offsets).unwrap_or_default(),
        )
        .await;
    let segment_frames = segment_frames.ok_or_else(|| "Failed to decode frame".to_string())?;

    let frame_number = (frame_time * settings.fps as f64).floor() as u32;
    let total_duration = project_config
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(0.0);

    let mut zoom_timeline = ZoomTransformTimeline::from_project(
        &project_config,
        &segment_media.cursor,
        total_duration,
        editor.render_constants.options.screen_size,
    );
    zoom_timeline.ensure_precomputed_until((frame_number as f32 + 1.0) / settings.fps as f32);

    let uniforms = ProjectUniforms::new(
        &editor.render_constants,
        &project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        &segment_media.cursor,
        &segment_frames,
        total_duration,
        &zoom_timeline,
    );

    let mut frame_renderer = FrameRenderer::new(&editor.render_constants);
    let mut layers = RendererLayers::new_with_options(
        &editor.render_constants.device,
        &editor.render_constants.queue,
        editor.render_constants.is_software_adapter,
    );

    let frame = frame_renderer
        .render_immediate(
            segment_frames,
            uniforms,
            &segment_media.cursor,
            !settings.cursor_only,
            &mut layers,
        )
        .await
        .map_err(|e| format!("Failed to render frame: {e}"))?;

    let frame_render_time_ms = render_start.elapsed().as_secs_f64() * 1000.0;

    let width = frame.width;
    let height = frame.height;

    let rgb_data: Vec<u8> = frame
        .data
        .chunks(frame.padded_bytes_per_row as usize)
        .flat_map(|row| {
            row[0..(frame.width * 4) as usize]
                .chunks(4)
                .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
        })
        .collect();

    let jpeg_quality = bpp_to_jpeg_quality(settings.compression_bpp);
    let mut jpeg_buffer = Vec::new();
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buffer, jpeg_quality);
        encoder
            .encode(&rgb_data, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
    }

    let jpeg_base64 = STANDARD.encode(&jpeg_buffer);

    let total_pixels = (settings.resolution_base.x * settings.resolution_base.y) as f64;
    let fps_f64 = settings.fps as f64;

    let duration_seconds = editor.recordings.duration();
    let total_frames = (duration_seconds * fps_f64).ceil() as u32;

    let estimated_size_mb = if settings.cursor_only {
        let total_frames_f64 = (duration_seconds * fps_f64).ceil();
        estimate_cursor_only_size_mb(total_pixels, total_frames_f64)
    } else {
        let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
        let video_bitrate = total_pixels * settings.compression_bpp as f64 * effective_fps;
        let audio_bitrate = 192_000.0;
        let total_bitrate = video_bitrate + audio_bitrate;
        let encoder_efficiency = 0.5;
        (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0)
    };

    Ok(ExportPreviewResult {
        jpeg_base64,
        estimated_size_mb,
        actual_width: width,
        actual_height: height,
        frame_render_time_ms,
        total_frames,
    })
}
