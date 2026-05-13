use crate::editor_window::{OptionalWindowEditorInstance, WindowEditorInstance};
use crate::{FramesRendered, get_video_metadata};
use cap_export::{ExporterBase, make_cursor_only_project};
use cap_project::{RecordingMeta, XY};
use cap_rendering::{
    FrameRenderer, ProjectRecordingsMeta, ProjectUniforms, RenderSegment, RenderVideoConstants,
    RendererLayers, ZoomFocusInterpolator, spring_mass_damper::SpringMassDamperSimulationConfig,
};
use futures::FutureExt;
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::io::AsyncBufReadExt;
use tracing::{error, info, instrument};

fn panic_message(panic: Box<dyn Any + Send>) -> String {
    if let Some(msg) = panic.downcast_ref::<&str>() {
        msg.to_string()
    } else if let Some(msg) = panic.downcast_ref::<String>() {
        msg.clone()
    } else {
        "unknown panic".to_string()
    }
}

async fn run_protected_export(
    project_path: &Path,
    settings: &ExportSettings,
    progress: ExportProgress,
    force_ffmpeg: bool,
) -> Result<PathBuf, String> {
    match AssertUnwindSafe(do_export(project_path, settings, progress, force_ffmpeg))
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

const EXPORTER_ENV_BIN_PATH: &str = "CAP_EXPORTER_BIN";
const EXPORTER_STDERR_TAIL_LIMIT: usize = 80;
static ACTIVE_EXPORT_SESSIONS: AtomicUsize = AtomicUsize::new(0);

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

#[derive(Clone)]
enum ExportProgress {
    Channel(tauri::ipc::Channel<FramesRendered>),
    Disabled,
}

impl ExportProgress {
    fn send(&self, progress: FramesRendered) -> bool {
        match self {
            Self::Channel(channel) => channel.send(progress).is_ok(),
            Self::Disabled => true,
        }
    }

    fn enabled(&self) -> bool {
        matches!(self, Self::Channel(_))
    }
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

#[tauri::command]
#[specta::specta]
pub fn begin_export_session() {
    retain_export_session();
}

#[tauri::command]
#[specta::specta]
pub fn end_export_session() {
    release_export_session();
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
) -> Result<PathBuf, String> {
    let safe_mode = should_start_export_sidecar_in_safe_mode();
    match run_out_of_process_export_attempt(
        project_path,
        settings,
        progress.clone(),
        force_ffmpeg,
        safe_mode,
    )
    .await
    {
        Ok(path) => Ok(path),
        Err(e) if e != "Export cancelled" && !safe_mode => {
            error!(
                error = %e,
                "Export worker failed, retrying with software rendering and encoding"
            );
            run_out_of_process_export_attempt(project_path, settings, progress, force_ffmpeg, true)
                .await
        }
        Err(e) => Err(e),
    }
}

async fn run_out_of_process_export_attempt(
    project_path: &Path,
    settings: &ExportSettings,
    progress: ExportProgress,
    force_ffmpeg: bool,
    safe_mode: bool,
) -> Result<PathBuf, String> {
    let bin_path = resolve_exporter_binary()?;
    let settings_json = serde_json::to_string(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;

    info!(
        path = %bin_path.display(),
        project_path = %project_path.display(),
        force_ffmpeg,
        safe_mode,
        "Starting export worker process"
    );

    let mut command = tokio::process::Command::new(&bin_path);
    command
        .arg("export")
        .arg(project_path)
        .arg("--settings-json")
        .arg(settings_json)
        .arg("--progress-json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if force_ffmpeg {
        command.arg("--force-ffmpeg-decoder");
    }

    if safe_mode {
        command
            .env("CAP_RENDER_FORCE_SOFTWARE_ADAPTER", "1")
            .env("CAP_EXPORT_FORCE_SOFTWARE_ENCODER", "1");
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

    while let Some(line) = stdout_lines
        .next_line()
        .await
        .map_err(|e| format!("Failed reading export worker stdout: {e}"))?
    {
        match serde_json::from_str::<ExportSidecarMessage>(&line) {
            Ok(ExportSidecarMessage::Progress {
                rendered_count,
                total_frames,
            }) => {
                if !progress.send(FramesRendered {
                    rendered_count,
                    total_frames,
                }) {
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

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed waiting for export worker: {e}"))?;
    let stderr_tail = stderr_task.await.unwrap_or_default();

    if !status.success() {
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
                info!(line = %line, "Export worker stderr");
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
    if let Ok(override_path) = std::env::var(EXPORTER_ENV_BIN_PATH) {
        let path = PathBuf::from(override_path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "{EXPORTER_ENV_BIN_PATH} points to missing path: {}",
            path.display()
        ));
    }

    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    if let Some(dir) = exe.parent() {
        let candidate = dir.join(exporter_bin_name());
        if candidate.exists() {
            return Ok(candidate);
        }

        let candidate = dir.join("..").join("MacOS").join(exporter_bin_name());
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for candidate in [
            cwd.join("target").join("debug").join(cli_bin_name()),
            cwd.join("target").join("release").join(cli_bin_name()),
        ] {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "Export worker binary not found; set {EXPORTER_ENV_BIN_PATH} or place {} next to the app executable",
        exporter_bin_name()
    ))
}

fn exporter_bin_name() -> &'static str {
    if cfg!(windows) {
        "cap-exporter.exe"
    } else {
        "cap-exporter"
    }
}

fn cli_bin_name() -> &'static str {
    if cfg!(windows) { "cap.exe" } else { "cap" }
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

async fn wait_for_export_preview_idle(flag: &AtomicBool) {
    while flag.load(Ordering::Acquire) {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
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
) -> Result<PathBuf, String> {
    let mut exporter_builder =
        ExporterBase::builder(project_path.to_path_buf()).with_force_ffmpeg_decoder(force_ffmpeg);

    if settings.cursor_only() {
        let meta = RecordingMeta::load_for_project(project_path).map_err(|e| e.to_string())?;
        exporter_builder =
            exporter_builder.with_config(export_project_config(meta.project_config(), true));
    }

    let exporter_base = exporter_builder.build().await.map_err(|e| e.to_string())?;

    let total_frames = exporter_base.total_frames(settings.fps());

    progress.send(FramesRendered {
        rendered_count: 0,
        total_frames,
    });

    match settings {
        ExportSettings::Mp4(mp4_settings) => {
            let progress = progress.clone();
            mp4_settings
                .export(exporter_base, move |frame_index| {
                    progress.send(FramesRendered {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    })
                })
                .await
        }
        ExportSettings::Gif(gif_settings) => {
            let progress = progress.clone();
            gif_settings
                .export(exporter_base, move |frame_index| {
                    progress.send(FramesRendered {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    })
                })
                .await
        }
        ExportSettings::Mov(mov_settings) => {
            let progress = progress.clone();
            mov_settings
                .export(exporter_base, move |frame_index| {
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
    settings.force_ffmpeg_decoder() || should_use_windows_release_ffmpeg_workaround()
}

fn should_force_ffmpeg_preview() -> bool {
    should_use_windows_release_ffmpeg_workaround()
}

fn should_use_out_of_process_export() -> bool {
    should_use_release_export_sidecar()
}

fn should_use_release_export_sidecar() -> bool {
    cfg!(all(target_os = "macos", not(debug_assertions)))
}

fn should_start_export_sidecar_in_safe_mode() -> bool {
    cfg!(all(target_os = "windows", not(debug_assertions)))
}

fn should_use_windows_release_ffmpeg_workaround() -> bool {
    cfg!(all(target_os = "windows", not(debug_assertions)))
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(progress, editor))]
pub async fn export_video(
    project_path: PathBuf,
    progress: tauri::ipc::Channel<FramesRendered>,
    settings: ExportSettings,
    editor: OptionalWindowEditorInstance,
) -> Result<PathBuf, String> {
    export_video_inner(
        project_path,
        settings,
        editor,
        ExportProgress::Channel(progress),
    )
    .await
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor))]
pub async fn export_video_no_progress(
    project_path: PathBuf,
    settings: ExportSettings,
    editor: OptionalWindowEditorInstance,
) -> Result<PathBuf, String> {
    export_video_inner(project_path, settings, editor, ExportProgress::Disabled).await
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(settings_json))]
pub async fn export_video_no_progress_detached(
    project_path: PathBuf,
    settings_json: String,
) -> Result<PathBuf, String> {
    info!(
        project_path = %project_path.display(),
        "Starting detached no-progress export command"
    );
    let settings = serde_json::from_str::<ExportSettings>(&settings_json)
        .map_err(|e| format!("Invalid export settings JSON: {e}"))?;
    export_video_inner(
        project_path,
        settings,
        OptionalWindowEditorInstance(None),
        ExportProgress::Disabled,
    )
    .await
}

async fn export_video_inner(
    project_path: PathBuf,
    settings: ExportSettings,
    editor: OptionalWindowEditorInstance,
    progress: ExportProgress,
) -> Result<PathBuf, String> {
    let _session_guard = ExportSessionGuard::new();
    let force_ffmpeg = should_force_ffmpeg_export(&project_path, &settings);
    info!(
        project_path = %project_path.display(),
        force_ffmpeg,
        progress = progress.enabled(),
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
        wait_for_export_preview_idle(&ed.export_preview_active).await;
    }

    let result = if should_use_out_of_process_export() {
        run_out_of_process_export(&project_path, &settings, progress.clone(), force_ffmpeg).await
    } else {
        run_protected_export(&project_path, &settings, progress.clone(), force_ffmpeg).await
    };

    match result {
        Ok(path) => {
            info!("Exported to {} completed", path.display());
            Ok(path)
        }
        Err(e) if !force_ffmpeg && is_frame_decode_error(&e) => {
            info!(
                "Export failed with frame decode error, retrying with FFmpeg decoder: {}",
                e
            );

            let retry_result = if should_use_out_of_process_export() {
                run_out_of_process_export(&project_path, &settings, progress, true).await
            } else {
                run_protected_export(&project_path, &settings, progress, true).await
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
                    sentry::capture_message(&retry_e, sentry::Level::Error);
                    Err(retry_e)
                }
            }
        }
        Err(e) => {
            sentry::capture_message(&e, sentry::Level::Error);
            Err(e)
        }
    }
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

    let cursor_smoothing =
        (!project_config.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project_config.cursor.tension,
            mass: project_config.cursor.mass,
            friction: project_config.cursor.friction,
        });

    let zoom_focus_interpolator = ZoomFocusInterpolator::new(
        &render_segment.cursor,
        cursor_smoothing,
        project_config.cursor.click_spring_config(),
        project_config.screen_movement_spring,
        total_duration,
        project_config
            .timeline
            .as_ref()
            .map(|t| t.zoom_segments.as_slice())
            .unwrap_or(&[]),
    );

    let uniforms = ProjectUniforms::new(
        &render_constants,
        &project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        &render_segment.cursor,
        &segment_frames,
        total_duration,
        &zoom_focus_interpolator,
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

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_exports_force_ffmpeg_in_release_builds_without_explicit_setting() {
        let dir = tempdir().unwrap();

        let gif_settings = ExportSettings::Gif(cap_export::gif::GifExportSettings {
            fps: 15,
            resolution_base: XY { x: 1280, y: 720 },
            quality: None,
        });

        assert_eq!(
            should_force_ffmpeg_export(dir.path(), &gif_settings),
            !cfg!(debug_assertions)
        );
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

    let cursor_smoothing =
        (!project_config.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project_config.cursor.tension,
            mass: project_config.cursor.mass,
            friction: project_config.cursor.friction,
        });

    let zoom_focus_interpolator = ZoomFocusInterpolator::new(
        &segment_media.cursor,
        cursor_smoothing,
        project_config.cursor.click_spring_config(),
        project_config.screen_movement_spring,
        total_duration,
        project_config
            .timeline
            .as_ref()
            .map(|t| t.zoom_segments.as_slice())
            .unwrap_or(&[]),
    );

    let uniforms = ProjectUniforms::new(
        &editor.render_constants,
        &project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        &segment_media.cursor,
        &segment_frames,
        total_duration,
        &zoom_focus_interpolator,
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
