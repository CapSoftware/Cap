use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    future::Future,
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use tokio::sync::mpsc;
use tracing::{debug, error, warn};
use uuid::Uuid;

use crate::{
    auth::{AuthSecret, AuthStore},
    general_settings::GeneralSettingsStore,
    web_api::ManagerExt,
};

const PRODUCT_EVENT_QUEUE_CAPACITY: usize = 100;
const PRODUCT_EVENT_BATCH_SIZE: usize = 20;
const PRODUCT_EVENT_BATCH_DELAY: Duration = Duration::from_millis(250);
const PRODUCT_EVENT_RETRY_DELAY: Duration = Duration::from_millis(500);
const PRODUCT_EVENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const PRODUCT_EVENT_SESSION_STORE_KEY: &str = "product_analytics_session_id";

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
            data.set("error", truncate_reason(error));
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
            data.set("reason", truncate_reason(reason));
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductEvent {
    event_id: String,
    event_name: &'static str,
    occurred_at: String,
    anonymous_id: String,
    session_id: String,
    platform: &'static str,
    app_version: &'static str,
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
        event_name: data.name,
        occurred_at: chrono::Utc::now().to_rfc3339(),
        anonymous_id,
        session_id: PRODUCT_EVENT_SESSION_ID
            .get_or_init(Uuid::new_v4)
            .to_string(),
        platform: "desktop",
        app_version: env!("CARGO_PKG_VERSION"),
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

async fn send_product_batch_once(app: &AppHandle, events: &[ProductEvent]) -> Result<(), String> {
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
        .map_err(|err| err.to_string())?;

    if response.status().is_success() || !should_retry_product_status(response.status().as_u16()) {
        Ok(())
    } else {
        Err(format!(
            "product analytics endpoint returned {}",
            response.status()
        ))
    }
}

fn should_retry_product_status(status: u16) -> bool {
    status == 429 || status >= 500
}

async fn retry_once<F, Fut, E>(mut operation: F, retry_delay: Duration) -> Result<(), E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), E>>,
{
    if operation().await.is_ok() {
        return Ok(());
    }

    tokio::time::sleep(retry_delay).await;
    operation().await
}

async fn run_product_event_worker(app: AppHandle, mut receiver: mpsc::Receiver<ProductEvent>) {
    while let Some(first) = receiver.recv().await {
        let mut events = Vec::with_capacity(PRODUCT_EVENT_BATCH_SIZE);
        events.push(first);
        let deadline = tokio::time::Instant::now() + PRODUCT_EVENT_BATCH_DELAY;

        while events.len() < PRODUCT_EVENT_BATCH_SIZE {
            match tokio::time::timeout_at(deadline, receiver.recv()).await {
                Ok(Some(event)) => events.push(event),
                Ok(None) | Err(_) => break,
            }
        }

        if !live_telemetry_enabled(&app) {
            continue;
        }

        if let Err(err) = retry_once(
            || send_product_batch_once(&app, &events),
            PRODUCT_EVENT_RETRY_DELAY,
        )
        .await
        {
            warn!(
                event_count = events.len(),
                "Dropping product analytics batch after one retry: {err}"
            );
        }
    }
}

fn enqueue_product_event(app: &AppHandle, event: ProductEvent) {
    let sender = PRODUCT_EVENT_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel(PRODUCT_EVENT_QUEUE_CAPACITY);
        tokio::spawn(run_product_event_worker(app.clone(), receiver));
        sender
    });

    if let Err(err) = sender.try_send(event) {
        let dropped = PRODUCT_EVENTS_DROPPED.fetch_add(1, Ordering::Relaxed) + 1;
        if dropped.is_power_of_two() {
            debug!(
                dropped,
                reason = %err,
                "Product analytics queue is unavailable; event dropped"
            );
        }
    }
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
}

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(true);
static PRODUCT_EVENT_SESSION_ID: OnceLock<Uuid> = OnceLock::new();
static PRODUCT_EVENT_SENDER: OnceLock<mpsc::Sender<ProductEvent>> = OnceLock::new();
static PRODUCT_EVENTS_DROPPED: AtomicU64 = AtomicU64::new(0);

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
    let mut data = event_data(event);
    data.set("cap_version", env!("CARGO_PKG_VERSION"));
    data.set("os", std::env::consts::OS);
    data.set("arch", std::env::consts::ARCH);

    if let Some(event) = product_event(&data, anonymous_id) {
        enqueue_product_event(app, event);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    #[tokio::test]
    async fn retry_once_stops_after_success() {
        let attempts = AtomicUsize::new(0);

        let result = retry_once(
            || {
                let attempt = attempts.fetch_add(1, Ordering::Relaxed);
                async move {
                    if attempt == 0 {
                        Err("temporary")
                    } else {
                        Ok(())
                    }
                }
            },
            Duration::ZERO,
        )
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(attempts.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn retry_once_never_attempts_more_than_twice() {
        let attempts = AtomicUsize::new(0);

        let result = retry_once(
            || {
                attempts.fetch_add(1, Ordering::Relaxed);
                async { Err::<(), _>("offline") }
            },
            Duration::ZERO,
        )
        .await;

        assert_eq!(result, Err("offline"));
        assert_eq!(attempts.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn product_status_retry_policy_matches_the_browser() {
        assert!(!should_retry_product_status(400));
        assert!(!should_retry_product_status(401));
        assert!(should_retry_product_status(429));
        assert!(should_retry_product_status(503));
    }
}
