use std::{future::Future, time::Duration};

use tokio::sync::{Mutex, watch};

pub(super) struct ProbeCoordinator {
    running: Mutex<()>,
    recording_started: watch::Sender<()>,
}

impl Default for ProbeCoordinator {
    fn default() -> Self {
        Self {
            running: Mutex::new(()),
            recording_started: watch::channel(()).0,
        }
    }
}

impl ProbeCoordinator {
    pub(super) fn cancel(&self) {
        self.recording_started.send_replace(());
    }

    pub(super) async fn wait_for_idle(&self) {
        let _guard = self.running.lock().await;
    }

    pub(super) async fn run_if_idle<T>(
        &self,
        is_recording: impl Future<Output = bool>,
        probe: impl Future<Output = T>,
    ) -> Option<T> {
        let Ok(_guard) = self.running.try_lock() else {
            return None;
        };
        let mut recording_started = self.recording_started.subscribe();
        if is_recording.await {
            return None;
        }

        tokio::select! {
            biased;
            _ = recording_started.changed() => None,
            snapshot = probe => Some(snapshot),
        }
    }
}

pub(super) async fn measure_warm_rtt<F, Fut>(mut measure: F) -> Option<Duration>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<Duration>>,
{
    measure().await?;
    measure().await
}

pub(super) fn upload_elapsed_after_rtt(
    total_elapsed: Duration,
    rtt_elapsed: Option<Duration>,
) -> Duration {
    let total_elapsed = total_elapsed.max(Duration::from_millis(1));
    let Some(rtt_elapsed) = rtt_elapsed else {
        return total_elapsed;
    };

    match total_elapsed.checked_sub(rtt_elapsed) {
        Some(adjusted_elapsed) if adjusted_elapsed >= Duration::from_millis(50) => adjusted_elapsed,
        _ => total_elapsed,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use super::*;

    struct Dropped(Arc<AtomicBool>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn recording_cancels_an_in_flight_probe_before_idle_returns() {
        let coordinator = Arc::new(ProbeCoordinator::default());
        let dropped = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn({
            let coordinator = coordinator.clone();
            let dropped = dropped.clone();
            async move {
                coordinator
                    .run_if_idle(async { false }, async {
                        let _guard = Dropped(dropped);
                        started_tx.send(()).unwrap();
                        std::future::pending::<u32>().await
                    })
                    .await
            }
        });

        started_rx.await.unwrap();
        coordinator.cancel();
        tokio::time::timeout(Duration::from_secs(1), coordinator.wait_for_idle())
            .await
            .unwrap();

        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(task.await.unwrap(), None);
    }

    #[tokio::test]
    async fn recording_start_during_state_check_does_not_start_the_request() {
        let coordinator = ProbeCoordinator::default();
        let polled = AtomicBool::new(false);
        let result = coordinator
            .run_if_idle(
                async {
                    coordinator.cancel();
                    false
                },
                async {
                    polled.store(true, Ordering::SeqCst);
                    1
                },
            )
            .await;

        assert_eq!(result, None);
        assert!(!polled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn pending_recording_after_lock_acquisition_does_not_start_the_request() {
        let coordinator = ProbeCoordinator::default();
        let polled = AtomicBool::new(false);
        let result = coordinator
            .run_if_idle(async { true }, async {
                polled.store(true, Ordering::SeqCst);
                1
            })
            .await;

        assert_eq!(result, None);
        assert!(!polled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn concurrent_refresh_does_not_run_a_second_probe() {
        let coordinator = ProbeCoordinator::default();
        let _guard = coordinator.running.lock().await;
        let result = coordinator
            .run_if_idle(async { false }, async { panic!("second probe started") })
            .await;

        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn a_new_refresh_can_run_after_recording_finishes() {
        let coordinator = ProbeCoordinator::default();
        coordinator.cancel();

        assert_eq!(
            coordinator.run_if_idle(async { false }, async { 42 }).await,
            Some(42)
        );
    }

    #[tokio::test]
    async fn cold_connection_time_is_not_subtracted_from_warm_upload() {
        let mut samples = [
            Some(Duration::from_millis(500)),
            Some(Duration::from_millis(50)),
        ]
        .into_iter();
        let rtt = measure_warm_rtt(|| std::future::ready(samples.next().unwrap())).await;

        assert_eq!(rtt, Some(Duration::from_millis(50)));
        assert_eq!(
            upload_elapsed_after_rtt(Duration::from_millis(700), rtt),
            Duration::from_millis(650)
        );
        assert!(samples.next().is_none());
    }

    #[tokio::test]
    async fn failed_warmup_does_not_treat_next_cold_request_as_rtt() {
        let mut samples = [None, Some(Duration::from_millis(500))].into_iter();
        let rtt = measure_warm_rtt(|| std::future::ready(samples.next().unwrap())).await;

        assert_eq!(rtt, None);
        assert_eq!(samples.next(), Some(Some(Duration::from_millis(500))));
    }

    #[test]
    fn keeps_total_elapsed_when_rtt_would_overcorrect() {
        assert_eq!(
            upload_elapsed_after_rtt(Duration::from_millis(520), Some(Duration::from_millis(500))),
            Duration::from_millis(520)
        );
    }
}
