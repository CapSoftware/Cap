mod policy;

use std::{
    sync::{Mutex, MutexGuard, OnceLock},
    time::{Duration, SystemTime},
};

use futures_util::future::{AbortHandle, AbortRegistration, Abortable, select};
use gpui::App;
use policy::{AUTOMATIC_PROBE_INTERVAL, Admission, Measurement, Sample, Scope};
use serde::Deserialize;

use crate::{auth, session::RecordingSession, store};

#[derive(Clone, Copy, Default)]
enum Status {
    #[default]
    Unknown,
    Checking,
    Ready,
    Failed,
    Unsupported,
}

struct Running {
    ticket: u64,
    abort: AbortHandle,
    done: flume::Receiver<()>,
}

#[derive(Default)]
struct Controller {
    admission: Admission,
    scope: Option<Scope>,
    measurement: Option<Measurement>,
    status: Status,
    running: Option<Running>,
    attempted_at: Option<SystemTime>,
    applied_width: Option<u32>,
}

fn controller() -> MutexGuard<'static, Controller> {
    static STATE: OnceLock<Mutex<Controller>> = OnceLock::new();
    STATE
        .get_or_init(|| Mutex::new(Controller::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn wake_channel() -> &'static (flume::Sender<()>, flume::Receiver<()>) {
    static WAKE: OnceLock<(flume::Sender<()>, flume::Receiver<()>)> = OnceLock::new();
    WAKE.get_or_init(|| flume::bounded(1))
}

fn notify_wake() {
    let _ = wake_channel().0.try_send(());
}

impl Controller {
    fn admit_recording(&mut self) {
        self.applied_width = None;
        self.status = Status::Unknown;
        self.admission.admit_recording();
        if let Some(running) = &self.running {
            running.abort.abort();
        }
    }

    fn admit_transfer(&mut self) {
        self.status = Status::Unknown;
        self.admission.admit_transfer();
        if let Some(running) = &self.running {
            running.abort.abort();
        }
    }

    fn release_transfer(&mut self) {
        self.admission.release_transfer();
    }

    fn begin_request(
        &mut self,
        scope: Option<Scope>,
        recording_in_flight: bool,
        manual: bool,
        now: SystemTime,
    ) -> Option<(Scope, u64, AbortRegistration, Completion)> {
        if self.scope != scope {
            self.admission.invalidate();
            if let Some(running) = &self.running {
                running.abort.abort();
            }
            self.scope = scope.clone();
            self.measurement = None;
            self.attempted_at = None;
            self.status = Status::Unknown;
        }
        let scope = scope?;
        let interval = if manual {
            Duration::from_secs(60)
        } else {
            AUTOMATIC_PROBE_INTERVAL
        };
        if self.running.is_some()
            || recording_in_flight
            || self
                .attempted_at
                .is_some_and(|at| now.duration_since(at).is_ok_and(|age| age < interval))
        {
            return None;
        }
        let ticket = self.admission.begin_probe()?;
        let (abort, registration) = AbortHandle::new_pair();
        let (done, receiver) = flume::bounded(1);
        self.running = Some(Running {
            ticket,
            abort,
            done: receiver,
        });
        self.status = Status::Checking;
        self.attempted_at = Some(now);
        Some((scope, ticket, registration, Completion(done)))
    }

    fn finish_request(
        &mut self,
        ticket: u64,
        expected_scope: &Scope,
        current_scope: Option<&Scope>,
        result: Result<Measurement, ProbeError>,
        now: SystemTime,
    ) -> bool {
        if !self
            .running
            .as_ref()
            .is_some_and(|running| running.ticket == ticket)
        {
            return false;
        }
        self.running = None;
        if !self.admission.accepts(ticket) || current_scope != Some(expected_scope) {
            self.status = Status::Unknown;
            self.attempted_at = self
                .measurement
                .as_ref()
                .map(|measurement| measurement.checked_at);
        } else {
            match result {
                Ok(measurement) => {
                    self.attempted_at = Some(measurement.checked_at);
                    self.measurement = Some(measurement);
                    self.status = Status::Ready;
                }
                Err(ProbeError::Unsupported) => {
                    self.measurement = None;
                    self.status = Status::Unsupported;
                }
                Err(ProbeError::Failed) => {
                    if self
                        .measurement
                        .as_ref()
                        .is_none_or(|measurement| !measurement.fresh_for(expected_scope, now))
                    {
                        self.measurement = None;
                    }
                    self.status = Status::Failed;
                }
            }
        }
        true
    }
}

fn current_scope() -> Option<Scope> {
    store::auth_snapshot().token?;
    Some(Scope {
        server: auth::server_url(),
        owner: store::store_section("auth")
            .get("user_id")?
            .as_str()?
            .to_string(),
        organization: store::store_section(store::RECORDING_SETTINGS)
            .get("organizationId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
    })
}

pub(crate) fn invalidate() {
    let mut state = controller();
    state.admission.invalidate();
    if let Some(running) = &state.running {
        running.abort.abort();
    }
    state.measurement = None;
    state.attempted_at = None;
    state.status = Status::Unknown;
    drop(state);
    notify_wake();
}

pub(crate) fn recording_admitted() {
    controller().admit_recording();
}

pub(crate) fn recording_released() {
    let mut state = controller();
    state.admission.release_recording();
    state.applied_width = None;
    drop(state);
    notify_wake();
}

pub(crate) struct TransferLease;

impl Drop for TransferLease {
    fn drop(&mut self) {
        let mut state = controller();
        state.release_transfer();
        drop(state);
        notify_wake();
    }
}

pub(crate) fn acquire_transfer() -> TransferLease {
    controller().admit_transfer();
    TransferLease
}

#[cfg(test)]
pub(crate) fn probe_admitted_for_test() -> bool {
    controller().admission.begin_probe().is_some()
}

pub(crate) async fn wait_for_probe() {
    let done = controller()
        .running
        .as_ref()
        .map(|running| running.done.clone());
    if let Some(done) = done {
        let _ = done.recv_async().await;
    }
}

pub(crate) fn max_width(configured: u32, organization: Option<&str>) -> u32 {
    let Some(scope) = current_scope() else {
        return configured;
    };
    let mut state = controller();
    let width = state
        .measurement
        .as_ref()
        .and_then(|measurement| measurement.max_width_for(&scope, organization, SystemTime::now()))
        .map_or(configured, |cap| configured.min(cap));
    state.applied_width = (width < configured).then_some(width);
    width
}

pub(crate) struct Indicator {
    pub label: String,
    pub tooltip: String,
    pub failed: bool,
    pub limited: bool,
}

pub(crate) fn indicator() -> Option<Indicator> {
    let scope = current_scope()?;
    let state = controller();
    let measurement = state
        .measurement
        .as_ref()
        .filter(|measurement| {
            !matches!(state.status, Status::Failed)
                && measurement.fresh_for(&scope, SystemTime::now())
        });
    let (label, tooltip, failed, limited) = if let Some(width) = state.applied_width {
        (
            format!("Instant limited: {}p", width * 9 / 16),
            "This recording uses a lower resolution because repeated upload samples were slow. Your saved setting is unchanged; retest after recording.".into(),
            false,
            true,
        )
    } else if state.scope.as_ref() == Some(&scope) && matches!(state.status, Status::Checking) {
        (
            "Checking upload".into(),
            "Checking upload availability and transfer speed.".into(),
            false,
            false,
        )
    } else if let Some(measurement) = measurement {
        let speed = measurement
            .mbps
            .map_or_else(|| "Upload OK".to_string(), |rate| format!("{rate:.1} Mb/s"));
        let configured = if store::auth_snapshot().is_upgraded() {
            store::GeneralSettings::load().instant_mode_max_resolution
        } else {
            cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
        };
        let cap = measurement.max_width.filter(|cap| *cap < configured);
        match cap {
            Some(width) => (
                format!("{speed} · {}p", width * 9 / 16),
                format!(
                    "Repeated slow uploads: Instant recordings are limited to {}p. Your saved resolution is unchanged. Click to retest while idle.",
                    width * 9 / 16
                ),
                false,
                true,
            ),
            None => (
                speed,
                "Upload destination is writable. Click to retest while idle. Tests are paused during recording.".into(),
                false,
                false,
            ),
        }
    } else {
        match if state.scope.as_ref() == Some(&scope) {
            state.status
        } else {
            Status::Unknown
        } {
            Status::Checking => (
                "Checking upload".into(),
                "Checking upload availability and transfer speed.".into(),
                false,
                false,
            ),
            Status::Failed => (
                "Upload check failed".into(),
                "The upload check failed. Check your connection and storage settings, retry while idle, or contact support. Recording is still available.".into(),
                true,
                false,
            ),
            Status::Unsupported => (
                "Upload check unavailable".into(),
                "This server does not support upload diagnostics. Your recording resolution is unchanged.".into(),
                false,
                false,
            ),
            _ => (
                "Check upload".into(),
                "Click to check the upload destination and speed while idle.".into(),
                false,
                false,
            ),
        }
    };
    Some(Indicator {
        label,
        tooltip,
        failed,
        limited,
    })
}

struct Completion(flume::Sender<()>);

impl Drop for Completion {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

pub(crate) fn request(cx: &mut App, manual: bool) {
    let scope = current_scope();
    let recording_in_flight = RecordingSession::recording_in_flight(cx);
    let Some((scope, ticket, registration, completion)) =
        controller().begin_request(scope, recording_in_flight, manual, SystemTime::now())
    else {
        return;
    };
    let expected_scope = scope.clone();
    let task = gpui_tokio::Tokio::spawn(cx, async move {
        let _completion = completion;
        Abortable::new(probe(scope, ticket), registration).await
    });
    cx.spawn(async move |cx| {
        let result = match task.await {
            Ok(Ok(result)) => result,
            _ => Err(ProbeError::Failed),
        };
        cx.update(|cx| {
            let active_scope = current_scope();
            let updated = controller().finish_request(
                ticket,
                &expected_scope,
                active_scope.as_ref(),
                result,
                SystemTime::now(),
            );
            if updated {
                cx.refresh_windows();
            }
        });
    })
    .detach();
    cx.refresh_windows();
}

pub(crate) fn init(cx: &mut App) {
    let wake = wake_channel().1.clone();
    cx.spawn(async move |cx| {
        loop {
            cx.update(|cx| request(cx, false));
            let timer = cx.background_executor().timer(Duration::from_secs(15));
            let notified = wake.recv_async();
            let _ = select(std::pin::pin!(timer), std::pin::pin!(notified)).await;
        }
    })
    .detach();
}

#[derive(Debug)]
enum ProbeError {
    Failed,
    Unsupported,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResponse {
    bytes: usize,
    body_read_ms: f64,
    organization_id: String,
}

fn probe_admitted(ticket: u64, scope: &Scope) -> bool {
    current_scope().as_ref() == Some(scope) && controller().admission.accepts(ticket)
}

async fn probe(scope: Scope, ticket: u64) -> Result<Measurement, ProbeError> {
    let client = auth::api_client().map_err(|_| ProbeError::Failed)?;
    let context = auth::UploadRequestContext::for_upload(&scope.server, Some(&scope.owner))
        .map_err(|_| ProbeError::Failed)?;
    context
        .run(async {
            if !probe_admitted(ticket, &scope) {
                return Err(ProbeError::Failed);
            }
            let warm = auth::authed_request_with(
                &client,
                reqwest::Method::GET,
                "/api/desktop/upload-health",
                None,
            )
            .await
            .map_err(|_| ProbeError::Failed)?;
            if warm.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(ProbeError::Unsupported);
            }
            if !warm.status().is_success() {
                return Err(ProbeError::Failed);
            }
            warm.bytes().await.map_err(|_| ProbeError::Failed)?;
            let mut payload = vec![0_u8; 2 * 1024 * 1024];
            let mut random = 0x3ab1_5fc9_u32;
            for byte in &mut payload {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                *byte = random as u8;
            }
            let payload = bytes::Bytes::from(payload);
            let mut samples = [Sample {
                bytes: 0,
                body_read_ms: 0.,
            }; 2];
            let mut organization: Option<String> = None;
            for (index, sample) in samples.iter_mut().enumerate() {
                if !probe_admitted(ticket, &scope) {
                    return Err(ProbeError::Failed);
                }
                let path = if index == 0 {
                    "/api/desktop/upload-health?checkStorage=true"
                } else {
                    "/api/desktop/upload-health"
                };
                let mut request =
                    auth::authed_request_builder(&client, reqwest::Method::POST, path)
                        .map_err(|_| ProbeError::Failed)?;
                if let Some(id) = organization.as_ref().or(scope.organization.as_ref()) {
                    request = request.query(&[("orgId", id)]);
                }
                let response = request
                    .header("Content-Type", "application/octet-stream")
                    .timeout(Duration::from_secs(30))
                    .body(payload.clone())
                    .send()
                    .await
                    .map_err(|_| ProbeError::Failed)?;
                if !response.status().is_success() {
                    return Err(ProbeError::Failed);
                }
                let response = response
                    .json::<ProbeResponse>()
                    .await
                    .map_err(|_| ProbeError::Failed)?;
                if response.bytes != payload.len()
                    || response.organization_id.is_empty()
                    || organization
                        .as_ref()
                        .is_some_and(|id| *id != response.organization_id)
                {
                    return Err(ProbeError::Failed);
                }
                organization = Some(response.organization_id);
                *sample = Sample {
                    bytes: response.bytes,
                    body_read_ms: response.body_read_ms,
                };
            }
            Ok(Measurement::from_samples(
                scope.clone(),
                organization.ok_or(ProbeError::Failed)?,
                samples,
                SystemTime::now(),
            ))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct ActiveTransfer(Arc<AtomicBool>);

    impl Drop for ActiveTransfer {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn recording_waits_for_an_in_flight_transfer_to_be_dropped() {
        let active = Arc::new(AtomicBool::new(false));
        let mut state = Controller::default();
        let ticket = state.admission.begin_probe().unwrap();
        let (abort, registration) = AbortHandle::new_pair();
        let (done, receiver) = flume::bounded(1);
        let (started, ready) = flume::bounded(1);
        state.running = Some(Running {
            ticket,
            abort,
            done: receiver.clone(),
        });
        let completion = Completion(done);
        let transfer_active = active.clone();
        let task = tokio::spawn(async move {
            let _completion = completion;
            Abortable::new(
                async move {
                    transfer_active.store(true, Ordering::SeqCst);
                    let _transfer = ActiveTransfer(transfer_active);
                    started.send(()).unwrap();
                    std::future::pending::<()>().await;
                },
                registration,
            )
            .await
        });
        ready.recv_async().await.unwrap();
        assert!(active.load(Ordering::SeqCst));
        state.admit_recording();
        tokio::time::timeout(Duration::from_secs(1), receiver.recv_async())
            .await
            .unwrap()
            .unwrap();
        assert!(!active.load(Ordering::SeqCst));
        assert!(!state.admission.accepts(ticket));
        assert_eq!(state.admission.begin_probe(), None);
        assert!(task.await.unwrap().is_err());
    }

    #[test]
    fn dropping_an_unpolled_probe_still_releases_recording_startup() {
        let (done, receiver) = flume::bounded(1);
        let completion = Completion(done);
        let task = async move {
            let _completion = completion;
            std::future::pending::<()>().await;
        };
        drop(task);
        assert_eq!(receiver.try_recv(), Ok(()));
    }

    fn test_scope() -> Scope {
        Scope {
            server: "https://cap.example".into(),
            owner: "owner".into(),
            organization: Some("org-1".into()),
        }
    }

    fn slow_measurement(scope: Scope, checked_at: SystemTime) -> Measurement {
        let sample = Sample {
            bytes: 2 * 1024 * 1024,
            body_read_ms: 2. * 1024. * 1024. * 8. / (3. * 1000.),
        };
        Measurement::from_samples(scope, "org-1".into(), [sample, sample], checked_at)
    }

    #[tokio::test]
    async fn background_transfer_aborts_an_in_flight_probe_and_blocks_new_ones() {
        let active = Arc::new(AtomicBool::new(false));
        let mut state = Controller::default();
        let scope = test_scope();
        let t0 = SystemTime::now();
        let (_, ticket, registration, completion) = state
            .begin_request(Some(scope.clone()), false, false, t0)
            .unwrap();
        let receiver = state.running.as_ref().unwrap().done.clone();
        let (started, ready) = flume::bounded(1);
        let transfer_active = active.clone();
        let task = tokio::spawn(async move {
            let _completion = completion;
            Abortable::new(
                async move {
                    transfer_active.store(true, Ordering::SeqCst);
                    let _transfer = ActiveTransfer(transfer_active);
                    started.send(()).unwrap();
                    std::future::pending::<()>().await;
                },
                registration,
            )
            .await
        });
        ready.recv_async().await.unwrap();
        assert!(active.load(Ordering::SeqCst));
        state.admit_transfer();
        tokio::time::timeout(Duration::from_secs(1), receiver.recv_async())
            .await
            .unwrap()
            .unwrap();
        assert!(!active.load(Ordering::SeqCst));
        assert!(task.await.unwrap().is_err());
        assert!(
            state.finish_request(
                ticket,
                &scope,
                Some(&scope),
                Err(ProbeError::Failed),
                t0 + Duration::from_secs(1),
            )
        );
        assert_eq!(state.attempted_at, None);
        assert!(
            state
                .begin_request(
                    Some(scope.clone()),
                    false,
                    true,
                    t0 + Duration::from_secs(120),
                )
                .is_none()
        );
        state.release_transfer();
        assert!(
            state
                .begin_request(Some(scope), false, false, t0 + Duration::from_secs(2))
                .is_some()
        );
    }

    #[test]
    fn automatic_checks_refresh_before_measurement_ttl_expires_and_preserve_fresh_caps() {
        let mut state = Controller::default();
        let scope = test_scope();
        let t0 = SystemTime::now();
        let (_, first_ticket, _, _completion) = state
            .begin_request(Some(scope.clone()), false, false, t0)
            .unwrap();
        let first_checked_at = t0 + Duration::from_secs(5);
        assert!(state.finish_request(
            first_ticket,
            &scope,
            Some(&scope),
            Ok(slow_measurement(scope.clone(), first_checked_at)),
            first_checked_at,
        ));
        assert!(
            state
                .begin_request(
                    Some(scope.clone()),
                    false,
                    false,
                    first_checked_at + AUTOMATIC_PROBE_INTERVAL - Duration::from_secs(1),
                )
                .is_none()
        );
        let refresh_start = first_checked_at + AUTOMATIC_PROBE_INTERVAL;
        assert_eq!(
            state
                .measurement
                .as_ref()
                .and_then(|m| m.max_width_for(&scope, Some("org-1"), refresh_start)),
            Some(1280)
        );
        let (_, second_ticket, _, _completion) = state
            .begin_request(Some(scope.clone()), false, false, refresh_start)
            .unwrap();
        let refresh_failed_at = refresh_start + Duration::from_secs(5);
        assert!(state.finish_request(
            second_ticket,
            &scope,
            Some(&scope),
            Err(ProbeError::Failed),
            refresh_failed_at,
        ));
        assert_eq!(
            state
                .measurement
                .as_ref()
                .and_then(|m| m.max_width_for(&scope, Some("org-1"), refresh_failed_at)),
            Some(1280)
        );
    }
}
