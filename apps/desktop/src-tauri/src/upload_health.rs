use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;
use tracing::{debug, warn};

use crate::{
    ArcLock,
    web_api::{AuthedApiError, ManagerExt},
};

const PROBE_PAYLOAD_BYTES: usize = 512 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const STATUS_TTL: Duration = Duration::from_secs(10 * 60);
const DEGRADED_THRESHOLD_MBPS: f64 = 4.0;
const UPLOAD_HEALTH_PATH: &str = "/api/desktop/upload-health";

#[derive(Serialize, Deserialize, Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadHealthState {
    Unknown,
    Checking,
    Healthy,
    Degraded,
    Failed,
}

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadHealthStatus {
    pub state: UploadHealthState,
    pub upload_mbps: Option<f64>,
    pub checked_at: Option<u32>,
    pub error: Option<String>,
}

impl Default for UploadHealthStatus {
    fn default() -> Self {
        Self {
            state: UploadHealthState::Unknown,
            upload_mbps: None,
            checked_at: None,
            error: None,
        }
    }
}

#[derive(Serialize, Type, tauri_specta::Event, Clone, Debug)]
pub struct UploadHealthChanged(pub UploadHealthStatus);

struct ProbeHandle {
    id: u64,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct MonitorInner {
    status: UploadHealthStatus,
    checked_at: Option<Instant>,
    probe: Option<ProbeHandle>,
    next_probe_id: u64,
}

#[derive(Default)]
pub struct UploadHealthMonitor {
    inner: Mutex<MonitorInner>,
}

impl UploadHealthMonitor {
    fn snapshot(&self) -> UploadHealthStatus {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut status = inner.status.clone();
        if inner.probe.is_some() {
            status.state = UploadHealthState::Checking;
        }
        status
    }

    fn is_stale(&self) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.checked_at {
            Some(checked_at) => checked_at.elapsed() > STATUS_TTL,
            None => true,
        }
    }

    fn start_probe<R: Runtime>(&self, app: &AppHandle<R>) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.probe.is_some() {
            return false;
        }

        let id = inner.next_probe_id;
        inner.next_probe_id = inner.next_probe_id.wrapping_add(1);
        let task = tokio::spawn(probe_task(app.clone(), id));
        inner.probe = Some(ProbeHandle { id, task });
        drop(inner);

        let _ = UploadHealthChanged(self.snapshot()).emit(app);
        true
    }

    fn cancel_probe<R: Runtime>(&self, app: &AppHandle<R>) -> bool {
        let probe = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.probe.take()
        };
        let Some(probe) = probe else { return false };
        probe.task.abort();
        let _ = UploadHealthChanged(self.snapshot()).emit(app);
        true
    }

    fn apply_outcome(&self, probe_id: u64, outcome: ProbeOutcome) -> UploadHealthStatus {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner
            .probe
            .as_ref()
            .is_some_and(|probe| probe.id == probe_id)
        {
            inner.probe = None;
        }
        match outcome {
            ProbeOutcome::Skipped => {}
            ProbeOutcome::Measured(mbps) => {
                inner.status = UploadHealthStatus {
                    state: if mbps < DEGRADED_THRESHOLD_MBPS {
                        UploadHealthState::Degraded
                    } else {
                        UploadHealthState::Healthy
                    },
                    upload_mbps: Some(mbps),
                    checked_at: Some(unix_now()),
                    error: None,
                };
                inner.checked_at = Some(Instant::now());
            }
            ProbeOutcome::Failed(error) => {
                inner.status = UploadHealthStatus {
                    state: UploadHealthState::Failed,
                    upload_mbps: inner.status.upload_mbps,
                    checked_at: Some(unix_now()),
                    error: Some(error),
                };
                inner.checked_at = Some(Instant::now());
            }
        }
        let mut status = inner.status.clone();
        if inner.probe.is_some() {
            status.state = UploadHealthState::Checking;
        }
        status
    }

    fn settle<R: Runtime>(&self, app: &AppHandle<R>, probe_id: u64, outcome: ProbeOutcome) {
        let status = self.apply_outcome(probe_id, outcome);
        let _ = UploadHealthChanged(status).emit(app);
    }
}

enum ProbeOutcome {
    Measured(f64),
    Skipped,
    Failed(String),
}

fn monitor<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, UploadHealthMonitor>> {
    app.try_state::<UploadHealthMonitor>()
}

async fn recording_in_progress<R: Runtime>(app: &AppHandle<R>) -> bool {
    match app.try_state::<ArcLock<crate::App>>() {
        Some(state) => state.read().await.is_recording_active_or_pending(),
        None => false,
    }
}

fn unix_now() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as u32
}

async fn begin_probe<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(monitor) = monitor(app) else {
        return false;
    };
    if recording_in_progress(app).await {
        return false;
    }
    match crate::auth::AuthStore::get(app) {
        Ok(Some(_)) => monitor.start_probe(app),
        _ => false,
    }
}

async fn run_probe<R: Runtime>(app: &AppHandle<R>) -> ProbeOutcome {
    let liveness_started = Instant::now();
    let liveness = app
        .authed_api_request(UPLOAD_HEALTH_PATH, |client, url| client.get(url))
        .await;
    let rtt = liveness_started.elapsed();

    match liveness {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => {
            return ProbeOutcome::Failed(format!(
                "Upload health check failed ({})",
                response.status()
            ));
        }
        Err(AuthedApiError::InvalidAuthentication) => return ProbeOutcome::Skipped,
        Err(err) => return ProbeOutcome::Failed(err.to_string()),
    }

    let payload = vec![0x5a_u8; PROBE_PAYLOAD_BYTES];
    let upload_started = Instant::now();
    let upload = app
        .authed_api_request(UPLOAD_HEALTH_PATH, move |client, url| {
            client
                .post(url)
                .header("content-type", "application/octet-stream")
                .body(payload)
        })
        .await;
    let elapsed = upload_started.elapsed();

    let response = match upload {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            return ProbeOutcome::Failed(format!("Upload probe failed ({})", response.status()));
        }
        Err(AuthedApiError::InvalidAuthentication) => return ProbeOutcome::Skipped,
        Err(err) => return ProbeOutcome::Failed(err.to_string()),
    };

    #[derive(Deserialize)]
    struct ProbeAck {
        #[serde(rename = "receivedBytes")]
        received_bytes: u64,
    }

    match response.json::<ProbeAck>().await {
        Ok(ack) if ack.received_bytes as usize == PROBE_PAYLOAD_BYTES => {}
        Ok(_) => return ProbeOutcome::Failed("Upload probe payload was truncated".into()),
        Err(err) => return ProbeOutcome::Failed(err.to_string()),
    }

    // One liveness round trip estimates the fixed latency baked into the upload
    // timing, so RTT does not masquerade as throughput on high-latency links.
    let effective = elapsed.saturating_sub(rtt).max(Duration::from_millis(1));
    let mbps = (PROBE_PAYLOAD_BYTES as f64 * 8.0) / effective.as_secs_f64() / 1_000_000.0;
    ProbeOutcome::Measured(mbps)
}

async fn probe_task<R: Runtime>(app: AppHandle<R>, probe_id: u64) {
    let outcome = match tokio::time::timeout(PROBE_TIMEOUT, run_probe(&app)).await {
        Ok(outcome) => outcome,
        Err(_) => ProbeOutcome::Failed("Upload health check timed out".into()),
    };

    match &outcome {
        ProbeOutcome::Measured(mbps) => debug!(mbps, "Upload health probe complete"),
        ProbeOutcome::Skipped => debug!("Upload health probe skipped: not signed in"),
        ProbeOutcome::Failed(error) => warn!(%error, "Upload health probe failed"),
    }

    if let Some(monitor) = monitor(&app) {
        monitor.settle(&app, probe_id, outcome);
    }
}

/// Largest output width the measured upload throughput can keep up with, since
/// Instant mode uploads while recording.
pub fn recommended_max_width(upload_mbps: f64) -> Option<u32> {
    if upload_mbps < 4.0 {
        Some(1280)
    } else if upload_mbps < 10.0 {
        Some(1920)
    } else if upload_mbps < 25.0 {
        Some(2560)
    } else {
        None
    }
}

/// Resolution cap for an Instant recording about to start. Only a fresh
/// measurement applies; this never starts a probe because recording is already
/// beginning.
pub(crate) fn instant_resolution_cap<R: Runtime>(app: &AppHandle<R>) -> Option<u32> {
    let monitor = monitor(app)?;
    let inner = monitor.inner.lock().unwrap_or_else(|e| e.into_inner());
    if inner.probe.is_some()
        || inner
            .checked_at
            .is_none_or(|checked_at| checked_at.elapsed() > STATUS_TTL)
    {
        return None;
    }
    match inner.status.state {
        UploadHealthState::Healthy | UploadHealthState::Degraded => {
            inner.status.upload_mbps.and_then(recommended_max_width)
        }
        _ => None,
    }
}

/// Called when any recording starts: an in-flight probe must not keep running
/// once capture begins.
pub(crate) fn recording_started<R: Runtime>(app: &AppHandle<R>) {
    if let Some(monitor) = monitor(app) {
        monitor.cancel_probe(app);
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if monitor(app).is_none() {
        app.manage(UploadHealthMonitor::default());
    }

    let handle = app.clone();
    tokio::spawn(async move {
        begin_probe(&handle).await;
    });
}

#[tauri::command]
#[specta::specta]
pub async fn get_upload_health_status(app: AppHandle) -> Result<UploadHealthStatus, String> {
    let Some(monitor) = monitor(&app) else {
        return Ok(UploadHealthStatus::default());
    };
    if monitor.is_stale() {
        begin_probe(&app).await;
    }
    Ok(monitor.snapshot())
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_upload_health(app: AppHandle) -> Result<UploadHealthStatus, String> {
    let Some(monitor) = monitor(&app) else {
        return Ok(UploadHealthStatus::default());
    };
    begin_probe(&app).await;
    Ok(monitor.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommended_width_tiers() {
        assert_eq!(recommended_max_width(0.5), Some(1280));
        assert_eq!(recommended_max_width(3.9), Some(1280));
        assert_eq!(recommended_max_width(4.0), Some(1920));
        assert_eq!(recommended_max_width(9.9), Some(1920));
        assert_eq!(recommended_max_width(10.0), Some(2560));
        assert_eq!(recommended_max_width(24.9), Some(2560));
        assert_eq!(recommended_max_width(25.0), None);
        assert_eq!(recommended_max_width(100.0), None);
    }

    #[tokio::test]
    async fn snapshot_reports_checking_while_probe_in_flight() {
        let monitor = UploadHealthMonitor::default();
        {
            let mut inner = monitor.inner.lock().unwrap();
            inner.probe = Some(ProbeHandle {
                id: 0,
                task: tokio::spawn(async {}),
            });
            inner.status = UploadHealthStatus {
                state: UploadHealthState::Degraded,
                upload_mbps: Some(2.5),
                checked_at: Some(1),
                error: None,
            };
        }
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.state, UploadHealthState::Checking);
        assert_eq!(snapshot.upload_mbps, Some(2.5));
    }

    #[test]
    fn settle_failed_preserves_last_measured_speed() {
        let monitor = UploadHealthMonitor::default();
        monitor.apply_outcome(0, ProbeOutcome::Measured(8.0));
        let snapshot = monitor.apply_outcome(0, ProbeOutcome::Failed("offline".into()));
        assert_eq!(snapshot.state, UploadHealthState::Failed);
        assert_eq!(snapshot.upload_mbps, Some(8.0));
        assert_eq!(snapshot.error.as_deref(), Some("offline"));
    }
}
