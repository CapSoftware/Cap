use cap_project::StudioRecordingMeta;
use cap_recording::recovery::{RecoveryError, RecoveryManager};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::create_screenshot;

const RECOVERY_CUTOFF_DATE: (i32, u32, u32) = (2025, 12, 31);

pub(crate) fn finalization_storage_error(path: &Path) -> String {
    format!(
        "Not enough space to finish this recording. Your recording files have been kept at {}. Free up space, then click Recover Recording.",
        path.display()
    )
}

fn ensure_finalization_storage_with(
    path: &Path,
    inspect: impl FnOnce(&Path) -> std::io::Result<cap_utils::disk_space::RecordingStorage>,
) -> Result<(), String> {
    let storage = inspect(path)
        .map_err(|error| format!("Could not check available space for this recording: {error}"))?;
    if !storage.can_finalize() {
        return Err(finalization_storage_error(path));
    }
    Ok(())
}

pub(crate) fn ensure_finalization_storage(
    work_path: &Path,
    display_path: &Path,
) -> Result<(), String> {
    ensure_finalization_storage_with(display_path, |_| {
        cap_utils::disk_space::recording_storage(work_path)
    })
}

fn is_storage_full_remux_error(error: &cap_enc_ffmpeg::remux::RemuxError) -> bool {
    match error {
        cap_enc_ffmpeg::remux::RemuxError::Io(error) => {
            error.kind() == std::io::ErrorKind::StorageFull
        }
        cap_enc_ffmpeg::remux::RemuxError::Ffmpeg(ffmpeg::Error::Other { errno }) => {
            *errno == ffmpeg::error::ENOSPC
        }
        _ => false,
    }
}

pub(crate) fn is_storage_full_recovery_error(error: &RecoveryError) -> bool {
    match error {
        RecoveryError::Io(error) => error.kind() == std::io::ErrorKind::StorageFull,
        RecoveryError::VideoConcat(error)
        | RecoveryError::AudioConcat(error)
        | RecoveryError::MediaMerge(error) => is_storage_full_remux_error(error),
        _ => false,
    }
}

fn recovery_error_message(path: &Path, error: RecoveryError) -> String {
    let storage_full = is_storage_full_recovery_error(&error);
    tracing::error!(project_path = %path.display(), error = %error, "Recording recovery failed");
    if storage_full {
        finalization_storage_error(path)
    } else {
        error.to_string()
    }
}

fn parse_recording_date(pretty_name: &str) -> Option<NaiveDate> {
    let date_part = pretty_name.strip_prefix("Cap ")?;
    let date_str = date_part.split(" at ").next()?;
    NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()
}

fn is_recording_after_cutoff(pretty_name: &str) -> bool {
    let Some(recording_date) = parse_recording_date(pretty_name) else {
        return false;
    };
    let cutoff = NaiveDate::from_ymd_opt(
        RECOVERY_CUTOFF_DATE.0,
        RECOVERY_CUTOFF_DATE.1,
        RECOVERY_CUTOFF_DATE.2,
    )
    .expect("Invalid cutoff date");
    recording_date > cutoff
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IncompleteRecordingInfo {
    pub project_path: String,
    pub pretty_name: String,
    pub segment_count: u32,
    pub estimated_duration_secs: f64,
    pub total_bytes: f64,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ProjectDiskUsage {
    file_count: u64,
    total_bytes: u64,
    unreadable_entries: u64,
}

fn project_disk_usage(project_path: &Path) -> ProjectDiskUsage {
    let mut usage = ProjectDiskUsage::default();
    let mut pending = vec![project_path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            usage.unreadable_entries += 1;
            continue;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                usage.unreadable_entries += 1;
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                usage.unreadable_entries += 1;
                continue;
            };
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                usage.file_count += 1;
                usage.total_bytes += metadata.len();
            }
        }
    }
    usage
}

async fn is_recording_active_or_pending(app: &AppHandle) -> bool {
    app.state::<crate::ArcLock<crate::App>>()
        .read()
        .await
        .is_recording_active_or_pending()
}

#[tauri::command]
#[specta::specta]
pub async fn find_incomplete_recordings(
    app: AppHandle,
) -> Result<Vec<IncompleteRecordingInfo>, String> {
    if is_recording_active_or_pending(&app).await {
        return Ok(Vec::new());
    }

    let recordings_dirs = crate::recordings_locations::known_recordings_dirs(&app);

    let result = tokio::task::spawn_blocking(move || {
        let incomplete_list = recordings_dirs
            .iter()
            .flat_map(|dir| RecoveryManager::find_incomplete(dir));

        incomplete_list
            .into_iter()
            .filter(|recording| is_recording_after_cutoff(&recording.meta.pretty_name))
            .map(|recording| IncompleteRecordingInfo {
                project_path: recording.project_path.to_string_lossy().to_string(),
                pretty_name: recording.meta.pretty_name.clone(),
                segment_count: recording.recoverable_segments.len() as u32,
                estimated_duration_secs: recording.estimated_duration.as_secs_f64(),
                total_bytes: project_disk_usage(&recording.project_path).total_bytes as f64,
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("Recovery scan task failed: {e}"))?;

    Ok(result)
}

#[tauri::command]
pub async fn get_recording_recovery_success(
    app: AppHandle,
    project_path: String,
) -> Result<Option<String>, String> {
    app.state::<crate::FinalizingRecordings>()
        .recovery_success(Path::new(&project_path))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn recover_recording(app: AppHandle, project_path: String) -> Result<String, String> {
    let project = crate::FinalizationProject::admit(PathBuf::from(&project_path)).await?;
    let token = app
        .state::<crate::FinalizingRecordings>()
        .start_recovering(project)?;
    let recover_start = std::time::Instant::now();
    let app_for_recovery = app.clone();
    let result = crate::run_finalization_worker(token, move |project| {
        let path = project.work_path();
        ensure_finalization_storage(path, project.display_path())?;
        let recording = RecoveryManager::inspect_recording(path)
            .ok_or_else(|| "No recoverable segments found".to_string())?;
        if recording.recoverable_segments.is_empty() {
            return Err("No recoverable segments found".to_string());
        }
        let estimated_duration_secs = recording.estimated_duration.as_secs();
        let recovered = RecoveryManager::recover(&recording)
            .map_err(|error| recovery_error_message(project.display_path(), error))?;
        project.validate()?;
        let validation_took_ms = recover_start.elapsed().as_millis() as u64;

        let segment_count = match &recovered.meta {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        };

        info!(
            "Recovered recording with {} segments: {}",
            segment_count, project_path
        );

        crate::telemetry::async_capture_event(
            &app_for_recovery,
            crate::telemetry::AnalyticsEvent::RecordingRecovered {
                trigger: "app_startup",
                recovered_duration_secs: estimated_duration_secs,
                segments_recovered: segment_count as u32,
                validation_took_ms,
            },
        );

        let display_output_path = match &recovered.meta {
            StudioRecordingMeta::SingleSegment { segment } => {
                segment.display.path.to_path(&recovered.project_path)
            }
            StudioRecordingMeta::MultipleSegments { inner, .. } => inner.segments[0]
                .display
                .path
                .to_path(&recovered.project_path),
        };

        let screenshots_dir = recovered.project_path.join("screenshots");
        match std::fs::create_dir_all(&screenshots_dir) {
            Ok(()) => {
                let display_screenshot = screenshots_dir.join("display.jpg");
                tokio::spawn(async move {
                    if let Err(e) = create_screenshot(display_output_path, display_screenshot, None).await {
                        tracing::error!("Failed to create screenshot during recovery: {}", e);
                    }
                });
            }
            Err(error) => {
                tracing::warn!(project_path = %project_path, error = %error, "Failed to create recovery screenshots directory");
            }
        }

        if let Err(error) = app_for_recovery.emit("recording-recovery-completed", &project_path) {
            tracing::warn!(project_path = %project_path, error = %error, "Failed to notify editors of completed recording recovery");
        }

        Ok(project_path)
    })
    .await;
    if let Err(reason) = &result {
        crate::telemetry::async_capture_event(
            &app,
            crate::telemetry::AnalyticsEvent::RecordingRecoveryFailed {
                trigger: "app_startup",
                reason: reason.clone(),
            },
        );
    }
    result
}

#[tauri::command]
#[specta::specta]
pub async fn discard_incomplete_recording(
    app: AppHandle,
    project_path: String,
) -> Result<(), String> {
    if is_recording_active_or_pending(&app).await {
        return Err("Finish the current recording before discarding another one.".to_string());
    }

    let recordings_dirs = crate::recordings_locations::known_recordings_dirs(&app);
    let target = discard_target(&recordings_dirs, Path::new(&project_path))?;

    let project = crate::FinalizationProject::observe(target.clone()).await?;
    let finalizing = app.state::<crate::FinalizingRecordings>();
    let recovering = finalizing.is_running(&project);
    drop(project);
    if recovering {
        return Err("This recording is being recovered. Try again when it finishes.".to_string());
    }

    tokio::task::spawn_blocking(move || discard_project(&target))
        .await
        .map_err(|error| format!("Discard task failed: {error}"))?
}

fn discard_target(recordings_dirs: &[PathBuf], path: &Path) -> Result<PathBuf, String> {
    let is_link = path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink());
    let target = crate::recording_delete_target(recordings_dirs, path)?
        .ok_or_else(|| "Recording path does not exist".to_string())?;
    if is_link
        || !target.is_dir()
        || target
            .extension()
            .is_none_or(|extension| extension != "cap")
    {
        return Err("Path is not a Cap recording".to_string());
    }
    Ok(target)
}

fn discard_project(target: &Path) -> Result<(), String> {
    let ownership = crate::acquire_recording_delete_lock(target)?;
    let usage = project_disk_usage(target);
    let result = std::fs::remove_dir_all(target);
    drop(ownership);

    match result {
        Ok(()) => {
            warn!(
                project_path = %target.display(),
                file_count = usage.file_count,
                total_bytes = usage.total_bytes,
                unreadable_entries = usage.unreadable_entries,
                outcome = "permanently_deleted",
                "Discarded incomplete recording"
            );
            Ok(())
        }
        Err(error) => {
            warn!(
                project_path = %target.display(),
                file_count = usage.file_count,
                total_bytes = usage.total_bytes,
                unreadable_entries = usage.unreadable_entries,
                outcome = "failed",
                %error,
                "Discarded incomplete recording"
            );
            Err(format!("Failed to discard recording: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_usage_counts_nested_and_hidden_files() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Recording.cap");
        let segment = project.join("content/segments/segment-0");
        std::fs::create_dir_all(&segment).unwrap();
        std::fs::write(project.join("recording-meta.json"), [0u8; 10]).unwrap();
        std::fs::write(project.join(".recovery.lock"), b"").unwrap();
        std::fs::write(segment.join("display.m4s"), [0u8; 100]).unwrap();

        assert_eq!(
            project_disk_usage(&project),
            ProjectDiskUsage {
                file_count: 3,
                total_bytes: 110,
                unreadable_entries: 0,
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn disk_usage_does_not_follow_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("large.bin"), [0u8; 1000]).unwrap();
        let project = root.path().join("Recording.cap");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("recording-meta.json"), [0u8; 10]).unwrap();
        std::os::unix::fs::symlink(&outside, project.join("linked")).unwrap();

        assert_eq!(
            project_disk_usage(&project),
            ProjectDiskUsage {
                file_count: 1,
                total_bytes: 10,
                unreadable_entries: 0,
            }
        );
    }

    #[test]
    fn discard_target_rejects_paths_outside_recordings() {
        let root = tempfile::tempdir().unwrap();
        let dirs = [root.path().join("recordings")];
        let elsewhere = root.path().join("elsewhere/Recording.cap");
        std::fs::create_dir_all(&dirs[0]).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();

        assert!(discard_target(&dirs, &elsewhere).is_err());
        assert!(discard_target(&dirs, &dirs[0]).is_err());
    }

    #[test]
    fn discard_target_requires_a_cap_directory() {
        let root = tempfile::tempdir().unwrap();
        let dirs = [root.path().join("recordings")];
        let not_a_project = dirs[0].join("Downloads");
        let project = dirs[0].join("Recording.cap");
        std::fs::create_dir_all(&not_a_project).unwrap();
        std::fs::create_dir_all(&project).unwrap();

        assert!(discard_target(&dirs, &not_a_project).is_err());
        assert_eq!(
            discard_target(&dirs, &project),
            Ok(project.canonicalize().unwrap())
        );
    }

    #[test]
    fn discard_project_removes_the_project() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Recording.cap");
        std::fs::create_dir_all(project.join("content")).unwrap();
        std::fs::write(project.join("content/output.mp4"), [0u8; 10]).unwrap();

        assert_eq!(discard_project(&project), Ok(()));
        assert!(!project.exists());
    }
}
