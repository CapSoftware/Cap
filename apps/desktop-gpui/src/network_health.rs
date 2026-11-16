use std::{
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::future::{AbortHandle, Abortable};
use gpui::App;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::debug;

const PROBE_PAYLOAD_BYTES: usize = 768 * 1024;
const PROBE_SAMPLE_COUNT: usize = 2;
const PROBE_TIMEOUT: Duration = Duration::from_secs(25);
const MEASUREMENT_TTL: Duration = Duration::from_secs(15 * 60);
const STARTUP_PROBE_COOLDOWN: Duration = Duration::from_secs(6 * 60 * 60);
const DEGRADED_BELOW_MBPS: f64 = 4.0;
const UPLOAD_HEALTH_STORE_SECTION: &str = "upload_health";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadHealthStatus {
    pub state: UploadHealthState,
    pub upload_mbps: Option<f64>,
    pub recommended_max_width: Option<u32>,
    pub detail: Option<String>,
    pub checked_at: Option<f64>,
    pub recording_active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadHealthTone {
    Neutral,
    Healthy,
    Warning,
    Danger,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadHealthSummary {
    pub label: String,
    pub tooltip: String,
    pub tone: UploadHealthTone,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeIdentity {
    server_url: String,
    owner_id: String,
}

#[derive(Default)]
struct StoredStatus {
    state: UploadHealthState,
    upload_mbps: Option<f64>,
    recommended_max_width: Option<u32>,
    detail: Option<String>,
    checked_at: Option<f64>,
    measured_at: Option<Instant>,
    identity: Option<ProbeIdentity>,
}

impl StoredStatus {
    fn fresh_width(&self, now: Instant, identity: &ProbeIdentity) -> Option<u32> {
        if self.identity.as_ref() != Some(identity) {
            return None;
        }
        self.measured_at
            .is_some_and(|measured_at| {
                now.saturating_duration_since(measured_at) <= MEASUREMENT_TTL
            })
            .then_some(self.recommended_max_width?)
    }

    fn store_outcome(&mut self, outcome: ProbeOutcome, identity: Option<ProbeIdentity>) {
        if !matches!(outcome, ProbeOutcome::Aborted) {
            *self = outcome.into_stored(identity);
        }
    }
}

#[derive(Default)]
pub struct UploadHealth {
    stored: Mutex<StoredStatus>,
    probe_gate: tokio::sync::Mutex<()>,
    abort: Mutex<Option<AbortHandle>>,
    probing: AtomicBool,
    recording_active: AtomicBool,
}

static HEALTH: OnceLock<UploadHealth> = OnceLock::new();
static PROBE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn health() -> &'static UploadHealth {
    HEALTH.get_or_init(UploadHealth::default)
}

fn probe_client() -> Result<&'static reqwest::Client, crate::auth::AuthApiError> {
    if let Some(client) = PROBE_CLIENT.get() {
        return Ok(client);
    }
    let built = crate::auth::api_client()?;
    let _ = PROBE_CLIENT.set(built);
    PROBE_CLIENT
        .get()
        .ok_or_else(|| crate::auth::AuthApiError::Other("probe client unavailable".into()))
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
    fn into_stored(self, identity: Option<ProbeIdentity>) -> StoredStatus {
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
                identity,
            },
            Self::EndpointUnavailable => StoredStatus {
                state: UploadHealthState::EndpointUnavailable,
                detail: Some("The connected server does not support upload health checks".into()),
                checked_at,
                identity,
                ..Default::default()
            },
            Self::Unauthenticated => StoredStatus {
                state: UploadHealthState::Unauthenticated,
                checked_at,
                identity,
                ..Default::default()
            },
            Self::Failed { status, detail } => StoredStatus {
                state: UploadHealthState::Failed,
                detail: Some(match status {
                    Some(status) => format!("Upload test failed ({status}): {detail}"),
                    None => format!("Upload test failed: {detail}"),
                }),
                checked_at,
                identity,
                ..Default::default()
            },
            Self::Aborted => StoredStatus::default(),
        }
    }
}

/// Map measured upload speed to an Instant-mode capture width cap.
/// Never drops below `1280` (720p), which is the lowest tier offered in Settings.
fn recommended_width(upload_mbps: f64) -> Option<u32> {
    if upload_mbps >= 20.0 {
        None
    } else if upload_mbps >= 10.0 {
        Some(2560)
    } else if upload_mbps >= 5.0 {
        Some(1920)
    } else {
        Some(1280)
    }
}

/// Combine multiple warm probe samples so a single cold or jittery sample never
/// lowers resolution: the best sample determines the effective throughput, meaning
/// a resolution cap is only applied when every sample in the run is repeatably slow.
fn evaluate_probe_samples(samples_mbps: &[f64]) -> Option<f64> {
    let mut best: Option<f64> = None;
    for &sample in samples_mbps {
        if sample.is_finite() && sample > 0.0 {
            best = Some(best.map_or(sample, |current| current.max(sample)));
        }
    }
    best
}

fn compute_sample_mbps(
    counted_bytes: u64,
    server_receive_duration_ms: Option<f64>,
    client_elapsed: Duration,
    warmup_rtt: Duration,
) -> f64 {
    let transfer_secs = server_receive_duration_ms
        .filter(|ms| ms.is_finite() && *ms >= 1.0)
        .map(|ms| ms / 1_000.0)
        .unwrap_or_else(|| {
            client_elapsed
                .saturating_sub(warmup_rtt)
                .as_secs_f64()
                .max(0.005)
        });
    counted_bytes as f64 * 8.0 / transfer_secs / 1_000_000.0
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

fn current_identity() -> Option<ProbeIdentity> {
    let server_url = crate::auth::server_url();
    let owner_id = crate::store::auth_snapshot().user_id?;
    if server_url.is_empty() || owner_id.is_empty() {
        return None;
    }
    Some(ProbeIdentity {
        server_url,
        owner_id,
    })
}

fn load_persisted_probe(identity: &ProbeIdentity) -> Option<StoredStatus> {
    let section = crate::store::store_section(UPLOAD_HEALTH_STORE_SECTION);
    let server_url = section.get("serverUrl")?.as_str()?;
    let owner_id = section.get("ownerId")?.as_str()?;
    if server_url != identity.server_url || owner_id != identity.owner_id {
        return None;
    }
    let checked_at = section.get("checkedAt")?.as_f64()?;
    let upload_mbps = section.get("uploadMbps")?.as_f64()?;
    if !upload_mbps.is_finite() || upload_mbps <= 0.0 {
        return None;
    }
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs_f64();
    let age_secs = (now_secs - checked_at).max(0.0);
    if age_secs > STARTUP_PROBE_COOLDOWN.as_secs_f64() {
        return None;
    }
    let measured_at = Instant::now().checked_sub(Duration::from_secs_f64(age_secs));
    Some(StoredStatus {
        state: if upload_mbps < DEGRADED_BELOW_MBPS {
            UploadHealthState::Degraded
        } else {
            UploadHealthState::Healthy
        },
        upload_mbps: Some(upload_mbps),
        recommended_max_width: recommended_width(upload_mbps),
        detail: None,
        checked_at: Some(checked_at),
        measured_at,
        identity: Some(identity.clone()),
    })
}

fn persist_probe(stored: &StoredStatus) {
    let (Some(identity), Some(upload_mbps), Some(checked_at)) = (
        stored.identity.as_ref(),
        stored.upload_mbps,
        stored.checked_at,
    ) else {
        return;
    };
    let _ = crate::store::set_store_value(
        UPLOAD_HEALTH_STORE_SECTION,
        json!({
            "serverUrl": identity.server_url,
            "ownerId": identity.owner_id,
            "uploadMbps": upload_mbps,
            "checkedAt": checked_at,
        }),
    );
}

async fn send_probe() -> ProbeOutcome {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProbeResponse {
        received_bytes: u64,
        #[serde(default)]
        receive_duration_ms: Option<f64>,
    }

    let auth = crate::store::auth_snapshot();
    let Some(token) = auth.token.filter(|token| !token.is_empty()) else {
        return ProbeOutcome::Unauthenticated;
    };
    let client = match probe_client() {
        Ok(client) => client,
        Err(error) => {
            return ProbeOutcome::Failed {
                status: None,
                detail: error.to_string(),
            };
        }
    };
    let url = format!("{}/api/desktop/upload-health", crate::auth::server_url());

    // 1. Warm DNS, TCP, TLS, HTTP/2 connection pooling, and serverless cold start with GET first.
    let warmup_started = Instant::now();
    let warmup_resp = match crate::auth::apply_desktop_headers(client.get(&url))
        .bearer_auth(&token)
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(err) if err.is_timeout() => {
            return ProbeOutcome::Failed {
                status: None,
                detail: "Upload probe timed out".into(),
            };
        }
        Err(err) => {
            return ProbeOutcome::Failed {
                status: None,
                detail: err.to_string(),
            };
        }
    };
    let warmup_rtt = warmup_started.elapsed();
    let warmup_status = warmup_resp.status();
    let _ = warmup_resp.bytes().await;
    if warmup_status == reqwest::StatusCode::UNAUTHORIZED {
        return ProbeOutcome::Unauthenticated;
    }
    if warmup_status == reqwest::StatusCode::NOT_FOUND {
        return ProbeOutcome::EndpointUnavailable;
    }

    // 2. Take multiple warm samples. Sample 0 verifies storage write/cleanup; subsequent
    //    samples measure pure body transfer without duplicating S3/Drive writes.
    let payload = probe_payload();
    let sent_bytes = payload.len() as u64;
    let mut samples_mbps = Vec::with_capacity(PROBE_SAMPLE_COUNT);

    for sample_index in 0..PROBE_SAMPLE_COUNT {
        let verify_storage = if sample_index == 0 { "1" } else { "0" };
        let started = Instant::now();
        let resp = match crate::auth::apply_desktop_headers(client.post(&url))
            .bearer_auth(&token)
            .timeout(PROBE_TIMEOUT)
            .header("Content-Type", "application/octet-stream")
            .header("X-Cap-Upload-Probe", "1")
            .header("X-Cap-Upload-Probe-Verify-Storage", verify_storage)
            .body(payload.clone())
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) if err.is_timeout() => {
                return ProbeOutcome::Failed {
                    status: None,
                    detail: "Upload probe timed out".into(),
                };
            }
            Err(err) => {
                return ProbeOutcome::Failed {
                    status: None,
                    detail: err.to_string(),
                };
            }
        };

        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return ProbeOutcome::Unauthenticated;
        }
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

        let client_elapsed = started.elapsed();
        let parsed = match resp.json::<ProbeResponse>().await {
            Ok(body) => body,
            Err(err) => {
                return ProbeOutcome::Failed {
                    status: None,
                    detail: format!("Unparseable probe response: {err}"),
                };
            }
        };
        let counted = parsed.received_bytes.min(sent_bytes);
        if counted == 0 {
            return ProbeOutcome::Failed {
                status: None,
                detail: "Probe endpoint did not receive the upload".to_string(),
            };
        }
        let sample_mbps = compute_sample_mbps(
            counted,
            parsed.receive_duration_ms,
            client_elapsed,
            warmup_rtt,
        );
        samples_mbps.push(sample_mbps);
    }

    let Some(upload_mbps) = evaluate_probe_samples(&samples_mbps) else {
        return ProbeOutcome::Failed {
            status: None,
            detail: "No valid upload samples collected".to_string(),
        };
    };
    ProbeOutcome::Success { upload_mbps }
}

pub fn status() -> UploadHealthStatus {
    let health = health();
    let stored = health
        .stored
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let recording_active = health.recording_active.load(Ordering::Acquire);
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

pub fn format_upload_mbps(mbps: f64) -> String {
    if mbps >= 100.0 {
        format!("{mbps:.0} Mbps")
    } else {
        format!("{mbps:.1} Mbps")
    }
}

fn width_tier_label(width: Option<u32>) -> &'static str {
    match width {
        None => "full resolution",
        Some(width) if width >= 2560 => "up to 1440p",
        Some(width) if width >= 1920 => "up to 1080p",
        Some(_) => "up to 720p",
    }
}

pub fn upload_health_summary(status: &UploadHealthStatus) -> Option<UploadHealthSummary> {
    if matches!(
        status.state,
        UploadHealthState::EndpointUnavailable | UploadHealthState::Unauthenticated
    ) {
        return None;
    }

    let disabled = status.recording_active || status.state == UploadHealthState::Checking;

    if status.recording_active {
        let mbps = status.upload_mbps.filter(|mbps| mbps.is_finite());
        let label = match mbps {
            Some(mbps) => format_upload_mbps(mbps),
            None => "Upload paused".to_string(),
        };
        let tooltip = match mbps {
            Some(mbps) => format!(
                "Last measured upload speed: {}. Upload health checks are paused while recording.",
                format_upload_mbps(mbps)
            ),
            None => "Upload health checks are paused while recording.".to_string(),
        };
        return Some(UploadHealthSummary {
            label,
            tooltip,
            tone: UploadHealthTone::Neutral,
            disabled,
        });
    }

    match status.state {
        UploadHealthState::Checking => Some(UploadHealthSummary {
            label: "Checking upload...".to_string(),
            tooltip: "Measuring upload throughput to your Cap destination.".to_string(),
            tone: UploadHealthTone::Neutral,
            disabled,
        }),
        UploadHealthState::Healthy => {
            let mbps = status.upload_mbps.unwrap_or(0.0);
            let formatted = format_upload_mbps(mbps);
            let tier = width_tier_label(status.recommended_max_width);
            Some(UploadHealthSummary {
                label: formatted.clone(),
                tooltip: format!(
                    "Upload speed {formatted} ({tier} for Instant mode). Click to re-test."
                ),
                tone: UploadHealthTone::Healthy,
                disabled,
            })
        }
        UploadHealthState::Degraded => {
            let mbps = status.upload_mbps.unwrap_or(0.0);
            let formatted = format_upload_mbps(mbps);
            let tier = width_tier_label(status.recommended_max_width);
            Some(UploadHealthSummary {
                label: format!("Slow · {formatted}"),
                tooltip: format!(
                    "Upload speed is slow ({formatted}). Instant mode will record {tier} to prevent upload stalls. Click to re-test."
                ),
                tone: UploadHealthTone::Warning,
                disabled,
            })
        }
        UploadHealthState::Failed => {
            let detail = status
                .detail
                .as_deref()
                .filter(|detail| !detail.is_empty())
                .unwrap_or("Upload health check failed.");
            Some(UploadHealthSummary {
                label: "Upload check".to_string(),
                tooltip: format!("{detail} Click to retry."),
                tone: UploadHealthTone::Danger,
                disabled,
            })
        }
        UploadHealthState::Unknown
        | UploadHealthState::EndpointUnavailable
        | UploadHealthState::Unauthenticated => None,
    }
}

pub(crate) fn recording_admitted() {
    let health = health();
    health.recording_active.store(true, Ordering::Release);
    if let Some(abort) = health
        .abort
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        abort.abort();
    }
}

pub(crate) fn recording_released() {
    health().recording_active.store(false, Ordering::Release);
}

pub(crate) fn recommended_capture_width() -> Option<u32> {
    let identity = current_identity()?;
    health()
        .stored
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .fresh_width(Instant::now(), &identity)
}

pub(crate) async fn run_probe() -> UploadHealthStatus {
    let health = health();
    if health.recording_active.load(Ordering::Acquire) {
        return status();
    }
    let Ok(_gate) = health.probe_gate.try_lock() else {
        return status();
    };
    health.probing.store(true, Ordering::Release);
    let identity = current_identity();
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    *health
        .abort
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(abort_handle);

    let outcome = if health.recording_active.load(Ordering::Acquire) {
        ProbeOutcome::Aborted
    } else {
        match identity.as_ref() {
            Some(_) => match Abortable::new(send_probe(), abort_registration).await {
                Ok(outcome) => outcome,
                Err(_) => ProbeOutcome::Aborted,
            },
            None => ProbeOutcome::Unauthenticated,
        }
    };

    *health
        .abort
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    health.probing.store(false, Ordering::Release);
    debug!(?outcome, "upload health probe finished");

    let current_identity = current_identity();
    let mut stored = health
        .stored
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if identity == current_identity {
        stored.store_outcome(outcome, current_identity);
        persist_probe(&stored);
    } else {
        *stored = StoredStatus::default();
    }
    drop(stored);
    status()
}

fn refresh_windows(cx: &mut App) {
    if !cx.has_global::<crate::app_windows::AppWindows>() {
        return;
    }
    let windows = cx.global::<crate::app_windows::AppWindows>();
    let main = windows.main;
    let settings = windows.settings;
    main.update(cx, |_, _, cx| cx.notify()).ok();
    if let Some(settings) = settings {
        settings.update(cx, |_, _, cx| cx.notify()).ok();
    }
}

pub(crate) fn schedule_startup_check(cx: &mut App) {
    if let Some(identity) = current_identity()
        && let Some(persisted) = load_persisted_probe(&identity)
    {
        *health()
            .stored
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = persisted;
        refresh_windows(cx);
        return;
    }
    run_upload_health_check(cx);
}

pub(crate) fn run_upload_health_check(cx: &mut App) {
    let health = health();
    if health.recording_active.load(Ordering::Acquire) {
        refresh_windows(cx);
        return;
    }
    refresh_windows(cx);
    let probe = gpui_tokio::Tokio::spawn(cx, run_probe());
    cx.spawn(async move |cx| {
        let _ = probe.await;
        cx.update(refresh_windows);
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ProbeIdentity {
        ProbeIdentity {
            server_url: "https://cap.so".into(),
            owner_id: "user-1".into(),
        }
    }

    #[test]
    fn width_ladder_boundaries_never_drop_below_720p() {
        assert_eq!(recommended_width(0.0), Some(1280));
        assert_eq!(recommended_width(2.49), Some(1280));
        assert_eq!(recommended_width(4.99), Some(1280));
        assert_eq!(recommended_width(5.0), Some(1920));
        assert_eq!(recommended_width(9.99), Some(1920));
        assert_eq!(recommended_width(10.0), Some(2560));
        assert_eq!(recommended_width(19.99), Some(2560));
        assert_eq!(recommended_width(20.0), None);
        assert_eq!(recommended_width(100.0), None);
    }

    #[test]
    fn single_cold_sample_never_lowers_resolution_when_warm_sample_is_fast() {
        let combined = evaluate_probe_samples(&[6.5, 42.0]).expect("combined sample");
        assert_eq!(combined, 42.0);
        assert_eq!(recommended_width(combined), None);

        let repeatably_slow = evaluate_probe_samples(&[3.2, 3.8]).expect("slow samples");
        assert_eq!(repeatably_slow, 3.8);
        assert_eq!(recommended_width(repeatably_slow), Some(1280));
    }

    #[test]
    fn compute_sample_mbps_prefers_server_body_read_duration() {
        let bytes = 768 * 1024;
        let mbps = compute_sample_mbps(
            bytes,
            Some(50.0),
            Duration::from_millis(850),
            Duration::from_millis(120),
        );
        let expected = (bytes as f64 * 8.0) / 0.050 / 1_000_000.0;
        assert!((mbps - expected).abs() < 0.01);
    }

    #[test]
    fn success_outcome_marks_degraded_only_below_threshold() {
        for (mbps, expected) in [
            (50.0, UploadHealthState::Healthy),
            (4.0, UploadHealthState::Healthy),
            (3.99, UploadHealthState::Degraded),
            (0.5, UploadHealthState::Degraded),
        ] {
            let stored = ProbeOutcome::Success { upload_mbps: mbps }.into_stored(Some(identity()));
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
            let stored = outcome.into_stored(Some(identity()));
            assert!(stored.recommended_max_width.is_none());
            assert!(stored.upload_mbps.is_none());
            assert!(stored.measured_at.is_none());
        }
    }

    #[test]
    fn aborted_probe_preserves_existing_measurement() {
        let mut stored = ProbeOutcome::Success { upload_mbps: 1.0 }.into_stored(Some(identity()));
        let checked_at = stored.checked_at;
        let measured_at = stored.measured_at;
        stored.store_outcome(ProbeOutcome::Aborted, Some(identity()));
        assert_eq!(stored.state, UploadHealthState::Degraded);
        assert_eq!(stored.checked_at, checked_at);
        assert_eq!(stored.measured_at, measured_at);
        assert_eq!(stored.recommended_max_width, Some(1280));
    }

    #[test]
    fn fresh_width_only_applies_to_matching_identity_within_ttl() {
        let mut stored = ProbeOutcome::Success { upload_mbps: 1.0 }.into_stored(Some(identity()));
        assert_eq!(stored.fresh_width(Instant::now(), &identity()), Some(1280));
        for other_identity in [
            ProbeIdentity {
                server_url: "https://self-hosted.example".into(),
                owner_id: "user-1".into(),
            },
            ProbeIdentity {
                server_url: "https://cap.so".into(),
                owner_id: "user-2".into(),
            },
        ] {
            assert_eq!(stored.fresh_width(Instant::now(), &other_identity), None);
        }
        stored.measured_at = Instant::now().checked_sub(MEASUREMENT_TTL + Duration::from_secs(1));
        assert_eq!(stored.fresh_width(Instant::now(), &identity()), None);
        stored.measured_at = None;
        assert_eq!(stored.fresh_width(Instant::now(), &identity()), None);
        stored.recommended_max_width = None;
        stored.measured_at = Some(Instant::now());
        assert_eq!(stored.fresh_width(Instant::now(), &identity()), None);
    }

    #[test]
    fn probe_payload_is_deterministic_and_bounded() {
        let a = probe_payload();
        let b = probe_payload();
        assert_eq!(a.len(), PROBE_PAYLOAD_BYTES);
        assert_eq!(a, b);
        assert!(a.iter().any(|byte| *byte != 0));
    }

    #[test]
    fn formats_upload_summary_states_for_header_pill() {
        assert_eq!(
            upload_health_summary(&UploadHealthStatus {
                state: UploadHealthState::Unauthenticated,
                ..Default::default()
            }),
            None
        );
        assert_eq!(
            upload_health_summary(&UploadHealthStatus {
                state: UploadHealthState::EndpointUnavailable,
                ..Default::default()
            }),
            None
        );

        let healthy = upload_health_summary(&UploadHealthStatus {
            state: UploadHealthState::Healthy,
            upload_mbps: Some(14.24),
            recommended_max_width: Some(2560),
            ..Default::default()
        })
        .expect("healthy summary");
        assert_eq!(healthy.label, "14.2 Mbps");
        assert_eq!(healthy.tone, UploadHealthTone::Healthy);
        assert!(!healthy.disabled);

        let degraded = upload_health_summary(&UploadHealthStatus {
            state: UploadHealthState::Degraded,
            upload_mbps: Some(3.1),
            recommended_max_width: Some(1280),
            ..Default::default()
        })
        .expect("degraded summary");
        assert_eq!(degraded.label, "Slow · 3.1 Mbps");
        assert_eq!(degraded.tone, UploadHealthTone::Warning);

        let paused = upload_health_summary(&UploadHealthStatus {
            state: UploadHealthState::Healthy,
            upload_mbps: Some(18.0),
            recommended_max_width: Some(2560),
            recording_active: true,
            ..Default::default()
        })
        .expect("paused summary");
        assert_eq!(paused.label, "18.0 Mbps");
        assert_eq!(paused.tone, UploadHealthTone::Neutral);
        assert!(paused.disabled);
    }
}
