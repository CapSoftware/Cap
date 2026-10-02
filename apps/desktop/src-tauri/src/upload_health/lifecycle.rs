use std::{future::Future, pin::Pin};

use tokio::sync::{Mutex, MutexGuard, Notify, futures::Notified};

#[derive(Default)]
pub(super) struct ProbeControl {
    running: Mutex<()>,
    cancelled: Notify,
}

impl ProbeControl {
    pub(super) fn try_start(&self) -> Option<ActiveProbe<'_>> {
        let running = self.running.try_lock().ok()?;
        let mut cancelled = Box::pin(self.cancelled.notified());
        cancelled.as_mut().enable();
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
}
