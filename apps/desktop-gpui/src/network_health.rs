pub mod policy;

use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use futures_util::future::{AbortHandle, Abortable};
use gpui::{App, AppContext as _};
use serde::Deserialize;

use crate::auth::{self, AuthApiError, UploadRequestContext};
use crate::store;

use self::policy::{AUTOMATIC_PROBE_INTERVAL, Admission, Measurement, Sample, Scope};

const PROBE_BYTES: usize = 2 * 1024 * 1024;
const PROBE_CHUNK_BYTES: usize = 32 * 1024;
const MANUAL_COOLDOWN: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Indicator {
    pub label: String,
    pub detail: String,
    pub failed: bool,
    pub limited: bool,
}

#[derive(Default)]
struct Controller {
    admission: Admission,
    status: Status,
    measurement: Option<Measurement>,
    active_abort: Option<AbortHandle>,
    active_done: Option<tokio::sync::watch::Receiver<bool>>,
    last_attempt: Option<(Scope, Instant)>,
    last_manual: Option<Instant>,
}

#[derive(Default, Clone)]
enum Status {
    #[default]
    Idle,
    Checking(Scope),
    Ready(Measurement),
    Unsupported(Scope),
    Failed {
        scope: Scope,
        message: String,
    },
}

static CONTROLLER: OnceLock<Mutex<Controller>> = OnceLock::new();

fn controller() -> &'static Mutex<Controller> {
    CONTROLLER.get_or_init(|| Mutex::new(Controller::default()))
}

fn lock_controller() -> std::sync::MutexGuard<'static, Controller> {
    controller()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

pub struct TransferLease(bool);

impl Drop for TransferLease {
    fn drop(&mut self) {
        if self.0 {
            lock_controller().admission.release_transfer();
        }
    }
}

pub fn acquire_transfer() -> TransferLease {
    abort_for_activity(|controller| controller.admission.admit_transfer());
    TransferLease(true)
}

pub fn init(cx: &mut App) {
    if std::env::var("CAP_GPUI_DISABLE_UPLOAD_HEALTH").is_ok_and(|value| value == "1") {
        return;
    }
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_secs(2)).await;
        loop {
            cx.update(|cx| request(cx, false));
            cx.background_executor()
                .timer(Duration::from_secs(30))
                .await;
        }
    })
    .detach();
}

pub fn recording_admitted() {
    abort_for_activity(|controller| controller.admission.admit_recording());
}

fn abort_for_activity(admit: impl FnOnce(&mut Controller)) {
    let abort = {
        let mut controller = lock_controller();
        admit(&mut controller);
        if matches!(controller.status, Status::Checking(_)) {
            controller.status = match controller.measurement.clone() {
                Some(measurement) => Status::Ready(measurement),
                None => Status::Idle,
            };
        }
        controller.active_abort.take()
    };
    if let Some(abort) = abort {
        abort.abort();
    }
}

pub fn recording_released() {
    lock_controller().admission.release_recording();
}

pub async fn wait_for_probe() {
    let done = lock_controller().active_done.clone();
    if let Some(mut done) = done {
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                break;
            }
        }
    }
}

pub fn invalidate() {
    let abort = {
        let mut controller = lock_controller();
        controller.admission.invalidate();
        controller.status = Status::Idle;
        controller.measurement = None;
        controller.last_attempt = None;
        controller.active_abort.take()
    };
    if let Some(abort) = abort {
        abort.abort();
    }
}

pub fn max_width(configured: u32, organization: Option<&str>) -> u32 {
    let Some(scope) = current_scope() else {
        return configured;
    };
    let now = SystemTime::now();
    let controller = lock_controller();
    controller
        .measurement
        .as_ref()
        .and_then(|measurement| measurement.max_width_for(&scope, organization, now))
        .map_or(configured, |cap| configured.min(cap))
}

pub fn indicator() -> Option<Indicator> {
    let scope = current_scope()?;
    let configured = configured_instant_width();
    let now = SystemTime::now();
    let controller = lock_controller();
    match &controller.status {
        Status::Idle | Status::Unsupported(_) => None,
        Status::Checking(checking) if checking == &scope => Some(Indicator {
            label: "Checking upload".into(),
            detail: "Checking upload storage and connection speed.".into(),
            failed: false,
            limited: false,
        }),
        Status::Checking(_) => None,
        Status::Failed {
            scope: failed,
            message,
        } if failed == &scope => Some(Indicator {
            label: "Upload check failed".into(),
            detail: format!("{message} Click to retry while idle."),
            failed: true,
            limited: false,
        }),
        Status::Failed { .. } => None,
        Status::Ready(measurement) if measurement.fresh_for(&scope, now) => {
            let cap = measurement.max_width.filter(|cap| *cap < configured);
            let speed = measurement.mbps.map(|mbps| format!("{mbps:.1} Mb/s"));
            let label = match (&speed, cap) {
                (Some(speed), Some(cap)) => format!("{speed} · {}", width_name(cap)),
                (Some(speed), None) => speed.clone(),
                (None, Some(cap)) => format!("Instant limited: {}", width_name(cap)),
                (None, None) => "Upload ready".into(),
            };
            let detail = match (&speed, cap) {
                (Some(speed), Some(cap)) => format!(
                    "Upload health passed at {speed}. Instant recordings are capped at {} to avoid stalls.",
                    width_name(cap)
                ),
                (None, Some(cap)) => format!(
                    "Upload health passed. Instant recordings are capped at {} to avoid stalls.",
                    width_name(cap)
                ),
                (Some(speed), None) => format!("Upload health passed at {speed}."),
                (None, None) => "Upload health passed.".into(),
            };
            Some(Indicator {
                label,
                detail,
                failed: false,
                limited: cap.is_some(),
            })
        }
        Status::Ready(_) => None,
    }
}

pub fn request(cx: &mut App, manual: bool) {
    let Some(scope) = current_scope() else {
        return;
    };
    let (ticket, registration, done) = {
        let mut controller = lock_controller();
        let now = Instant::now();
        if !should_start_probe(&controller, &scope, manual, now) {
            return;
        }
        let Some(ticket) = controller.admission.begin_probe() else {
            return;
        };
        if let Some(abort) = controller.active_abort.take() {
            abort.abort();
        }
        let (abort, registration) = AbortHandle::new_pair();
        let (done_tx, done_rx) = tokio::sync::watch::channel(false);
        controller.active_abort = Some(abort);
        controller.active_done = Some(done_rx);
        controller.status = Status::Checking(scope.clone());
        controller.last_attempt = Some((scope.clone(), now));
        if manual {
            controller.last_manual = Some(now);
        }
        (ticket, registration, Arc::new(ProbeDone(done_tx)))
    };
    cx.refresh_windows();

    let probe_scope = scope.clone();
    let task = gpui_tokio::Tokio::spawn(cx, async move {
        let _done = done;
        Abortable::new(probe(probe_scope, ticket), registration).await
    });
    cx.spawn(async move |cx| {
        let outcome = task.await;
        cx.update(|cx| {
            let mut controller = lock_controller();
            if !controller.admission.accepts(ticket) {
                return;
            }
            controller.active_abort = None;
            apply_probe_outcome(&mut controller, scope, outcome, SystemTime::now());
            drop(controller);
            cx.refresh_windows();
        });
    })
    .detach();
}

fn should_start_probe(
    controller: &Controller,
    scope: &Scope,
    manual: bool,
    now: Instant,
) -> bool {
    if matches!(&controller.status, Status::Unsupported(unsupported) if unsupported == scope)
        && !manual
    {
        return false;
    }
    if manual
        && controller
            .last_manual
            .is_some_and(|at| now.duration_since(at) < MANUAL_COOLDOWN)
    {
        return false;
    }
    if !manual
        && controller
            .last_attempt
            .as_ref()
            .is_some_and(|(last_scope, at)| {
                last_scope == scope && now.duration_since(*at) < AUTOMATIC_PROBE_INTERVAL
            })
    {
        return false;
    }
    true
}

fn apply_probe_outcome<E: std::fmt::Display>(
    controller: &mut Controller,
    scope: Scope,
    outcome: Result<Result<Result<Measurement, ProbeError>, AbortError>, E>,
    now: SystemTime,
) {
    match outcome {
        Ok(Ok(Ok(measurement))) => {
            controller.measurement = Some(measurement.clone());
            controller.status = Status::Ready(measurement);
        }
        Ok(Ok(Err(ProbeError::Unsupported))) => {
            controller.measurement = None;
            controller.status = Status::Unsupported(scope);
        }
        Ok(Ok(Err(ProbeError::InvalidAuthentication))) => {
            controller.measurement = None;
            controller.status = Status::Idle;
        }
        Ok(Ok(Err(ProbeError::Failed(message)))) => {
            if !controller
                .measurement
                .as_ref()
                .is_some_and(|measurement| measurement.fresh_for(&scope, now))
            {
                controller.measurement = None;
            }
            controller.status = Status::Failed { scope, message };
        }
        Ok(Err(_aborted)) => {}
        Err(join_error) => {
            if !controller
                .measurement
                .as_ref()
                .is_some_and(|measurement| measurement.fresh_for(&scope, now))
            {
                controller.measurement = None;
            }
            controller.status = Status::Failed {
                scope,
                message: format!("Upload check stopped: {join_error}."),
            };
        }
    }
}

type AbortError = futures_util::future::Aborted;

struct ProbeDone(tokio::sync::watch::Sender<bool>);

impl Drop for ProbeDone {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

enum ProbeError {
    Unsupported,
    InvalidAuthentication,
    Failed(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResponse {
    bytes: usize,
    body_read_ms: f64,
    organization_id: String,
}

async fn probe(scope: Scope, ticket: u64) -> Result<Measurement, ProbeError> {
    let context = UploadRequestContext::for_upload(&scope.server, Some(&scope.owner))
        .map_err(|_| ProbeError::InvalidAuthentication)?;
    let client = auth::api_client().map_err(map_auth_error)?;
    let payload = Arc::new(probe_payload(PROBE_BYTES));
    let scope_for_request = scope.clone();

    context
        .run(async move {
            ensure_probe_accepted(ticket)?;
            let warm = auth::authed_request_with(
                &client,
                reqwest::Method::GET,
                "/api/desktop/upload-health",
                None,
            )
            .await
            .map_err(map_auth_error)?;
            if warm.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(ProbeError::Unsupported);
            }
            if !warm.status().is_success() {
                return Err(ProbeError::Failed(format!(
                    "Upload health endpoint returned {}.",
                    warm.status()
                )));
            }

            let mut samples = [Sample {
                bytes: 0,
                body_read_ms: 0.0,
            }; 2];
            let mut probed_organization = None;
            for (index, sample) in samples.iter_mut().enumerate() {
                ensure_probe_accepted(ticket)?;
                let mut query = Vec::new();
                if index == 0 {
                    query.push(("checkStorage", "true".to_string()));
                }
                if let Some(org) = &scope_for_request.organization {
                    query.push(("orgId", org.clone()));
                }
                let request = auth::authed_request_builder(
                    &client,
                    reqwest::Method::POST,
                    "/api/desktop/upload-health",
                )
                .map_err(map_auth_error)?
                .query(&query)
                .header("Content-Type", "application/octet-stream")
                .header("Content-Length", payload.len())
                .body(probe_body(payload.clone()));
                let response = request.send().await.map_err(|error| {
                    if error.is_timeout() {
                        ProbeError::Failed("Upload check timed out.".into())
                    } else {
                        ProbeError::Failed("Could not reach upload server.".into())
                    }
                })?;
                if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                    return Err(ProbeError::InvalidAuthentication);
                }
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Err(ProbeError::Unsupported);
                }
                if !response.status().is_success() {
                    return Err(ProbeError::Failed(format!(
                        "Upload storage check failed ({}).",
                        response.status()
                    )));
                }
                let parsed: ProbeResponse = response.json().await.map_err(|_| {
                    ProbeError::Failed("Upload health response was invalid.".into())
                })?;
                if parsed.bytes != payload.len() {
                    return Err(ProbeError::Failed(
                        "Upload check transferred an incomplete payload.".into(),
                    ));
                }
                if parsed.organization_id.is_empty() {
                    return Err(ProbeError::Failed(
                        "Upload health response had no organization.".into(),
                    ));
                }
                if let Some(existing) = &probed_organization
                    && existing != &parsed.organization_id
                {
                    return Err(ProbeError::Failed(
                        "Upload organization changed during check.".into(),
                    ));
                }
                probed_organization = Some(parsed.organization_id);
                *sample = Sample {
                    bytes: parsed.bytes,
                    body_read_ms: parsed.body_read_ms,
                };
            }
            ensure_probe_accepted(ticket)?;
            Ok(Measurement::from_samples(
                scope_for_request,
                probed_organization.ok_or_else(|| {
                    ProbeError::Failed("Upload health response had no organization.".into())
                })?,
                samples,
                SystemTime::now(),
            ))
        })
        .await
}

fn ensure_probe_accepted(ticket: u64) -> Result<(), ProbeError> {
    if lock_controller().admission.accepts(ticket) {
        Ok(())
    } else {
        Err(ProbeError::Failed("Upload check interrupted.".into()))
    }
}

fn map_auth_error(error: AuthApiError) -> ProbeError {
    match error {
        AuthApiError::InvalidAuthentication => ProbeError::InvalidAuthentication,
        AuthApiError::Timeout => ProbeError::Failed("Upload check timed out.".into()),
        other => ProbeError::Failed(other.message()),
    }
}

fn probe_payload(len: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut out = vec![0_u8; len];
    for chunk in out.chunks_mut(8) {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let bytes = state.to_le_bytes();
        chunk.copy_from_slice(&bytes[..chunk.len()]);
    }
    out
}

fn probe_body(payload: Arc<Vec<u8>>) -> reqwest::Body {
    let total = payload.len();
    let chunks = (0..total).step_by(PROBE_CHUNK_BYTES).map(move |offset| {
        let end = (offset + PROBE_CHUNK_BYTES).min(total);
        Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::copy_from_slice(&payload[offset..end]))
    });
    reqwest::Body::wrap_stream(futures_util::stream::iter(chunks))
}

fn current_scope() -> Option<Scope> {
    let auth = store::auth_snapshot();
    if !auth.signed_in() {
        return None;
    }
    let owner = store::store_section("auth")
        .get("user_id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())?
        .to_string();
    let organization = store::store_section(store::RECORDING_SETTINGS)
        .get("organizationId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    Some(Scope {
        server: auth::server_url(),
        owner,
        organization,
    })
}

fn configured_instant_width() -> u32 {
    if store::auth_snapshot().is_upgraded() {
        store::GeneralSettings::load().instant_mode_max_resolution
    } else {
        cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
    }
}

fn width_name(width: u32) -> &'static str {
    match width {
        0..=1280 => "720p",
        1281..=1920 => "1080p",
        1921..=2560 => "1440p",
        _ => "4K",
    }
}

#[cfg(test)]
async fn run_for_test<F, Fut>(mut make_future: F)
where
    F: FnMut(Arc<ProbeDone>, AbortHandle, futures_util::future::AbortRegistration) -> Fut,
    Fut: Future<Output = ()>,
{
    let (abort, registration) = AbortHandle::new_pair();
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    {
        let mut controller = lock_controller();
        controller.active_abort = Some(abort.clone());
        controller.active_done = Some(done_rx);
    }
    make_future(Arc::new(ProbeDone(done_tx)), abort, registration).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_health::policy::MEASUREMENT_TTL;

    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn sample_scope() -> Scope {
        Scope {
            server: "https://cap.so".into(),
            owner: "user-1".into(),
            organization: Some("org-1".into()),
        }
    }

    fn slow_measurement(scope: Scope, checked_at: SystemTime) -> Measurement {
        Measurement {
            scope,
            organization: "org-1".into(),
            checked_at,
            mbps: Some(4.0),
            max_width: Some(1280),
        }
    }

    #[tokio::test]
    async fn recording_admission_waits_for_aborted_probe_to_drop() {
        let _guard = TEST_LOCK.lock().await;
        invalidate();
        recording_released();

        run_for_test(|done, _abort, registration| async move {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _done = done;
                let _ = Abortable::new(
                    async move {
                        let _ = started_tx.send(());
                        std::future::pending::<()>().await;
                    },
                    registration,
                )
                .await;
            });

            started_rx.await.unwrap();
            recording_admitted();
            tokio::time::timeout(Duration::from_secs(1), wait_for_probe())
                .await
                .expect("probe dropped after recording admission");
            task.await.unwrap();
            recording_released();
        })
        .await;
    }

    #[tokio::test]
    async fn transfer_lease_aborts_active_probe_and_blocks_new_ones() {
        let _guard = TEST_LOCK.lock().await;
        invalidate();
        recording_released();

        run_for_test(|done, _abort, registration| async move {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _done = done;
                let _ = Abortable::new(
                    async move {
                        let _ = started_tx.send(());
                        std::future::pending::<()>().await;
                    },
                    registration,
                )
                .await;
            });

            started_rx.await.unwrap();
            let lease = acquire_transfer();
            tokio::time::timeout(Duration::from_secs(1), wait_for_probe())
                .await
                .expect("probe dropped after transfer admission");
            assert!(lock_controller().admission.begin_probe().is_none());
            drop(lease);
            assert!(lock_controller().admission.begin_probe().is_some());
            task.await.unwrap();
        })
        .await;
    }

    #[test]
    fn automatic_checks_refresh_before_measurement_ttl_and_keep_fresh_caps_on_failure() {
        let scope = sample_scope();
        let start = Instant::now();
        let checked_at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let measurement = slow_measurement(scope.clone(), checked_at);
        let mut controller = Controller {
            status: Status::Ready(measurement.clone()),
            measurement: Some(measurement),
            last_attempt: Some((scope.clone(), start)),
            ..Controller::default()
        };

        assert!(!should_start_probe(
            &controller,
            &scope,
            false,
            start + AUTOMATIC_PROBE_INTERVAL - Duration::from_secs(1)
        ));
        assert!(should_start_probe(
            &controller,
            &scope,
            false,
            start + AUTOMATIC_PROBE_INTERVAL
        ));
        assert!(AUTOMATIC_PROBE_INTERVAL < MEASUREMENT_TTL);

        apply_probe_outcome::<&str>(
            &mut controller,
            scope.clone(),
            Ok(Ok(Err(ProbeError::Failed("Temporary error.".into())))),
            checked_at + AUTOMATIC_PROBE_INTERVAL,
        );
        assert_eq!(
            controller
                .measurement
                .as_ref()
                .and_then(|m| m.max_width_for(
                    &scope,
                    Some("org-1"),
                    checked_at + AUTOMATIC_PROBE_INTERVAL
                )),
            Some(1280)
        );

        apply_probe_outcome::<&str>(
            &mut controller,
            scope.clone(),
            Ok(Ok(Err(ProbeError::Failed("Expired error.".into())))),
            checked_at + MEASUREMENT_TTL,
        );
        assert!(controller.measurement.is_none());
    }
}
