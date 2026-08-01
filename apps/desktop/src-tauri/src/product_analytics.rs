use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::mpsc;
use tracing::{error, warn};
use uuid::Uuid;

use crate::{
    auth::{AuthSecret, AuthStore},
    general_settings::GeneralSettingsStore,
    web_api::ManagerExt,
};

const PRODUCT_EVENT_QUEUE_CAPACITY: usize = 100;
const PRODUCT_EVENT_BATCH_SIZE: usize = 20;
const PRODUCT_EVENT_RETRY_DELAY: Duration = Duration::from_millis(500);
const PRODUCT_EVENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const PRODUCT_EVENT_SESSION_STORE_KEY: &str = "product_analytics_session_id";
const PRODUCT_EVENT_OUTBOX_STORE_KEY: &str = "product_analytics_outbox_v1";
const PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY: &str = "product_analytics_outbox_recovery_v1";
const PRODUCT_EVENT_OUTBOX_LEGACY_KEY_STORE_KEY: &str = "product_analytics_outbox_fallback_key_v1";
const PRODUCT_EVENT_OUTBOX_KEY_FILE: &str = "product-analytics-outbox-key-v1";
const PRODUCT_EVENT_OUTBOX_JOURNAL_FILE: &str = "product-analytics-outbox-journal-v1";
const PRODUCT_EVENT_OUTBOX_KEYRING_SERVICE: &str = "so.cap.desktop";
const PRODUCT_EVENT_OUTBOX_KEYRING_USER: &str = "product-analytics-outbox-v1";
const PRODUCT_EVENT_OUTBOX_LEGACY_KEYRING_USER: &str = "product-analytics-outbox-v1-backup";
const PRODUCT_EVENT_OUTBOX_CAPACITY: usize = 500;
const PRODUCT_EVENT_DEAD_LETTER_CAPACITY: usize = 100;
const PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY: usize = 100;
const PRODUCT_EVENT_MAX_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);

#[derive(Debug)]
pub enum ProductAnalyticsEvent {
    AnalyticsDeliveryLoss {
        failure_class: String,
        failed_event_name: String,
        status: Option<u16>,
        count: u64,
        first_sequence: u64,
        last_sequence: u64,
        first_failed_at_ms: i64,
        last_failed_at_ms: i64,
    },
    MultipartUploadComplete {
        duration: Duration,
        length: Duration,
        size: u64,
    },
    MultipartUploadFailed {
        duration: Duration,
        error: String,
    },
    RecordingStarted {
        mode: &'static str,
        target_kind: &'static str,
        has_camera: bool,
        has_mic: bool,
        has_system_audio: bool,
        target_fps: u32,
        target_width: u32,
        target_height: u32,
        fragmented: bool,
        custom_cursor_capture: bool,
    },
    RecordingStartFailed {
        mode: &'static str,
        error: String,
    },
    RecordingCompleted {
        mode: &'static str,
        status: &'static str,
        duration_secs: u64,
        segment_count: u32,
        track_failure_count: u32,
        error_class: Option<String>,
        video_frames_captured: u64,
        video_frames_dropped: u64,
        drop_rate_pct: f64,
        capture_stalls_count: u64,
        capture_stalls_max_ms: u64,
        mixer_stalls_count: u64,
        mixer_stalls_max_ms: u64,
        audio_gaps_count: u64,
        audio_gaps_total_ms: u64,
        frame_drop_rate_high_count: u64,
        source_restarts_count: u64,
        muxer_crash_count: u64,
        audio_degraded_count: u64,
        dropped_mic_messages: u64,
    },
    RecordingRecoveryFailed {
        trigger: &'static str,
        reason: String,
    },
}

fn truncate_reason(mut s: String) -> String {
    const MAX_LEN: usize = 240;
    if s.len() > MAX_LEN {
        let mut end = MAX_LEN;
        while !s.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        s.truncate(end);
        s.push('…');
    }
    s
}

fn classify_failure(error: &str) -> &'static str {
    let normalized = error.to_lowercase();
    if normalized.contains("timeout") || normalized.contains("timed out") {
        "timeout"
    } else if normalized.contains("permission") || normalized.contains("denied") {
        "permission"
    } else if normalized.contains("network") || normalized.contains("connect") {
        "network"
    } else if normalized.contains("disk") || normalized.contains("storage") {
        "storage"
    } else if normalized.contains("codec")
        || normalized.contains("format")
        || normalized.contains("media")
    {
        "invalid_media"
    } else {
        "unknown"
    }
}

#[derive(Clone, Debug)]
struct EventData {
    name: &'static str,
    properties: Map<String, Value>,
}

impl EventData {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            properties: Map::new(),
        }
    }

    fn set(&mut self, key: &str, value: impl Serialize) {
        match serde_json::to_value(value) {
            Ok(value) => {
                self.properties.insert(key.to_string(), value);
            }
            Err(err) => error!("Error serializing analytics property {key}: {err:?}"),
        }
    }
}

fn event_data(event: ProductAnalyticsEvent) -> EventData {
    match event {
        ProductAnalyticsEvent::AnalyticsDeliveryLoss {
            failure_class,
            failed_event_name,
            status,
            count,
            first_sequence,
            last_sequence,
            first_failed_at_ms,
            last_failed_at_ms,
        } => {
            let mut data = EventData::new("analytics_delivery_loss");
            data.set("failure_class", failure_class);
            data.set("failed_event_name", failed_event_name);
            data.set("status", status);
            data.set("count", count);
            data.set("first_sequence", first_sequence);
            data.set("last_sequence", last_sequence);
            data.set("first_failed_at_ms", first_failed_at_ms);
            data.set("last_failed_at_ms", last_failed_at_ms);
            data
        }
        ProductAnalyticsEvent::MultipartUploadComplete {
            duration,
            length,
            size,
        } => {
            let mut data = EventData::new("multipart_upload_complete");
            data.set("duration", duration.as_secs());
            data.set("length", length.as_secs());
            data.set("size", size);
            data
        }
        ProductAnalyticsEvent::MultipartUploadFailed { duration, error } => {
            let mut data = EventData::new("multipart_upload_failed");
            data.set("duration", duration.as_secs());
            data.set("failure_class", classify_failure(&error));
            data
        }
        ProductAnalyticsEvent::RecordingStarted {
            mode,
            target_kind,
            has_camera,
            has_mic,
            has_system_audio,
            target_fps,
            target_width,
            target_height,
            fragmented,
            custom_cursor_capture,
        } => {
            let mut data = EventData::new("recording_started");
            data.set("mode", mode);
            data.set("target_kind", target_kind);
            data.set("has_camera", has_camera);
            data.set("has_mic", has_mic);
            data.set("has_system_audio", has_system_audio);
            data.set("target_fps", target_fps);
            data.set("target_width", target_width);
            data.set("target_height", target_height);
            data.set("fragmented", fragmented);
            data.set("custom_cursor_capture", custom_cursor_capture);
            data
        }
        ProductAnalyticsEvent::RecordingStartFailed { mode, error } => {
            let mut data = EventData::new("recording_start_failed");
            data.set("mode", mode);
            data.set("failure_class", classify_failure(&error));
            data
        }
        ProductAnalyticsEvent::RecordingCompleted {
            mode,
            status,
            duration_secs,
            segment_count,
            track_failure_count,
            error_class,
            video_frames_captured,
            video_frames_dropped,
            drop_rate_pct,
            capture_stalls_count,
            capture_stalls_max_ms,
            mixer_stalls_count,
            mixer_stalls_max_ms,
            audio_gaps_count,
            audio_gaps_total_ms,
            frame_drop_rate_high_count,
            source_restarts_count,
            muxer_crash_count,
            audio_degraded_count,
            dropped_mic_messages,
        } => {
            let mut data = EventData::new("recording_completed");
            data.set("mode", mode);
            data.set("status", status);
            data.set("duration_secs", duration_secs);
            data.set("segment_count", segment_count);
            data.set("track_failure_count", track_failure_count);
            if let Some(ec) = error_class {
                data.set("error_class", truncate_reason(ec));
            }
            data.set("video_frames_captured", video_frames_captured);
            data.set("video_frames_dropped", video_frames_dropped);
            data.set("drop_rate_pct", (drop_rate_pct * 100.0).round() / 100.0);
            data.set("capture_stalls_count", capture_stalls_count);
            data.set("capture_stalls_max_ms", capture_stalls_max_ms);
            data.set("mixer_stalls_count", mixer_stalls_count);
            data.set("mixer_stalls_max_ms", mixer_stalls_max_ms);
            data.set("audio_gaps_count", audio_gaps_count);
            data.set("audio_gaps_total_ms", audio_gaps_total_ms);
            data.set("frame_drop_rate_high_count", frame_drop_rate_high_count);
            data.set("source_restarts_count", source_restarts_count);
            data.set("muxer_crash_count", muxer_crash_count);
            data.set("audio_degraded_count", audio_degraded_count);
            data.set("dropped_mic_messages", dropped_mic_messages);
            data
        }
        ProductAnalyticsEvent::RecordingRecoveryFailed { trigger, reason } => {
            let mut data = EventData::new("recording_recovery_failed");
            data.set("trigger", trigger);
            data.set("failure_class", classify_failure(&reason));
            data
        }
    }
}

fn is_core_product_event(name: &str) -> bool {
    matches!(
        name,
        "recording_started"
            | "recording_completed"
            | "recording_start_failed"
            | "multipart_upload_complete"
            | "multipart_upload_failed"
            | "recording_recovery_failed"
            | "analytics_delivery_loss"
    )
}

fn desktop_client_product_event_name(name: &str) -> Option<&'static str> {
    match name {
        "user_signed_in" => Some("user_signed_in"),
        "user_signed_out" => Some("user_signed_out"),
        "recording_started" => Some("recording_started"),
        "recording_start_failed" => Some("recording_start_failed"),
        "recording_completed" => Some("recording_completed"),
        "multipart_upload_complete" => Some("multipart_upload_complete"),
        "multipart_upload_failed" => Some("multipart_upload_failed"),
        "recording_recovery_failed" => Some("recording_recovery_failed"),
        "export_button_clicked" => Some("export_button_clicked"),
        "export_fps_changed" => Some("export_fps_changed"),
        "export_started" => Some("export_started"),
        "export_completed" => Some("export_completed"),
        "export_failed" => Some("export_failed"),
        "create_shareable_link_clicked" => Some("create_shareable_link_clicked"),
        "camera_selected" => Some("camera_selected"),
        "microphone_selected" => Some("microphone_selected"),
        "screenshot_view_clicked" => Some("screenshot_view_clicked"),
        "screenshot_editor_clicked" => Some("screenshot_editor_clicked"),
        "screenshot_folder_clicked" => Some("screenshot_folder_clicked"),
        "screenshot_copy_clicked" => Some("screenshot_copy_clicked"),
        "screenshot_share_clicked" => Some("screenshot_share_clicked"),
        "recording_view_clicked" => Some("recording_view_clicked"),
        "recording_folder_clicked" => Some("recording_folder_clicked"),
        "recording_copy_clicked" => Some("recording_copy_clicked"),
        "recording_editor_clicked" => Some("recording_editor_clicked"),
        "experiment_exposed" => Some("experiment_exposed"),
        _ => None,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductEvent {
    event_id: String,
    event_name: String,
    occurred_at: String,
    anonymous_id: String,
    session_id: String,
    platform: String,
    app_version: String,
    properties: Map<String, Value>,
}

#[derive(Serialize)]
struct ProductEventBatch<'a> {
    events: &'a [ProductEvent],
}

fn product_event(data: &EventData, anonymous_id: String) -> Option<ProductEvent> {
    if !is_core_product_event(data.name) {
        return None;
    }

    Some(ProductEvent {
        event_id: Uuid::new_v4().to_string(),
        event_name: data.name.to_string(),
        occurred_at: chrono::Utc::now().to_rfc3339(),
        anonymous_id,
        session_id: PRODUCT_EVENT_SESSION_ID
            .get_or_init(Uuid::new_v4)
            .to_string(),
        platform: "desktop".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        properties: product_event_properties(data),
    })
}

fn product_event_properties(data: &EventData) -> Map<String, Value> {
    data.properties
        .iter()
        .filter(|(key, value)| {
            !matches!(
                key.as_str(),
                "error" | "error_message" | "file_name" | "file_path" | "raw_error" | "reason"
            ) && (value.is_null() || value.is_boolean() || value.is_number() || value.is_string())
        })
        .map(|(key, value)| {
            let value = match value {
                Value::String(value) => Value::String(truncate_reason(value.clone())),
                value => value.clone(),
            };
            (key.clone(), value)
        })
        .collect()
}

fn live_telemetry_enabled(app: &AppHandle) -> bool {
    let enabled = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|settings| settings.enable_telemetry)
        .unwrap_or_else(telemetry_enabled);
    TELEMETRY_ENABLED.store(enabled, Ordering::Release);
    enabled
}

fn product_auth_token(app: &AppHandle) -> Option<String> {
    AuthStore::get(app)
        .ok()
        .flatten()
        .map(|auth| match auth.secret {
            AuthSecret::ApiKey { api_key } => api_key,
            AuthSecret::Session { token, .. } => token,
        })
}

#[derive(Debug)]
struct DeliveryError {
    retryable: bool,
    status: Option<u16>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProductEventBatchKind {
    LossReport,
    Pending,
    DeadLetterRetry,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ProductEventDeadLetter {
    event: ProductEvent,
    failure_class: String,
    status: Option<u16>,
    failed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ProductEventLossSummary {
    summary_id: String,
    failure_class: String,
    failed_event_name: String,
    platform: String,
    app_version: String,
    anonymous_id: String,
    session_id: String,
    status: Option<u16>,
    count: u64,
    first_sequence: u64,
    last_sequence: u64,
    first_failed_at_ms: i64,
    last_failed_at_ms: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct ProductEventOutbox {
    pending: Vec<ProductEvent>,
    dead_letters: Vec<ProductEventDeadLetter>,
    loss_summaries: Vec<ProductEventLossSummary>,
    loss_reports_in_flight: Vec<ProductEvent>,
    next_delivery_sequence: u64,
}

async fn send_product_batch_once(
    app: &AppHandle,
    events: &[ProductEvent],
) -> Result<(), DeliveryError> {
    if !live_telemetry_enabled(app) {
        return Ok(());
    }

    let auth_token = product_auth_token(app);
    let response = app
        .api_request("/api/events", |client, url| {
            let request = client
                .post(url)
                .timeout(PRODUCT_EVENT_REQUEST_TIMEOUT)
                .json(&ProductEventBatch { events });
            match &auth_token {
                Some(token) => request.bearer_auth(token),
                None => request,
            }
        })
        .await
        .map_err(|_| DeliveryError {
            retryable: true,
            status: None,
        })?;

    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status().as_u16();
        Err(DeliveryError {
            retryable: should_retry_product_status(status),
            status: Some(status),
        })
    }
}

fn should_retry_product_status(status: u16) -> bool {
    status == 429 || status >= 500
}

fn decode_outbox_encryption_key(encoded: &str) -> Result<[u8; 32], String> {
    BASE64
        .decode(encoded.trim())
        .map_err(|_| "invalid_outbox_key".to_string())?
        .try_into()
        .map_err(|_| "invalid_outbox_key".to_string())
}

fn read_keyring_outbox_key(user: &str) -> Result<Option<[u8; 32]>, String> {
    let entry = keyring::Entry::new(PRODUCT_EVENT_OUTBOX_KEYRING_SERVICE, user)
        .map_err(|_| "outbox_keyring_unavailable".to_string())?;
    match entry.get_password() {
        Ok(encoded) => decode_outbox_encryption_key(&encoded).map(Some),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("outbox_keyring_unavailable".to_string()),
    }
}

fn keyring_outbox_encryption_keys() -> Result<Vec<[u8; 32]>, String> {
    let mut keys = Vec::new();
    let mut failure = None;
    for user in [
        PRODUCT_EVENT_OUTBOX_KEYRING_USER,
        PRODUCT_EVENT_OUTBOX_LEGACY_KEYRING_USER,
    ] {
        match read_keyring_outbox_key(user) {
            Ok(Some(key)) if !keys.contains(&key) => keys.push(key),
            Ok(_) => {}
            Err(error) => failure = Some(error),
        }
    }
    if keys.is_empty()
        && let Some(error) = failure
    {
        return Err(error);
    }
    Ok(keys)
}

fn persist_keyring_outbox_key(user: &str, key: [u8; 32]) -> Result<(), String> {
    let entry = keyring::Entry::new(PRODUCT_EVENT_OUTBOX_KEYRING_SERVICE, user)
        .map_err(|_| "outbox_keyring_unavailable".to_string())?;
    entry
        .set_password(&BASE64.encode(key))
        .map_err(|_| "outbox_keyring_write_failed".to_string())
}

fn file_outbox_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(PRODUCT_EVENT_OUTBOX_KEY_FILE))
        .map_err(|_| "outbox_key_directory_unavailable".to_string())
}

fn outbox_journal_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(PRODUCT_EVENT_OUTBOX_JOURNAL_FILE))
        .map_err(|_| "outbox_journal_directory_unavailable".to_string())
}

fn append_event_journal(app: &AppHandle, event: &ProductEvent) -> Result<(), String> {
    let path = outbox_journal_path(app)?;
    let encryption_key = outbox_encryption_key(app)?;
    append_encrypted_event_journal(&path, event, encryption_key).map(|_| ())
}

fn append_encrypted_event_journal(
    path: &Path,
    event: &ProductEvent,
    encryption_key: &[u8; 32],
) -> Result<usize, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "outbox_journal_directory_unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "outbox_journal_directory_unavailable".to_string())?;
    let encoded = encrypt_outbox_with_key(
        &ProductEventOutbox {
            pending: vec![event.clone()],
            ..ProductEventOutbox::default()
        },
        encryption_key,
    )?;
    let appended_bytes = encoded.len().saturating_add(1);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| "outbox_journal_write_failed".to_string())?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "outbox_journal_write_failed".to_string())?;
    file.write_all(encoded.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_data())
        .map_err(|_| "outbox_journal_write_failed".to_string())?;
    Ok(appended_bytes)
}

fn load_event_journal(app: &AppHandle) -> Result<(ProductEventOutbox, bool), String> {
    let path = outbox_journal_path(app)?;
    let value = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((ProductEventOutbox::default(), false));
        }
        Err(_) => return Err("outbox_journal_read_failed".to_string()),
    };
    let mut outbox = ProductEventOutbox::default();
    let mut corrupt = false;
    for encoded in value.lines().filter(|line| !line.is_empty()) {
        match decrypt_outbox(app, encoded) {
            Ok(record) => merge_outbox(&mut outbox, record),
            Err(_) => corrupt = true,
        }
    }
    Ok((outbox, corrupt))
}

fn truncate_event_journal(app: &AppHandle) -> Result<(), String> {
    let path = outbox_journal_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "outbox_journal_directory_unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "outbox_journal_directory_unavailable".to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|_| "outbox_journal_write_failed".to_string())?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "outbox_journal_write_failed".to_string())?;
    file.sync_all()
        .map_err(|_| "outbox_journal_write_failed".to_string())
}

fn delete_event_journal(app: &AppHandle) -> Result<(), String> {
    match fs::remove_file(outbox_journal_path(app)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("outbox_journal_delete_failed".to_string()),
    }
}

fn read_file_outbox_key(path: &Path) -> Result<Option<[u8; 32]>, String> {
    match fs::read_to_string(path) {
        Ok(encoded) => decode_outbox_encryption_key(&encoded).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("outbox_key_file_unavailable".to_string()),
    }
}

fn initialize_file_outbox_key(path: &Path, key: [u8; 32]) -> Result<[u8; 32], String> {
    if let Some(existing) = read_file_outbox_key(path)? {
        return Ok(existing);
    }
    let parent = path
        .parent()
        .ok_or_else(|| "outbox_key_directory_unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "outbox_key_directory_unavailable".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "outbox_key_file_write_failed".to_string())?;
    #[cfg(unix)]
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "outbox_key_file_write_failed".to_string())?;
    temporary
        .write_all(BASE64.encode(key).as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| "outbox_key_file_write_failed".to_string())?;
    match temporary.persist_noclobber(path) {
        Ok(file) => {
            file.sync_all()
                .map_err(|_| "outbox_key_file_write_failed".to_string())?;
            #[cfg(unix)]
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "outbox_key_file_write_failed".to_string())?;
            Ok(key)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_file_outbox_key(path)?.ok_or_else(|| "outbox_key_file_unavailable".to_string())
        }
        Err(_) => Err("outbox_key_file_write_failed".to_string()),
    }
}

fn decode_legacy_outbox_encryption_keys(value: &Value) -> Result<Vec<[u8; 32]>, String> {
    if let Some(encoded) = value.as_str() {
        return decode_outbox_encryption_key(encoded).map(|key| vec![key]);
    }
    value
        .as_array()
        .ok_or_else(|| "invalid_legacy_outbox_key".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "invalid_legacy_outbox_key".to_string())
                .and_then(decode_outbox_encryption_key)
        })
        .collect()
}

fn legacy_store_outbox_encryption_keys(app: &AppHandle) -> Result<Vec<[u8; 32]>, String> {
    let store = app
        .store("store")
        .map_err(|_| "legacy_outbox_key_store_unavailable".to_string())?;
    match store.get(PRODUCT_EVENT_OUTBOX_LEGACY_KEY_STORE_KEY) {
        Some(value) => decode_legacy_outbox_encryption_keys(&value),
        None => Ok(Vec::new()),
    }
}

fn delete_legacy_store_outbox_encryption_keys(app: &AppHandle) -> Result<(), String> {
    let store = app
        .store("store")
        .map_err(|_| "legacy_outbox_key_store_unavailable".to_string())?;
    store.delete(PRODUCT_EVENT_OUTBOX_LEGACY_KEY_STORE_KEY);
    store
        .save()
        .map_err(|_| "legacy_outbox_key_store_write_failed".to_string())
}

fn outbox_encryption_keys(app: &AppHandle) -> Result<Vec<[u8; 32]>, String> {
    let mut keys = Vec::new();
    let mut failure = None;
    if let Some(key) = PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY.get() {
        keys.push(*key);
    }
    match file_outbox_key_path(app).and_then(|path| read_file_outbox_key(&path)) {
        Ok(Some(key)) if !keys.contains(&key) => keys.push(key),
        Ok(_) => {}
        Err(error) => failure = Some(error),
    }
    match keyring_outbox_encryption_keys() {
        Ok(keyring_keys) => {
            for key in keyring_keys {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        Err(error) => failure = Some(error),
    }
    match legacy_store_outbox_encryption_keys(app) {
        Ok(legacy_keys) => {
            for key in legacy_keys {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        Err(error) => failure = Some(error),
    }
    if keys.is_empty()
        && let Some(error) = failure
    {
        return Err(error);
    }
    Ok(keys)
}

fn outbox_encryption_key(app: &AppHandle) -> Result<&'static [u8; 32], String> {
    if let Some(key) = PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY.get() {
        return Ok(key);
    }

    let key_path = file_outbox_key_path(app)?;
    let candidate = if let Some(key) = read_file_outbox_key(&key_path)? {
        key
    } else if let Some(key) = keyring_outbox_encryption_keys().unwrap_or_default().first() {
        *key
    } else {
        let mut generated = [0_u8; 32];
        SystemRandom::new()
            .fill(&mut generated)
            .map_err(|_| "key_generation_failed".to_string())?;
        generated
    };
    let key = initialize_file_outbox_key(&key_path, candidate)?;
    let _ = persist_keyring_outbox_key(PRODUCT_EVENT_OUTBOX_KEYRING_USER, key);
    let _ = PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY.set(key);
    PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY
        .get()
        .ok_or_else(|| "key_cache_failed".to_string())
}

fn encrypt_outbox(app: &AppHandle, outbox: &ProductEventOutbox) -> Result<String, String> {
    encrypt_outbox_with_key(outbox, outbox_encryption_key(app)?)
}

fn encrypt_outbox_with_key(
    outbox: &ProductEventOutbox,
    encryption_key: &[u8; 32],
) -> Result<String, String> {
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, encryption_key)
            .map_err(|_| "encryption_key_failed".to_string())?,
    );
    let mut nonce_bytes = [0_u8; 12];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "nonce_generation_failed".to_string())?;
    let mut encrypted =
        serde_json::to_vec(outbox).map_err(|_| "outbox_serialization_failed".to_string())?;
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(b"cap-product-analytics-outbox-v1".as_slice()),
        &mut encrypted,
    )
    .map_err(|_| "outbox_encryption_failed".to_string())?;
    let mut stored = nonce_bytes.to_vec();
    stored.extend(encrypted);
    Ok(BASE64.encode(stored))
}

fn decrypt_outbox(app: &AppHandle, value: &str) -> Result<ProductEventOutbox, String> {
    if let Some(key) = PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY.get()
        && let Ok(outbox) = decrypt_outbox_with_key(value, key)
    {
        return Ok(outbox);
    }

    let candidates = outbox_encryption_keys(app)?;
    decrypt_outbox_with_keys(value, &candidates).map(|(outbox, _)| outbox)
}

fn decrypt_outbox_with_keys(
    value: &str,
    candidates: &[[u8; 32]],
) -> Result<(ProductEventOutbox, [u8; 32]), String> {
    if candidates.is_empty() {
        return Err("outbox_key_unavailable".to_string());
    }
    for key in candidates {
        if let Ok(outbox) = decrypt_outbox_with_key(value, key) {
            return Ok((outbox, *key));
        }
    }
    Err("outbox_decryption_failed".to_string())
}

fn decrypt_outbox_with_key(
    value: &str,
    encryption_key: &[u8; 32],
) -> Result<ProductEventOutbox, String> {
    let stored = BASE64
        .decode(value)
        .map_err(|_| "outbox_decode_failed".to_string())?;
    if stored.len() <= 12 {
        return Err("outbox_decode_failed".to_string());
    }
    let (nonce, encrypted) = stored.split_at(12);
    let nonce_bytes: [u8; 12] = nonce
        .try_into()
        .map_err(|_| "outbox_decode_failed".to_string())?;
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, encryption_key)
            .map_err(|_| "encryption_key_failed".to_string())?,
    );
    let mut decrypted = encrypted.to_vec();
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(b"cap-product-analytics-outbox-v1".as_slice()),
            &mut decrypted,
        )
        .map_err(|_| "outbox_decryption_failed".to_string())?;
    serde_json::from_slice(plaintext).map_err(|_| "outbox_deserialization_failed".to_string())
}

fn write_outbox(
    app: &AppHandle,
    store_key: &str,
    outbox: &ProductEventOutbox,
) -> Result<(), String> {
    let encrypted = encrypt_outbox(app, outbox)?;
    let store = app
        .store("store")
        .map_err(|_| "store_unavailable".to_string())?;
    store.set(store_key, encrypted);
    store.save().map_err(|_| "store_write_failed".to_string())
}

fn delete_stored_outbox(app: &AppHandle, store_key: &str) -> Result<(), String> {
    let store = app
        .store("store")
        .map_err(|_| "store_unavailable".to_string())?;
    store.delete(store_key);
    store.save().map_err(|_| "store_write_failed".to_string())
}

fn load_stored_outbox(app: &AppHandle, store_key: &str) -> Result<ProductEventOutbox, String> {
    let store = app
        .store("store")
        .map_err(|_| "store_unavailable".to_string())?;
    let Some(value) = store.get(store_key) else {
        return Ok(ProductEventOutbox::default());
    };
    let Some(encrypted) = value.as_str() else {
        return Err("invalid_stored_outbox".to_string());
    };
    decrypt_outbox(app, encrypted)
}

fn loss_summary_matches(
    summary: &ProductEventLossSummary,
    failure_class: &str,
    event: &ProductEvent,
    status: Option<u16>,
) -> bool {
    summary.failure_class == failure_class
        && summary.failed_event_name == event.event_name
        && summary.platform == event.platform
        && summary.app_version == event.app_version
        && summary.status == status
        && summary.anonymous_id == event.anonymous_id
        && summary.session_id == event.session_id
}

fn is_capacity_loss_summary(summary: &ProductEventLossSummary) -> bool {
    summary.failure_class == "summary_capacity" && summary.failed_event_name == "other"
}

fn capacity_loss_summary(source: ProductEventLossSummary) -> ProductEventLossSummary {
    ProductEventLossSummary {
        summary_id: source.summary_id,
        failure_class: "summary_capacity".to_string(),
        failed_event_name: "other".to_string(),
        platform: "desktop".to_string(),
        app_version: "mixed".to_string(),
        anonymous_id: source.anonymous_id,
        session_id: String::new(),
        status: None,
        count: source.count,
        first_sequence: source.first_sequence,
        last_sequence: source.last_sequence,
        first_failed_at_ms: source.first_failed_at_ms,
        last_failed_at_ms: source.last_failed_at_ms,
    }
}

fn aggregate_loss_summary(
    fallback: &mut ProductEventLossSummary,
    source: &ProductEventLossSummary,
) {
    fallback.count = fallback.count.saturating_add(source.count);
    fallback.first_sequence = fallback.first_sequence.min(source.first_sequence);
    fallback.last_sequence = fallback.last_sequence.max(source.last_sequence);
    fallback.first_failed_at_ms = fallback.first_failed_at_ms.min(source.first_failed_at_ms);
    fallback.last_failed_at_ms = fallback.last_failed_at_ms.max(source.last_failed_at_ms);
}

fn record_delivery_loss(
    outbox: &mut ProductEventOutbox,
    failure_class: &str,
    event: &ProductEvent,
    status: Option<u16>,
    failed_at_ms: i64,
) {
    outbox.next_delivery_sequence = outbox.next_delivery_sequence.saturating_add(1);
    let sequence = outbox.next_delivery_sequence;
    if let Some(summary) = outbox
        .loss_summaries
        .iter_mut()
        .find(|summary| loss_summary_matches(summary, failure_class, event, status))
    {
        summary.count = summary.count.saturating_add(1);
        summary.last_sequence = sequence;
        summary.last_failed_at_ms = failed_at_ms;
        return;
    }

    let detailed_capacity = PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY.saturating_sub(1);
    if outbox.loss_summaries.len() < detailed_capacity {
        outbox.loss_summaries.push(ProductEventLossSummary {
            summary_id: Uuid::new_v4().to_string(),
            failure_class: failure_class.to_string(),
            failed_event_name: event.event_name.clone(),
            platform: event.platform.clone(),
            app_version: event.app_version.clone(),
            anonymous_id: event.anonymous_id.clone(),
            session_id: event.session_id.clone(),
            status,
            count: 1,
            first_sequence: sequence,
            last_sequence: sequence,
            first_failed_at_ms: failed_at_ms,
            last_failed_at_ms: failed_at_ms,
        });
        return;
    }

    if let Some(summary) = outbox
        .loss_summaries
        .iter_mut()
        .find(|summary| is_capacity_loss_summary(summary))
    {
        summary.count = summary.count.saturating_add(1);
        summary.last_sequence = sequence;
        summary.last_failed_at_ms = failed_at_ms;
        return;
    }

    if outbox.loss_summaries.len() < PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY {
        outbox.loss_summaries.push(ProductEventLossSummary {
            summary_id: Uuid::new_v4().to_string(),
            failure_class: "summary_capacity".to_string(),
            failed_event_name: "other".to_string(),
            platform: "desktop".to_string(),
            app_version: "mixed".to_string(),
            anonymous_id: event.anonymous_id.clone(),
            session_id: String::new(),
            status: None,
            count: 1,
            first_sequence: sequence,
            last_sequence: sequence,
            first_failed_at_ms: failed_at_ms,
            last_failed_at_ms: failed_at_ms,
        });
    }
}

fn merge_loss_summary(target: &mut Vec<ProductEventLossSummary>, source: ProductEventLossSummary) {
    if let Some(existing) = target
        .iter_mut()
        .find(|summary| summary.summary_id == source.summary_id)
    {
        if source.last_sequence > existing.last_sequence {
            *existing = source;
        }
        return;
    }
    if let Some(fallback) = target
        .iter_mut()
        .find(|summary| is_capacity_loss_summary(summary))
    {
        aggregate_loss_summary(fallback, &source);
        return;
    }

    let detailed_capacity = PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY.saturating_sub(1);
    if target.len() < detailed_capacity && !is_capacity_loss_summary(&source) {
        target.push(source);
        return;
    }

    let mut fallback = if target.len() < PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY {
        capacity_loss_summary(source)
    } else {
        let displaced = target.remove(target.len().saturating_sub(1));
        let mut fallback = capacity_loss_summary(displaced);
        aggregate_loss_summary(&mut fallback, &source);
        fallback
    };
    fallback.platform = "desktop".to_string();
    fallback.app_version = "mixed".to_string();
    fallback.session_id.clear();
    target.push(fallback);
}

fn loss_report_from_summary(summary: ProductEventLossSummary) -> ProductEvent {
    let data = event_data(ProductAnalyticsEvent::AnalyticsDeliveryLoss {
        failure_class: summary.failure_class,
        failed_event_name: summary.failed_event_name,
        status: summary.status,
        count: summary.count,
        first_sequence: summary.first_sequence,
        last_sequence: summary.last_sequence,
        first_failed_at_ms: summary.first_failed_at_ms,
        last_failed_at_ms: summary.last_failed_at_ms,
    });
    let occurred_at =
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(summary.last_failed_at_ms)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339();
    ProductEvent {
        event_id: summary.summary_id,
        event_name: data.name.to_string(),
        occurred_at,
        anonymous_id: summary.anonymous_id,
        session_id: summary.session_id,
        platform: summary.platform,
        app_version: summary.app_version,
        properties: product_event_properties(&data),
    }
}

fn merge_outbox(target: &mut ProductEventOutbox, source: ProductEventOutbox) {
    let mut known_event_ids = target
        .pending
        .iter()
        .map(|event| event.event_id.clone())
        .chain(
            target
                .dead_letters
                .iter()
                .map(|entry| entry.event.event_id.clone()),
        )
        .chain(
            target
                .loss_reports_in_flight
                .iter()
                .map(|event| event.event_id.clone()),
        )
        .collect::<std::collections::HashSet<_>>();
    for event in source.pending {
        if known_event_ids.insert(event.event_id.clone()) {
            target.pending.push(event);
        }
    }
    for entry in source.dead_letters {
        if known_event_ids.insert(entry.event.event_id.clone()) {
            target.dead_letters.push(entry);
        }
    }
    for event in source.loss_reports_in_flight {
        target
            .loss_summaries
            .retain(|summary| summary.summary_id != event.event_id);
        if known_event_ids.insert(event.event_id.clone()) {
            target.loss_reports_in_flight.push(event);
        }
    }
    for summary in source.loss_summaries {
        if !known_event_ids.contains(&summary.summary_id) {
            merge_loss_summary(&mut target.loss_summaries, summary);
        }
    }
    target.next_delivery_sequence = target
        .next_delivery_sequence
        .max(source.next_delivery_sequence)
        .max(
            target
                .loss_summaries
                .iter()
                .map(|summary| summary.last_sequence)
                .max()
                .unwrap_or(0),
        );
}

fn persist_outbox(app: &AppHandle, outbox: &mut ProductEventOutbox) -> Result<(), String> {
    if !PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.load(Ordering::Acquire) {
        if write_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY, outbox).is_ok() {
            return truncate_event_journal(app);
        }
        PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(true, Ordering::Release);
        write_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY, outbox)?;
        return truncate_event_journal(app);
    }

    let Ok(mut restored) = load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY) else {
        let (journal, corrupt) = load_event_journal(app)?;
        merge_outbox(outbox, journal);
        if corrupt {
            PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
            warn!("Product analytics journal contained an incomplete record");
        }
        write_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY, outbox)?;
        return truncate_event_journal(app);
    };
    merge_outbox(&mut restored, outbox.clone());
    let recovery = load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY)?;
    merge_outbox(&mut restored, recovery);
    let (journal, corrupt) = load_event_journal(app)?;
    merge_outbox(&mut restored, journal);
    if corrupt {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
        warn!("Product analytics journal contained an incomplete record");
    }
    write_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY, &restored)?;
    delete_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY)?;
    delete_legacy_store_outbox_encryption_keys(app)?;
    truncate_event_journal(app)?;
    *outbox = restored;
    PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(false, Ordering::Release);
    Ok(())
}

fn outbox_guard() -> std::sync::MutexGuard<'static, ProductEventOutbox> {
    PRODUCT_EVENT_OUTBOX
        .get_or_init(|| Mutex::new(ProductEventOutbox::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn remove_delivered_from_outbox(outbox: &mut ProductEventOutbox, delivered: &[ProductEvent]) {
    let delivered_ids = delivered
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    outbox
        .pending
        .retain(|event| !delivered_ids.contains(event.event_id.as_str()));
    outbox
        .loss_reports_in_flight
        .retain(|event| !delivered_ids.contains(event.event_id.as_str()));
    outbox
        .dead_letters
        .retain(|entry| !delivered_ids.contains(entry.event.event_id.as_str()));
}

fn remove_delivered_events(app: &AppHandle, delivered: &[ProductEvent]) {
    let mut outbox = outbox_guard();
    remove_delivered_from_outbox(&mut outbox, delivered);
    if let Err(failure_class) = persist_outbox(app, &mut outbox) {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
        warn!(
            failure_class,
            "Failed to persist delivered product analytics state"
        );
    }
}

fn dead_letter_retry_attempts_guard() -> std::sync::MutexGuard<'static, HashSet<String>> {
    PRODUCT_EVENT_DEAD_LETTER_RETRY_ATTEMPTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn select_dead_letter_retry_batch(
    outbox: &ProductEventOutbox,
    attempted: &mut HashSet<String>,
) -> Vec<ProductEvent> {
    let mut events = Vec::new();
    for entry in &outbox.dead_letters {
        if attempted.insert(entry.event.event_id.clone()) {
            events.push(entry.event.clone());
        }
        if events.len() == PRODUCT_EVENT_BATCH_SIZE {
            break;
        }
    }
    events
}

fn prepare_dead_letter_retry_batch() -> Vec<ProductEvent> {
    let mut attempted = dead_letter_retry_attempts_guard();
    let outbox = outbox_guard();
    select_dead_letter_retry_batch(&outbox, &mut attempted)
}

fn record_dead_letter_retry_rejection(
    app: &AppHandle,
    events: &[ProductEvent],
    error: &DeliveryError,
) {
    let now = chrono::Utc::now().timestamp_millis();
    let mut outbox = outbox_guard();
    record_dead_letter_retry_rejection_in_outbox(&mut outbox, events, error, now);
    if let Err(failure_class) = persist_outbox(app, &mut outbox) {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
        warn!(
            failure_class,
            "Failed to persist product analytics dead letter retry state"
        );
    }
}

fn record_dead_letter_retry_rejection_in_outbox(
    outbox: &mut ProductEventOutbox,
    events: &[ProductEvent],
    error: &DeliveryError,
    failed_at_ms: i64,
) {
    for event in events {
        record_delivery_loss(
            outbox,
            "dead_letter_retry_rejected",
            event,
            error.status,
            failed_at_ms,
        );
    }
}

fn prepare_loss_report_batch(app: &AppHandle) -> Result<Vec<ProductEvent>, String> {
    let mut outbox = outbox_guard();
    if outbox.loss_reports_in_flight.is_empty() && !outbox.loss_summaries.is_empty() {
        let report_count = outbox.loss_summaries.len().min(PRODUCT_EVENT_BATCH_SIZE);
        outbox.loss_reports_in_flight = outbox
            .loss_summaries
            .drain(..report_count)
            .map(loss_report_from_summary)
            .collect();
        persist_outbox(app, &mut outbox)?;
    }
    Ok(outbox.loss_reports_in_flight.clone())
}

fn dead_letter_events(
    outbox: &mut ProductEventOutbox,
    events: &[ProductEvent],
    error: &DeliveryError,
    failed_at_ms: i64,
    failed_at: &str,
) -> (u64, u64) {
    let failed_ids = events
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    outbox
        .pending
        .retain(|event| !failed_ids.contains(event.event_id.as_str()));
    let mut stored = 0_u64;
    let mut dropped = 0_u64;
    for event in events {
        if outbox.dead_letters.len() < PRODUCT_EVENT_DEAD_LETTER_CAPACITY {
            record_delivery_loss(
                outbox,
                "contract_rejected",
                event,
                error.status,
                failed_at_ms,
            );
            outbox.dead_letters.push(ProductEventDeadLetter {
                event: event.clone(),
                failure_class: "contract_rejected".to_string(),
                status: error.status,
                failed_at: failed_at.to_string(),
            });
            stored = stored.saturating_add(1);
        } else {
            record_delivery_loss(
                outbox,
                "dead_letter_overflow",
                event,
                error.status,
                failed_at_ms,
            );
            dropped = dropped.saturating_add(1);
        }
    }
    (stored, dropped)
}

fn move_to_dead_letters(app: &AppHandle, events: &[ProductEvent], error: &DeliveryError) {
    let now = chrono::Utc::now();
    let mut outbox = outbox_guard();
    let (stored, dropped) = dead_letter_events(
        &mut outbox,
        events,
        error,
        now.timestamp_millis(),
        &now.to_rfc3339(),
    );
    PRODUCT_EVENT_DEAD_LETTERS.fetch_add(stored, Ordering::Relaxed);
    PRODUCT_EVENTS_DROPPED.fetch_add(dropped, Ordering::Relaxed);
    if let Err(failure_class) = persist_outbox(app, &mut outbox) {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
        warn!(
            failure_class,
            "Failed to persist product analytics dead letter"
        );
    }
}

async fn run_product_event_worker(app: AppHandle, mut receiver: mpsc::Receiver<()>) {
    while receiver.recv().await.is_some() {
        let mut retry_attempt = 0_u32;
        loop {
            if !live_telemetry_enabled(&app) {
                break;
            }
            let (events, batch_kind) = match prepare_loss_report_batch(&app) {
                Ok(loss_reports) if !loss_reports.is_empty() => {
                    (loss_reports, ProductEventBatchKind::LossReport)
                }
                Ok(_) => {
                    let outbox = outbox_guard();
                    let pending = outbox
                        .pending
                        .iter()
                        .take(PRODUCT_EVENT_BATCH_SIZE)
                        .cloned()
                        .collect::<Vec<_>>();
                    drop(outbox);
                    if pending.is_empty() {
                        (
                            prepare_dead_letter_retry_batch(),
                            ProductEventBatchKind::DeadLetterRetry,
                        )
                    } else {
                        (pending, ProductEventBatchKind::Pending)
                    }
                }
                Err(failure_class) => {
                    PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                    warn!(
                        failure_class,
                        "Failed to persist product analytics loss report snapshot"
                    );
                    break;
                }
            };
            if events.is_empty() {
                break;
            }
            if batch_kind == ProductEventBatchKind::DeadLetterRetry {
                PRODUCT_EVENT_RETRIES.fetch_add(events.len() as u64, Ordering::Relaxed);
            }

            match send_product_batch_once(&app, &events).await {
                Ok(()) => {
                    remove_delivered_events(&app, &events);
                    retry_attempt = 0;
                }
                Err(error) if error.retryable => {
                    PRODUCT_EVENT_RETRIES.fetch_add(events.len() as u64, Ordering::Relaxed);
                    let multiplier = 2_u32.saturating_pow(retry_attempt.min(9));
                    let delay = PRODUCT_EVENT_RETRY_DELAY
                        .saturating_mul(multiplier)
                        .min(PRODUCT_EVENT_MAX_RETRY_DELAY);
                    retry_attempt = retry_attempt.saturating_add(1);
                    warn!(
                        event_count = events.len(),
                        status = error.status,
                        retry_attempt,
                        "Product analytics delivery will retry"
                    );
                    tokio::time::sleep(delay).await;
                }
                Err(error) => {
                    match batch_kind {
                        ProductEventBatchKind::LossReport => {
                            warn!(
                                event_count = events.len(),
                                status = error.status,
                                "Product analytics loss report was rejected and remains encrypted for recovery"
                            );
                            break;
                        }
                        ProductEventBatchKind::DeadLetterRetry => {
                            record_dead_letter_retry_rejection(&app, &events, &error);
                            warn!(
                                event_count = events.len(),
                                status = error.status,
                                "Product analytics dead letters remain encrypted after a recovery attempt"
                            );
                            break;
                        }
                        ProductEventBatchKind::Pending => {}
                    }
                    warn!(
                        event_count = events.len(),
                        status = error.status,
                        "Product analytics delivery entered the encrypted dead letter queue"
                    );
                    move_to_dead_letters(&app, &events, &error);
                    retry_attempt = 0;
                }
            }
        }
    }
}

fn insert_product_event(
    outbox: &mut ProductEventOutbox,
    event: ProductEvent,
    failed_at_ms: i64,
    failed_at: &str,
) -> (bool, bool, bool) {
    if outbox.pending.len() < PRODUCT_EVENT_OUTBOX_CAPACITY {
        outbox.pending.push(event);
        return (true, false, false);
    }

    if outbox.dead_letters.len() < PRODUCT_EVENT_DEAD_LETTER_CAPACITY {
        record_delivery_loss(
            outbox,
            "queue_overflow_dead_lettered",
            &event,
            None,
            failed_at_ms,
        );
        outbox.dead_letters.push(ProductEventDeadLetter {
            event,
            failure_class: "queue_overflow".to_string(),
            status: None,
            failed_at: failed_at.to_string(),
        });
        (true, true, false)
    } else {
        record_delivery_loss(
            outbox,
            "queue_overflow_unrecoverable",
            &event,
            None,
            failed_at_ms,
        );
        (true, false, true)
    }
}

fn enqueue_product_event(app: &AppHandle, event: ProductEvent) -> Result<(), String> {
    let now = chrono::Utc::now();
    let journal_event = event.clone();
    let (should_wake, dead_lettered, dropped, persistence) = {
        let mut outbox = outbox_guard();
        let (should_wake, dead_lettered, dropped) = insert_product_event(
            &mut outbox,
            event,
            now.timestamp_millis(),
            &now.to_rfc3339(),
        );
        let persistence = if dead_lettered || dropped {
            persist_outbox(app, &mut outbox)
        } else {
            append_event_journal(app, &journal_event).or_else(|_| persist_outbox(app, &mut outbox))
        };
        (should_wake, dead_lettered, dropped, persistence)
    };
    if dead_lettered {
        PRODUCT_EVENT_DEAD_LETTERS.fetch_add(1, Ordering::Relaxed);
    }
    if dropped {
        PRODUCT_EVENTS_DROPPED.fetch_add(1, Ordering::Relaxed);
    }
    if persistence.is_err() {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
    }
    let sender = product_event_sender(app);

    if should_wake && let Err(mpsc::error::TrySendError::Closed(_)) = sender.try_send(()) {
        warn!("Product analytics worker is unavailable; event remains in the encrypted outbox");
    }
    persistence
}

fn product_event_sender(app: &AppHandle) -> &'static mpsc::Sender<()> {
    PRODUCT_EVENT_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel(PRODUCT_EVENT_QUEUE_CAPACITY);
        tokio::spawn(run_product_event_worker(app.clone(), receiver));
        sender
    })
}

fn clear_product_event_outbox(outbox: &mut ProductEventOutbox) {
    *outbox = ProductEventOutbox::default();
}

fn purge_stored_product_analytics(app: &AppHandle) -> Result<(), String> {
    clear_product_event_outbox(&mut outbox_guard());
    dead_letter_retry_attempts_guard().clear();
    let store = app
        .store("store")
        .map_err(|_| "store_unavailable".to_string())?;
    store.delete(PRODUCT_EVENT_SESSION_STORE_KEY);
    store.delete(PRODUCT_EVENT_OUTBOX_STORE_KEY);
    store.delete(PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY);
    store
        .save()
        .map_err(|_| "analytics_opt_out_purge_failed".to_string())?;
    delete_event_journal(app)
}

pub fn init_product_session(app: &AppHandle) {
    if !telemetry_enabled() {
        if let Err(failure_class) = purge_stored_product_analytics(app) {
            PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
            warn!(
                failure_class,
                "Failed to purge opted-out product analytics state"
            );
        }
        return;
    }

    let session_id = PRODUCT_EVENT_SESSION_ID
        .get_or_init(Uuid::new_v4)
        .to_string();
    match app.store("store") {
        Ok(store) => {
            store.set(PRODUCT_EVENT_SESSION_STORE_KEY, session_id);
            if let Err(err) = store.save() {
                warn!("Failed to persist product analytics session ID: {err}");
            }
        }
        Err(err) => warn!("Failed to access store for product analytics session: {err}"),
    }

    let journal = load_event_journal(app);
    match load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY) {
        Ok(mut loaded) => {
            if let Ok((journal_outbox, corrupt)) = &journal {
                merge_outbox(&mut loaded, journal_outbox.clone());
                if *corrupt {
                    PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                    warn!("Product analytics journal contained an incomplete record");
                }
            }
            match load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY) {
                Ok(recovery) => {
                    merge_outbox(&mut loaded, recovery);
                    let consolidation = write_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY, &loaded)
                        .and_then(|()| {
                            delete_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY)
                        })
                        .and_then(|()| delete_legacy_store_outbox_encryption_keys(app))
                        .and_then(|()| match journal {
                            Ok(_) => truncate_event_journal(app),
                            Err(ref failure_class) => Err(failure_class.clone()),
                        });
                    if let Err(failure_class) = consolidation {
                        PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(true, Ordering::Release);
                        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                        warn!(
                            failure_class,
                            "Failed to consolidate product analytics recovery outbox"
                        );
                    } else {
                        PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(false, Ordering::Release);
                    }
                }
                Err(failure_class) => {
                    PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(true, Ordering::Release);
                    PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                    warn!(
                        failure_class,
                        "Failed to restore product analytics recovery outbox"
                    );
                }
            }
            let has_pending = !loaded.pending.is_empty()
                || !loaded.dead_letters.is_empty()
                || !loaded.loss_summaries.is_empty()
                || !loaded.loss_reports_in_flight.is_empty();
            *outbox_guard() = loaded;
            if has_pending {
                let _ = product_event_sender(app).try_send(());
            }
        }
        Err(failure_class) => {
            PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(true, Ordering::Release);
            PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
            match load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY) {
                Ok(mut recovery) => {
                    if let Ok((journal_outbox, corrupt)) = &journal {
                        merge_outbox(&mut recovery, journal_outbox.clone());
                        if *corrupt {
                            PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                            warn!("Product analytics journal contained an incomplete record");
                        }
                    }
                    *outbox_guard() = recovery;
                }
                Err(recovery_failure_class) => {
                    PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                    warn!(
                        failure_class = recovery_failure_class,
                        "Failed to restore product analytics recovery outbox"
                    );
                }
            }
            warn!(
                failure_class,
                "Failed to restore encrypted product analytics outbox"
            );
            let has_pending = {
                let outbox = outbox_guard();
                !outbox.pending.is_empty()
                    || !outbox.dead_letters.is_empty()
                    || !outbox.loss_summaries.is_empty()
                    || !outbox.loss_reports_in_flight.is_empty()
            };
            if has_pending {
                let _ = product_event_sender(app).try_send(());
            }
        }
    }
}

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(true);
static PRODUCT_EVENT_SESSION_ID: OnceLock<Uuid> = OnceLock::new();
static PRODUCT_EVENT_SENDER: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static PRODUCT_EVENT_OUTBOX: OnceLock<Mutex<ProductEventOutbox>> = OnceLock::new();
static PRODUCT_EVENT_DEAD_LETTER_RETRY_ATTEMPTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY: OnceLock<[u8; 32]> = OnceLock::new();
static PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED: AtomicBool = AtomicBool::new(false);
static PRODUCT_EVENTS_DROPPED: AtomicU64 = AtomicU64::new(0);
static PRODUCT_EVENT_RETRIES: AtomicU64 = AtomicU64::new(0);
static PRODUCT_EVENT_DEAD_LETTERS: AtomicU64 = AtomicU64::new(0);
static PRODUCT_EVENT_PERSISTENCE_FAILURES: AtomicU64 = AtomicU64::new(0);

pub fn set_telemetry_enabled(app: &AppHandle, enabled: bool) {
    TELEMETRY_ENABLED.store(enabled, Ordering::Release);
    if !enabled && let Err(failure_class) = purge_stored_product_analytics(app) {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
        warn!(
            failure_class,
            "Failed to purge opted-out product analytics state"
        );
    }
}

pub fn telemetry_enabled() -> bool {
    TELEMETRY_ENABLED.load(Ordering::Acquire)
}

pub fn capture_event(app: &AppHandle, event: ProductAnalyticsEvent) {
    if !live_telemetry_enabled(app) {
        return;
    }

    let anonymous_id = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|settings| settings.instance_id.to_string())
        .unwrap_or_else(|| {
            PRODUCT_EVENT_SESSION_ID
                .get_or_init(Uuid::new_v4)
                .to_string()
        });
    let data = event_data(event);

    if let Some(event) = product_event(&data, anonymous_id) {
        if let Err(failure_class) = enqueue_product_event(app, event) {
            warn!(
                failure_class,
                "Critical product analytics event is retained only in process memory"
            );
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn capture_client_product_analytics_event(
    app: AppHandle,
    event_id: String,
    event_name: String,
    occurred_at: String,
    properties: String,
) -> Result<(), String> {
    if !live_telemetry_enabled(&app) {
        return Ok(());
    }
    let event_name = desktop_client_product_event_name(&event_name)
        .ok_or_else(|| "unregistered_product_event".to_string())?;
    Uuid::parse_str(&event_id).map_err(|_| "invalid_product_event_id".to_string())?;
    chrono::DateTime::parse_from_rfc3339(&occurred_at)
        .map_err(|_| "invalid_product_event_timestamp".to_string())?;
    let properties = serde_json::from_str::<Map<String, Value>>(&properties)
        .map_err(|_| "invalid_product_event_properties".to_string())?;
    let data = EventData {
        name: event_name,
        properties,
    };
    let anonymous_id = GeneralSettingsStore::get(&app)
        .ok()
        .flatten()
        .map(|settings| settings.instance_id.to_string())
        .unwrap_or_else(|| {
            PRODUCT_EVENT_SESSION_ID
                .get_or_init(Uuid::new_v4)
                .to_string()
        });
    enqueue_product_event(
        &app,
        ProductEvent {
            event_id,
            event_name: event_name.to_string(),
            occurred_at,
            anonymous_id,
            session_id: PRODUCT_EVENT_SESSION_ID
                .get_or_init(Uuid::new_v4)
                .to_string(),
            platform: "desktop".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            properties: product_event_properties(&data),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording_started() -> ProductAnalyticsEvent {
        ProductAnalyticsEvent::RecordingStarted {
            mode: "studio",
            target_kind: "screen",
            has_camera: true,
            has_mic: true,
            has_system_audio: false,
            target_fps: 60,
            target_width: 1920,
            target_height: 1080,
            fragmented: true,
            custom_cursor_capture: true,
        }
    }

    #[test]
    fn core_product_event_catalog_is_intentionally_small() {
        let included = [
            "recording_started",
            "recording_start_failed",
            "recording_completed",
            "multipart_upload_complete",
            "multipart_upload_failed",
            "recording_recovery_failed",
            "analytics_delivery_loss",
        ];
        let excluded = [
            "recording_recovered",
            "recording_muxer_crashed",
            "recording_audio_degraded",
            "recording_disk_space_low",
            "recording_disk_space_exhausted",
            "recording_device_lost",
            "recording_encoder_rebuilt",
            "recording_source_audio_reset",
            "recording_capture_target_lost",
        ];

        assert!(included.into_iter().all(is_core_product_event));
        assert!(!excluded.into_iter().any(is_core_product_event));
    }

    #[test]
    fn recording_started_has_scalar_properties() {
        let data = event_data(recording_started());

        assert_eq!(data.name, "recording_started");
        assert_eq!(data.properties["mode"], "studio");
        assert_eq!(data.properties["target_fps"], 60);
        assert_eq!(data.properties["has_camera"], true);
        assert!(data.properties.values().all(|value| {
            value.is_null() || value.is_boolean() || value.is_number() || value.is_string()
        }));
    }

    #[test]
    fn recording_start_failure_is_bounded_and_excludes_raw_errors() {
        let data = event_data(ProductAnalyticsEvent::RecordingStartFailed {
            mode: "instant",
            error: "/Users/private/recording.cap permission denied".to_string(),
        });
        let event = product_event(&data, "install-id".to_string()).unwrap();

        assert_eq!(event.event_name, "recording_start_failed");
        assert_eq!(event.properties["mode"], "instant");
        assert_eq!(event.properties["failure_class"], "permission");
        assert!(!event.properties.contains_key("error"));
    }

    #[test]
    fn product_event_reuses_install_id_and_process_session() {
        let data = event_data(recording_started());
        let first = product_event(&data, "install-id".to_string()).unwrap();
        let second = product_event(&data, "install-id".to_string()).unwrap();

        assert_eq!(first.anonymous_id, "install-id");
        assert_eq!(second.anonymous_id, "install-id");
        assert_eq!(first.session_id, second.session_id);
        assert_ne!(first.event_id, second.event_id);
        assert_eq!(first.platform, "desktop");
    }

    #[test]
    fn product_events_remove_raw_error_details_before_networking() {
        let data = event_data(ProductAnalyticsEvent::MultipartUploadFailed {
            duration: Duration::from_secs(2),
            error: "/Users/private/recording.cap failed".to_string(),
        });
        let event = product_event(&data, "install-id".to_string()).unwrap();

        assert!(!event.properties.contains_key("error"));
        assert_eq!(event.properties["duration"], 2);
        assert_eq!(event.properties["failure_class"], "unknown");
    }

    #[test]
    fn truncation_is_safe_for_multibyte_text() {
        let value = "🙂".repeat(100);
        let truncated = truncate_reason(value);

        assert!(truncated.ends_with('…'));
        assert!(truncated.len() <= 243);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn batch_contract_uses_expected_camel_case_fields() {
        let data = event_data(recording_started());
        let event = product_event(&data, "install-id".to_string()).unwrap();
        let json = serde_json::to_value(ProductEventBatch { events: &[event] }).unwrap();
        let serialized = &json["events"][0];

        assert!(serialized.get("eventId").is_some());
        assert_eq!(serialized["eventName"], "recording_started");
        assert_eq!(serialized["anonymousId"], "install-id");
        assert_eq!(serialized["platform"], "desktop");
        assert!(serialized.get("occurredAt").is_some());
        assert!(serialized.get("sessionId").is_some());
        assert!(serialized.get("appVersion").is_some());
    }

    #[test]
    fn encrypted_outbox_round_trips_without_plaintext_event_data() {
        let data = event_data(recording_started());
        let event = product_event(&data, "install-id".to_string()).unwrap();
        let event_id = event.event_id.clone();
        let outbox = ProductEventOutbox {
            pending: vec![event],
            ..ProductEventOutbox::default()
        };
        let key = [7_u8; 32];

        let encrypted = encrypt_outbox_with_key(&outbox, &key).unwrap();
        assert!(!encrypted.contains("recording_started"));
        assert!(!encrypted.contains(&event_id));

        let decrypted = decrypt_outbox_with_key(&encrypted, &key).unwrap();
        assert_eq!(decrypted.pending.len(), 1);
        assert_eq!(decrypted.pending[0].event_id, event_id);
    }

    #[test]
    fn encrypted_durable_journal_enqueue_meets_latency_and_size_budgets() {
        let data = event_data(recording_started());
        let event = product_event(&data, "install-id".to_string()).unwrap();
        let mut pending = Vec::with_capacity(PRODUCT_EVENT_OUTBOX_CAPACITY);
        for index in 0..PRODUCT_EVENT_OUTBOX_CAPACITY {
            let mut queued = event.clone();
            queued.event_id = format!("event-{index}");
            pending.push(queued);
        }
        let full_snapshot = encrypt_outbox_with_key(
            &ProductEventOutbox {
                pending,
                ..ProductEventOutbox::default()
            },
            &[7_u8; 32],
        )
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal");
        let encryption_key = [7_u8; 32];
        let warmup_sample_count = 10;
        let measured_sample_count = 100;
        let mut failures = 0_usize;
        let mut appended_bytes = 0_usize;
        for index in 0..warmup_sample_count {
            let mut warmup_event = event.clone();
            warmup_event.event_id = format!("warmup-{index}");
            match append_encrypted_event_journal(&path, &warmup_event, &encryption_key) {
                Ok(bytes) => appended_bytes = appended_bytes.saturating_add(bytes),
                Err(_) => failures = failures.saturating_add(1),
            }
        }

        let mut timings = Vec::with_capacity(measured_sample_count);
        let mut record_sizes = Vec::with_capacity(measured_sample_count);
        let measured_started = std::time::Instant::now();
        for index in 0..measured_sample_count {
            let mut measured_event = event.clone();
            measured_event.event_id = format!("measured-{index}");
            let started = std::time::Instant::now();
            match append_encrypted_event_journal(&path, &measured_event, &encryption_key) {
                Ok(bytes) => {
                    timings.push(started.elapsed());
                    record_sizes.push(bytes);
                    appended_bytes = appended_bytes.saturating_add(bytes);
                }
                Err(_) => failures = failures.saturating_add(1),
            }
        }
        let measured_elapsed = measured_started.elapsed();
        timings.sort_unstable();
        let p50 = timings.get(49).copied().unwrap_or(Duration::MAX);
        let p95 = timings.get(94).copied().unwrap_or(Duration::MAX);
        let p99 = timings.get(98).copied().unwrap_or(Duration::MAX);
        let throughput = timings.len() as f64 / measured_elapsed.as_secs_f64();
        let journal_size = usize::try_from(fs::metadata(&path).unwrap().len()).unwrap();
        let max_record_size = record_sizes.iter().copied().max().unwrap_or(usize::MAX);

        eprintln!(
            "CAP_ANALYTICS_DESKTOP_PERF={{\"samples\":{},\"failures\":{},\"p50_ms\":{:.3},\"p95_ms\":{:.3},\"p99_ms\":{:.3},\"throughput_events_per_second\":{:.2},\"journal_bytes\":{},\"max_record_bytes\":{},\"full_snapshot_bytes\":{}}}",
            timings.len(),
            failures,
            p50.as_secs_f64() * 1_000.0,
            p95.as_secs_f64() * 1_000.0,
            p99.as_secs_f64() * 1_000.0,
            throughput,
            journal_size,
            max_record_size,
            full_snapshot.len()
        );

        assert_eq!(failures, 0);
        assert_eq!(timings.len(), measured_sample_count);
        assert_eq!(journal_size, appended_bytes);
        assert!(journal_size < full_snapshot.len());
        assert!(max_record_size.saturating_mul(10) < full_snapshot.len());
        assert!(p50 < Duration::from_millis(25));
        assert!(p95 < Duration::from_millis(50));
        assert!(p99 < Duration::from_millis(100));
        assert!(throughput >= 20.0);
    }

    #[test]
    fn encrypted_outbox_tries_every_persisted_key_without_replacing_it() {
        let data = event_data(recording_started());
        let event = product_event(&data, "install-id".to_string()).unwrap();
        let event_id = event.event_id.clone();
        let outbox = ProductEventOutbox {
            pending: vec![event],
            ..ProductEventOutbox::default()
        };
        let valid_key = [7_u8; 32];
        let encrypted = encrypt_outbox_with_key(&outbox, &valid_key).unwrap();

        let (decrypted, selected_key) =
            decrypt_outbox_with_keys(&encrypted, &[[8_u8; 32], valid_key]).unwrap();

        assert_eq!(selected_key, valid_key);
        assert_eq!(decrypted.pending[0].event_id, event_id);
    }

    #[test]
    fn keyring_outbox_key_requires_a_valid_aes_key() {
        let key = [7_u8; 32];

        assert_eq!(
            decode_outbox_encryption_key(&BASE64.encode(key)).unwrap(),
            key
        );
        assert!(decode_outbox_encryption_key("invalid").is_err());
    }

    #[test]
    fn legacy_outbox_keys_remain_readable_during_migration() {
        let first = [7_u8; 32];
        let second = [8_u8; 32];

        assert_eq!(
            decode_legacy_outbox_encryption_keys(&Value::String(BASE64.encode(first))).unwrap(),
            vec![first]
        );
        assert_eq!(
            decode_legacy_outbox_encryption_keys(&serde_json::json!([
                BASE64.encode(first),
                BASE64.encode(second)
            ]))
            .unwrap(),
            vec![first, second]
        );
    }

    #[test]
    fn fallback_key_file_is_created_once_and_concurrent_initializers_adopt_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("outbox-key");
        let first = [7_u8; 32];

        assert_eq!(initialize_file_outbox_key(&path, first).unwrap(), first);

        assert_eq!(read_file_outbox_key(&path).unwrap(), Some(first));
        assert_eq!(
            initialize_file_outbox_key(&path, [8_u8; 32]).unwrap(),
            first
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn recovery_outbox_merge_preserves_unique_events() {
        let first =
            product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
        let mut duplicate = first.clone();
        duplicate.event_name = "recording_completed".to_string();
        let second = product_event(
            &event_data(recording_started()),
            "second-install-id".to_string(),
        )
        .unwrap();
        let mut target = ProductEventOutbox {
            pending: vec![first.clone()],
            ..ProductEventOutbox::default()
        };

        merge_outbox(
            &mut target,
            ProductEventOutbox {
                pending: vec![duplicate, second.clone()],
                ..ProductEventOutbox::default()
            },
        );

        assert_eq!(target.pending.len(), 2);
        assert_eq!(target.pending[0].event_name, first.event_name);
        assert_eq!(target.pending[1].event_id, second.event_id);
    }

    #[test]
    fn dead_letter_capacity_never_evicts_recoverable_events() {
        let mut outbox = ProductEventOutbox::default();
        for index in 0..PRODUCT_EVENT_DEAD_LETTER_CAPACITY {
            let mut event =
                product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
            event.event_id = format!("dead-letter-{index}");
            outbox.dead_letters.push(ProductEventDeadLetter {
                event,
                failure_class: "contract_rejected".to_string(),
                status: Some(400),
                failed_at: "2026-08-01T00:00:00Z".to_string(),
            });
        }
        let oldest_id = outbox.dead_letters[0].event.event_id.clone();
        let event = product_event(
            &event_data(recording_started()),
            "overflow-install-id".to_string(),
        )
        .unwrap();
        let event_id = event.event_id.clone();
        outbox.pending = (0..PRODUCT_EVENT_OUTBOX_CAPACITY)
            .map(|index| {
                let mut pending = event.clone();
                pending.event_id = format!("pending-{index}");
                pending
            })
            .collect();

        let (wake, dead_lettered, dropped) = insert_product_event(
            &mut outbox,
            event,
            1_785_542_400_000,
            "2026-08-01T00:00:00Z",
        );

        assert!(wake);
        assert!(!dead_lettered);
        assert!(dropped);
        assert_eq!(
            outbox.dead_letters.len(),
            PRODUCT_EVENT_DEAD_LETTER_CAPACITY
        );
        assert_eq!(outbox.dead_letters[0].event.event_id, oldest_id);
        assert!(
            !outbox
                .dead_letters
                .iter()
                .any(|entry| entry.event.event_id == event_id)
        );
        assert_eq!(outbox.loss_summaries.len(), 1);
        assert_eq!(
            outbox.loss_summaries[0].failure_class,
            "queue_overflow_unrecoverable"
        );
    }

    #[test]
    fn dead_letters_retry_once_per_process_and_again_after_restart() {
        let mut outbox = ProductEventOutbox::default();
        for index in 0..=PRODUCT_EVENT_BATCH_SIZE {
            let mut event =
                product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
            event.event_id = format!("dead-letter-{index}");
            outbox.dead_letters.push(ProductEventDeadLetter {
                event,
                failure_class: "contract_rejected".to_string(),
                status: Some(400),
                failed_at: "2026-08-01T00:00:00Z".to_string(),
            });
        }
        let mut attempted = HashSet::new();

        let first = select_dead_letter_retry_batch(&outbox, &mut attempted);
        let second = select_dead_letter_retry_batch(&outbox, &mut attempted);
        let exhausted = select_dead_letter_retry_batch(&outbox, &mut attempted);
        let restarted = select_dead_letter_retry_batch(&outbox, &mut HashSet::new());

        assert_eq!(first.len(), PRODUCT_EVENT_BATCH_SIZE);
        assert_eq!(second.len(), 1);
        assert!(exhausted.is_empty());
        assert_eq!(
            restarted
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            first
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(outbox.dead_letters.len(), PRODUCT_EVENT_BATCH_SIZE + 1);
    }

    #[test]
    fn dead_letter_recovery_retains_rejections_and_removes_accepted_events() {
        let event =
            product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
        let mut outbox = ProductEventOutbox {
            dead_letters: vec![ProductEventDeadLetter {
                event: event.clone(),
                failure_class: "contract_rejected".to_string(),
                status: Some(400),
                failed_at: "2026-08-01T00:00:00Z".to_string(),
            }],
            ..ProductEventOutbox::default()
        };
        let error = DeliveryError {
            retryable: false,
            status: Some(422),
        };

        record_dead_letter_retry_rejection_in_outbox(
            &mut outbox,
            std::slice::from_ref(&event),
            &error,
            1_785_542_400_000,
        );

        assert_eq!(outbox.dead_letters.len(), 1);
        assert_eq!(outbox.loss_summaries.len(), 1);
        assert_eq!(
            outbox.loss_summaries[0].failure_class,
            "dead_letter_retry_rejected"
        );
        assert_eq!(outbox.loss_summaries[0].status, Some(422));

        remove_delivered_from_outbox(&mut outbox, &[event]);

        assert!(outbox.dead_letters.is_empty());
    }

    #[test]
    fn loss_report_payload_and_id_survive_encrypted_restart() {
        let event =
            product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
        let mut outbox = ProductEventOutbox::default();
        record_delivery_loss(
            &mut outbox,
            "queue_overflow_unrecoverable",
            &event,
            None,
            1_785_542_400_000,
        );
        let report = loss_report_from_summary(outbox.loss_summaries.remove(0));
        let report_id = report.event_id.clone();
        let report_json = serde_json::to_value(&report).unwrap();
        outbox.loss_reports_in_flight.push(report);
        let key = [9_u8; 32];

        let encrypted = encrypt_outbox_with_key(&outbox, &key).unwrap();
        let restored = decrypt_outbox_with_key(&encrypted, &key).unwrap();

        assert!(!encrypted.contains("queue_overflow_unrecoverable"));
        assert_eq!(restored.loss_reports_in_flight.len(), 1);
        assert_eq!(restored.loss_reports_in_flight[0].event_id, report_id);
        assert_eq!(
            serde_json::to_value(&restored.loss_reports_in_flight[0]).unwrap(),
            report_json
        );
    }

    #[test]
    fn loss_summary_capacity_preserves_counts_across_app_versions() {
        let mut outbox = ProductEventOutbox::default();
        for index in 0..=PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY {
            let mut event =
                product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
            event.app_version = format!("version-{index}");
            record_delivery_loss(
                &mut outbox,
                "queue_overflow_unrecoverable",
                &event,
                None,
                1_785_542_400_000_i64
                    .saturating_add(i64::try_from(index).expect("capacity index fits i64")),
            );
        }

        assert_eq!(
            outbox.loss_summaries.len(),
            PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY
        );
        assert_eq!(
            outbox
                .loss_summaries
                .iter()
                .map(|summary| summary.count)
                .sum::<u64>(),
            u64::try_from(PRODUCT_EVENT_LOSS_SUMMARY_CAPACITY)
                .expect("loss summary capacity fits u64")
                + 1
        );
        let fallback = outbox
            .loss_summaries
            .iter()
            .find(|summary| is_capacity_loss_summary(summary))
            .unwrap();
        assert_eq!(fallback.count, 2);
        assert_eq!(fallback.app_version, "mixed");
    }

    #[test]
    fn recovery_merge_is_idempotent_for_loss_summaries() {
        let event =
            product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
        let mut source = ProductEventOutbox::default();
        record_delivery_loss(
            &mut source,
            "queue_overflow_dead_lettered",
            &event,
            None,
            1_785_542_400_000,
        );
        let mut target = ProductEventOutbox::default();

        merge_outbox(&mut target, source.clone());
        merge_outbox(&mut target, source);

        assert_eq!(target.loss_summaries.len(), 1);
        assert_eq!(target.loss_summaries[0].count, 1);
        assert_eq!(target.next_delivery_sequence, 1);
    }

    #[test]
    fn old_encrypted_outbox_shape_defaults_new_delivery_state() {
        let json = serde_json::json!({ "pending": [], "dead_letters": [] });
        let outbox = serde_json::from_value::<ProductEventOutbox>(json).unwrap();

        assert!(outbox.loss_summaries.is_empty());
        assert!(outbox.loss_reports_in_flight.is_empty());
        assert_eq!(outbox.next_delivery_sequence, 0);
    }

    #[test]
    fn opt_out_clear_removes_all_recoverable_delivery_state() {
        let event =
            product_event(&event_data(recording_started()), "install-id".to_string()).unwrap();
        let mut outbox = ProductEventOutbox {
            pending: vec![event.clone()],
            dead_letters: vec![ProductEventDeadLetter {
                event: event.clone(),
                failure_class: "contract_rejected".to_string(),
                status: Some(400),
                failed_at: "2026-08-01T00:00:00Z".to_string(),
            }],
            ..ProductEventOutbox::default()
        };
        record_delivery_loss(
            &mut outbox,
            "queue_overflow_dead_lettered",
            &event,
            None,
            1_785_542_400_000,
        );
        outbox
            .loss_reports_in_flight
            .push(loss_report_from_summary(outbox.loss_summaries.remove(0)));

        clear_product_event_outbox(&mut outbox);

        assert!(outbox.pending.is_empty());
        assert!(outbox.dead_letters.is_empty());
        assert!(outbox.loss_summaries.is_empty());
        assert!(outbox.loss_reports_in_flight.is_empty());
        assert_eq!(outbox.next_delivery_sequence, 0);
    }

    #[test]
    fn product_status_retry_policy_matches_the_browser() {
        assert!(!should_retry_product_status(400));
        assert!(!should_retry_product_status(401));
        assert!(should_retry_product_status(429));
        assert!(should_retry_product_status(503));
    }
}
