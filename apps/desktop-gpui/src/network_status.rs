//! Upload speed test and startup health check.
//!
//! On startup the app uploads a small probe payload to the web app's
//! `/api/desktop/health-check` endpoint; a failure means uploading is broken
//! and the main window shows a warning. While idle (never during an active
//! recording) a periodic speed test measures the current upload bandwidth and
//! caps the studio recording quality to what the connection can sustain.

use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use cap_recording::StudioQuality;
use gpui::{App, AppContext as _, AsyncApp, Entity, Global};

use crate::auth::{self, AuthApiError};
use crate::session::{Phase, RecordingSession};

pub const HEALTH_CHECK_PATH: &str = "/api/desktop/health-check";

const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const SPEED_TEST_INTERVAL: Duration = Duration::from_secs(60);
const SPEED_TEST_TIMEOUT: Duration = Duration::from_secs(20);
const SPEED_TEST_PAYLOAD_BYTES: usize = 1024 * 1024;

const ULTRA_MIN_MBPS: f64 = 25.0;
const BALANCED_MIN_MBPS: f64 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Pending,
    Ok,
    Failed,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NetworkStatus {
    pub health: HealthStatus,
    pub upload_mbps: Option<f64>,
    pub last_speed_test: Option<Instant>,
}

impl Default for HealthStatus {
    fn default() -> Self {
        Self::Pending
    }
}

struct NetworkStatusGlobal(Entity<NetworkStatus>);

impl Global for NetworkStatusGlobal {}

static SNAPSHOT: OnceLock<RwLock<NetworkStatus>> = OnceLock::new();

fn snapshot() -> &'static RwLock<NetworkStatus> {
    SNAPSHOT.get_or_init(|| RwLock::new(NetworkStatus::default()))
}

pub fn current_upload_mbps() -> Option<f64> {
    snapshot().read().ok()?.upload_mbps
}

fn publish(status: NetworkStatus) {
    if let Ok(mut guard) = snapshot().write() {
        *guard = status;
    }
}

impl NetworkStatus {
    pub fn init(cx: &mut App) -> Entity<Self> {
        let initial = snapshot().read().map(|s| *s).unwrap_or_default();
        let entity = cx.new(|_| initial);
        cx.set_global(NetworkStatusGlobal(entity.clone()));
        entity
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<NetworkStatusGlobal>().0.clone()
    }

    fn snapshot_of(&self) -> NetworkStatus {
        NetworkStatus {
            health: self.health,
            upload_mbps: self.upload_mbps,
            last_speed_test: self.last_speed_test,
        }
    }
}

fn quality_tier(quality: StudioQuality) -> u8 {
    match quality {
        StudioQuality::Compatibility => 0,
        StudioQuality::Balanced => 1,
        StudioQuality::Ultra => 2,
    }
}

pub fn quality_for_upload_speed(upload_mbps: f64) -> StudioQuality {
    if upload_mbps >= ULTRA_MIN_MBPS {
        StudioQuality::Ultra
    } else if upload_mbps >= BALANCED_MIN_MBPS {
        StudioQuality::Balanced
    } else {
        StudioQuality::Compatibility
    }
}

pub fn effective_studio_quality(
    configured: StudioQuality,
    upload_mbps: Option<f64>,
) -> StudioQuality {
    match upload_mbps {
        Some(mbps) => {
            let cap = quality_for_upload_speed(mbps);
            if quality_tier(cap) < quality_tier(configured) {
                cap
            } else {
                configured
            }
        }
        None => configured,
    }
}

async fn post_probe(payload_bytes: usize, timeout: Duration) -> Result<Duration, AuthApiError> {
    let mut payload = vec![0u8; payload_bytes];
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    let start = Instant::now();
    let response = tokio::time::timeout(
        timeout,
        auth::authed_raw_request(
            reqwest::Method::POST,
            HEALTH_CHECK_PATH,
            "application/octet-stream",
            payload,
        ),
    )
    .await
    .map_err(|_| AuthApiError::Timeout)??;
    if !response.status().is_success() {
        return Err(AuthApiError::Status(
            response.status(),
            "health check endpoint returned an error".into(),
        ));
    }
    Ok(start.elapsed())
}

async fn run_health_check(status: &Entity<NetworkStatus>, cx: &mut AsyncApp) {
    let probe_task = gpui_tokio::Tokio::spawn(cx, post_probe(64 * 1024, HEALTH_CHECK_TIMEOUT));
    let outcome = match probe_task.await {
        Ok(Ok(_)) => HealthStatus::Ok,
        Ok(Err(AuthApiError::InvalidAuthentication)) => return,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "upload health check failed");
            HealthStatus::Failed
        }
        Err(error) => {
            tracing::warn!(error = %error, "upload health check task failed");
            HealthStatus::Failed
        }
    };
    cx.update(|cx| {
        status.update(cx, |status, cx| {
            status.health = outcome;
            publish(status.snapshot_of());
            cx.notify();
        });
    });
}

async fn measure_upload_speed(status: &Entity<NetworkStatus>, cx: &mut AsyncApp) {
    let probe_task = gpui_tokio::Tokio::spawn(cx, post_probe(SPEED_TEST_PAYLOAD_BYTES, SPEED_TEST_TIMEOUT));
    let (outcome, recovered) = match probe_task.await {
        Ok(Ok(elapsed)) => {
            let mbps = SPEED_TEST_PAYLOAD_BYTES as f64 * 8.0 / elapsed.as_secs_f64() / 1_000_000.0;
            (Some(mbps), true)
        }
        Ok(Err(AuthApiError::Timeout)) => {
            tracing::warn!("upload speed test timed out; capping quality to minimum tier");
            (Some(0.0), true)
        }
        Ok(Err(AuthApiError::InvalidAuthentication)) => return,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "upload speed test failed");
            (None, false)
        }
        Err(error) => {
            tracing::warn!(error = %error, "upload speed test task failed");
            (None, false)
        }
    };
    cx.update(|cx| {
        status.update(cx, |status, cx| {
            status.upload_mbps = outcome;
            if recovered {
                status.health = HealthStatus::Ok;
            }
            status.last_speed_test = Some(Instant::now());
            publish(status.snapshot_of());
            cx.notify();
        });
    });
}

fn recording_active(cx: &mut AsyncApp) -> bool {
    cx.update(|cx| RecordingSession::global(cx).read(cx).phase != Phase::Idle)
}

/// Runs the startup health check once, then measures upload speed on an
/// interval. Speed tests are skipped while a recording is active so the
/// probe never competes with a real upload.
pub fn spawn_monitor(cx: &mut App) {
    let status = NetworkStatus::global(cx);
    cx.spawn(async move |cx| {
        run_health_check(&status, cx).await;
        loop {
            cx.background_executor().timer(SPEED_TEST_INTERVAL).await;
            if recording_active(cx) {
                continue;
            }
            measure_upload_speed(&status, cx).await;
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_thresholds_map_to_quality_tiers() {
        assert_eq!(quality_for_upload_speed(100.0), StudioQuality::Ultra);
        assert_eq!(quality_for_upload_speed(25.0), StudioQuality::Ultra);
        assert_eq!(quality_for_upload_speed(8.0), StudioQuality::Balanced);
        assert_eq!(quality_for_upload_speed(10.0), StudioQuality::Balanced);
        assert_eq!(quality_for_upload_speed(7.9), StudioQuality::Compatibility);
        assert_eq!(quality_for_upload_speed(0.5), StudioQuality::Compatibility);
    }

    #[test]
    fn effective_quality_is_capped_by_upload_speed() {
        assert_eq!(
            effective_studio_quality(StudioQuality::Ultra, Some(50.0)),
            StudioQuality::Ultra
        );
        assert_eq!(
            effective_studio_quality(StudioQuality::Ultra, Some(10.0)),
            StudioQuality::Balanced
        );
        assert_eq!(
            effective_studio_quality(StudioQuality::Balanced, Some(1.0)),
            StudioQuality::Compatibility
        );
        assert_eq!(
            effective_studio_quality(StudioQuality::Compatibility, Some(100.0)),
            StudioQuality::Compatibility
        );
    }

    #[test]
    fn effective_quality_keeps_configured_without_measurement() {
        assert_eq!(
            effective_studio_quality(StudioQuality::Ultra, None),
            StudioQuality::Ultra
        );
        assert_eq!(
            effective_studio_quality(StudioQuality::Compatibility, None),
            StudioQuality::Compatibility
        );
    }
}
