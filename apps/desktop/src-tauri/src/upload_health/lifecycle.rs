use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use tokio::sync::{Mutex, MutexGuard, Notify, futures::Notified};

#[derive(Default)]
pub(super) struct ProbeControl {
    running: Mutex<()>,
    cancelled: Notify,
    terminal: Arc<TerminalPauses>,
}

impl ProbeControl {
    pub(super) fn try_start(&self) -> Option<ActiveProbe<'_>> {
        let running = self.running.try_lock().ok()?;
        if self.pause_state().is_some() {
            return None;
        }
        let mut cancelled = Box::pin(self.cancelled.notified());
        cancelled.as_mut().enable();
        if self.pause_state().is_some() {
            return None;
        }
        Some(ActiveProbe {
            _running: running,
            cancelled,
        })
    }

    pub(super) fn cancel(&self) {
        self.cancelled.notify_waiters();
    }

    pub(super) async fn cancel_and_wait(&self) {
        self.cancel();
        drop(self.running.lock().await);
    }

    pub(super) fn pause(&self) -> ProbePause {
        self.pause_kind(PauseKind::Terminal)
    }

    #[cfg(any(not(target_os = "linux"), test))]
    pub(super) fn pause_startup(&self) -> ProbePause {
        self.pause_kind(PauseKind::Startup)
    }

    fn pause_kind(&self, kind: PauseKind) -> ProbePause {
        kind.active(&self.terminal).fetch_add(1, Ordering::SeqCst);
        self.cancel();
        ProbePause {
            recovery: ProbeRecoveryToken {
                terminal: Arc::clone(&self.terminal),
                state: Arc::new(StdMutex::new(PauseRecoveryState::default())),
                kind,
            },
        }
    }

    pub(super) fn pause_state(&self) -> Option<PauseState> {
        // A failed guard publishes unconfirmed before decrementing this count.
        let active = self.terminal.active.load(Ordering::SeqCst);
        let startup = self.terminal.startup.load(Ordering::SeqCst);
        if self.terminal.unconfirmed.load(Ordering::SeqCst) > 0 {
            Some(PauseState::Unconfirmed)
        } else if active > 0 {
            Some(PauseState::Stopping)
        } else if startup > 0 {
            Some(PauseState::Starting)
        } else {
            None
        }
    }
}

#[derive(Default)]
struct TerminalPauses {
    active: AtomicUsize,
    startup: AtomicUsize,
    unconfirmed: AtomicUsize,
}

#[derive(Clone, Copy)]
enum PauseKind {
    #[cfg(any(not(target_os = "linux"), test))]
    Startup,
    Terminal,
}

impl PauseKind {
    fn active(self, pauses: &TerminalPauses) -> &AtomicUsize {
        match self {
            #[cfg(any(not(target_os = "linux"), test))]
            Self::Startup => &pauses.startup,
            Self::Terminal => &pauses.active,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PauseState {
    Starting,
    Stopping,
    Unconfirmed,
}

pub(crate) struct ProbePause {
    recovery: ProbeRecoveryToken,
}

#[derive(Clone)]
pub(crate) struct ProbeRecoveryToken {
    terminal: Arc<TerminalPauses>,
    state: Arc<StdMutex<PauseRecoveryState>>,
    kind: PauseKind,
}

#[derive(Default)]
struct PauseRecoveryState {
    acknowledged: bool,
    dropped: bool,
}

impl ProbeRecoveryToken {
    pub(crate) fn acknowledge_capture(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.acknowledged {
            if state.dropped {
                self.terminal.unconfirmed.fetch_sub(1, Ordering::SeqCst);
            }
            state.acknowledged = true;
        }
    }
}

impl ProbePause {
    pub(crate) fn recovery_token(&self) -> ProbeRecoveryToken {
        self.recovery.clone()
    }

    pub(crate) fn cancel_before_handoff(self) {
        self.recovery.acknowledge_capture();
    }

    pub(crate) fn spawn<T, F>(self, shutdown: F) -> tokio::task::JoinHandle<T>
    where
        T: Send + 'static,
        F: Future<Output = (T, bool)> + Send + 'static,
    {
        // The task owns both shutdown and its pause even if the command is dropped.
        tokio::spawn(async move {
            let pause = self;
            let (result, acknowledged) = shutdown.await;
            if acknowledged {
                pause.recovery.acknowledge_capture();
            }
            result
        })
    }
}

impl Drop for ProbePause {
    fn drop(&mut self) {
        let mut state = self
            .recovery
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.acknowledged {
            self.recovery
                .terminal
                .unconfirmed
                .fetch_add(1, Ordering::SeqCst);
        }
        state.dropped = true;
        self.recovery
            .kind
            .active(&self.recovery.terminal)
            .fetch_sub(1, Ordering::SeqCst);
    }
}

pub(super) struct ActiveProbe<'a> {
    _running: MutexGuard<'a, ()>,
    cancelled: Pin<Box<Notified<'a>>>,
}

impl ActiveProbe<'_> {
    pub(super) async fn run<Probe: Future>(&mut self, probe: Probe) -> Option<Probe::Output> {
        tokio::select! {
            biased;
            () = &mut self.cancelled => None,
            result = probe => Some(result),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::{pending, ready},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use tokio::{io::AsyncReadExt, net::TcpListener, sync::oneshot};

    use super::*;

    #[tokio::test]
    async fn startup_exclusion_cancels_probes_and_failed_drop_requires_its_own_ack() {
        let control = ProbeControl::default();
        let mut active = control.try_start().unwrap();
        let pause = control.pause_startup();
        let recovery = pause.recovery_token();
        assert_eq!(control.pause_state(), Some(PauseState::Starting));
        assert_eq!(
            active
                .run(async { panic!("startup exclusion must cancel the active probe") })
                .await,
            None::<()>
        );
        drop(active);
        assert!(control.try_start().is_none());
        let terminal = control.pause();
        assert_eq!(control.pause_state(), Some(PauseState::Stopping));
        terminal.cancel_before_handoff();
        assert_eq!(control.pause_state(), Some(PauseState::Starting));
        drop(pause);
        assert_eq!(control.pause_state(), Some(PauseState::Unconfirmed));
        assert!(control.try_start().is_none());
        recovery.acknowledge_capture();
        assert_eq!(control.pause_state(), None);
        assert!(control.try_start().is_some());
    }

    #[tokio::test]
    async fn cancellation_before_first_poll_does_not_start_the_request() {
        let control = ProbeControl::default();
        let mut active = control.try_start().expect("probe should start");
        control.cancel();

        let result = active
            .run(async { panic!("a cancelled probe must not send an HTTP request") })
            .await;

        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn only_one_probe_can_run_at_a_time() {
        let control = ProbeControl::default();
        let mut active = control.try_start().expect("probe should start");
        assert!(control.try_start().is_none());
        assert_eq!(active.run(ready(42)).await, Some(42));
        assert!(control.try_start().is_none());
        drop(active);
        assert!(control.try_start().is_some());
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn recording_waits_until_in_flight_request_is_dropped() {
        let control = Arc::new(ProbeControl::default());
        let request_dropped = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = oneshot::channel();
        let probe_control = Arc::clone(&control);
        let dropped = Arc::clone(&request_dropped);
        let task = tokio::spawn(async move {
            let mut active = probe_control.try_start().expect("probe should start");
            active
                .run(async move {
                    let _drop_flag = DropFlag(dropped);
                    started_tx.send(()).expect("receiver should be waiting");
                    pending::<()>().await;
                })
                .await
        });

        started_rx
            .await
            .expect("probe should enter the upload POST");
        control.cancel_and_wait().await;

        assert!(request_dropped.load(Ordering::SeqCst));
        assert_eq!(task.await.expect("probe task should not panic"), None);
        assert!(control.try_start().is_some());
    }

    #[tokio::test]
    async fn cancels_a_real_http_request_waiting_for_its_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("test listener should bind");
        let url = format!("http://{}/upload-health", listener.local_addr().unwrap());
        let (request_tx, request_rx) = oneshot::channel();
        let (stop_tx, stop_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut method = [0; 5];
            socket.read_exact(&mut method).await.unwrap();
            assert_eq!(&method, b"POST ");
            request_tx.send(()).unwrap();
            stop_rx.await.unwrap();
        });
        let control = Arc::new(ProbeControl::default());
        let probe_control = Arc::clone(&control);
        let request = tokio::spawn(async move {
            let mut active = probe_control.try_start().expect("probe should start");
            active
                .run(async {
                    reqwest::Client::builder()
                        .no_proxy()
                        .build()
                        .unwrap()
                        .post(url)
                        .body(vec![0; 256 * 1024])
                        .send()
                        .await
                })
                .await
        });

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            request_rx.await.unwrap();
            control.cancel_and_wait().await;
            assert!(request.await.unwrap().is_none());
            stop_tx.send(()).unwrap();
            server.await.unwrap();
        })
        .await
        .expect("cancellation should not wait for the HTTP response");
    }

    #[tokio::test]
    async fn previous_cancellation_does_not_cancel_a_later_probe() {
        let control = ProbeControl::default();
        let mut active = control.try_start().expect("probe should start");
        control.cancel();
        assert_eq!(active.run(ready(1)).await, None);
        drop(active);

        control.cancel_and_wait().await;
        let mut next = control.try_start().expect("next probe should start");
        assert_eq!(next.run(ready(2)).await, Some(2));
    }

    #[tokio::test]
    async fn held_terminal_shutdown_blocks_probes_until_acknowledged() {
        let control = ProbeControl::default();
        let mut active = control.try_start().unwrap();
        let pause = control.pause();
        assert_eq!(active.run(ready(1)).await, None);
        drop(active);

        let (ack_tx, ack_rx) = oneshot::channel();
        let shutdown = pause.spawn(async move {
            ack_rx.await.unwrap();
            (Some("cancelled-video"), true)
        });
        assert_eq!(control.pause_state(), Some(PauseState::Stopping));
        assert!(control.try_start().is_none());
        ack_tx.send(()).unwrap();
        assert_eq!(shutdown.await.unwrap(), Some("cancelled-video"));
        assert_eq!(control.pause_state(), None);
        let mut next = control.try_start().unwrap();
        assert_eq!(next.run(ready(2)).await, Some(2));
    }

    #[tokio::test]
    async fn aborting_a_terminal_caller_does_not_cancel_owned_shutdown() {
        let control = Arc::new(ProbeControl::default());
        let (ack_tx, ack_rx) = oneshot::channel();
        let (started_tx, started_rx) = oneshot::channel();
        let (finished_tx, finished_rx) = oneshot::channel();
        let pause = control.pause();
        let caller = tokio::spawn(async move {
            let shutdown = pause.spawn(async move {
                started_tx.send(()).unwrap();
                ack_rx.await.unwrap();
                finished_tx.send(()).unwrap();
                ((), true)
            });
            shutdown.await.unwrap();
        });
        started_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(control.pause_state(), Some(PauseState::Stopping));
        assert!(control.try_start().is_none());

        ack_tx.send(()).unwrap();
        finished_rx.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while control.pause_state().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the detached shutdown must finish and release its pause");
        assert!(control.try_start().is_some());
    }

    #[tokio::test]
    async fn acknowledged_shutdown_preserves_errors_without_a_sticky_pause() {
        let control = ProbeControl::default();
        let result = control
            .pause()
            .spawn(async {
                (
                    Err::<(), _>("upload cleanup failed after capture stopped"),
                    true,
                )
            })
            .await
            .unwrap();
        assert_eq!(result, Err("upload cleanup failed after capture stopped"));
        assert_eq!(control.pause_state(), None);
        assert!(control.try_start().is_some());
    }

    #[tokio::test]
    async fn unconfirmed_shutdown_remains_paused_after_later_acknowledgements() {
        let control = ProbeControl::default();
        let result = control
            .pause()
            .spawn(async { (Err::<(), _>("capture shutdown timed out"), false) })
            .await
            .unwrap();
        assert_eq!(result, Err("capture shutdown timed out"));
        control.pause().spawn(async { ((), true) }).await.unwrap();
        assert_eq!(control.pause_state(), Some(PauseState::Unconfirmed));
        assert!(control.try_start().is_none());
    }

    #[tokio::test]
    async fn panicked_shutdown_keeps_probes_paused() {
        let control = ProbeControl::default();
        let result = control
            .pause()
            .spawn::<(), _>(async {
                panic!("shutdown failed before acknowledgment");
            })
            .await;
        assert!(result.unwrap_err().is_panic());
        assert_eq!(control.pause_state(), Some(PauseState::Unconfirmed));
        assert!(control.try_start().is_none());
    }

    #[tokio::test]
    async fn aborted_shutdown_task_keeps_probes_paused() {
        let control = ProbeControl::default();
        let task = control.pause().spawn(pending::<((), bool)>());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(control.pause_state(), Some(PauseState::Unconfirmed));
        assert!(control.try_start().is_none());
    }

    #[tokio::test]
    async fn nested_terminal_pauses_require_every_shutdown_acknowledgement() {
        let control = ProbeControl::default();
        let first = control.pause();
        let second = control.pause();
        first.spawn(async { ((), true) }).await.unwrap();
        assert_eq!(control.pause_state(), Some(PauseState::Stopping));
        assert!(control.try_start().is_none());
        second.spawn(async { ((), true) }).await.unwrap();
        assert_eq!(control.pause_state(), None);
        assert!(control.try_start().is_some());
    }

    #[tokio::test]
    async fn retained_recording_does_not_clear_another_terminal_pause() {
        let control = ProbeControl::default();
        control.pause().cancel_before_handoff();
        assert_eq!(control.pause_state(), None);
        assert!(control.try_start().is_some());

        let first = control.pause();
        control.pause().cancel_before_handoff();
        assert_eq!(control.pause_state(), Some(PauseState::Stopping));
        first.spawn(async { ((), false) }).await.unwrap();
        control.pause().cancel_before_handoff();
        assert_eq!(control.pause_state(), Some(PauseState::Unconfirmed));
        assert!(control.try_start().is_none());
    }

    #[tokio::test]
    async fn recovery_acknowledges_only_its_own_failed_pause() {
        let control = ProbeControl::default();
        let first = control.pause();
        let first_recovery = first.recovery_token();
        let second = control.pause();
        let second_recovery = second.recovery_token();
        first.spawn(async { ((), false) }).await.unwrap();
        second.spawn(async { ((), false) }).await.unwrap();

        first_recovery.acknowledge_capture();
        first_recovery.acknowledge_capture();
        assert_eq!(control.pause_state(), Some(PauseState::Unconfirmed));
        assert!(control.try_start().is_none());
        second_recovery.acknowledge_capture();
        assert_eq!(control.pause_state(), None);
        assert!(control.try_start().is_some());
    }

    #[tokio::test]
    async fn recovery_before_guard_drop_still_waits_for_owned_completion() {
        let control = ProbeControl::default();
        let pause = control.pause();
        let recovery = pause.recovery_token();
        let (complete_tx, complete_rx) = oneshot::channel();
        let shutdown = pause.spawn(async move {
            complete_rx.await.unwrap();
            ((), false)
        });

        recovery.acknowledge_capture();
        assert_eq!(control.pause_state(), Some(PauseState::Stopping));
        assert!(control.try_start().is_none());
        complete_tx.send(()).unwrap();
        shutdown.await.unwrap();
        assert_eq!(control.pause_state(), None);
        assert!(control.try_start().is_some());
    }

    #[test]
    fn concurrent_recovery_and_drop_never_reintroduce_a_failed_pause() {
        let control = ProbeControl::default();
        for _ in 0..128 {
            let pause = control.pause();
            let recovery = pause.recovery_token();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            std::thread::scope(|scope| {
                let drop_barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    drop_barrier.wait();
                    drop(pause);
                });
                barrier.wait();
                recovery.acknowledge_capture();
            });
            assert_eq!(control.pause_state(), None);
            assert!(control.try_start().is_some());
        }
    }
}
