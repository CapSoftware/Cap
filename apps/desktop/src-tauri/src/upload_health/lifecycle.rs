use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
        self.terminal.active.fetch_add(1, Ordering::SeqCst);
        self.cancel();
        ProbePause {
            terminal: Arc::clone(&self.terminal),
            acknowledged: false,
        }
    }

    pub(super) fn pause_state(&self) -> Option<PauseState> {
        // A failed guard publishes unconfirmed before decrementing this count.
        let active = self.terminal.active.load(Ordering::SeqCst);
        if self.terminal.unconfirmed.load(Ordering::SeqCst) {
            Some(PauseState::Unconfirmed)
        } else if active > 0 {
            Some(PauseState::Stopping)
        } else {
            None
        }
    }
}

#[derive(Default)]
struct TerminalPauses {
    active: AtomicUsize,
    unconfirmed: AtomicBool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PauseState {
    Stopping,
    Unconfirmed,
}

pub(crate) struct ProbePause {
    terminal: Arc<TerminalPauses>,
    acknowledged: bool,
}

impl ProbePause {
    pub(crate) fn cancel_before_handoff(mut self) {
        self.acknowledged = true;
    }

    pub(crate) fn spawn<T, F>(mut self, shutdown: F) -> tokio::task::JoinHandle<T>
    where
        T: Send + 'static,
        F: Future<Output = (T, bool)> + Send + 'static,
    {
        // The task owns both shutdown and its pause even if the command is dropped.
        tokio::spawn(async move {
            let (result, acknowledged) = shutdown.await;
            self.acknowledged = acknowledged;
            result
        })
    }
}

impl Drop for ProbePause {
    fn drop(&mut self) {
        if !self.acknowledged {
            self.terminal.unconfirmed.store(true, Ordering::SeqCst);
        }
        self.terminal.active.fetch_sub(1, Ordering::SeqCst);
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
}
