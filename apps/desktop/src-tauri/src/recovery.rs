use cap_project::StudioRecordingMeta;
use cap_recording::recovery::RecoveryManager;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tracing::info;

use crate::create_screenshot;

const RECOVERY_CUTOFF_DATE: (i32, u32, u32) = (2025, 12, 31);

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
    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");

    if !recordings_dir.exists() {
        return Ok(Vec::new());
    }

    let incomplete_list = RecoveryManager::find_incomplete(&recordings_dir);

    let result = incomplete_list
        .into_iter()
        .filter(|recording| is_recording_after_cutoff(&recording.meta.pretty_name))
        .map(|recording| IncompleteRecordingInfo {
            project_path: recording.project_path.to_string_lossy().to_string(),
            pretty_name: recording.meta.pretty_name.clone(),
            segment_count: recording.recoverable_segments.len() as u32,
            estimated_duration_secs: recording.estimated_duration.as_secs_f64(),
        })
        .collect();

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn recover_recording(app: AppHandle, project_path: String) -> Result<String, String> {
    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");

    let path = PathBuf::from(&project_path);

    let incomplete_list = RecoveryManager::find_incomplete(&recordings_dir);

    let recording = incomplete_list
        .into_iter()
        .find(|r| r.project_path == path)
        .ok_or_else(|| "Recording not found in incomplete list".to_string())?;

    if recording.recoverable_segments.is_empty() {
        return Err("No recoverable segments found".to_string());
    }

    let recovered = RecoveryManager::recover(&recording).map_err(|e| format!("{e}"))?;

    let segment_count = match &recovered.meta {
        StudioRecordingMeta::SingleSegment { .. } => 1,
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
    };

    info!(
        "Recovered recording with {} segments: {}",
        segment_count, project_path
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
    std::fs::create_dir_all(&screenshots_dir)
        .map_err(|e| format!("Failed to create screenshots directory: {e}"))?;

    let display_screenshot = screenshots_dir.join("display.jpg");
    tokio::spawn(async move {
        if let Err(e) = create_screenshot(display_output_path, display_screenshot, None).await {
            tracing::error!("Failed to create screenshot during recovery: {}", e);
        }
    });

    Ok(project_path)
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
