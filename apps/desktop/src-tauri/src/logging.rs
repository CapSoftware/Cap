use crate::{ArcLock, feeds::microphone::MicrophoneFeed, permissions, web_api::ManagerExt};
use cap_recording::diagnostics::{
    CameraDiagnostics, CameraFormatInfo, DisplayDiagnostics, HardwareInfo, MicrophoneDiagnostics,
    StorageInfo,
};
use serde::Serialize;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

async fn get_latest_log_file(app: &AppHandle) -> Option<PathBuf> {
    let logs_dir = app
        .state::<ArcLock<crate::App>>()
        .read()
        .await
        .logs_dir
        .clone();

    let entries = fs::read_dir(&logs_dir).ok()?;
    let mut log_files: Vec<_> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_file() && path.file_name()?.to_str()?.contains("cap-desktop.log") {
                let metadata = fs::metadata(&path).ok()?;
                let modified = metadata.modified().ok()?;
                Some((path, modified))
            } else {
                None
            }
        })
        .collect();

    log_files.sort_by(|a, b| b.1.cmp(&a.1));
    log_files.first().map(|(path, _)| path.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogUploadDiagnostics {
    hardware: HardwareInfo,
    system: cap_recording::diagnostics::SystemDiagnostics,
    displays: Vec<DisplayDiagnostics>,
    cameras: Vec<CameraDiagnostics>,
    microphones: Vec<MicrophoneDiagnostics>,
    storage: Option<StorageInfo>,
    permissions: PermissionsInfo,
    app_state: AppStateInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionsInfo {
    screen_recording: String,
    camera: String,
    microphone: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateInfo {
    is_recording: bool,
    recordings_dir: String,
    app_data_dir: String,
}

fn collect_cameras(has_permission: bool) -> Vec<CameraDiagnostics> {
    if !has_permission {
        return vec![];
    }

    cap_camera::list_cameras()
        .map(|camera| {
            let formats = camera
                .formats()
                .unwrap_or_default()
                .into_iter()
                .take(10)
                .map(|f| CameraFormatInfo {
                    width: f.width(),
                    height: f.height(),
                    frame_rate: f.frame_rate(),
                })
                .collect();

            CameraDiagnostics {
                device_id: camera.device_id().to_string(),
                display_name: camera.display_name().to_string(),
                model_id: camera.model_id().map(|m| m.to_string()),
                formats,
            }
        })
        .collect()
}

fn collect_microphones(has_permission: bool) -> Vec<MicrophoneDiagnostics> {
    if !has_permission {
        return vec![];
    }

    MicrophoneFeed::list()
        .into_iter()
        .map(|(name, (_device, config))| MicrophoneDiagnostics {
            name,
            sample_rate: config.sample_rate().0,
            channels: config.channels(),
            sample_format: format!("{:?}", config.sample_format()),
        })
        .collect()
}

fn collect_storage_info(recordings_path: &std::path::Path) -> Option<StorageInfo> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();

    let mut best_match: Option<(&sysinfo::Disk, usize)> = None;

    for disk in disks.iter() {
        if recordings_path.starts_with(disk.mount_point()) {
            let mount_point_len = disk.mount_point().as_os_str().len();
            if best_match.is_none_or(|(_, len)| mount_point_len > len) {
                best_match = Some((disk, mount_point_len));
            }
        }
    }

    best_match.map(|(disk, _)| StorageInfo {
        recordings_path: recordings_path.display().to_string(),
        available_space_mb: disk.available_space() / (1024 * 1024),
        total_space_mb: disk.total_space() / (1024 * 1024),
    })
}

fn collect_diagnostics_for_upload(
    recordings_dir: &std::path::Path,
    app_data_dir: &std::path::Path,
    is_recording: bool,
) -> LogUploadDiagnostics {
    let hardware = cap_recording::diagnostics::collect_hardware_info();
    let system = cap_recording::diagnostics::collect_diagnostics();
    let displays = cap_recording::diagnostics::collect_displays();
    let permissions = permissions::do_permissions_check(false);

    let cameras = collect_cameras(permissions.camera.permitted());
    let microphones = collect_microphones(permissions.microphone.permitted());
    let storage = collect_storage_info(recordings_dir);

    let perm_status = |p: &permissions::OSPermissionStatus| match p {
        permissions::OSPermissionStatus::NotNeeded => "not_needed",
        permissions::OSPermissionStatus::Empty => "not_requested",
        permissions::OSPermissionStatus::Granted => "granted",
        permissions::OSPermissionStatus::Denied => "denied",
    };

    LogUploadDiagnostics {
        hardware,
        system,
        displays,
        cameras,
        microphones,
        storage,
        permissions: PermissionsInfo {
            screen_recording: perm_status(&permissions.screen_recording).to_string(),
            camera: perm_status(&permissions.camera).to_string(),
            microphone: perm_status(&permissions.microphone).to_string(),
        },
        app_state: AppStateInfo {
            is_recording,
            recordings_dir: recordings_dir.display().to_string(),
            app_data_dir: app_data_dir.display().to_string(),
        },
    }
}

pub async fn upload_log_file(app: &AppHandle) -> Result<(), String> {
    let log_file = get_latest_log_file(app).await.ok_or("No log file found")?;

    let metadata =
        fs::metadata(&log_file).map_err(|e| format!("Failed to read log file metadata: {e}"))?;
    let file_size = metadata.len();

    const MAX_SIZE: u64 = 1024 * 1024;

    let log_content = if file_size > MAX_SIZE {
        let content =
            fs::read_to_string(&log_file).map_err(|e| format!("Failed to read log file: {e}"))?;

        let header = format!(
            "⚠️ Log file truncated (original size: {file_size} bytes, showing last ~1MB)\n\n"
        );
        let max_content_size = (MAX_SIZE as usize) - header.len();

        if content.len() > max_content_size {
            let start_pos = content.len() - max_content_size;
            let truncated = &content[start_pos..];
            if let Some(newline_pos) = truncated.find('\n') {
                format!("{}{}", header, &truncated[newline_pos + 1..])
            } else {
                format!("{header}{truncated}")
            }
        } else {
            content
        }
    } else {
        fs::read_to_string(&log_file).map_err(|e| format!("Failed to read log file: {e}"))?
    };

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let recordings_dir = app_data_dir.join("recordings");

    let is_recording = {
        let app_lock = app.state::<ArcLock<crate::App>>();
        let state = app_lock.read().await;
        matches!(
            state.recording_state,
            crate::RecordingState::Active(_) | crate::RecordingState::Pending { .. }
        )
    };

    let diagnostics = collect_diagnostics_for_upload(&recordings_dir, &app_data_dir, is_recording);
    let diagnostics_json = serde_json::to_string(&diagnostics).unwrap_or_else(|_| "{}".to_string());

    let form = reqwest::multipart::Form::new()
        .text("log", log_content)
        .text("os", std::env::consts::OS)
        .text("version", env!("CARGO_PKG_VERSION"))
        .text("diagnostics", diagnostics_json);

    let response = app
        .api_request("/api/desktop/logs", |client, url| {
            client.post(url).multipart(form)
        })
        .await
        .map_err(|e| format!("Failed to upload logs: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Upload failed with status: {}", response.status()));
    }

    Ok(())
}
