use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::{
    ArcLock, RecordingState,
    auth::{AuthSecret, AuthStore},
    http_client::HttpClient,
    web_api::ManagerExt,
};

pub const UPLOAD_HEALTH_PATH: &str = "/api/desktop/upload-health";
pub const PROBE_PAYLOAD_BYTES: usize = 256 * 1024;
const RTT_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const UPLOAD_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MIN_EFFECTIVE_UPLOAD_WINDOW: Duration = Duration::from_millis(25);
const DEFAULT_SUPPORT_URL: &str = "https://cap.so/support";

pub const RESOLUTION_HIGH_1080P: u32 = 1920;
pub const RESOLUTION_MEDIUM_720P: u32 = 1280;
pub const RESOLUTION_LOW_540P: u32 = 960;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UploadHealthState {
    Checking,
    Healthy,
    Degraded,
    Unavailable,
    Unauthenticated,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadHealthStatus {
    pub state: UploadHealthState,
    pub upload_mbps: Option<f64>,
    pub recommended_max_resolution: u32,
    pub quality_label: String,
    pub message: String,
    pub support_url: String,
    pub checked_at_unix_ms: Option<f64>,
}

impl Default for UploadHealthStatus {
    fn default() -> Self {
        Self {
            state: UploadHealthState::Checking,
            upload_mbps: None,
            recommended_max_resolution: RESOLUTION_HIGH_1080P,
            quality_label: "1080p".to_string(),
            message: "Checking upload connection and speed...".to_string(),
            support_url: DEFAULT_SUPPORT_URL.to_string(),
            checked_at_unix_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct UploadHealthUpdated {
    pub status: UploadHealthStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadHealthApiResponse {
    ok: bool,
    received_bytes: Option<usize>,
    storage_ready: Option<bool>,
    error: Option<String>,
}

#[derive(Default)]
pub struct UploadHealthManager {
    status: RwLock<UploadHealthStatus>,
    in_flight: Mutex<Option<CancellationToken>>,
}

pub fn recommended_resolution_for_mbps(upload_mbps: f64) -> (u32, &'static str, UploadHealthState) {
    if !upload_mbps.is_finite() || upload_mbps <= 0.0 {
        return (
            RESOLUTION_LOW_540P,
            "540p",
            UploadHealthState::Degraded,
        );
    }
    if upload_mbps >= 8.0 {
        (
            RESOLUTION_HIGH_1080P,
            "1080p",
            UploadHealthState::Healthy,
        )
    } else if upload_mbps >= 3.5 {
        (
            RESOLUTION_MEDIUM_720P,
            "720p",
            UploadHealthState::Healthy,
        )
    } else {
        (
            RESOLUTION_LOW_540P,
            "540p",
            UploadHealthState::Degraded,
        )
    }
}

pub fn compute_debiased_upload_mbps(
    payload_bytes: usize,
    received_bytes: Option<usize>,
    post_elapsed: Duration,
    rtt_estimate: Option<Duration>,
) -> Option<f64> {
    if payload_bytes == 0 {
        return None;
    }
    if let Some(received) = received_bytes
        && received != payload_bytes
    {
        return None;
    }

    let effective_duration = match rtt_estimate {
        Some(rtt) if post_elapsed > rtt => {
            (post_elapsed - rtt).max(MIN_EFFECTIVE_UPLOAD_WINDOW)
        }
        _ => post_elapsed.max(MIN_EFFECTIVE_UPLOAD_WINDOW),
    };

    let seconds = effective_duration.as_secs_f64();
    if seconds <= 0.0 {
        return None;
    }

    let bits = (payload_bytes as f64) * 8.0;
    let mbps = (bits / 1_000_000.0) / seconds;
    Some((mbps * 100.0).round() / 100.0)
}

pub fn cap_resolution_for_upload_speed(
    configured_max_resolution: u32,
    status: &UploadHealthStatus,
) -> u32 {
    if status.upload_mbps.is_some() {
        configured_max_resolution.min(status.recommended_max_resolution)
    } else {
        configured_max_resolution
    }
}

fn now_unix_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

async fn is_recording_pending_or_active(app: &AppHandle) -> bool {
    let Some(app_state) = app.try_state::<ArcLock<crate::App>>() else {
        return false;
    };
    let state = app_state.read().await;
    !matches!(state.recording_state, RecordingState::None)
}

pub async fn cancel_in_flight_probe(app: &AppHandle) {
    if let Some(manager) = app.try_state::<Arc<UploadHealthManager>>() {
        let mut guard = manager.in_flight.lock().await;
        if let Some(token) = guard.take() {
            debug!("Cancelling in-flight upload health probe because recording is starting");
            token.cancel();
        }
    }
}

pub async fn resolve_instant_max_resolution(
    app: &AppHandle,
    configured_max_resolution: u32,
) -> u32 {
    cancel_in_flight_probe(app).await;
    let Some(manager) = app.try_state::<Arc<UploadHealthManager>>() else {
        return configured_max_resolution;
    };
    let status = manager.status.read().await;
    cap_resolution_for_upload_speed(configured_max_resolution, &status)
}

async fn run_probe_once(app: &AppHandle, cancel_token: &CancellationToken) -> UploadHealthStatus {
    let checked_at = Some(now_unix_ms());

    let auth = match AuthStore::get(app) {
        Ok(Some(auth)) => auth,
        Ok(None) => {
            return UploadHealthStatus {
                state: UploadHealthState::Unauthenticated,
                upload_mbps: None,
                recommended_max_resolution: RESOLUTION_HIGH_1080P,
                quality_label: "1080p".to_string(),
                message: "Sign in to test cloud upload speed and health.".to_string(),
                support_url: DEFAULT_SUPPORT_URL.to_string(),
                checked_at_unix_ms: checked_at,
            };
        }
        Err(err) => {
            warn!(%err, "Failed to read auth store for upload health check");
            return UploadHealthStatus {
                state: UploadHealthState::Unavailable,
                upload_mbps: None,
                recommended_max_resolution: RESOLUTION_LOW_540P,
                quality_label: "540p".to_string(),
                message: "Upload check failed. Please contact support.".to_string(),
                support_url: DEFAULT_SUPPORT_URL.to_string(),
                checked_at_unix_ms: checked_at,
            };
        }
    };

    let url = app.make_app_url(UPLOAD_HEALTH_PATH).await;
    let bearer_token = match &auth.secret {
        AuthSecret::ApiKey { api_key } => api_key.clone(),
        AuthSecret::Session { token, .. } => token.clone(),
    };

    let client = app.state::<HttpClient>();

    // Step 1: Fast RTT baseline probe (bounded to 2 seconds) so connection/RTT latency
    // does not artificially depress the measured upload speed.
    let rtt_estimate = {
        let head_started = Instant::now();
        let head_req = client
            .head(&url)
            .header("Authorization", format!("Bearer {bearer_token}"))
            .timeout(RTT_PROBE_TIMEOUT)
            .send();

        tokio::select! {
            _ = cancel_token.cancelled() => return cached_or_default(app).await,
            res = head_req => res.ok().map(|_| head_started.elapsed()),
        }
    };

    if cancel_token.is_cancelled() || is_recording_pending_or_active(app).await {
        return cached_or_default(app).await;
    }

    // Step 2: Upload 256 KiB test probe to /api/desktop/upload-health
    let payload = vec![0x5Au8; PROBE_PAYLOAD_BYTES];
    let post_started = Instant::now();
    let post_req = client
        .post(&url)
        .header("Authorization", format!("Bearer {bearer_token}"))
        .header("Content-Type", "application/octet-stream")
        .timeout(UPLOAD_PROBE_TIMEOUT)
        .body(payload)
        .send();

    let response = tokio::select! {
        _ = cancel_token.cancelled() => return cached_or_default(app).await,
        res = post_req => match res {
            Ok(resp) => resp,
            Err(err) => {
                warn!(error = %err.without_url(), "Upload health check request failed");
                return UploadHealthStatus {
                    state: UploadHealthState::Unavailable,
                    upload_mbps: None,
                    recommended_max_resolution: RESOLUTION_LOW_540P,
                    quality_label: "540p".to_string(),
                    message: "Unable to reach Cap upload service. Please check your connection or contact support.".to_string(),
                    support_url: DEFAULT_SUPPORT_URL.to_string(),
                    checked_at_unix_ms: checked_at,
                };
            }
        }
    };

    let post_elapsed = post_started.elapsed();

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        warn!(status_code, "Upload health check returned non-success status");
        return UploadHealthStatus {
            state: UploadHealthState::Unavailable,
            upload_mbps: None,
            recommended_max_resolution: RESOLUTION_LOW_540P,
            quality_label: "540p".to_string(),
            message: format!(
                "Upload health check failed (HTTP {status_code}). Please contact support."
            ),
            support_url: DEFAULT_SUPPORT_URL.to_string(),
            checked_at_unix_ms: checked_at,
        };
    }

    let parsed: UploadHealthApiResponse = match response.json().await {
        Ok(body) => body,
        Err(err) => {
            warn!(%err, "Failed to parse upload health check response");
            return UploadHealthStatus {
                state: UploadHealthState::Unavailable,
                upload_mbps: None,
                recommended_max_resolution: RESOLUTION_LOW_540P,
                quality_label: "540p".to_string(),
                message: "Unexpected response from upload check. Please contact support."
                    .to_string(),
                support_url: DEFAULT_SUPPORT_URL.to_string(),
                checked_at_unix_ms: checked_at,
            };
        }
    };

    if !parsed.ok || parsed.storage_ready == Some(false) {
        return UploadHealthStatus {
            state: UploadHealthState::Unavailable,
            upload_mbps: None,
            recommended_max_resolution: RESOLUTION_LOW_540P,
            quality_label: "540p".to_string(),
            message: parsed.error.unwrap_or_else(|| {
                "Recording upload destination is currently unavailable. Please contact support."
                    .to_string()
            }),
            support_url: DEFAULT_SUPPORT_URL.to_string(),
            checked_at_unix_ms: checked_at,
        };
    }

    let Some(upload_mbps) = compute_debiased_upload_mbps(
        PROBE_PAYLOAD_BYTES,
        parsed.received_bytes,
        post_elapsed,
        rtt_estimate,
    ) else {
        return UploadHealthStatus {
            state: UploadHealthState::Unavailable,
            upload_mbps: None,
            recommended_max_resolution: RESOLUTION_LOW_540P,
            quality_label: "540p".to_string(),
            message: "Upload test payload was truncated. Please check your network or contact support.".to_string(),
            support_url: DEFAULT_SUPPORT_URL.to_string(),
            checked_at_unix_ms: checked_at,
        };
    };

    let (recommended_max_resolution, quality_label, state) =
        recommended_resolution_for_mbps(upload_mbps);

    let message = match state {
        UploadHealthState::Healthy => format!(
            "Upload ready ({upload_mbps:.1} Mbps) · Recording at {quality_label}"
        ),
        UploadHealthState::Degraded => format!(
            "Slow upload ({upload_mbps:.1} Mbps) · Recording scaled to {quality_label} for reliability"
        ),
        _ => "Upload status updated".to_string(),
    };

    info!(
        upload_mbps,
        recommended_max_resolution,
        quality_label,
        "Completed desktop upload speed & health check"
    );

    UploadHealthStatus {
        state,
        upload_mbps: Some(upload_mbps),
        recommended_max_resolution,
        quality_label: quality_label.to_string(),
        message,
        support_url: DEFAULT_SUPPORT_URL.to_string(),
        checked_at_unix_ms: checked_at,
    }
}

async fn cached_or_default(app: &AppHandle) -> UploadHealthStatus {
    if let Some(manager) = app.try_state::<Arc<UploadHealthManager>>() {
        manager.status.read().await.clone()
    } else {
        UploadHealthStatus::default()
    }
}

pub async fn perform_upload_health_check(app: &AppHandle) -> UploadHealthStatus {
    // Do not perform speed/health checks once a recording is pending or active.
    if is_recording_pending_or_active(app).await {
        debug!("Skipping upload speed/health check because a recording is active or pending");
        return cached_or_default(app).await;
    }

    let Some(manager) = app.try_state::<Arc<UploadHealthManager>>() else {
        return UploadHealthStatus::default();
    };

    let token = {
        let mut in_flight = manager.in_flight.lock().await;
        if in_flight.is_some() {
            debug!("Upload health check already in flight; returning cached status");
            return manager.status.read().await.clone();
        }
        let token = CancellationToken::new();
        *in_flight = Some(token.clone());
        token
    };

    let new_status = run_probe_once(app, &token).await;

    {
        let mut in_flight = manager.in_flight.lock().await;
        *in_flight = None;
    }

    // If recording started while the probe was running, discard the probe update.
    if token.is_cancelled() || is_recording_pending_or_active(app).await {
        return manager.status.read().await.clone();
    }

    {
        let mut status_lock = manager.status.write().await;
        *status_lock = new_status.clone();
    }

    let _ = UploadHealthUpdated {
        status: new_status.clone(),
    }
    .emit(app);

    new_status
}

pub fn spawn_startup_check(app: AppHandle) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = perform_upload_health_check(&app).await;
    });
}

#[tauri::command]
#[specta::specta]
pub async fn get_upload_health_status(app: AppHandle) -> Result<UploadHealthStatus, String> {
    Ok(cached_or_default(&app).await)
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_upload_health_status(app: AppHandle) -> Result<UploadHealthStatus, String> {
    Ok(perform_upload_health_check(&app).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_upload_speeds_to_expected_resolution_tiers() {
        let (res_high, label_high, state_high) = recommended_resolution_for_mbps(15.0);
        assert_eq!(res_high, RESOLUTION_HIGH_1080P);
        assert_eq!(label_high, "1080p");
        assert_eq!(state_high, UploadHealthState::Healthy);

        let (res_med, label_med, state_med) = recommended_resolution_for_mbps(5.2);
        assert_eq!(res_med, RESOLUTION_MEDIUM_720P);
        assert_eq!(label_med, "720p");
        assert_eq!(state_med, UploadHealthState::Healthy);

        let (res_low, label_low, state_low) = recommended_resolution_for_mbps(1.8);
        assert_eq!(res_low, RESOLUTION_LOW_540P);
        assert_eq!(label_low, "540p");
        assert_eq!(state_low, UploadHealthState::Degraded);
    }

    #[test]
    fn debiases_rtt_and_validates_received_bytes() {
        // 256 KiB = 262,144 bytes = 2.097152 Mbits.
        // If total POST took 700ms and RTT was 500ms, actual upload window is 200ms -> ~10.49 Mbps.
        let mbps = compute_debiased_upload_mbps(
            PROBE_PAYLOAD_BYTES,
            Some(PROBE_PAYLOAD_BYTES),
            Duration::from_millis(700),
            Some(Duration::from_millis(500)),
        )
        .expect("should compute mbps");
        assert!(mbps > 10.0 && mbps < 11.0, "expected ~10.49 Mbps, got {mbps}");

        // Truncated upload must be rejected
        assert!(
            compute_debiased_upload_mbps(
                PROBE_PAYLOAD_BYTES,
                Some(PROBE_PAYLOAD_BYTES - 10),
                Duration::from_millis(200),
                None,
            )
            .is_none()
        );
    }

    #[test]
    fn caps_configured_resolution_without_exceeding_user_ceiling() {
        let slow_status = UploadHealthStatus {
            state: UploadHealthState::Degraded,
            upload_mbps: Some(2.0),
            recommended_max_resolution: RESOLUTION_LOW_540P,
            quality_label: "540p".to_string(),
            message: String::new(),
            support_url: DEFAULT_SUPPORT_URL.to_string(),
            checked_at_unix_ms: None,
        };
        assert_eq!(
            cap_resolution_for_upload_speed(RESOLUTION_HIGH_1080P, &slow_status),
            RESOLUTION_LOW_540P
        );

        let fast_status = UploadHealthStatus {
            state: UploadHealthState::Healthy,
            upload_mbps: Some(25.0),
            recommended_max_resolution: RESOLUTION_HIGH_1080P,
            quality_label: "1080p".to_string(),
            message: String::new(),
            support_url: DEFAULT_SUPPORT_URL.to_string(),
            checked_at_unix_ms: None,
        };
        assert_eq!(
            cap_resolution_for_upload_speed(RESOLUTION_MEDIUM_720P, &fast_status),
            RESOLUTION_MEDIUM_720P
        );
    }
}
