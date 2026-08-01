use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::AppHandle;
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
const PRODUCT_EVENT_OUTBOX_KEYRING_SERVICE: &str = "so.cap.desktop";
const PRODUCT_EVENT_OUTBOX_KEYRING_USER: &str = "product-analytics-outbox-v1";
const PRODUCT_EVENT_OUTBOX_KEYRING_BACKUP_USER: &str = "product-analytics-outbox-v1-backup";
const PRODUCT_EVENT_OUTBOX_CAPACITY: usize = 500;
const PRODUCT_EVENT_DEAD_LETTER_CAPACITY: usize = 100;
const PRODUCT_EVENT_MAX_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);

#[derive(Debug)]
pub enum ProductAnalyticsEvent {
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
            | "multipart_upload_complete"
            | "multipart_upload_failed"
            | "recording_recovery_failed"
    )
}

fn desktop_client_product_event_name(name: &str) -> Option<&'static str> {
    match name {
        "user_signed_in" => Some("user_signed_in"),
        "user_signed_out" => Some("user_signed_out"),
        "recording_started" => Some("recording_started"),
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

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ProductEventDeadLetter {
    event: ProductEvent,
    failure_class: String,
    status: Option<u16>,
    failed_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct ProductEventOutbox {
    pending: Vec<ProductEvent>,
    dead_letters: Vec<ProductEventDeadLetter>,
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
        .decode(encoded)
        .map_err(|_| "invalid_keyring_value".to_string())?
        .try_into()
        .map_err(|_| "invalid_keyring_value".to_string())
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
        PRODUCT_EVENT_OUTBOX_KEYRING_BACKUP_USER,
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

fn outbox_encryption_key(_app: &AppHandle) -> Result<&'static [u8; 32], String> {
    if let Some(key) = PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY.get() {
        return Ok(key);
    }

    let keys = keyring_outbox_encryption_keys()?;
    let key = if let Some(key) = keys.first() {
        *key
    } else {
        let mut generated = [0_u8; 32];
        SystemRandom::new()
            .fill(&mut generated)
            .map_err(|_| "key_generation_failed".to_string())?;
        persist_keyring_outbox_key(PRODUCT_EVENT_OUTBOX_KEYRING_USER, generated)?;
        generated
    };
    let _ = persist_keyring_outbox_key(PRODUCT_EVENT_OUTBOX_KEYRING_USER, key);
    let _ = persist_keyring_outbox_key(PRODUCT_EVENT_OUTBOX_KEYRING_BACKUP_USER, key);
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

fn decrypt_outbox(value: &str) -> Result<ProductEventOutbox, String> {
    if let Some(key) = PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY.get()
        && let Ok(outbox) = decrypt_outbox_with_key(value, key)
    {
        return Ok(outbox);
    }

    let candidates = keyring_outbox_encryption_keys()?;
    let (outbox, key) = decrypt_outbox_with_keys(value, &candidates)?;
    let _ = PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY.set(key);
    Ok(outbox)
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
    decrypt_outbox(encrypted)
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
}

fn persist_outbox(app: &AppHandle, outbox: &mut ProductEventOutbox) -> Result<(), String> {
    if !PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.load(Ordering::Acquire) {
        return write_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY, outbox);
    }

    let Ok(mut restored) = load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY) else {
        return write_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY, outbox);
    };
    merge_outbox(&mut restored, outbox.clone());
    let recovery = load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY)?;
    merge_outbox(&mut restored, recovery);
    write_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY, &restored)?;
    delete_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY)?;
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

fn persist_current_outbox(app: &AppHandle) {
    let mut outbox = outbox_guard();
    if let Err(failure_class) = persist_outbox(app, &mut outbox) {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
        warn!(
            failure_class,
            "Failed to persist encrypted product analytics outbox"
        );
    }
}

fn remove_delivered_events(app: &AppHandle, delivered: &[ProductEvent]) {
    let delivered_ids = delivered
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut outbox = outbox_guard();
    outbox
        .pending
        .retain(|event| !delivered_ids.contains(event.event_id.as_str()));
    if let Err(failure_class) = persist_outbox(app, &mut outbox) {
        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
        warn!(
            failure_class,
            "Failed to persist delivered product analytics state"
        );
    }
}

fn move_to_dead_letters(app: &AppHandle, events: &[ProductEvent], error: &DeliveryError) {
    let failed_ids = events
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut outbox = outbox_guard();
    outbox
        .pending
        .retain(|event| !failed_ids.contains(event.event_id.as_str()));
    for event in events {
        if outbox.dead_letters.len() >= PRODUCT_EVENT_DEAD_LETTER_CAPACITY {
            outbox.dead_letters.remove(0);
            PRODUCT_EVENTS_DROPPED.fetch_add(1, Ordering::Relaxed);
        }
        outbox.dead_letters.push(ProductEventDeadLetter {
            event: event.clone(),
            failure_class: "contract_rejected".to_string(),
            status: error.status,
            failed_at: chrono::Utc::now().to_rfc3339(),
        });
    }
    PRODUCT_EVENT_DEAD_LETTERS.fetch_add(events.len() as u64, Ordering::Relaxed);
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
            let events = {
                let outbox = outbox_guard();
                outbox
                    .pending
                    .iter()
                    .take(PRODUCT_EVENT_BATCH_SIZE)
                    .cloned()
                    .collect::<Vec<_>>()
            };
            if events.is_empty() {
                break;
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

fn enqueue_product_event(app: &AppHandle, event: ProductEvent) {
    let should_wake = {
        let mut outbox = outbox_guard();
        if outbox.pending.len() >= PRODUCT_EVENT_OUTBOX_CAPACITY {
            if outbox.dead_letters.len() >= PRODUCT_EVENT_DEAD_LETTER_CAPACITY {
                outbox.dead_letters.remove(0);
                PRODUCT_EVENTS_DROPPED.fetch_add(1, Ordering::Relaxed);
            }
            outbox.dead_letters.push(ProductEventDeadLetter {
                event,
                failure_class: "queue_overflow".to_string(),
                status: None,
                failed_at: chrono::Utc::now().to_rfc3339(),
            });
            PRODUCT_EVENT_DEAD_LETTERS.fetch_add(1, Ordering::Relaxed);
            false
        } else {
            outbox.pending.push(event);
            true
        }
    };
    persist_current_outbox(app);

    let sender = product_event_sender(app);

    if should_wake && let Err(mpsc::error::TrySendError::Closed(_)) = sender.try_send(()) {
        warn!("Product analytics worker is unavailable; event remains in the encrypted outbox");
    }
}

fn product_event_sender(app: &AppHandle) -> &'static mpsc::Sender<()> {
    PRODUCT_EVENT_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel(PRODUCT_EVENT_QUEUE_CAPACITY);
        tokio::spawn(run_product_event_worker(app.clone(), receiver));
        sender
    })
}

pub fn init_product_session(app: &AppHandle) {
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

    match load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY) {
        Ok(mut loaded) => {
            match load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY) {
                Ok(recovery) => {
                    merge_outbox(&mut loaded, recovery);
                    if let Err(failure_class) =
                        write_outbox(app, PRODUCT_EVENT_OUTBOX_STORE_KEY, &loaded)
                    {
                        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                        warn!(
                            failure_class,
                            "Failed to consolidate product analytics recovery outbox"
                        );
                    } else if let Err(failure_class) =
                        delete_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY)
                    {
                        PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                        warn!(
                            failure_class,
                            "Failed to remove consolidated product analytics recovery outbox"
                        );
                    }
                }
                Err(failure_class) => {
                    PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
                    warn!(
                        failure_class,
                        "Failed to restore product analytics recovery outbox"
                    );
                }
            }
            PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(false, Ordering::Release);
            let has_pending = !loaded.pending.is_empty();
            *outbox_guard() = loaded;
            if has_pending {
                let _ = product_event_sender(app).try_send(());
            }
        }
        Err(failure_class) => {
            PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED.store(true, Ordering::Release);
            PRODUCT_EVENT_PERSISTENCE_FAILURES.fetch_add(1, Ordering::Relaxed);
            match load_stored_outbox(app, PRODUCT_EVENT_OUTBOX_RECOVERY_STORE_KEY) {
                Ok(recovery) => *outbox_guard() = recovery,
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
            if !outbox_guard().pending.is_empty() {
                let _ = product_event_sender(app).try_send(());
            }
        }
    }
}

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(true);
static PRODUCT_EVENT_SESSION_ID: OnceLock<Uuid> = OnceLock::new();
static PRODUCT_EVENT_SENDER: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static PRODUCT_EVENT_OUTBOX: OnceLock<Mutex<ProductEventOutbox>> = OnceLock::new();
static PRODUCT_EVENT_OUTBOX_ENCRYPTION_KEY: OnceLock<[u8; 32]> = OnceLock::new();
static PRODUCT_EVENT_OUTBOX_RESTORE_BLOCKED: AtomicBool = AtomicBool::new(false);
static PRODUCT_EVENTS_DROPPED: AtomicU64 = AtomicU64::new(0);
static PRODUCT_EVENT_RETRIES: AtomicU64 = AtomicU64::new(0);
static PRODUCT_EVENT_DEAD_LETTERS: AtomicU64 = AtomicU64::new(0);
static PRODUCT_EVENT_PERSISTENCE_FAILURES: AtomicU64 = AtomicU64::new(0);

pub fn set_telemetry_enabled(enabled: bool) {
    TELEMETRY_ENABLED.store(enabled, Ordering::Release);
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
        enqueue_product_event(app, event);
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
    );
    Ok(())
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
            "recording_completed",
            "multipart_upload_complete",
            "multipart_upload_failed",
            "recording_recovery_failed",
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
            dead_letters: Vec::new(),
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
    fn encrypted_outbox_tries_every_persisted_key_without_replacing_it() {
        let data = event_data(recording_started());
        let event = product_event(&data, "install-id".to_string()).unwrap();
        let event_id = event.event_id.clone();
        let outbox = ProductEventOutbox {
            pending: vec![event],
            dead_letters: Vec::new(),
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
            dead_letters: Vec::new(),
        };

        merge_outbox(
            &mut target,
            ProductEventOutbox {
                pending: vec![duplicate, second.clone()],
                dead_letters: Vec::new(),
            },
        );

        assert_eq!(target.pending.len(), 2);
        assert_eq!(target.pending[0].event_name, first.event_name);
        assert_eq!(target.pending[1].event_id, second.event_id);
    }

    #[test]
    fn product_status_retry_policy_matches_the_browser() {
        assert!(!should_retry_product_status(400));
        assert!(!should_retry_product_status(401));
        assert!(should_retry_product_status(429));
        assert!(should_retry_product_status(503));
    }
}
