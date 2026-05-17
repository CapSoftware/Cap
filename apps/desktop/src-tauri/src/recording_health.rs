use cap_enc_ffmpeg::remux::{
    get_media_duration, probe_media_valid, probe_video_can_decode, remux_file,
};
use cap_project::{
    AudioMeta, InstantRecordingMeta, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    StudioRecordingStatus, VideoMeta,
};
use cap_recording::recovery::RecoveryManager;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, ipc::Channel};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingHealthStatus {
    Healthy,
    Degraded,
    Damaged,
    Missing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingHealthSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingHealthMediaKind {
    Video,
    Audio,
    Data,
    Directory,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingHealthMode {
    Studio,
    Instant,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingRepairStatus {
    Performed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHealthIssue {
    pub severity: RecordingHealthSeverity,
    pub code: String,
    pub title: String,
    pub detail: String,
    pub path: Option<String>,
    pub repairable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHealthFile {
    pub label: String,
    pub path: String,
    pub kind: RecordingHealthMediaKind,
    pub required: bool,
    pub exists: bool,
    pub size_bytes: Option<f64>,
    pub valid_container: Option<bool>,
    pub decodable: Option<bool>,
    pub duration_secs: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRecoverableSummary {
    pub available: bool,
    pub segment_count: u32,
    pub estimated_duration_secs: f64,
}

impl Default for RecordingRecoverableSummary {
    fn default() -> Self {
        Self {
            available: false,
            segment_count: 0,
            estimated_duration_secs: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRepairAttempt {
    pub status: RecordingRepairStatus,
    pub title: String,
    pub detail: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHealthReport {
    pub project_path: String,
    pub pretty_name: String,
    pub mode: RecordingHealthMode,
    pub recording_status: String,
    pub status: RecordingHealthStatus,
    pub score: u8,
    pub repairable: bool,
    pub issues: Vec<RecordingHealthIssue>,
    pub files: Vec<RecordingHealthFile>,
    pub recoverable: RecordingRecoverableSummary,
    pub repairs: Vec<RecordingRepairAttempt>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingHealthProgressPhase {
    Preparing,
    Scanning,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHealthProgress {
    pub phase: RecordingHealthProgressPhase,
    pub completed: u32,
    pub total: u32,
    pub current_path: Option<String>,
    pub current_name: Option<String>,
    pub message: String,
    pub elapsed_secs: f64,
    pub eta_secs: Option<f64>,
    pub report: Option<RecordingHealthReport>,
}

#[tauri::command]
#[specta::specta]
pub async fn inspect_recording_health(
    project_path: String,
) -> Result<RecordingHealthReport, String> {
    tokio::task::spawn_blocking(move || inspect_project(&PathBuf::from(project_path)))
        .await
        .map_err(|e| format!("Recording health check task failed: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn scan_recording_health(app: AppHandle) -> Result<Vec<RecordingHealthReport>, String> {
    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");

    tokio::task::spawn_blocking(move || scan_recordings_dir(&recordings_dir))
        .await
        .map_err(|e| format!("Recording health scan task failed: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn scan_recording_health_with_progress(
    app: AppHandle,
    progress: Channel<RecordingHealthProgress>,
) -> Result<Vec<RecordingHealthReport>, String> {
    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");

    tokio::task::spawn_blocking(move || {
        scan_recordings_dir_with_progress(&recordings_dir, Some(&progress))
    })
    .await
    .map_err(|e| format!("Recording health scan task failed: {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn repair_recording_health(
    project_path: String,
) -> Result<RecordingHealthReport, String> {
    tokio::task::spawn_blocking(move || repair_project(&PathBuf::from(project_path)))
        .await
        .map_err(|e| format!("Recording repair task failed: {e}"))
}

fn scan_recordings_dir(recordings_dir: &Path) -> Vec<RecordingHealthReport> {
    scan_recordings_dir_with_progress(recordings_dir, None)
}

fn scan_recordings_dir_with_progress(
    recordings_dir: &Path,
    progress: Option<&Channel<RecordingHealthProgress>>,
) -> Vec<RecordingHealthReport> {
    let started_at = std::time::Instant::now();
    let paths = recording_project_paths(recordings_dir);
    let total = paths.len() as u32;

    emit_scan_progress(
        progress,
        RecordingHealthProgressPhase::Preparing,
        0,
        total,
        None,
        None,
        "Preparing recording scan".to_string(),
        started_at,
        None,
    );

    let mut reports = Vec::with_capacity(paths.len());

    for (index, path) in paths.into_iter().enumerate() {
        let completed = index as u32;
        let current_name = path_display_name(&path);
        emit_scan_progress(
            progress,
            RecordingHealthProgressPhase::Scanning,
            completed,
            total,
            Some(&path),
            Some(current_name),
            format!("Inspecting recording {} of {total}", completed + 1),
            started_at,
            None,
        );

        let report = inspect_project(&path);
        let completed = completed + 1;
        emit_scan_progress(
            progress,
            RecordingHealthProgressPhase::Scanning,
            completed,
            total,
            Some(Path::new(&report.project_path)),
            Some(report.pretty_name.clone()),
            format!("Checked {completed} of {total} recordings"),
            started_at,
            Some(report.clone()),
        );
        reports.push(report);
    }

    emit_scan_progress(
        progress,
        RecordingHealthProgressPhase::Complete,
        total,
        total,
        None,
        None,
        format!("Finished checking {total} recordings"),
        started_at,
        None,
    );

    reports
}

fn recording_project_paths(recordings_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(recordings_dir) else {
        return Vec::new();
    };

    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();

    paths.sort_by(|a, b| path_created_at(b).cmp(&path_created_at(a)));
    paths
}

fn path_created_at(path: &Path) -> std::time::SystemTime {
    path.metadata()
        .and_then(|metadata| metadata.created())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}

fn path_display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Recording")
        .to_string()
}

fn emit_scan_progress(
    progress: Option<&Channel<RecordingHealthProgress>>,
    phase: RecordingHealthProgressPhase,
    completed: u32,
    total: u32,
    current_path: Option<&Path>,
    current_name: Option<String>,
    message: String,
    started_at: std::time::Instant,
    report: Option<RecordingHealthReport>,
) {
    let Some(progress) = progress else {
        return;
    };

    let elapsed_secs = started_at.elapsed().as_secs_f64();
    let eta_secs = if completed > 0 && completed < total {
        Some((elapsed_secs / f64::from(completed)) * f64::from(total - completed))
    } else {
        None
    };

    let _ = progress.send(RecordingHealthProgress {
        phase,
        completed,
        total,
        current_path: current_path.map(|path| path.display().to_string()),
        current_name,
        message,
        elapsed_secs,
        eta_secs,
        report,
    });
}

fn inspect_project(project_path: &Path) -> RecordingHealthReport {
    let mut inspector = HealthInspector::new(project_path);

    if !project_path.exists() {
        inspector.status = RecordingHealthStatus::Missing;
        inspector.push_issue(
            RecordingHealthSeverity::Critical,
            "project_missing",
            "Recording folder missing",
            "The recording folder no longer exists on disk.",
            Some(project_path),
            false,
        );
        return inspector.finish();
    }

    if !project_path.is_dir() {
        inspector.push_issue(
            RecordingHealthSeverity::Critical,
            "project_not_directory",
            "Recording path is not a folder",
            "The selected recording path is not a valid Cap recording bundle.",
            Some(project_path),
            false,
        );
        return inspector.finish();
    }

    match RecordingMeta::load_for_project(project_path) {
        Ok(meta) => {
            inspector.pretty_name = meta.pretty_name.clone();
            inspector.mode = mode_for_meta(&meta);
            inspector.recording_status = status_for_meta(&meta);
            let recoverable = RecoveryManager::inspect_recording(project_path);
            inspect_meta(&mut inspector, project_path, &meta);
            if should_offer_recovery(&meta, &inspector, recoverable.as_ref()) {
                inspector.apply_recoverable(recoverable);
            }
        }
        Err(error) => {
            inspector.push_issue(
                RecordingHealthSeverity::Critical,
                "metadata_unreadable",
                "Metadata cannot be read",
                &format!("recording-meta.json could not be loaded: {error}"),
                Some(&project_path.join("recording-meta.json")),
                false,
            );
            inspector.recording_status = "Unreadable metadata".to_string();
            inspect_orphaned_content(&mut inspector, project_path);
        }
    }

    inspector.finish()
}

fn repair_project(project_path: &Path) -> RecordingHealthReport {
    let mut repairs = Vec::new();

    if inspect_project(project_path).recoverable.available {
        match RecoveryManager::inspect_recording(project_path) {
            Some(recording) if !recording.recoverable_segments.is_empty() => {
                let segment_count = recording.recoverable_segments.len();
                match RecoveryManager::recover(&recording) {
                    Ok(_) => repairs.push(RecordingRepairAttempt {
                        status: RecordingRepairStatus::Performed,
                        title: "Recovered recording fragments".to_string(),
                        detail: format!("Recovered {segment_count} recording segment(s)."),
                        path: Some(project_path.display().to_string()),
                    }),
                    Err(error) => repairs.push(RecordingRepairAttempt {
                        status: RecordingRepairStatus::Failed,
                        title: "Fragment recovery failed".to_string(),
                        detail: error.to_string(),
                        path: Some(project_path.display().to_string()),
                    }),
                }
            }
            _ => repairs.push(RecordingRepairAttempt {
                status: RecordingRepairStatus::Skipped,
                title: "No recoverable fragments found".to_string(),
                detail: "No complete fragment set was available for timeline recovery.".to_string(),
                path: Some(project_path.display().to_string()),
            }),
        }
    } else {
        repairs.push(RecordingRepairAttempt {
            status: RecordingRepairStatus::Skipped,
            title: "No recoverable fragments found".to_string(),
            detail: "No incomplete recording fragments needed recovery.".to_string(),
            path: Some(project_path.display().to_string()),
        });
    }

    if let Ok(meta) = RecordingMeta::load_for_project(project_path) {
        if let Some(attempt) = repair_instant_segment_output(project_path, &meta) {
            repairs.push(attempt);
        }

        for path in collect_video_paths(project_path, &meta) {
            if should_try_video_remux(&path) {
                repairs.push(repair_video_file(&path));
            }
        }
    }

    let mut report = inspect_project(project_path);
    report.repairs = repairs;
    report.repairable = report.repairable
        || report.repairs.iter().any(|attempt| {
            matches!(
                attempt.status,
                RecordingRepairStatus::Performed | RecordingRepairStatus::Failed
            )
        });
    report
}

fn inspect_meta(inspector: &mut HealthInspector, project_path: &Path, meta: &RecordingMeta) {
    match &meta.inner {
        RecordingMetaInner::Instant(instant) => inspect_instant(inspector, project_path, instant),
        RecordingMetaInner::Studio(studio) => inspect_studio(inspector, project_path, studio),
    }
}

fn inspect_instant(
    inspector: &mut HealthInspector,
    project_path: &Path,
    instant: &InstantRecordingMeta,
) {
    match instant {
        InstantRecordingMeta::Failed { error } => inspector.push_issue(
            RecordingHealthSeverity::Critical,
            "instant_failed",
            "Instant recording failed",
            error,
            Some(project_path),
            true,
        ),
        InstantRecordingMeta::InProgress { .. } => inspector.push_issue(
            RecordingHealthSeverity::Warning,
            "instant_in_progress",
            "Instant recording still in progress",
            "The metadata says this recording did not finish cleanly.",
            Some(project_path),
            true,
        ),
        InstantRecordingMeta::Complete { .. } => {}
    }

    let output_path = project_path.join("content/output.mp4");
    let display_dir = project_path.join("content/display");
    let display_output_path = display_dir.join("output.mp4");
    let has_display_fragments = count_m4s_segments(&display_dir) > 0;

    if output_path.exists() {
        inspector.check_file(
            "Instant output",
            output_path,
            RecordingHealthMediaKind::Video,
            true,
            true,
        );
    } else if display_output_path.exists() {
        inspector.check_file(
            "Instant display output",
            display_output_path,
            RecordingHealthMediaKind::Video,
            true,
            true,
        );
    } else {
        inspector.push_issue(
            if has_display_fragments {
                RecordingHealthSeverity::Warning
            } else {
                RecordingHealthSeverity::Critical
            },
            "instant_output_missing",
            "Instant output missing",
            if has_display_fragments {
                "Segment files are present, but no progressive MP4 output was found."
            } else {
                "No progressive MP4 output or display segments were found."
            },
            Some(&output_path),
            has_display_fragments,
        );
    }

    inspect_segment_directory(inspector, &display_dir, "Instant video segments");
    inspect_segment_directory(
        inspector,
        &project_path.join("content/audio"),
        "Instant audio segments",
    );
}

fn inspect_studio(
    inspector: &mut HealthInspector,
    project_path: &Path,
    studio: &StudioRecordingMeta,
) {
    match studio.status() {
        StudioRecordingStatus::InProgress => inspector.push_issue(
            RecordingHealthSeverity::Warning,
            "studio_in_progress",
            "Studio recording did not finish cleanly",
            "The metadata still marks this recording as in progress.",
            Some(project_path),
            true,
        ),
        StudioRecordingStatus::NeedsRemux => inspector.push_issue(
            RecordingHealthSeverity::Warning,
            "studio_needs_remux",
            "Recording needs remux",
            "The recording stopped before fragments were finalized into editor-ready media.",
            Some(project_path),
            true,
        ),
        StudioRecordingStatus::Failed { ref error } => inspector.push_issue(
            RecordingHealthSeverity::Critical,
            "studio_failed",
            "Studio recording failed",
            error,
            Some(project_path),
            true,
        ),
        StudioRecordingStatus::Complete => {}
    }

    match studio {
        StudioRecordingMeta::SingleSegment { segment } => {
            let display = inspector.check_video_meta(
                project_path,
                "Display",
                &segment.display,
                true,
                inspector.recoverable.available,
            );
            if let Some(camera) = &segment.camera {
                let camera_file = inspector.check_video_meta(
                    project_path,
                    "Camera",
                    camera,
                    false,
                    inspector.recoverable.available,
                );
                compare_duration(inspector, "camera", &display, &camera_file);
            }
            if let Some(audio) = &segment.audio {
                let audio_file = inspector.check_audio_meta(
                    project_path,
                    "Microphone",
                    audio,
                    false,
                    inspector.recoverable.available,
                );
                compare_duration(inspector, "microphone", &display, &audio_file);
            }
            if let Some(cursor) = &segment.cursor {
                inspector.check_file(
                    "Cursor events",
                    cursor.to_path(project_path),
                    RecordingHealthMediaKind::Data,
                    false,
                    false,
                );
            }
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            if inner.segments.is_empty() {
                inspector.push_issue(
                    RecordingHealthSeverity::Critical,
                    "studio_no_segments",
                    "No timeline media segments",
                    "The recording metadata does not reference any media segments.",
                    Some(project_path),
                    inspector.recoverable.available,
                );
            }

            for (index, segment) in inner.segments.iter().enumerate() {
                let label = format!("Segment {}", index + 1);
                let display = inspector.check_video_meta(
                    project_path,
                    &format!("{label} display"),
                    &segment.display,
                    true,
                    inspector.recoverable.available,
                );
                if let Some(camera) = &segment.camera {
                    let camera_file = inspector.check_video_meta(
                        project_path,
                        &format!("{label} camera"),
                        camera,
                        false,
                        inspector.recoverable.available,
                    );
                    compare_duration(inspector, "camera", &display, &camera_file);
                }
                if let Some(mic) = &segment.mic {
                    let mic_file = inspector.check_audio_meta(
                        project_path,
                        &format!("{label} microphone"),
                        mic,
                        false,
                        inspector.recoverable.available,
                    );
                    compare_duration(inspector, "microphone", &display, &mic_file);
                }
                if let Some(system_audio) = &segment.system_audio {
                    let system_audio_file = inspector.check_audio_meta(
                        project_path,
                        &format!("{label} system audio"),
                        system_audio,
                        false,
                        inspector.recoverable.available,
                    );
                    compare_duration(inspector, "system audio", &display, &system_audio_file);
                }
                if let Some(cursor) = &segment.cursor {
                    inspector.check_file(
                        &format!("{label} cursor events"),
                        cursor.to_path(project_path),
                        RecordingHealthMediaKind::Data,
                        false,
                        false,
                    );
                }
                if let Some(keyboard) = &segment.keyboard {
                    inspector.check_file(
                        &format!("{label} keyboard events"),
                        keyboard.to_path(project_path),
                        RecordingHealthMediaKind::Data,
                        false,
                        false,
                    );
                }
            }
        }
    }
}

fn inspect_orphaned_content(inspector: &mut HealthInspector, project_path: &Path) {
    for path in [
        project_path.join("content/output.mp4"),
        project_path.join("content/display.mp4"),
        project_path.join("output/result.mp4"),
    ] {
        if path.exists() {
            inspector.check_file(
                "Unreferenced video",
                path,
                RecordingHealthMediaKind::Video,
                false,
                true,
            );
        }
    }
}

fn should_offer_recovery(
    meta: &RecordingMeta,
    inspector: &HealthInspector,
    recording: Option<&cap_recording::recovery::IncompleteRecording>,
) -> bool {
    let Some(recording) = recording else {
        return false;
    };

    if recording.recoverable_segments.is_empty() {
        return false;
    }

    if studio_status_needs_recovery(meta) {
        return true;
    }

    inspector
        .issues
        .iter()
        .any(|issue| issue.severity == RecordingHealthSeverity::Critical)
        && recoverable_contains_fragment_stream(recording)
}

fn studio_status_needs_recovery(meta: &RecordingMeta) -> bool {
    match &meta.inner {
        RecordingMetaInner::Studio(studio) => {
            !matches!(studio.status(), StudioRecordingStatus::Complete)
        }
        RecordingMetaInner::Instant(instant) => {
            !matches!(instant, InstantRecordingMeta::Complete { .. })
        }
    }
}

fn recoverable_contains_fragment_stream(
    recording: &cap_recording::recovery::IncompleteRecording,
) -> bool {
    recording.recoverable_segments.iter().any(|segment| {
        segment.display_init_segment.is_some()
            || segment
                .display_fragments
                .iter()
                .any(|path| path_is_segment_fragment(path))
            || segment.camera_fragments.as_ref().is_some_and(|fragments| {
                fragments.iter().any(|path| path_is_segment_fragment(path))
            })
    })
}

fn path_is_segment_fragment(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("m4s"))
        || path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, "display" | "camera"))
}

fn inspect_segment_directory(inspector: &mut HealthInspector, dir: &Path, label: &str) {
    if !dir.exists() {
        return;
    }

    let segment_count = count_m4s_segments(dir);
    let init_path = dir.join("init.mp4");

    inspector.files.push(RecordingHealthFile {
        label: label.to_string(),
        path: dir.display().to_string(),
        kind: RecordingHealthMediaKind::Directory,
        required: false,
        exists: true,
        size_bytes: None,
        valid_container: None,
        decodable: None,
        duration_secs: Some(segment_count as f64),
    });

    if segment_count > 0 && !init_path.exists() {
        inspector.push_issue(
            RecordingHealthSeverity::Warning,
            "segment_init_missing",
            "Segment init file missing",
            "Segment files exist without the init segment needed for a complete stream.",
            Some(&init_path),
            false,
        );
    }
}

fn compare_duration(
    inspector: &mut HealthInspector,
    track_name: &str,
    display: &RecordingHealthFile,
    track: &RecordingHealthFile,
) {
    let Some(display_duration) = display.duration_secs else {
        return;
    };
    let Some(track_duration) = track.duration_secs else {
        return;
    };
    if display_duration < 1.0 || track_duration < 1.0 {
        return;
    }

    let difference = (display_duration - track_duration).abs();
    let tolerance = display_duration.max(track_duration) * 0.2;
    if difference > tolerance.max(2.0) {
        inspector.push_issue(
            RecordingHealthSeverity::Warning,
            "track_duration_mismatch",
            "Track duration mismatch",
            &format!("{track_name} duration differs from display by {difference:.1}s."),
            Some(Path::new(&track.path)),
            true,
        );
    }
}

fn repair_instant_segment_output(
    project_path: &Path,
    meta: &RecordingMeta,
) -> Option<RecordingRepairAttempt> {
    if !matches!(meta.inner, RecordingMetaInner::Instant(_)) {
        return None;
    }

    let display_dir = project_path.join("content/display");
    if count_m4s_segments(&display_dir) == 0 {
        return None;
    }

    let output = project_path.join("content/output.mp4");
    if output.exists() && probe_video_can_decode(&output).unwrap_or(false) {
        return None;
    }

    match RecoveryManager::finalize_to_progressive_mp4(&display_dir, &output) {
        Ok(_) => Some(RecordingRepairAttempt {
            status: RecordingRepairStatus::Performed,
            title: "Rebuilt instant MP4 output".to_string(),
            detail: "Finalized available video segments into content/output.mp4.".to_string(),
            path: Some(output.display().to_string()),
        }),
        Err(error) => Some(RecordingRepairAttempt {
            status: RecordingRepairStatus::Failed,
            title: "Instant segment rebuild failed".to_string(),
            detail: error.to_string(),
            path: Some(display_dir.display().to_string()),
        }),
    }
}

fn collect_video_paths(project_path: &Path, meta: &RecordingMeta) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    match &meta.inner {
        RecordingMetaInner::Instant(_) => {
            paths.push(project_path.join("content/output.mp4"));
            paths.push(project_path.join("content/display/output.mp4"));
        }
        RecordingMetaInner::Studio(studio) => match &**studio {
            StudioRecordingMeta::SingleSegment { segment } => {
                paths.push(segment.display.path.to_path(project_path));
                if let Some(camera) = &segment.camera {
                    paths.push(camera.path.to_path(project_path));
                }
            }
            StudioRecordingMeta::MultipleSegments { inner } => {
                for segment in &inner.segments {
                    paths.push(segment.display.path.to_path(project_path));
                    if let Some(camera) = &segment.camera {
                        paths.push(camera.path.to_path(project_path));
                    }
                }
            }
        },
    }

    paths.sort();
    paths.dedup();
    paths
}

fn should_try_video_remux(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }

    match probe_video_can_decode(path) {
        Ok(true) => false,
        Ok(false) | Err(_) => true,
    }
}

fn repair_video_file(path: &Path) -> RecordingRepairAttempt {
    let temp_path = repaired_video_path(path);
    let result = remux_file(path, &temp_path)
        .map_err(|e| e.to_string())
        .and_then(|_| match probe_video_can_decode(&temp_path) {
            Ok(true) => Ok(()),
            Ok(false) => Err("Remuxed file has no decodable frames".to_string()),
            Err(error) => Err(error),
        })
        .and_then(|_| replace_file(&temp_path, path).map_err(|e| e.to_string()));

    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }

    match result {
        Ok(()) => RecordingRepairAttempt {
            status: RecordingRepairStatus::Performed,
            title: "Remuxed damaged MP4".to_string(),
            detail: "Rewrote the MP4 container while preserving media streams.".to_string(),
            path: Some(path.display().to_string()),
        },
        Err(error) => RecordingRepairAttempt {
            status: RecordingRepairStatus::Failed,
            title: "MP4 remux failed".to_string(),
            detail: error,
            path: Some(path.display().to_string()),
        },
    }
}

fn repaired_video_path(path: &Path) -> PathBuf {
    let file_name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    path.with_file_name(format!("{file_name}.repaired.mp4"))
}

fn replace_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() {
        std::fs::remove_file(dst)?;
    }
    std::fs::rename(src, dst)
}

fn count_m4s_segments(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };

    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("m4s"))
        })
        .count()
}

fn mode_for_meta(meta: &RecordingMeta) -> RecordingHealthMode {
    match &meta.inner {
        RecordingMetaInner::Studio(_) => RecordingHealthMode::Studio,
        RecordingMetaInner::Instant(_) => RecordingHealthMode::Instant,
    }
}

fn status_for_meta(meta: &RecordingMeta) -> String {
    match &meta.inner {
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
            "In progress".to_string()
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::Failed { .. }) => "Failed".to_string(),
        RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
            "Complete".to_string()
        }
        RecordingMetaInner::Studio(studio) => match studio.status() {
            StudioRecordingStatus::InProgress => "In progress".to_string(),
            StudioRecordingStatus::NeedsRemux => "Needs remux".to_string(),
            StudioRecordingStatus::Failed { .. } => "Failed".to_string(),
            StudioRecordingStatus::Complete => "Complete".to_string(),
        },
    }
}

struct HealthInspector {
    project_path: PathBuf,
    pretty_name: String,
    mode: RecordingHealthMode,
    recording_status: String,
    status: RecordingHealthStatus,
    issues: Vec<RecordingHealthIssue>,
    files: Vec<RecordingHealthFile>,
    recoverable: RecordingRecoverableSummary,
}

impl HealthInspector {
    fn new(project_path: &Path) -> Self {
        Self {
            project_path: project_path.to_path_buf(),
            pretty_name: project_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Recording")
                .to_string(),
            mode: RecordingHealthMode::Unknown,
            recording_status: "Unknown".to_string(),
            status: RecordingHealthStatus::Healthy,
            issues: Vec::new(),
            files: Vec::new(),
            recoverable: RecordingRecoverableSummary::default(),
        }
    }

    fn apply_recoverable(
        &mut self,
        recording: Option<cap_recording::recovery::IncompleteRecording>,
    ) {
        let Some(recording) = recording else {
            return;
        };

        self.recoverable = RecordingRecoverableSummary {
            available: !recording.recoverable_segments.is_empty(),
            segment_count: recording.recoverable_segments.len() as u32,
            estimated_duration_secs: recording.estimated_duration.as_secs_f64(),
        };

        if self.recoverable.available {
            self.push_issue(
                RecordingHealthSeverity::Warning,
                "recoverable_fragments_found",
                "Recoverable fragments available",
                &format!(
                    "{} segment(s) can be rebuilt from available fragments.",
                    self.recoverable.segment_count
                ),
                Some(&self.project_path.clone()),
                true,
            );
        }
    }

    fn check_video_meta(
        &mut self,
        project_path: &Path,
        label: &str,
        meta: &VideoMeta,
        required: bool,
        repairable: bool,
    ) -> RecordingHealthFile {
        self.check_file(
            label,
            meta.path.to_path(project_path),
            RecordingHealthMediaKind::Video,
            required,
            repairable,
        )
    }

    fn check_audio_meta(
        &mut self,
        project_path: &Path,
        label: &str,
        meta: &AudioMeta,
        required: bool,
        repairable: bool,
    ) -> RecordingHealthFile {
        self.check_file(
            label,
            meta.path.to_path(project_path),
            RecordingHealthMediaKind::Audio,
            required,
            repairable,
        )
    }

    fn check_file(
        &mut self,
        label: &str,
        path: PathBuf,
        kind: RecordingHealthMediaKind,
        required: bool,
        repairable: bool,
    ) -> RecordingHealthFile {
        let exists = path.exists();
        let metadata = path.metadata().ok();
        let size_bytes = metadata.as_ref().map(|metadata| metadata.len() as f64);
        let mut valid_container = None;
        let mut decodable = None;
        let mut duration_secs = None;

        if !exists {
            self.push_issue(
                if required {
                    RecordingHealthSeverity::Critical
                } else {
                    RecordingHealthSeverity::Warning
                },
                "file_missing",
                &format!("{label} missing"),
                "The file referenced by the recording metadata does not exist.",
                Some(&path),
                repairable,
            );
        } else if size_bytes == Some(0.0) {
            self.push_issue(
                if required {
                    RecordingHealthSeverity::Critical
                } else {
                    RecordingHealthSeverity::Warning
                },
                "file_empty",
                &format!("{label} is empty"),
                "The file exists but has no bytes.",
                Some(&path),
                repairable,
            );
        } else {
            match kind {
                RecordingHealthMediaKind::Video => {
                    let container_ok = probe_media_valid(&path);
                    valid_container = Some(container_ok);
                    let video_decodable = probe_video_can_decode(&path).unwrap_or(false);
                    decodable = Some(video_decodable);
                    duration_secs =
                        get_media_duration(&path).map(|duration| duration.as_secs_f64());

                    if !container_ok || !video_decodable {
                        self.push_issue(
                            if required {
                                RecordingHealthSeverity::Critical
                            } else {
                                RecordingHealthSeverity::Warning
                            },
                            "video_unreadable",
                            &format!("{label} cannot be decoded"),
                            "The media container or video stream could not be decoded.",
                            Some(&path),
                            true,
                        );
                    } else if duration_secs.is_none() {
                        self.push_issue(
                            RecordingHealthSeverity::Warning,
                            "duration_unknown",
                            &format!("{label} duration unavailable"),
                            "The media file is readable, but its duration could not be determined.",
                            Some(&path),
                            true,
                        );
                    }
                }
                RecordingHealthMediaKind::Audio => {
                    let container_ok = probe_media_valid(&path);
                    valid_container = Some(container_ok);
                    duration_secs =
                        get_media_duration(&path).map(|duration| duration.as_secs_f64());

                    if !container_ok {
                        self.push_issue(
                            if required {
                                RecordingHealthSeverity::Critical
                            } else {
                                RecordingHealthSeverity::Warning
                            },
                            "audio_unreadable",
                            &format!("{label} cannot be read"),
                            "The audio file could not be opened as media.",
                            Some(&path),
                            false,
                        );
                    }
                }
                RecordingHealthMediaKind::Data | RecordingHealthMediaKind::Directory => {}
            }
        }

        let file = RecordingHealthFile {
            label: label.to_string(),
            path: path.display().to_string(),
            kind,
            required,
            exists,
            size_bytes,
            valid_container,
            decodable,
            duration_secs,
        };
        self.files.push(file.clone());
        file
    }

    fn push_issue(
        &mut self,
        severity: RecordingHealthSeverity,
        code: &str,
        title: &str,
        detail: &str,
        path: Option<&Path>,
        repairable: bool,
    ) {
        self.issues.push(RecordingHealthIssue {
            severity,
            code: code.to_string(),
            title: title.to_string(),
            detail: detail.to_string(),
            path: path.map(|p| p.display().to_string()),
            repairable,
        });
    }

    fn finish(mut self) -> RecordingHealthReport {
        let critical_count = self
            .issues
            .iter()
            .filter(|issue| issue.severity == RecordingHealthSeverity::Critical)
            .count() as i32;
        let warning_count = self
            .issues
            .iter()
            .filter(|issue| issue.severity == RecordingHealthSeverity::Warning)
            .count() as i32;

        if self.status != RecordingHealthStatus::Missing {
            self.status = if critical_count > 0 {
                RecordingHealthStatus::Damaged
            } else if warning_count > 0 {
                RecordingHealthStatus::Degraded
            } else {
                RecordingHealthStatus::Healthy
            };
        }

        let score = (100 - critical_count * 28 - warning_count * 9).clamp(0, 100) as u8;
        let repairable = self.recoverable.available || self.issues.iter().any(|i| i.repairable);

        RecordingHealthReport {
            project_path: self.project_path.display().to_string(),
            pretty_name: self.pretty_name,
            mode: self.mode,
            recording_status: self.recording_status,
            status: self.status,
            score,
            repairable,
            issues: self.issues,
            files: self.files,
            recoverable: self.recoverable,
            repairs: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RecordingHealthStatus, RecordingRepairStatus, inspect_project, repair_project};
    use std::{fs, path::PathBuf};
    use tempfile::tempdir;

    fn fixture_video() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../media-server/src/__tests__/fixtures/test-no-audio.mp4")
    }

    fn write_meta(project_path: &std::path::Path, json: &str) {
        fs::create_dir_all(project_path).unwrap();
        fs::write(project_path.join("recording-meta.json"), json).unwrap();
    }

    fn copy_fixture_video(path: &std::path::Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::copy(fixture_video(), path).unwrap();
    }

    #[test]
    fn reports_missing_project_as_missing() {
        let dir = tempdir().unwrap();
        let report = inspect_project(&dir.path().join("missing.cap"));

        assert_eq!(report.status, RecordingHealthStatus::Missing);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == "project_missing")
        );
    }

    #[test]
    fn reports_unreadable_metadata_as_damaged() {
        let dir = tempdir().unwrap();
        let project_path = dir.path().join("broken.cap");
        fs::create_dir_all(&project_path).unwrap();
        fs::write(project_path.join("recording-meta.json"), b"{").unwrap();

        let report = inspect_project(&project_path);

        assert_eq!(report.status, RecordingHealthStatus::Damaged);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.code == "metadata_unreadable")
        );
    }

    #[test]
    fn reports_healthy_studio_recording() {
        let dir = tempdir().unwrap();
        let project_path = dir.path().join("healthy.cap");
        write_meta(
            &project_path,
            r#"{
                "pretty_name": "Healthy",
                "display": { "path": "content/display.mp4" }
            }"#,
        );
        copy_fixture_video(&project_path.join("content/display.mp4"));

        let report = inspect_project(&project_path);

        assert_eq!(report.status, RecordingHealthStatus::Healthy);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn reports_missing_optional_audio_as_degraded() {
        let dir = tempdir().unwrap();
        let project_path = dir.path().join("missing-audio.cap");
        write_meta(
            &project_path,
            r#"{
                "pretty_name": "Missing Audio",
                "display": { "path": "content/display.mp4" },
                "audio": { "path": "content/audio-input.ogg" }
            }"#,
        );
        copy_fixture_video(&project_path.join("content/display.mp4"));

        let report = inspect_project(&project_path);

        assert_eq!(report.status, RecordingHealthStatus::Degraded);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.title == "Microphone missing")
        );
    }

    #[test]
    fn failed_repair_leaves_corrupt_recording_damaged() {
        let dir = tempdir().unwrap();
        let project_path = dir.path().join("corrupt.cap");
        write_meta(
            &project_path,
            r#"{
                "pretty_name": "Corrupt",
                "display": { "path": "content/display.mp4" }
            }"#,
        );
        fs::create_dir_all(project_path.join("content")).unwrap();
        fs::write(project_path.join("content/display.mp4"), b"not a video").unwrap();

        let report = repair_project(&project_path);

        assert_eq!(report.status, RecordingHealthStatus::Damaged);
        assert!(
            report
                .repairs
                .iter()
                .any(|attempt| attempt.status == RecordingRepairStatus::Failed)
        );
    }

    #[test]
    fn repairs_in_progress_studio_recording_from_complete_segment_file() {
        let dir = tempdir().unwrap();
        let project_path = dir.path().join("recoverable.cap");
        write_meta(
            &project_path,
            r#"{
                "pretty_name": "Recoverable",
                "segments": [
                    {
                        "display": {
                            "path": "content/segments/segment-0/display.mp4"
                        }
                    }
                ],
                "status": { "status": "InProgress" }
            }"#,
        );
        copy_fixture_video(&project_path.join("content/segments/segment-0/display.mp4"));

        let before = inspect_project(&project_path);
        assert!(before.recoverable.available);

        let after = repair_project(&project_path);
        assert_eq!(after.status, RecordingHealthStatus::Healthy);
        assert!(
            after
                .repairs
                .iter()
                .any(|attempt| attempt.status == RecordingRepairStatus::Performed)
        );
    }
}
