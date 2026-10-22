mod policy;

use std::{
    sync::{Mutex, MutexGuard, OnceLock},
    time::{Duration, SystemTime},
};

use futures_util::future::{AbortHandle, Abortable};
use gpui::App;
use policy::{Admission, Measurement, Sample, Scope};
use serde::Deserialize;

use crate::{auth, session::RecordingSession, store};

const AUTOMATIC_PROBE_INTERVAL: Duration = Duration::from_secs(60 * 60);

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

impl Controller {
    fn admit_recording(&mut self) {
        self.applied_width = None;
        self.status = Status::Unknown;
        self.admission.admit_recording();
        if let Some(running) = &self.running {
            running.abort.abort();
        }
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
}

pub(crate) fn recording_admitted() {
    controller().admit_recording();
}

pub(crate) fn recording_released() {
    let mut state = controller();
    state.admission.release_recording();
    state.applied_width = None;
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

pub(crate) fn max_width(configured: u32) -> u32 {
    let Some(scope) = current_scope() else {
        return configured;
    };
    let mut state = controller();
    let width = state
        .measurement
        .as_ref()
        .filter(|measurement| measurement.fresh_for(&scope, SystemTime::now()))
        .and_then(|measurement| measurement.max_width)
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
        .filter(|measurement| measurement.fresh_for(&scope, SystemTime::now()));
    let (label, tooltip, failed, limited) = if let Some(width) = state.applied_width {
        (format!("Instant limited: {}p", width * 9 / 16),
        "This recording uses a lower resolution because repeated upload samples were slow. Your saved setting is unchanged; retest after recording.".into(), false, true)
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
                format!("Repeated slow uploads: Instant recordings are limited to {}p. Your saved resolution is unchanged. Click to retest while idle.", width * 9 / 16),
                false, true,
            ),
            None => (speed, "Upload destination is writable. Click to retest while idle. Tests are paused during recording.".into(), false, false),
        }
    } else {
        match if state.scope.as_ref() == Some(&scope) { state.status } else { Status::Unknown } {
            Status::Checking => ("Checking upload".into(), "Checking upload availability and transfer speed.".into(), false, false),
            Status::Failed => ("Upload check failed".into(), "The upload check failed. Check your connection and storage settings, retry while idle, or contact support. Recording is still available.".into(), true, false),
            Status::Unsupported => ("Upload check unavailable".into(), "This server does not support upload diagnostics. Your recording resolution is unchanged.".into(), false, false),
            _ => ("Check upload".into(), "Click to check the upload destination and speed while idle.".into(), false, false),
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
    let launch = {
        let mut state = controller();
        if state.scope != scope {
            state.admission.invalidate();
            if let Some(running) = &state.running {
                running.abort.abort();
            }
            state.scope = scope.clone();
            state.measurement = None;
            state.attempted_at = None;
            state.status = Status::Unknown;
        }
        let Some(scope) = scope else {
            return;
        };
        let interval = if manual {
            Duration::from_secs(60)
        } else {
            AUTOMATIC_PROBE_INTERVAL
        };
        if state.running.is_some()
            || RecordingSession::recording_in_flight(cx)
            || state
                .attempted_at
                .is_some_and(|at| at.elapsed().is_ok_and(|age| age < interval))
        {
            return;
        }
        let Some(ticket) = state.admission.begin_probe() else {
            return;
        };
        let (abort, registration) = AbortHandle::new_pair();
        let (done, receiver) = flume::bounded(1);
        state.running = Some(Running {
            ticket,
            abort,
            done: receiver,
        });
        state.status = Status::Checking;
        state.attempted_at = Some(SystemTime::now());
        (scope, ticket, registration, Completion(done))
    };
    let (scope, ticket, registration, completion) = launch;
    let expected_scope = scope.clone();
    let task = gpui_tokio::Tokio::spawn(cx, async move {
        let _completion = completion;
        Abortable::new(probe(scope), registration).await
    });
    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| {
            let mut state = controller();
            if !state
                .running
                .as_ref()
                .is_some_and(|running| running.ticket == ticket)
            {
                return;
            }
            state.running = None;
            if !state.admission.accepts(ticket) || current_scope().as_ref() != Some(&expected_scope)
            {
                state.status = Status::Unknown;
                if state.measurement.is_none() {
                    state.attempted_at = None;
                }
            } else {
                match result {
                    Ok(Ok(Ok(measurement))) => {
                        state.measurement = Some(measurement);
                        state.status = Status::Ready;
                    }
                    Ok(Ok(Err(ProbeError::Unsupported))) => {
                        state.measurement = None;
                        state.status = Status::Unsupported;
                    }
                    _ => {
                        state.measurement = None;
                        state.status = Status::Failed;
                    }
                }
            }
            drop(state);
            cx.refresh_windows();
        });
    })
    .detach();
    cx.refresh_windows();
}

pub(crate) fn init(cx: &mut App) {
    cx.spawn(async move |cx| {
        loop {
            cx.update(|cx| request(cx, false));
            cx.background_executor()
                .timer(Duration::from_secs(15))
                .await;
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
}

async fn probe(scope: Scope) -> Result<Measurement, ProbeError> {
    let client = auth::api_client().map_err(|_| ProbeError::Failed)?;
    let context = auth::UploadRequestContext::for_upload(&scope.server, Some(&scope.owner))
        .map_err(|_| ProbeError::Failed)?;
    context
        .run(async {
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
            for (index, sample) in samples.iter_mut().enumerate() {
                if current_scope().as_ref() != Some(&scope) {
                    return Err(ProbeError::Failed);
                }
                let path = if index == 0 {
                    "/api/desktop/upload-health?checkStorage=true"
                } else {
                    "/api/desktop/upload-health"
                };
                let response = auth::authed_request_builder(&client, reqwest::Method::POST, path)
                    .map_err(|_| ProbeError::Failed)?
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
                if response.bytes != payload.len() {
                    return Err(ProbeError::Failed);
                }
                *sample = Sample {
                    bytes: response.bytes,
                    body_read_ms: response.body_read_ms,
                };
            }
            Ok(Measurement::from_samples(
                scope.clone(),
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
}
