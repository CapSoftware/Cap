use cap_project::StudioRecordingMeta;
use cap_recording::recovery::{RecoveryError, RecoveryManager};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tracing::info;

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
}

#[tauri::command]
#[specta::specta]
pub async fn find_incomplete_recordings(
    app: AppHandle,
) -> Result<Vec<IncompleteRecordingInfo>, String> {
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
pub async fn discard_incomplete_recording(project_path: String) -> Result<(), String> {
    let path = PathBuf::from(&project_path);

    if !path.exists() {
        return Err("Recording path does not exist".to_string());
    }

    std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;

    info!("Discarded incomplete recording: {}", project_path);

    Ok(())
}
