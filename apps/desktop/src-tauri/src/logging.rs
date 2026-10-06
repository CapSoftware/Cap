use crate::{
    ArcLock, feeds::microphone::MicrophoneFeed, general_settings::GeneralSettingsStore,
    permissions, web_api::ManagerExt,
};
use cap_recording::diagnostics::{
    CameraDiagnostics, CameraFormatInfo, DisplayDiagnostics, HardwareInfo, MicrophoneDiagnostics,
    StorageInfo,
};
use serde::Serialize;

use tauri::{AppHandle, Manager};

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
                    pixel_format: f.pixel_format_name(),
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
            // The richer capability/heuristic fields belong to the diagnostic
            // report; the log upload keeps its existing shape.
            is_default: None,
            is_bluetooth: None,
            is_usb: None,
            is_builtin: None,
            supported_configs: None,
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
        // The diagnostic report redacts these same paths, and both fields ride
        // in one upload -- leaving this one raw defeats the redaction.
        recordings_path: cap_recording::diagnostics::redact_home_paths(
            &recordings_path.display().to_string(),
        ),
        available_space_mb: disk.available_space() / (1024 * 1024),
        total_space_mb: disk.total_space() / (1024 * 1024),
    })
}

pub(crate) fn permission_status_str(status: &permissions::OSPermissionStatus) -> &'static str {
    match status {
        permissions::OSPermissionStatus::NotNeeded => "not_needed",
        permissions::OSPermissionStatus::Empty => "not_requested",
        permissions::OSPermissionStatus::Granted => "granted",
        permissions::OSPermissionStatus::Denied => "denied",
    }
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

    LogUploadDiagnostics {
        hardware,
        system,
        displays,
        cameras,
        microphones,
        storage,
        permissions: PermissionsInfo {
            screen_recording: permission_status_str(&permissions.screen_recording).to_string(),
            camera: permission_status_str(&permissions.camera).to_string(),
            microphone: permission_status_str(&permissions.microphone).to_string(),
        },
        app_state: AppStateInfo {
            is_recording,
            recordings_dir: cap_recording::diagnostics::redact_home_paths(
                &recordings_dir.display().to_string(),
            ),
            app_data_dir: cap_recording::diagnostics::redact_home_paths(
                &app_data_dir.display().to_string(),
            ),
        },
    }
}

pub async fn upload_log_file(app: &AppHandle) -> Result<(), String> {
    upload_log_file_inner(app, None).await
}

pub(crate) async fn upload_log_file_inner(
    app: &AppHandle,
    report: Option<String>,
) -> Result<(), String> {
    let logs_dir = app
        .state::<ArcLock<crate::App>>()
        .read()
        .await
        .logs_dir
        .clone();
    let log_bundle = tokio::task::spawn_blocking(move || {
        cap_utils::log_upload::collect(&logs_dir, "cap-desktop.log")
    })
    .await
    .map_err(|_| "Log collection could not finish".to_string())?;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let recordings_dir = GeneralSettingsStore::recordings_dir(app);

    let is_recording = {
        let app_lock = app.state::<ArcLock<crate::App>>();
        let state = app_lock.read().await;
        matches!(
            state.recording_state,
            crate::RecordingState::Active(_) | crate::RecordingState::Pending { .. }
        )
    };

    let diagnostics = tokio::task::spawn_blocking(move || {
        collect_diagnostics_for_upload(&recordings_dir, &app_data_dir, is_recording)
    })
    .await
    .ok();
    let diagnostics_json = serde_json::to_string(&diagnostics).unwrap_or_else(|_| "{}".to_string());
    let context = serde_json::json!({
        "schemaVersion": 1,
        "app": {
            "flavor": "tauri",
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "binaryArchitecture": std::env::consts::ARCH,
            "debugBuild": cfg!(debug_assertions),
            "sourceRevision": option_env!("CAP_BUILD_REVISION"),
            "sourceDirty": option_env!("CAP_BUILD_DIRTY").and_then(|value| value.parse::<bool>().ok()),
        },
        "operations": cap_utils::operation_diagnostics::snapshot(),
        "logCoverage": &log_bundle,
        "environmentCollectedAt": "upload_time",
        "mediaIncluded": false,
    });

    // Everything leaving the machine goes through the redactor. Logs record
    // whole URLs on failure (reqwest's Display and Debug both append the URL),
    // and an upload failure logs a presigned S3 PUT, whose query string is a
    // live write credential for up to an hour.
    use cap_recording::log_redaction::scrub_log_text;

    let upload = cap_utils::log_upload::prepare_upload(
        log_bundle,
        context,
        Some(&diagnostics_json),
        report.as_deref(),
        scrub_log_text,
    );
    let mut form = reqwest::multipart::Form::new()
        .text("log", upload.log)
        .text("os", std::env::consts::OS)
        .text("version", env!("CARGO_PKG_VERSION"))
        .text("context", upload.context);
    if let Some(diagnostics) = upload.diagnostics {
        form = form.text("diagnostics", diagnostics);
    }
    if let Some(report) = upload.report {
        form = form.text("report", report);
    }

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
