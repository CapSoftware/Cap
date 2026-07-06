//! Session profiling: bundles a user's latest Studio and Instant recordings
//! together with full system diagnostics and logs, uploads the bundle to S3 and
//! posts the download link to the Cap feedback Discord channel. This gives the
//! team everything required to reproduce and debug a user's session.

use std::{
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use cap_project::{RecordingMeta, RecordingMetaInner};
use cap_recording::RecordingMode;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio_util::io::ReaderStream;
use tracing::{info, instrument, warn};
use walkdir::WalkDir;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{
    auth::{AuthSecret, AuthStore},
    http_client::RetryableHttpClient,
    logging,
    web_api::ManagerExt,
};

const STUDIO_DIR: &str = "studio";
const INSTANT_DIR: &str = "instant";
const ZIP_LARGE_FILE_THRESHOLD: u64 = u32::MAX as u64;
const ZIP_COPY_BUFFER_SIZE: usize = 1024 * 1024;
/// Upper bound on the combined size of the recordings we will bundle. Keeps us
/// from filling the user's temp disk and attempting a multi-GB upload.
const MAX_SESSION_PROFILE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const GIB: u64 = 1024 * 1024 * 1024;
/// Mirrors the `note` length limit enforced by the web notify endpoint so an
/// over-long note can't fail the request after the bundle is already uploaded.
const MAX_NOTE_LENGTH: usize = 4000;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfileRecording {
    pub mode: RecordingMode,
    pub pretty_name: String,
    #[specta(type = String)]
    pub path: PathBuf,
    pub modified_at: Option<f64>,
    pub size_bytes: f64,
}

#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfileStatus {
    pub studio: Option<SessionProfileRecording>,
    pub instant: Option<SessionProfileRecording>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfileUploadResult {
    pub uploaded: bool,
    pub download_url: Option<String>,
    pub discord_delivered: bool,
    pub included_modes: Vec<RecordingMode>,
    pub bundle_size_bytes: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionProfileStage {
    Collecting,
    Compressing,
    Uploading,
    Notifying,
    Done,
}

#[derive(Clone, Serialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfileProgress {
    pub stage: SessionProfileStage,
    pub progress: f64,
    pub message: String,
}

struct RecordingCandidate {
    mode: RecordingMode,
    path: PathBuf,
    pretty_name: String,
    modified: SystemTime,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSummaryRecording {
    mode: RecordingMode,
    pretty_name: String,
    bundle_path: String,
    source_path: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSummary {
    generated_at: String,
    app_version: String,
    os: String,
    arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    recordings: Vec<ProfileSummaryRecording>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateUploadRequest {
    file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUploadResponse {
    id: String,
    key: String,
    upload_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyRecording {
    mode: RecordingMode,
    pretty_name: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyRequest {
    id: String,
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    os: String,
    version: String,
    size_bytes: u64,
    recordings: Vec<NotifyRecording>,
    diagnostics_summary: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotifyResponse {
    #[allow(dead_code)]
    success: bool,
    download_url: Option<String>,
    #[serde(default)]
    discord_delivered: bool,
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_file(&self.0)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            warn!(error = %err, path = %self.0.display(), "Failed to clean up session profile bundle");
        }
    }
}

fn directory_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn system_time_to_millis(time: SystemTime) -> Option<f64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as f64)
}

fn candidate_to_recording(candidate: RecordingCandidate) -> SessionProfileRecording {
    SessionProfileRecording {
        mode: candidate.mode,
        pretty_name: candidate.pretty_name,
        modified_at: system_time_to_millis(candidate.modified),
        size_bytes: directory_size(&candidate.path) as f64,
        path: candidate.path,
    }
}

/// Scans the recordings directory and returns the most-recently-modified Studio
/// and Instant recordings, if any exist.
pub fn find_latest_recordings(recordings_dir: &Path) -> SessionProfileStatus {
    let mut studio: Option<RecordingCandidate> = None;
    let mut instant: Option<RecordingCandidate> = None;

    let Ok(entries) = std::fs::read_dir(recordings_dir) else {
        return SessionProfileStatus::default();
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Ok(meta) = RecordingMeta::load_for_project(&path) else {
            continue;
        };

        let mode = match meta.inner {
            RecordingMetaInner::Studio(_) => RecordingMode::Studio,
            RecordingMetaInner::Instant(_) => RecordingMode::Instant,
        };

        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH);

        let slot = match mode {
            RecordingMode::Studio => &mut studio,
            RecordingMode::Instant => &mut instant,
            RecordingMode::Screenshot => continue,
        };

        let is_newer = slot
            .as_ref()
            .map(|existing| modified > existing.modified)
            .unwrap_or(true);

        if is_newer {
            *slot = Some(RecordingCandidate {
                mode,
                path,
                pretty_name: meta.pretty_name,
                modified,
            });
        }
    }

    SessionProfileStatus {
        studio: studio.map(candidate_to_recording),
        instant: instant.map(candidate_to_recording),
    }
}

fn zip_compression_method(path: &Path) -> CompressionMethod {
    const STORED_EXTENSIONS: &[&str] = &[
        "mp4", "mov", "m4a", "m4s", "mp3", "aac", "ogg", "opus", "wav", "webm", "mkv", "flac",
        "jpg", "jpeg", "png", "gif", "webp", "heic", "zip", "gz",
    ];

    let is_stored = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| STORED_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false);

    if is_stored {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    }
}

fn relative_zip_path(relative: &Path) -> String {
    relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str().map(ToString::to_string),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn write_zip_text<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    contents: &str,
) -> Result<(), String> {
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(name, options)
        .map_err(|err| format!("Failed to start zip entry {name}: {err}"))?;
    zip.write_all(contents.as_bytes())
        .map_err(|err| format!("Failed to write zip entry {name}: {err}"))?;
    Ok(())
}

fn stream_file_into_zip<W: Write + Seek, P: FnMut(u64, u64)>(
    zip: &mut ZipWriter<W>,
    source: &Path,
    done: &mut u64,
    total: u64,
    progress: &mut P,
) -> Result<(), String> {
    let mut file =
        std::fs::File::open(source).map_err(|err| format!("Failed to open {source:?}: {err}"))?;
    let mut buffer = vec![0u8; ZIP_COPY_BUFFER_SIZE];

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("Failed to read {source:?}: {err}"))?;
        if read == 0 {
            break;
        }
        zip.write_all(&buffer[..read])
            .map_err(|err| format!("Failed to write {source:?} into bundle: {err}"))?;
        *done = done.saturating_add(read as u64);
        progress(*done, total);
    }

    Ok(())
}

/// Builds the zip bundle containing every supplied recording directory along
/// with the diagnostics, profile summary and latest log file. Returns the final
/// bundle size in bytes.
pub fn build_profile_zip(
    output_path: &Path,
    recordings: &[SessionProfileRecording],
    diagnostics_json: &str,
    profile_json: &str,
    log_file: Option<&Path>,
    mut progress: impl FnMut(u64, u64),
) -> Result<u64, String> {
    let log_size = log_file
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let total: u64 = recordings
        .iter()
        .map(|recording| recording.size_bytes as u64)
        .sum::<u64>()
        + log_size
        + diagnostics_json.len() as u64
        + profile_json.len() as u64;

    let mut done: u64 = 0;

    let file = std::fs::File::create(output_path)
        .map_err(|err| format!("Failed to create bundle file: {err}"))?;
    let mut zip = ZipWriter::new(file);

    write_zip_text(&mut zip, "profile.json", profile_json)?;
    done = done.saturating_add(profile_json.len() as u64);
    progress(done, total);

    write_zip_text(&mut zip, "diagnostics.json", diagnostics_json)?;
    done = done.saturating_add(diagnostics_json.len() as u64);
    progress(done, total);

    if let Some(log) = log_file
        && log.exists()
    {
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("cap-desktop.log", options)
            .map_err(|err| format!("Failed to start log zip entry: {err}"))?;
        stream_file_into_zip(&mut zip, log, &mut done, total, &mut progress)?;
    }

    for recording in recordings {
        let mode_dir = match recording.mode {
            RecordingMode::Studio => STUDIO_DIR,
            RecordingMode::Instant => INSTANT_DIR,
            RecordingMode::Screenshot => continue,
        };

        let root = recording.path.as_path();
        let base_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("recording");

        for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }

            let file_path = entry.path();
            let relative = file_path.strip_prefix(root).unwrap_or(file_path);
            let relative_unix = relative_zip_path(relative);
            if relative_unix.is_empty() {
                continue;
            }

            let name = format!("{mode_dir}/{base_name}/{relative_unix}");
            let file_size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            let options = SimpleFileOptions::default()
                .compression_method(zip_compression_method(file_path))
                .large_file(file_size >= ZIP_LARGE_FILE_THRESHOLD);

            zip.start_file(name.clone(), options)
                .map_err(|err| format!("Failed to start zip entry {name}: {err}"))?;
            stream_file_into_zip(&mut zip, file_path, &mut done, total, &mut progress)?;
        }
    }

    let mut finished = zip
        .finish()
        .map_err(|err| format!("Failed to finalize bundle: {err}"))?;
    finished
        .flush()
        .map_err(|err| format!("Failed to flush bundle: {err}"))?;

    let size = std::fs::metadata(output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    progress(total, total);

    Ok(size)
}

async fn request_upload_target(
    client: &Client,
    base_url: &str,
    bearer: &str,
    file_name: &str,
) -> Result<CreateUploadResponse, String> {
    let url = format!("{base_url}/api/desktop/session-profile/create");
    let request = crate::web_api::apply_env_headers(client.post(&url).bearer_auth(bearer).json(
        &CreateUploadRequest {
            file_name: file_name.to_string(),
        },
    ));

    let response = request
        .send()
        .await
        .map_err(|err| format!("Failed to request upload URL: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Upload URL request failed ({status}): {body}"));
    }

    response
        .json::<CreateUploadResponse>()
        .await
        .map_err(|err| format!("Failed to parse upload URL response: {err}"))
}

async fn upload_file_streaming<F>(
    client: &Client,
    url: &str,
    path: &Path,
    on_progress: F,
) -> Result<(), String>
where
    F: Fn(u64, u64) + Send + 'static,
{
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|err| format!("Failed to open bundle for upload: {err}"))?;
    let total = file
        .metadata()
        .await
        .map_err(|err| format!("Failed to read bundle metadata: {err}"))?
        .len();

    let body_stream = async_stream::stream! {
        let mut reader = ReaderStream::new(file);
        let mut sent: u64 = 0;
        while let Some(chunk) = reader.next().await {
            match chunk {
                Ok(bytes) => {
                    sent = sent.saturating_add(bytes.len() as u64);
                    on_progress(sent, total);
                    yield Ok::<bytes::Bytes, std::io::Error>(bytes);
                }
                Err(err) => yield Err(err),
            }
        }
    };

    let response = client
        .put(url)
        .header("Content-Length", total)
        .body(reqwest::Body::wrap_stream(body_stream))
        .send()
        .await
        .map_err(|err| format!("Failed to upload bundle: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Bundle upload failed ({status}): {body}"));
    }

    Ok(())
}

async fn send_notify(
    client: &Client,
    base_url: &str,
    bearer: &str,
    payload: &NotifyRequest,
) -> Result<NotifyResponse, String> {
    let url = format!("{base_url}/api/desktop/session-profile/notify");
    let request =
        crate::web_api::apply_env_headers(client.post(&url).bearer_auth(bearer).json(payload));

    let response = request
        .send()
        .await
        .map_err(|err| format!("Failed to notify session profile: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Session profile notify failed ({status}): {body}"));
    }

    response
        .json::<NotifyResponse>()
        .await
        .map_err(|err| format!("Failed to parse notify response: {err}"))
}

fn auth_bearer_token(app: &AppHandle) -> Result<String, String> {
    let auth = AuthStore::get(app)
        .map_err(|err| format!("Failed to read auth store: {err}"))?
        .ok_or("You must be signed in to send a session profile.")?;

    Ok(match auth.secret {
        AuthSecret::ApiKey { api_key } => api_key,
        AuthSecret::Session { token, .. } => token,
    })
}

fn emit_progress(app: &AppHandle, stage: SessionProfileStage, progress: f64, message: &str) {
    let _ = SessionProfileProgress {
        stage,
        progress: progress.clamp(0.0, 1.0),
        message: message.to_string(),
    }
    .emit(app);
}

fn build_profile_summary(
    recordings: &[SessionProfileRecording],
    note: Option<&str>,
) -> ProfileSummary {
    ProfileSummary {
        generated_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        note: note.map(ToString::to_string),
        recordings: recordings
            .iter()
            .map(|recording| {
                let mode_dir = match recording.mode {
                    RecordingMode::Studio => STUDIO_DIR,
                    RecordingMode::Instant | RecordingMode::Screenshot => INSTANT_DIR,
                };
                let base_name = recording
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("recording");
                ProfileSummaryRecording {
                    mode: recording.mode,
                    pretty_name: recording.pretty_name.clone(),
                    bundle_path: format!("{mode_dir}/{base_name}"),
                    source_path: recording.path.display().to_string(),
                    size_bytes: recording.size_bytes as u64,
                }
            })
            .collect(),
    }
}

async fn run_upload(
    app: &AppHandle,
    note: Option<String>,
) -> Result<SessionProfileUploadResult, String> {
    emit_progress(
        app,
        SessionProfileStage::Collecting,
        0.0,
        "Collecting recordings…",
    );

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?;
    let recordings_dir = app_data_dir.join("recordings");

    let status = find_latest_recordings(&recordings_dir);
    let mut recordings: Vec<SessionProfileRecording> = Vec::new();
    if let Some(studio) = status.studio {
        recordings.push(studio);
    }
    if let Some(instant) = status.instant {
        recordings.push(instant);
    }

    if recordings.is_empty() {
        return Err("No Studio or Instant recordings found to profile.".to_string());
    }

    let total_source_bytes: u64 = recordings
        .iter()
        .map(|recording| recording.size_bytes as u64)
        .sum();
    if total_source_bytes > MAX_SESSION_PROFILE_BYTES {
        return Err(format!(
            "These recordings are too large to share automatically ({:.1} GB). The session profile limit is {} GB \u{2014} please share a shorter recording or send the files to us directly.",
            total_source_bytes as f64 / GIB as f64,
            MAX_SESSION_PROFILE_BYTES / GIB
        ));
    }

    let is_recording = {
        let app_lock = app.state::<crate::ArcLock<crate::App>>();
        let state = app_lock.read().await;
        matches!(
            state.recording_state,
            crate::RecordingState::Active(_) | crate::RecordingState::Pending { .. }
        )
    };

    let diagnostics =
        logging::collect_diagnostics_for_upload(&recordings_dir, &app_data_dir, is_recording);
    let diagnostics_json =
        serde_json::to_string_pretty(&diagnostics).unwrap_or_else(|_| "{}".to_string());
    let diagnostics_summary = logging::summarize_diagnostics(&diagnostics);

    let profile_summary = build_profile_summary(&recordings, note.as_deref());
    let profile_json =
        serde_json::to_string_pretty(&profile_summary).unwrap_or_else(|_| "{}".to_string());

    let log_file = logging::get_latest_log_file(app).await;

    let file_name = format!(
        "cap-session-profile-{}.zip",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let zip_path = std::env::temp_dir().join(format!("{}-{file_name}", uuid::Uuid::new_v4()));
    let bundle_guard = TempFileGuard(zip_path.clone());

    emit_progress(
        app,
        SessionProfileStage::Compressing,
        0.0,
        "Compressing recordings…",
    );

    let bundle_size = {
        let app_progress = app.clone();
        let zip_path = zip_path.clone();
        let recordings = recordings.clone();
        let diagnostics_json = diagnostics_json.clone();
        let profile_json = profile_json.clone();
        let log_file = log_file.clone();

        tokio::task::spawn_blocking(move || {
            let mut last_pct: i64 = -1;
            build_profile_zip(
                &zip_path,
                &recordings,
                &diagnostics_json,
                &profile_json,
                log_file.as_deref(),
                |done, total| {
                    let pct = if total > 0 {
                        ((done.saturating_mul(100)) / total) as i64
                    } else {
                        100
                    };
                    if pct != last_pct {
                        last_pct = pct;
                        emit_progress(
                            &app_progress,
                            SessionProfileStage::Compressing,
                            pct as f64 / 100.0,
                            "Compressing recordings…",
                        );
                    }
                },
            )
        })
        .await
        .map_err(|err| format!("Bundle task failed: {err}"))??
    };

    let client = app
        .state::<RetryableHttpClient>()
        .as_ref()
        .map_err(|err| format!("HTTP client unavailable: {err:?}"))?
        .clone();
    let base_url = app.make_app_url("").await;
    let bearer = auth_bearer_token(app)?;

    emit_progress(
        app,
        SessionProfileStage::Uploading,
        0.0,
        "Uploading bundle…",
    );

    let upload_target = request_upload_target(&client, &base_url, &bearer, &file_name).await?;

    {
        let app_progress = app.clone();
        let last = Arc::new(AtomicI64::new(-1));
        upload_file_streaming(
            &client,
            &upload_target.upload_url,
            &zip_path,
            move |sent, total| {
                let pct = if total > 0 {
                    ((sent.saturating_mul(100)) / total) as i64
                } else {
                    100
                };
                if last.swap(pct, Ordering::Relaxed) != pct {
                    emit_progress(
                        &app_progress,
                        SessionProfileStage::Uploading,
                        pct as f64 / 100.0,
                        "Uploading bundle…",
                    );
                }
            },
        )
        .await?;
    }

    emit_progress(
        app,
        SessionProfileStage::Notifying,
        0.9,
        "Notifying the Cap team…",
    );

    let included_modes: Vec<RecordingMode> =
        recordings.iter().map(|recording| recording.mode).collect();

    let notify_request = NotifyRequest {
        id: upload_target.id,
        key: upload_target.key,
        note,
        os: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        size_bytes: bundle_size,
        recordings: recordings
            .iter()
            .map(|recording| NotifyRecording {
                mode: recording.mode,
                pretty_name: recording.pretty_name.clone(),
                size_bytes: recording.size_bytes as u64,
            })
            .collect(),
        diagnostics_summary,
    };

    let notify = send_notify(&client, &base_url, &bearer, &notify_request).await?;

    drop(bundle_guard);

    emit_progress(app, SessionProfileStage::Done, 1.0, "Session profile sent!");

    info!(
        modes = ?included_modes,
        bundle_size,
        "Session profile uploaded"
    );

    Ok(SessionProfileUploadResult {
        uploaded: true,
        download_url: notify.download_url,
        discord_delivered: notify.discord_delivered,
        included_modes,
        bundle_size_bytes: bundle_size as f64,
    })
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn get_session_profile_status(app: AppHandle) -> Result<SessionProfileStatus, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?;
    let recordings_dir = app_data_dir.join("recordings");
    Ok(find_latest_recordings(&recordings_dir))
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn upload_session_profile(
    app: AppHandle,
    note: Option<String>,
) -> Result<SessionProfileUploadResult, String> {
    let note = note.and_then(|value| {
        let trimmed: String = value.trim().chars().take(MAX_NOTE_LENGTH).collect();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    run_upload(&app, note).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn make_studio_recording(dir: &Path, name: &str, display_bytes: &[u8]) {
        write_file(
            &dir.join("recording-meta.json"),
            format!(
                "{{ \"pretty_name\": \"{name}\", \"display\": {{ \"path\": \"content/display.mp4\" }} }}"
            )
            .as_bytes(),
        );
        write_file(&dir.join("content/display.mp4"), display_bytes);
    }

    fn make_instant_recording(dir: &Path, name: &str, output_bytes: &[u8]) {
        write_file(
            &dir.join("recording-meta.json"),
            format!("{{ \"pretty_name\": \"{name}\", \"fps\": 30 }}").as_bytes(),
        );
        write_file(&dir.join("content/output.mp4"), output_bytes);
    }

    #[test]
    fn zip_method_selects_store_for_media() {
        assert_eq!(
            zip_compression_method(Path::new("content/display.mp4")),
            CompressionMethod::Stored
        );
        assert_eq!(
            zip_compression_method(Path::new("recording-meta.json")),
            CompressionMethod::Deflated
        );
        assert_eq!(
            zip_compression_method(Path::new("a/b/IMAGE.PNG")),
            CompressionMethod::Stored
        );
    }

    #[test]
    fn finds_latest_recordings_per_mode() {
        let temp = tempfile::tempdir().unwrap();
        let recordings_dir = temp.path();

        make_studio_recording(
            &recordings_dir.join("studio-old"),
            "Studio Old",
            b"old-video",
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        make_studio_recording(
            &recordings_dir.join("studio-new"),
            "Studio New",
            b"new-video-data",
        );
        make_instant_recording(
            &recordings_dir.join("instant-one"),
            "Instant One",
            b"instant-video",
        );

        let status = find_latest_recordings(recordings_dir);

        let studio = status.studio.expect("studio recording should be found");
        assert_eq!(studio.mode, RecordingMode::Studio);
        assert_eq!(studio.pretty_name, "Studio New");
        assert!(studio.size_bytes > 0.0);

        let instant = status.instant.expect("instant recording should be found");
        assert_eq!(instant.mode, RecordingMode::Instant);
        assert_eq!(instant.pretty_name, "Instant One");
    }

    #[test]
    fn returns_empty_status_when_no_recordings() {
        let temp = tempfile::tempdir().unwrap();
        let status = find_latest_recordings(temp.path());
        assert!(status.studio.is_none());
        assert!(status.instant.is_none());
    }

    #[test]
    fn builds_bundle_with_all_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let recordings_dir = temp.path().join("recordings");
        make_studio_recording(
            &recordings_dir.join("studio-1"),
            "Studio One",
            b"studio-video",
        );
        make_instant_recording(
            &recordings_dir.join("instant-1"),
            "Instant One",
            b"instant-video",
        );

        let status = find_latest_recordings(&recordings_dir);
        let recordings: Vec<SessionProfileRecording> = [status.studio, status.instant]
            .into_iter()
            .flatten()
            .collect();
        assert_eq!(recordings.len(), 2);

        let log_path = temp.path().join("cap-desktop.log");
        std::fs::write(&log_path, b"line one\nline two\n").unwrap();

        let zip_path = temp.path().join("bundle.zip");
        let size = build_profile_zip(
            &zip_path,
            &recordings,
            "{\"diagnostics\":true}",
            "{\"profile\":true}",
            Some(&log_path),
            |_, _| {},
        )
        .unwrap();
        assert!(size > 0);

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = archive.file_names().map(ToString::to_string).collect();

        assert!(names.contains(&"profile.json".to_string()));
        assert!(names.contains(&"diagnostics.json".to_string()));
        assert!(names.contains(&"cap-desktop.log".to_string()));
        assert!(
            names
                .iter()
                .any(|name| name == "studio/studio-1/content/display.mp4")
        );
        assert!(
            names
                .iter()
                .any(|name| name == "instant/instant-1/content/output.mp4")
        );

        let mut diagnostics = String::new();
        archive
            .by_name("diagnostics.json")
            .unwrap()
            .read_to_string(&mut diagnostics)
            .unwrap();
        assert_eq!(diagnostics, "{\"diagnostics\":true}");
    }

    #[tokio::test]
    async fn upload_and_notify_round_trip() {
        use std::sync::Mutex as StdMutex;

        let temp = tempfile::tempdir().unwrap();
        let bundle_path = temp.path().join("bundle.zip");
        let bundle_bytes = b"this-is-the-bundle-contents".to_vec();
        std::fs::write(&bundle_path, &bundle_bytes).unwrap();

        let received_put = Arc::new(StdMutex::new(Vec::<u8>::new()));
        let received_notify = Arc::new(StdMutex::new(String::new()));
        let created_with = Arc::new(StdMutex::new(String::new()));

        let put_state = received_put.clone();
        let notify_state = received_notify.clone();
        let create_state = created_with.clone();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base_url = format!("http://{addr}");
        let put_url = format!("{base_url}/s3-put/object.zip");
        let put_url_for_create = put_url.clone();

        let router = axum::Router::new()
            .route(
                "/api/desktop/session-profile/create",
                axum::routing::post({
                    let put_url = put_url_for_create.clone();
                    move |body: String| {
                        let create_state = create_state.clone();
                        let put_url = put_url.clone();
                        async move {
                            *create_state.lock().unwrap() = body;
                            axum::Json(serde_json::json!({
                                "id": "profile-id",
                                "key": "desktop-session-profiles/user/profile-id/object.zip",
                                "uploadUrl": put_url,
                            }))
                        }
                    }
                }),
            )
            .route(
                "/s3-put/object.zip",
                axum::routing::put(move |body: axum::body::Bytes| {
                    let put_state = put_state.clone();
                    async move {
                        put_state.lock().unwrap().extend_from_slice(&body);
                        axum::http::StatusCode::OK
                    }
                }),
            )
            .route(
                "/api/desktop/session-profile/notify",
                axum::routing::post(move |body: String| {
                    let notify_state = notify_state.clone();
                    async move {
                        *notify_state.lock().unwrap() = body;
                        axum::Json(serde_json::json!({
                            "success": true,
                            "downloadUrl": "https://example.com/download",
                            "discordDelivered": true,
                        }))
                    }
                }),
            );

        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        let client = reqwest::Client::new();

        let create = request_upload_target(&client, &base_url, "test-token", "bundle.zip")
            .await
            .unwrap();
        assert_eq!(create.id, "profile-id");
        assert_eq!(create.upload_url, put_url);
        assert!(
            created_with
                .lock()
                .unwrap()
                .contains("\"fileName\":\"bundle.zip\"")
        );

        upload_file_streaming(&client, &create.upload_url, &bundle_path, |_, _| {})
            .await
            .unwrap();
        assert_eq!(*received_put.lock().unwrap(), bundle_bytes);

        let notify_request = NotifyRequest {
            id: create.id,
            key: create.key,
            note: Some("it crashed".to_string()),
            os: "linux".to_string(),
            version: "0.0.0".to_string(),
            size_bytes: bundle_bytes.len() as u64,
            recordings: vec![NotifyRecording {
                mode: RecordingMode::Studio,
                pretty_name: "Studio One".to_string(),
                size_bytes: 123,
            }],
            diagnostics_summary: "**CPU:** test".to_string(),
        };

        let notify = send_notify(&client, &base_url, "test-token", &notify_request)
            .await
            .unwrap();
        assert_eq!(
            notify.download_url.as_deref(),
            Some("https://example.com/download")
        );
        assert!(notify.discord_delivered);

        let notify_body = received_notify.lock().unwrap().clone();
        assert!(
            notify_body.contains("\"key\":\"desktop-session-profiles/user/profile-id/object.zip\"")
        );
        assert!(notify_body.contains("\"mode\":\"studio\""));
        assert!(notify_body.contains("\"note\":\"it crashed\""));

        server.abort();
    }
}
