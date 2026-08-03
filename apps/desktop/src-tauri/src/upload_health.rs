use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use tracing::{debug, warn};

use crate::{
    App, MutableState,
    web_api::{AuthedApiError, ManagerExt},
};

const PROBE_BYTES: usize = 256 * 1024;
const HEALTH_FRESH_FOR: Duration = Duration::from_secs(10 * 60);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const HEALTH_RTT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UploadHealthKind {
    Unknown,
    Healthy,
    Slow,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadHealthStatus {
    pub kind: UploadHealthKind,
    pub upload_mbps: Option<f64>,
    pub max_instant_resolution: Option<u32>,
    pub checked_at_unix_ms: Option<u64>,
    pub stale: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadHealthProbeResponse {
    received_bytes: usize,
}

#[derive(Debug, Clone)]
struct UploadHealthSnapshot {
    kind: UploadHealthKind,
    upload_mbps: Option<f64>,
    max_instant_resolution: Option<u32>,
    checked_at_unix_ms: Option<u64>,
    recorded_at: Option<Instant>,
    message: String,
}

impl Default for UploadHealthSnapshot {
    fn default() -> Self {
        Self {
            kind: UploadHealthKind::Unknown,
            upload_mbps: None,
            max_instant_resolution: None,
            checked_at_unix_ms: None,
            recorded_at: None,
            message: "Upload health has not been checked yet.".to_string(),
        }
    }
}

impl UploadHealthSnapshot {
    fn is_stale(&self) -> bool {
        self.recorded_at
            .is_none_or(|recorded_at| recorded_at.elapsed() > HEALTH_FRESH_FOR)
    }

    fn status(&self) -> UploadHealthStatus {
        UploadHealthStatus {
            kind: self.kind,
            upload_mbps: self.upload_mbps,
            max_instant_resolution: self.max_instant_resolution,
            checked_at_unix_ms: self.checked_at_unix_ms,
            stale: self.is_stale(),
            message: self.message.clone(),
        }
    }
}

#[derive(Default)]
pub struct UploadHealthCache {
    snapshot: Mutex<UploadHealthSnapshot>,
    probe: Mutex<()>,
}

impl UploadHealthCache {
    async fn update(&self, snapshot: UploadHealthSnapshot) -> UploadHealthStatus {
        let mut guard = self.snapshot.lock().await;
        *guard = snapshot;
        guard.status()
    }

    pub async fn status(&self) -> UploadHealthStatus {
        self.snapshot.lock().await.status()
    }

    async fn fresh_instant_resolution_cap(&self) -> Option<u32> {
        let guard = self.snapshot.lock().await;
        if guard.is_stale() {
            return None;
        }

        match guard.kind {
            UploadHealthKind::Healthy | UploadHealthKind::Slow | UploadHealthKind::Unavailable => {
                guard.max_instant_resolution
            }
            UploadHealthKind::Unknown => None,
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn max_resolution_for_upload_mbps(upload_mbps: f64) -> u32 {
    if upload_mbps >= 35.0 {
        3840
    } else if upload_mbps >= 18.0 {
        2560
    } else if upload_mbps >= 6.0 {
        1920
    } else {
        1280
    }
}

fn health_kind_for_resolution(max_resolution: u32) -> UploadHealthKind {
    if max_resolution >= 1920 {
        UploadHealthKind::Healthy
    } else {
        UploadHealthKind::Slow
    }
}

fn probe_payload() -> Vec<u8> {
    vec![0x63; PROBE_BYTES]
}

async fn measure_probe_rtt(app: &AppHandle) -> Option<Duration> {
    let started = Instant::now();
    let response = app
        .authed_api_request("/api/desktop/upload-health", |client, url| {
            client.head(url).timeout(HEALTH_RTT_TIMEOUT)
        })
        .await;

    match response {
        Ok(response) if response.status().is_success() => Some(started.elapsed()),
        Ok(response) => {
            let status = response.status();
            debug!(%status, "Upload health RTT probe returned a non-success status");
            None
        }
        Err(err) => {
            debug!(error = %err, "Upload health RTT probe failed");
            None
        }
    }
}

fn upload_elapsed_after_rtt(total_elapsed: Duration, rtt_elapsed: Option<Duration>) -> Duration {
    let total_elapsed = total_elapsed.max(Duration::from_millis(1));

    let Some(rtt_elapsed) = rtt_elapsed else {
        return total_elapsed;
    };

    match total_elapsed.checked_sub(rtt_elapsed) {
        Some(adjusted_elapsed) if adjusted_elapsed >= Duration::from_millis(50) => adjusted_elapsed,
        _ => total_elapsed,
    }
}

fn upload_mbps_for_bytes(byte_count: usize, elapsed: Duration) -> f64 {
    (byte_count as f64 * 8.0) / elapsed.max(Duration::from_millis(1)).as_secs_f64() / 1_000_000.0
}

async fn run_probe(app: &AppHandle) -> UploadHealthSnapshot {
    let rtt_elapsed = measure_probe_rtt(app).await;
    let payload = probe_payload();
    let payload_len = payload.len();

    let started = Instant::now();
    let response = app
        .authed_api_request("/api/desktop/upload-health", |client, url| {
            client
                .post(url)
                .timeout(HEALTH_REQUEST_TIMEOUT)
                .header("Content-Type", "application/octet-stream")
                .body(payload)
        })
        .await;

    match response {
        Ok(response) if response.status().is_success() => {
            let probe_response = match response.json::<UploadHealthProbeResponse>().await {
                Ok(probe_response) => probe_response,
                Err(err) => {
                    warn!(error = %err, "Upload health probe returned an invalid response");
                    return UploadHealthSnapshot {
                        kind: UploadHealthKind::Unavailable,
                        upload_mbps: None,
                        max_instant_resolution: Some(
                            cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION,
                        ),
                        checked_at_unix_ms: Some(now_unix_ms()),
                        recorded_at: Some(Instant::now()),
                        message: "Upload health check returned an invalid response; Instant quality will be capped."
                            .to_string(),
                    };
                }
            };

            if probe_response.received_bytes != payload_len {
                warn!(
                    expected_bytes = payload_len,
                    received_bytes = probe_response.received_bytes,
                    "Upload health probe received an incomplete payload"
                );
                return UploadHealthSnapshot {
                    kind: UploadHealthKind::Unavailable,
                    upload_mbps: None,
                    max_instant_resolution: Some(cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION),
                    checked_at_unix_ms: Some(now_unix_ms()),
                    recorded_at: Some(Instant::now()),
                    message: "Upload health check received an incomplete probe; Instant quality will be capped."
                        .to_string(),
                };
            }

            let elapsed = upload_elapsed_after_rtt(started.elapsed(), rtt_elapsed);
            let upload_mbps = upload_mbps_for_bytes(probe_response.received_bytes, elapsed);
            let max_resolution = max_resolution_for_upload_mbps(upload_mbps);
            let kind = health_kind_for_resolution(max_resolution);

            UploadHealthSnapshot {
                kind,
                upload_mbps: Some(upload_mbps),
                max_instant_resolution: Some(max_resolution),
                checked_at_unix_ms: Some(now_unix_ms()),
                recorded_at: Some(Instant::now()),
                message: if kind == UploadHealthKind::Healthy {
                    format!("Upload looks ready at {:.1} Mbps.", upload_mbps)
                } else {
                    format!(
                        "Upload is slow at {:.1} Mbps; Instant quality will be capped.",
                        upload_mbps
                    )
                },
            }
        }
        Ok(response) => {
            let status = response.status();
            debug!(%status, "Upload health probe returned a non-success status");
            UploadHealthSnapshot {
                kind: UploadHealthKind::Unavailable,
                upload_mbps: None,
                max_instant_resolution: Some(cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION),
                checked_at_unix_ms: Some(now_unix_ms()),
                recorded_at: Some(Instant::now()),
                message: format!(
                    "Upload health check failed with status {status}; Instant quality will be capped."
                ),
            }
        }
        Err(AuthedApiError::InvalidAuthentication) => UploadHealthSnapshot {
            kind: UploadHealthKind::Unknown,
            upload_mbps: None,
            max_instant_resolution: None,
            checked_at_unix_ms: Some(now_unix_ms()),
            recorded_at: Some(Instant::now()),
            message: "Sign in to check upload health for Instant recording.".to_string(),
        },
        Err(err) => {
            warn!(error = %err, "Upload health probe failed");
            UploadHealthSnapshot {
                kind: UploadHealthKind::Unavailable,
                upload_mbps: None,
                max_instant_resolution: Some(cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION),
                checked_at_unix_ms: Some(now_unix_ms()),
                recorded_at: Some(Instant::now()),
                message: "Upload health check could not reach Cap; Instant quality will be capped."
                    .to_string(),
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_upload_health_status(
    cache: State<'_, UploadHealthCache>,
) -> Result<UploadHealthStatus, String> {
    Ok(cache.status().await)
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_upload_health_status(
    app: AppHandle,
    app_state: MutableState<'_, App>,
    cache: State<'_, UploadHealthCache>,
) -> Result<UploadHealthStatus, String> {
    if app_state.read().await.is_recording_active_or_pending() {
        return Ok(cache.status().await);
    }

    let Ok(_probe_guard) = cache.probe.try_lock() else {
        return Ok(cache.status().await);
    };

    let snapshot = run_probe(&app).await;
    Ok(cache.update(snapshot).await)
}

pub async fn cached_instant_resolution_cap(app: &AppHandle) -> Option<u32> {
    let cache = app.try_state::<UploadHealthCache>()?;
    cache.fresh_instant_resolution_cap().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_upload_speed_to_resolution_tiers() {
        assert_eq!(max_resolution_for_upload_mbps(3.9), 1280);
        assert_eq!(max_resolution_for_upload_mbps(6.0), 1920);
        assert_eq!(max_resolution_for_upload_mbps(18.0), 2560);
        assert_eq!(max_resolution_for_upload_mbps(35.0), 3840);
    }

    #[tokio::test]
    async fn stale_cached_resolution_is_not_used() {
        let cache = UploadHealthCache {
            snapshot: Mutex::new(UploadHealthSnapshot {
                kind: UploadHealthKind::Healthy,
                upload_mbps: Some(50.0),
                max_instant_resolution: Some(3840),
                checked_at_unix_ms: Some(now_unix_ms()),
                recorded_at: Some(Instant::now() - HEALTH_FRESH_FOR - Duration::from_secs(1)),
                message: "old".to_string(),
            }),
            probe: Mutex::new(()),
        };

        assert_eq!(cache.fresh_instant_resolution_cap().await, None);
    }

    #[tokio::test]
    async fn fresh_slow_result_caps_to_safe_resolution() {
        let cache = UploadHealthCache {
            snapshot: Mutex::new(UploadHealthSnapshot {
                kind: UploadHealthKind::Slow,
                upload_mbps: Some(2.0),
                max_instant_resolution: Some(1280),
                checked_at_unix_ms: Some(now_unix_ms()),
                recorded_at: Some(Instant::now()),
                message: "slow".to_string(),
            }),
            probe: Mutex::new(()),
        };

        assert_eq!(cache.fresh_instant_resolution_cap().await, Some(1280));
    }

    #[test]
    fn subtracts_rtt_from_probe_elapsed_when_safe() {
        assert_eq!(
            upload_elapsed_after_rtt(Duration::from_millis(700), Some(Duration::from_millis(500))),
            Duration::from_millis(200)
        );
    }

    #[test]
    fn keeps_total_elapsed_when_rtt_would_overcorrect() {
        assert_eq!(
            upload_elapsed_after_rtt(Duration::from_millis(520), Some(Duration::from_millis(500))),
            Duration::from_millis(520)
        );
    }
}
