use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::{
    ArcLock,
    web_api::{AuthedApiError, ManagerExt},
};

const PROBE_PAYLOAD_BYTES: usize = 768 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(25);
const MEASUREMENT_TTL: Duration = Duration::from_secs(15 * 60);
const DEGRADED_BELOW_MBPS: f64 = 4.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UploadHealthState {
    #[default]
    Unknown,
    Checking,
    Healthy,
    Degraded,
    Failed,
    EndpointUnavailable,
    Unauthenticated,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadHealthStatus {
    pub state: UploadHealthState,
    pub upload_mbps: Option<f64>,
    pub recommended_max_width: Option<u32>,
    pub detail: Option<String>,
    pub checked_at: Option<f64>,
    pub recording_active: bool,
}

#[derive(Clone, Debug, Serialize, Type, Event)]
pub struct UploadHealthChanged(pub UploadHealthStatus);

#[derive(Default)]
struct StoredStatus {
    state: UploadHealthState,
    upload_mbps: Option<f64>,
    recommended_max_width: Option<u32>,
    detail: Option<String>,
    checked_at: Option<f64>,
    measured_at: Option<Instant>,
}

impl StoredStatus {
    fn fresh_width(&self, now: Instant) -> Option<u32> {
        self.measured_at
            .is_some_and(|measured_at| {
                now.saturating_duration_since(measured_at) <= MEASUREMENT_TTL
            })
            .then_some(self.recommended_max_width?)
    }

    fn store_outcome(&mut self, outcome: ProbeOutcome) {
        if !matches!(outcome, ProbeOutcome::Aborted) {
            *self = outcome.into_stored();
        }
    }
}

#[derive(Default)]
pub struct UploadHealth {
    stored: Mutex<StoredStatus>,
    probe_gate: tokio::sync::Mutex<()>,
    cancel: Mutex<Option<CancellationToken>>,
    probing: AtomicBool,
}

#[derive(Debug)]
enum ProbeOutcome {
    Success { upload_mbps: f64 },
    EndpointUnavailable,
    Unauthenticated,
    Failed { status: Option<u16>, detail: String },
    Aborted,
}

impl ProbeOutcome {
    fn into_stored(self) -> StoredStatus {
        let checked_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_secs_f64())
            .ok();
        match self {
            Self::Success { upload_mbps } => StoredStatus {
                state: if upload_mbps < DEGRADED_BELOW_MBPS {
                    UploadHealthState::Degraded
                } else {
                    UploadHealthState::Healthy
                },
                upload_mbps: Some(upload_mbps),
                recommended_max_width: recommended_width(upload_mbps),
                detail: None,
                checked_at,
                measured_at: Some(Instant::now()),
            },
            Self::EndpointUnavailable => StoredStatus {
                state: UploadHealthState::EndpointUnavailable,
                detail: Some(
                    "The connected server does not support upload health checks".into(),
                ),
                checked_at,
                ..Default::default()
            },
            Self::Unauthenticated => StoredStatus {
                state: UploadHealthState::Unauthenticated,
                checked_at,
                ..Default::default()
            },
            Self::Failed { status, detail } => StoredStatus {
                state: UploadHealthState::Failed,
                detail: Some(match status {
                    Some(status) => format!("Upload test failed ({status}): {detail}"),
                    None => format!("Upload test failed: {detail}"),
                }),
                checked_at,
                ..Default::default()
            },
            Self::Aborted => StoredStatus::default(),
        }
    }
}

fn recommended_width(upload_mbps: f64) -> Option<u32> {
    if upload_mbps >= 20.0 {
        None
    } else if upload_mbps >= 10.0 {
        Some(2560)
    } else if upload_mbps >= 5.0 {
        Some(1920)
    } else if upload_mbps >= 2.5 {
        Some(1280)
    } else {
        Some(854)
    }
}

fn probe_payload() -> Vec<u8> {
    let mut payload = Vec::with_capacity(PROBE_PAYLOAD_BYTES);
    let mut state: u32 = 0x9E37_79B9;
    while payload.len() < PROBE_PAYLOAD_BYTES {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        payload.extend_from_slice(&state.to_le_bytes());
    }
    payload.truncate(PROBE_PAYLOAD_BYTES);
    payload
}

async fn send_probe(app: &AppHandle) -> ProbeOutcome {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProbeResponse {
        received_bytes: u64,
    }

    let payload = probe_payload();
    let sent_bytes = payload.len() as u64;
    let started = Instant::now();
    let resp = match app
        .authed_api_request("/api/desktop/upload-health", move |client, url| {
            client
                .post(url)
                .timeout(PROBE_TIMEOUT)
                .header("Content-Type", "application/octet-stream")
                .header("X-Cap-Upload-Probe", "1")
                .body(payload)
        })
        .await
    {
        Ok(resp) => resp,
        Err(AuthedApiError::InvalidAuthentication) => return ProbeOutcome::Unauthenticated,
        Err(err) => {
            return ProbeOutcome::Failed {
                status: None,
                detail: err.to_string(),
            };
        }
    };

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return ProbeOutcome::EndpointUnavailable;
    }
    if !status.is_success() {
        let detail = resp
            .text()
            .await
            .map(|body| body.chars().take(200).collect::<String>())
            .unwrap_or_else(|_| "<no response body>".to_string());
        return ProbeOutcome::Failed {
            status: Some(status.as_u16()),
            detail,
        };
    }

    let elapsed = started.elapsed();
    let received_bytes = match resp.json::<ProbeResponse>().await {
        Ok(body) => body.received_bytes,
        Err(err) => {
            return ProbeOutcome::Failed {
                status: None,
                detail: format!("Unparseable probe response: {err}"),
            };
        }
    };
    let counted = received_bytes.min(sent_bytes);
    if counted == 0 {
        return ProbeOutcome::Failed {
            status: None,
            detail: "Probe endpoint did not receive the upload".to_string(),
        };
    }
    let upload_mbps = counted as f64 * 8.0 / elapsed.as_secs_f64() / 1_000_000.0;
    ProbeOutcome::Success { upload_mbps }
}

async fn recording_active(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<ArcLock<crate::App>>() else {
        return false;
    };
    state.read().await.is_recording_active_or_pending()
}

fn build_status(health: &UploadHealth, recording_active: bool) -> UploadHealthStatus {
    let stored = health.stored.lock().unwrap();
    let measurement_is_fresh = stored.measured_at.is_some_and(|measured_at| {
        Instant::now().saturating_duration_since(measured_at) <= MEASUREMENT_TTL
    });
    UploadHealthStatus {
        state: if health.probing.load(Ordering::Acquire) {
            UploadHealthState::Checking
        } else {
            stored.state
        },
        upload_mbps: stored.upload_mbps,
        recommended_max_width: measurement_is_fresh
            .then_some(stored.recommended_max_width)
            .flatten(),
        detail: stored.detail.clone(),
        checked_at: stored.checked_at,
        recording_active,
    }
}

async fn status_with(app: &AppHandle, health: &UploadHealth) -> UploadHealthStatus {
    build_status(health, recording_active(app).await)
}

fn emit(app: &AppHandle, status: UploadHealthStatus) {
    UploadHealthChanged(status).emit(app).ok();
}

pub(crate) async fn run_probe(app: &AppHandle) -> UploadHealthStatus {
    let health = app.state::<UploadHealth>();
    if recording_active(app).await {
        return status_with(app, health.inner()).await;
    }
    let Ok(_gate) = health.probe_gate.try_lock() else {
        return status_with(app, health.inner()).await;
    };
    health.probing.store(true, Ordering::Release);
    let cancel = CancellationToken::new();
    *health.cancel.lock().unwrap() = Some(cancel.clone());
    emit(app, build_status(&health, false));

    // A recording admitted between the gate and the cancel-slot write owns the
    // cancellation window, so the recording state is re-checked before the
    // request is allowed to send.
    let outcome = if recording_active(app).await {
        ProbeOutcome::Aborted
    } else {
        tokio::select! {
            outcome = send_probe(app) => outcome,
            () = cancel.cancelled() => ProbeOutcome::Aborted,
        }
    };

    *health.cancel.lock().unwrap() = None;
    health.probing.store(false, Ordering::Release);
    debug!(?outcome, "upload health probe finished");
    health.stored.lock().unwrap().store_outcome(outcome);
    let status = status_with(app, health.inner()).await;
    emit(app, status.clone());
    status
}

pub(crate) fn recording_admitted(app: &AppHandle) {
    let Some(health) = app.try_state::<UploadHealth>() else {
        return;
    };
    if let Some(cancel) = health.cancel.lock().unwrap().take() {
        cancel.cancel();
    }
    emit(app, build_status(&health, true));
}

pub(crate) fn recording_released(app: &AppHandle) {
    let Some(health) = app.try_state::<UploadHealth>() else {
        return;
    };
    emit(app, build_status(&health, false));
}

pub(crate) async fn recommended_capture_width(app: &AppHandle) -> Option<u32> {
    let health = app.try_state::<UploadHealth>()?;
    health.stored.lock().unwrap().fresh_width(Instant::now())
}

#[tauri::command]
#[specta::specta]
pub async fn get_upload_health(app: AppHandle) -> UploadHealthStatus {
    match app.try_state::<UploadHealth>() {
        Some(health) => status_with(app, &health).await,
        None => UploadHealthStatus::default(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn run_upload_health_check(app: AppHandle) -> UploadHealthStatus {
    match app.try_state::<UploadHealth>() {
        Some(_) => run_probe(&app).await,
        None => UploadHealthStatus::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_ladder_boundaries() {
        assert_eq!(recommended_width(0.0), Some(854));
        assert_eq!(recommended_width(2.49), Some(854));
        assert_eq!(recommended_width(2.5), Some(1280));
        assert_eq!(recommended_width(4.99), Some(1280));
        assert_eq!(recommended_width(5.0), Some(1920));
        assert_eq!(recommended_width(9.99), Some(1920));
        assert_eq!(recommended_width(10.0), Some(2560));
        assert_eq!(recommended_width(19.99), Some(2560));
        assert_eq!(recommended_width(20.0), None);
        assert_eq!(recommended_width(100.0), None);
    }

    #[test]
    fn success_outcome_marks_degraded_only_below_threshold() {
        for (mbps, expected) in [
            (50.0, UploadHealthState::Healthy),
            (4.0, UploadHealthState::Healthy),
            (3.99, UploadHealthState::Degraded),
            (0.5, UploadHealthState::Degraded),
        ] {
            let stored = ProbeOutcome::Success {
                upload_mbps: mbps,
            }
            .into_stored();
            assert_eq!(stored.state, expected);
            assert_eq!(stored.upload_mbps, Some(mbps));
            assert_eq!(stored.recommended_max_width, recommended_width(mbps));
            assert!(stored.measured_at.is_some());
        }
    }

    #[test]
    fn failure_outcomes_do_not_keep_a_stale_speed_cap() {
        for outcome in [
            ProbeOutcome::EndpointUnavailable,
            ProbeOutcome::Unauthenticated,
            ProbeOutcome::Failed {
                status: Some(503),
                detail: "down".into(),
            },
            ProbeOutcome::Failed {
                status: None,
                detail: "offline".into(),
            },
        ] {
            let stored = outcome.into_stored();
            assert!(stored.recommended_max_width.is_none());
            assert!(stored.upload_mbps.is_none());
            assert!(stored.measured_at.is_none());
        }
    }

    #[test]
    fn aborted_probe_preserves_existing_measurement() {
        let mut stored = ProbeOutcome::Success {
            upload_mbps: 1.0,
        }
        .into_stored();
        let checked_at = stored.checked_at;
        let measured_at = stored.measured_at;
        stored.store_outcome(ProbeOutcome::Aborted);
        assert_eq!(stored.state, UploadHealthState::Degraded);
        assert_eq!(stored.checked_at, checked_at);
        assert_eq!(stored.measured_at, measured_at);
        assert_eq!(stored.recommended_max_width, Some(854));
    }

    #[test]
    fn fresh_width_only_applies_within_ttl() {
        let mut stored = ProbeOutcome::Success {
            upload_mbps: 1.0,
        }
        .into_stored();
        assert_eq!(stored.fresh_width(Instant::now()), Some(854));
        stored.measured_at = Instant::now().checked_sub(MEASUREMENT_TTL + Duration::from_secs(1));
        assert_eq!(stored.fresh_width(Instant::now()), None);
        stored.measured_at = None;
        assert_eq!(stored.fresh_width(Instant::now()), None);
        stored.recommended_max_width = None;
        stored.measured_at = Some(Instant::now());
        assert_eq!(stored.fresh_width(Instant::now()), None);
    }

    #[test]
    fn probe_payload_is_deterministic_and_bounded() {
        let a = probe_payload();
        let b = probe_payload();
        assert_eq!(a.len(), PROBE_PAYLOAD_BYTES);
        assert_eq!(a, b);
        assert!(a.iter().any(|byte| *byte != 0));
    }
}
