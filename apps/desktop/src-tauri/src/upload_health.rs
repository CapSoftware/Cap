use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use tracing::{debug, warn};

use crate::{
    App, ArcLock, MutableState,
    auth::AuthStore,
    web_api::{AuthedApiError, ManagerExt, UploadRequestContext},
};

mod lifecycle;
mod response;
mod timing;

use lifecycle::ProbeControl;
use response::read_probe_response;
use timing::{
    connection_will_close, measure_warm_probe_rtt, upload_elapsed_after_rtt, upload_mbps_for_bytes,
};

const PROBE_PAYLOAD: &[u8] = include_bytes!("upload_health/fixtures/probe.mp4");
const PROBE_SHA256: &str = "2a53c14ff7bd4380890b938b9d238455661b9aca84c169c8e17215235e46ef5d";
const HEALTH_FRESH_FOR: Duration = Duration::from_secs(10 * 60);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const HEALTH_RTT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UploadHealthKind {
    Unknown,
    Unsupported,
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
    #[specta(type = Option<f64>)]
    pub checked_at_unix_ms: Option<u64>,
    pub stale: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadHealthProbeResponse {
    success: bool,
    received_bytes: usize,
    #[serde(default, deserialize_with = "deserialize_probe_checksum")]
    sha256: Option<String>,
}

fn deserialize_probe_checksum<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

impl UploadHealthProbeResponse {
    fn verifies_payload(&self) -> bool {
        self.success
            && self.received_bytes == PROBE_PAYLOAD.len()
            && self.sha256.as_deref() == Some(PROBE_SHA256)
    }

    fn unverified_snapshot(&self) -> Option<UploadHealthSnapshot> {
        if self.verifies_payload() {
            return None;
        }

        let (kind, max_instant_resolution, message) = if self.success
            && self.received_bytes == PROBE_PAYLOAD.len()
            && self.sha256.is_none()
        {
            (
                UploadHealthKind::Unsupported,
                None,
                "This server does not support upload integrity checks. Update the server to enable them.",
            )
        } else {
            (
                UploadHealthKind::Unavailable,
                Some(cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION),
                "Upload health check could not verify the probe; Instant quality will be capped.",
            )
        };

        Some(UploadHealthSnapshot {
            kind,
            upload_mbps: None,
            max_instant_resolution,
            checked_at_unix_ms: Some(now_unix_ms()),
            recorded_at: Some(Instant::now()),
            message: message.to_string(),
        })
    }
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

#[derive(Clone, PartialEq, Eq)]
struct ProbeIdentity {
    server_url: String,
    owner_id: String,
}

impl ProbeIdentity {
    fn new(server_url: String, owner_id: Option<String>) -> Option<Self> {
        let owner_id = owner_id.filter(|owner_id| !owner_id.is_empty())?;
        if server_url.is_empty() {
            return None;
        }
        Some(Self {
            server_url,
            owner_id,
        })
    }

    fn current(app: &AppHandle, state: &App) -> Option<Self> {
        Self::new(
            state.server_url.clone(),
            AuthStore::get(app).ok().flatten()?.user_id,
        )
    }

    fn request_context(&self) -> Result<UploadRequestContext, AuthedApiError> {
        UploadRequestContext::new(self.server_url.clone(), self.owner_id.clone())
    }
}

struct ProbeTicket {
    identity: ProbeIdentity,
    generation: u64,
}

#[derive(Default)]
struct UploadHealthCacheState {
    identity: Option<ProbeIdentity>,
    generation: u64,
    snapshot: UploadHealthSnapshot,
}

impl UploadHealthCacheState {
    fn synchronize(&mut self, identity: Option<ProbeIdentity>) {
        if self.identity != identity {
            self.identity = identity;
            self.generation = self.generation.wrapping_add(1);
            self.snapshot = UploadHealthSnapshot::default();
        }
    }

    fn ticket(&self) -> Option<ProbeTicket> {
        Some(ProbeTicket {
            identity: self.identity.clone()?,
            generation: self.generation,
        })
    }

    fn publish(&mut self, ticket: &ProbeTicket, snapshot: UploadHealthSnapshot) {
        if self.generation == ticket.generation && self.identity.as_ref() == Some(&ticket.identity)
        {
            self.snapshot = snapshot;
        }
    }

    fn fresh_instant_resolution_cap(&self) -> Option<u32> {
        if self.identity.is_none() || self.snapshot.is_stale() {
            return None;
        }

        match self.snapshot.kind {
            UploadHealthKind::Healthy | UploadHealthKind::Slow | UploadHealthKind::Unavailable => {
                self.snapshot.max_instant_resolution
            }
            UploadHealthKind::Unknown | UploadHealthKind::Unsupported => None,
        }
    }
}

#[derive(Default)]
pub struct UploadHealthCache {
    state: Mutex<UploadHealthCacheState>,
    probe: ProbeControl,
}

impl UploadHealthCache {
    async fn status(&self, app: &AppHandle, state: &App) -> UploadHealthStatus {
        let mut cached = self.state.lock().await;
        cached.synchronize(ProbeIdentity::current(app, state));
        cached.snapshot.status()
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn max_resolution_for_upload_mbps(upload_mbps: f64) -> u32 {
    if !upload_mbps.is_finite() || upload_mbps < 0.0 {
        cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
    } else if upload_mbps >= 35.0 {
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

fn http_failure_snapshot(status: reqwest::StatusCode) -> UploadHealthSnapshot {
    let (kind, max_instant_resolution, message) = if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    ) {
        (
            UploadHealthKind::Unsupported,
            None,
            "This server does not support upload checks. Update the server to enable them."
                .to_string(),
        )
    } else {
        (
            UploadHealthKind::Unavailable,
            Some(cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION),
            format!(
                "Upload health check failed with status {status}; Instant quality will be capped."
            ),
        )
    };

    UploadHealthSnapshot {
        kind,
        upload_mbps: None,
        max_instant_resolution,
        checked_at_unix_ms: Some(now_unix_ms()),
        recorded_at: Some(Instant::now()),
        message,
    }
}

async fn measure_probe_rtt(app: &AppHandle) -> Option<Duration> {
    let started = Instant::now();
    let response = app
        .authed_api_request("/api/desktop/upload-health", |client, url| {
            client.head(url).timeout(HEALTH_RTT_TIMEOUT)
        })
        .await;

    match response {
        Ok(response) if response.status().is_success() => {
            let closes_connection = response.version() == reqwest::Version::HTTP_10
                || response
                    .headers()
                    .get_all(reqwest::header::CONNECTION)
                    .iter()
                    .any(|value| match value.to_str() {
                        Ok(value) => connection_will_close(value),
                        Err(_) => true,
                    });
            if closes_connection {
                None
            } else {
                Some(started.elapsed())
            }
        }
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

async fn run_probe(app: &AppHandle) -> UploadHealthSnapshot {
    let rtt_elapsed = measure_warm_probe_rtt(HEALTH_RTT_TIMEOUT, || measure_probe_rtt(app)).await;
    let started = Instant::now();
    let response = app
        .authed_api_request("/api/desktop/upload-health", |client, url| {
            client
                .post(url)
                .timeout(HEALTH_REQUEST_TIMEOUT)
                .header("Content-Type", "video/mp4")
                .body(PROBE_PAYLOAD)
        })
        .await;

    match response {
        Ok(response) if response.status().is_success() => {
            let probe_response = match read_probe_response(response).await {
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

            if let Some(snapshot) = probe_response.unverified_snapshot() {
                if snapshot.kind == UploadHealthKind::Unsupported {
                    debug!("Server returned a legacy upload health response without a checksum");
                } else {
                    warn!(
                        expected_bytes = PROBE_PAYLOAD.len(),
                        received_bytes = probe_response.received_bytes,
                        "Upload health probe did not verify the payload"
                    );
                }
                return snapshot;
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
                    format!(
                        "Test video reached the Cap API intact at approximately {upload_mbps:.1} Mbps. Screen capture, encoding and cloud storage were not tested."
                    )
                } else {
                    format!(
                        "Estimated API upload is {upload_mbps:.1} Mbps; Instant quality will be capped. The test video arrived intact. Screen capture, encoding and cloud storage were not tested."
                    )
                },
            }
        }
        Ok(response) => {
            let status = response.status();
            debug!(%status, "Upload health probe returned a non-success status");
            http_failure_snapshot(status)
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
    app: AppHandle,
    app_state: MutableState<'_, App>,
    cache: State<'_, UploadHealthCache>,
) -> Result<UploadHealthStatus, String> {
    let state = app_state.read().await;
    Ok(cache.status(&app, &state).await)
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_upload_health_status(
    app: AppHandle,
    app_state: MutableState<'_, App>,
    cache: State<'_, UploadHealthCache>,
) -> Result<UploadHealthStatus, String> {
    let state = app_state.read().await;
    let mut cached = cache.state.lock().await;
    cached.synchronize(ProbeIdentity::current(&app, &state));
    if state.is_recording_active_or_pending() {
        return Ok(cached.snapshot.status());
    }

    let Some(ticket) = cached.ticket() else {
        return Ok(cached.snapshot.status());
    };
    let Some(mut probe) = cache.probe.try_start() else {
        return Ok(cached.snapshot.status());
    };
    let request_context = ticket
        .identity
        .request_context()
        .map_err(|_| "Upload health identity is unavailable".to_string())?;
    drop(cached);
    drop(state);

    let snapshot = probe.run(request_context.run(run_probe(&app))).await;
    let state = app_state.read().await;
    let mut cached = cache.state.lock().await;
    cached.synchronize(ProbeIdentity::current(&app, &state));
    if let Some(snapshot) = snapshot {
        cached.publish(&ticket, snapshot);
    }
    Ok(cached.snapshot.status())
}

pub fn cancel_probe_for_recording(app: &AppHandle) {
    if let Some(cache) = app.try_state::<UploadHealthCache>() {
        cache.probe.cancel();
    }
}

pub async fn wait_for_probe_to_stop(app: &AppHandle) {
    if let Some(cache) = app.try_state::<UploadHealthCache>() {
        cache.probe.cancel_and_wait().await;
    }
}

pub async fn cached_instant_resolution_cap(app: &AppHandle) -> Option<u32> {
    let cache = app.try_state::<UploadHealthCache>()?;
    let app_state = app.try_state::<ArcLock<App>>()?;
    let state = app_state.read().await;
    let mut cached = cache.state.lock().await;
    cached.synchronize(ProbeIdentity::current(app, &state));
    cached.fresh_instant_resolution_cap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_exports_as_a_nullable_number() {
        let bindings =
            specta_typescript::export::<UploadHealthStatus>(&crate::typescript_exporter()).unwrap();
        assert!(bindings.contains("checkedAtUnixMs: number | null"));
    }

    #[test]
    fn maps_upload_speed_to_resolution_tiers() {
        for (speed, resolution) in [
            (0.0, 1280),
            (5.999, 1280),
            (6.0, 1920),
            (17.999, 1920),
            (18.0, 2560),
            (34.999, 2560),
            (35.0, 3840),
            (100.0, 3840),
        ] {
            assert_eq!(max_resolution_for_upload_mbps(speed), resolution);
        }
    }

    #[test]
    fn invalid_upload_speed_never_selects_high_quality() {
        for speed in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
            assert_eq!(max_resolution_for_upload_mbps(speed), 1280);
        }
    }

    #[test]
    fn older_servers_without_the_endpoint_do_not_cap_recording_quality() {
        for status in [
            reqwest::StatusCode::NOT_FOUND,
            reqwest::StatusCode::METHOD_NOT_ALLOWED,
        ] {
            let snapshot = http_failure_snapshot(status);
            let response = snapshot.status();
            assert_eq!(response.kind, UploadHealthKind::Unsupported);
            assert_eq!(response.upload_mbps, None);
            assert_eq!(response.max_instant_resolution, None);
            assert!(!response.stale);
            assert_eq!(
                response.message,
                "This server does not support upload checks. Update the server to enable them."
            );
            let mut cache = UploadHealthCacheState::default();
            cache.synchronize(Some(identity("https://older.test", "alice")));
            let ticket = cache.ticket().unwrap();
            cache.publish(&ticket, snapshot);
            assert_eq!(cache.fresh_instant_resolution_cap(), None);
        }
    }

    #[test]
    fn present_but_failing_endpoints_keep_the_safe_quality_cap() {
        for status in [
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            reqwest::StatusCode::BAD_GATEWAY,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let snapshot = http_failure_snapshot(status);
            assert_eq!(snapshot.status().kind, UploadHealthKind::Unavailable);
            let mut cache = UploadHealthCacheState::default();
            cache.synchronize(Some(identity("https://cap.test", "alice")));
            let ticket = cache.ticket().unwrap();
            cache.publish(&ticket, snapshot);
            assert_eq!(cache.fresh_instant_resolution_cap(), Some(1280));
        }
    }

    #[test]
    fn verifies_success_and_exact_recording_payload_identity() {
        let mut response = UploadHealthProbeResponse {
            success: true,
            received_bytes: PROBE_PAYLOAD.len(),
            sha256: Some(PROBE_SHA256.to_string()),
        };
        assert!(response.verifies_payload());
        assert!(response.unverified_snapshot().is_none());

        response.success = false;
        assert!(!response.verifies_payload());
        response.success = true;

        for received_bytes in [0, PROBE_PAYLOAD.len() - 1, PROBE_PAYLOAD.len() + 1] {
            response.received_bytes = received_bytes;
            assert!(!response.verifies_payload());
        }
        response.received_bytes = PROBE_PAYLOAD.len();

        for digest in [
            String::new(),
            "0".repeat(64),
            PROBE_SHA256[..63].to_string(),
        ] {
            response.sha256 = Some(digest);
            assert!(!response.verifies_payload());
            let snapshot = response.unverified_snapshot().unwrap();
            assert_eq!(snapshot.kind, UploadHealthKind::Unavailable);
            assert_eq!(snapshot.max_instant_resolution, Some(1280));
        }
    }

    #[test]
    fn legacy_response_without_checksum_is_unsupported_and_does_not_cap_quality() {
        let response: UploadHealthProbeResponse = serde_json::from_value(serde_json::json!({
            "success": true,
            "receivedBytes": PROBE_PAYLOAD.len(),
            "maxProbeBytes": 512 * 1024,
        }))
        .unwrap();

        assert!(!response.verifies_payload());
        let snapshot = response.unverified_snapshot().unwrap();
        let status = snapshot.status();
        assert_eq!(status.kind, UploadHealthKind::Unsupported);
        assert_eq!(status.upload_mbps, None);
        assert_eq!(status.max_instant_resolution, None);
        assert!(!status.stale);
        assert_eq!(
            status.message,
            "This server does not support upload integrity checks. Update the server to enable them."
        );

        let mut cache = UploadHealthCacheState::default();
        cache.synchronize(Some(identity("https://older.test", "alice")));
        let ticket = cache.ticket().unwrap();
        cache.publish(&ticket, snapshot);
        assert_eq!(cache.fresh_instant_resolution_cap(), None);
    }

    #[test]
    fn missing_checksum_does_not_hide_a_failed_or_incomplete_probe() {
        for (success, received_bytes) in [
            (false, PROBE_PAYLOAD.len()),
            (true, 0),
            (true, PROBE_PAYLOAD.len() - 1),
            (true, PROBE_PAYLOAD.len() + 1),
        ] {
            let response: UploadHealthProbeResponse = serde_json::from_value(serde_json::json!({
                "success": success,
                "receivedBytes": received_bytes,
                "maxProbeBytes": 512 * 1024,
            }))
            .unwrap();
            assert!(!response.verifies_payload());
            let snapshot = response.unverified_snapshot().unwrap();
            assert_eq!(snapshot.kind, UploadHealthKind::Unavailable);
            assert_eq!(snapshot.upload_mbps, None);
            assert_eq!(snapshot.max_instant_resolution, Some(1280));
        }
    }

    #[test]
    fn missing_or_invalid_probe_confirmation_fields_are_rejected() {
        let confirmed = serde_json::json!({
            "success": true,
            "receivedBytes": PROBE_PAYLOAD.len(),
            "sha256": PROBE_SHA256,
            "maxProbeBytes": 512 * 1024,
        });
        let response: UploadHealthProbeResponse =
            serde_json::from_value(confirmed.clone()).unwrap();
        assert!(response.verifies_payload());

        for field in ["success", "receivedBytes"] {
            let mut missing = confirmed.clone();
            assert!(missing.as_object_mut().unwrap().remove(field).is_some());
            assert!(serde_json::from_value::<UploadHealthProbeResponse>(missing).is_err());
        }
        for (field, value) in [
            ("success", serde_json::json!("true")),
            ("receivedBytes", serde_json::json!(-1)),
            ("receivedBytes", serde_json::json!(262144.5)),
            ("sha256", serde_json::Value::Null),
            ("sha256", serde_json::json!(false)),
            ("sha256", serde_json::json!(42)),
            ("sha256", serde_json::json!([])),
            ("sha256", serde_json::json!({})),
        ] {
            let mut invalid = confirmed.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<UploadHealthProbeResponse>(invalid).is_err());
        }
    }

    fn identity(server: &str, owner: &str) -> ProbeIdentity {
        ProbeIdentity::new(server.to_string(), Some(owner.to_string())).unwrap()
    }

    fn measured_snapshot(upload_mbps: f64) -> UploadHealthSnapshot {
        let max_resolution = max_resolution_for_upload_mbps(upload_mbps);
        UploadHealthSnapshot {
            kind: health_kind_for_resolution(max_resolution),
            upload_mbps: Some(upload_mbps),
            max_instant_resolution: Some(max_resolution),
            checked_at_unix_ms: Some(now_unix_ms()),
            recorded_at: Some(Instant::now()),
            message: "measured".to_string(),
        }
    }

    fn assert_unknown(cache: &UploadHealthCacheState) {
        let status = cache.snapshot.status();
        assert_eq!(status.kind, UploadHealthKind::Unknown);
        assert_eq!(status.upload_mbps, None);
        assert_eq!(status.max_instant_resolution, None);
        assert_eq!(status.checked_at_unix_ms, None);
        assert!(status.stale);
        assert_eq!(cache.fresh_instant_resolution_cap(), None);
    }

    #[test]
    fn stale_cached_resolution_is_not_used() {
        let mut cache = UploadHealthCacheState::default();
        cache.synchronize(Some(identity("https://cap.test", "alice")));
        let ticket = cache.ticket().unwrap();
        let mut snapshot = measured_snapshot(50.0);
        snapshot.recorded_at =
            Instant::now().checked_sub(HEALTH_FRESH_FOR + Duration::from_secs(1));
        cache.publish(&ticket, snapshot);

        assert!(cache.snapshot.status().stale);
        assert_eq!(cache.fresh_instant_resolution_cap(), None);
    }

    #[test]
    fn fresh_result_remains_available_for_the_same_identity() {
        let mut cache = UploadHealthCacheState::default();
        let current = identity("https://cap.test", "alice");
        cache.synchronize(Some(current.clone()));
        let ticket = cache.ticket().unwrap();
        cache.publish(&ticket, measured_snapshot(2.0));
        cache.synchronize(Some(current));

        let status = cache.snapshot.status();
        assert_eq!(status.kind, UploadHealthKind::Slow);
        assert_eq!(status.upload_mbps, Some(2.0));
        assert!(!status.stale);
        assert_eq!(cache.fresh_instant_resolution_cap(), Some(1280));
    }

    #[test]
    fn changing_server_or_account_discards_status_and_quality_cap() {
        for next in [
            identity("https://other.test", "alice"),
            identity("https://cap.test", "bob"),
        ] {
            for speed in [2.0, 50.0] {
                let mut cache = UploadHealthCacheState::default();
                cache.synchronize(Some(identity("https://cap.test", "alice")));
                let ticket = cache.ticket().unwrap();
                cache.publish(&ticket, measured_snapshot(speed));
                cache.synchronize(Some(next.clone()));

                assert_unknown(&cache);
            }
        }
    }

    #[test]
    fn missing_identity_discards_cached_status_and_rejects_probe_completion() {
        let mut cache = UploadHealthCacheState::default();
        cache.synchronize(Some(identity("https://cap.test", "alice")));
        let ticket = cache.ticket().unwrap();
        cache.publish(&ticket, measured_snapshot(2.0));

        cache.synchronize(None);
        cache.publish(&ticket, measured_snapshot(50.0));

        assert!(cache.ticket().is_none());
        assert_unknown(&cache);
    }

    #[test]
    fn old_probe_cannot_replace_a_new_identity_result() {
        for next in [
            identity("https://other.test", "alice"),
            identity("https://cap.test", "bob"),
        ] {
            let mut cache = UploadHealthCacheState::default();
            cache.synchronize(Some(identity("https://cap.test", "alice")));
            let old_ticket = cache.ticket().unwrap();
            cache.synchronize(Some(next));
            cache.publish(&old_ticket, measured_snapshot(50.0));
            assert_unknown(&cache);

            let current_ticket = cache.ticket().unwrap();
            cache.publish(&current_ticket, measured_snapshot(2.0));
            cache.publish(&old_ticket, measured_snapshot(50.0));

            assert_eq!(cache.snapshot.status().upload_mbps, Some(2.0));
            assert_eq!(cache.fresh_instant_resolution_cap(), Some(1280));
        }
    }

    #[test]
    fn returning_to_an_identity_does_not_revive_its_old_probe() {
        let mut cache = UploadHealthCacheState::default();
        let original = identity("https://cap.test", "alice");
        cache.synchronize(Some(original.clone()));
        let old_ticket = cache.ticket().unwrap();
        cache.synchronize(Some(identity("https://other.test", "alice")));
        cache.synchronize(Some(original));
        cache.publish(&old_ticket, measured_snapshot(50.0));

        assert_unknown(&cache);
        let current_ticket = cache.ticket().unwrap();
        cache.publish(&current_ticket, measured_snapshot(2.0));
        assert_eq!(cache.fresh_instant_resolution_cap(), Some(1280));
    }

    #[test]
    fn incomplete_identity_cannot_start_a_probe() {
        assert!(ProbeIdentity::new("https://cap.test".to_string(), None).is_none());
        assert!(ProbeIdentity::new("https://cap.test".to_string(), Some(String::new())).is_none());
        assert!(ProbeIdentity::new(String::new(), Some("alice".to_string())).is_none());
    }
}
