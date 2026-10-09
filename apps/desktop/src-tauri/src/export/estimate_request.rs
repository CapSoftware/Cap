use futures::FutureExt;
use std::{
    collections::HashMap,
    future::Future,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
pub struct EstimateRequests {
    cancellations: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
}

impl EstimateRequests {
    pub async fn run<T, Fut>(
        &self,
        path: PathBuf,
        estimate: impl FnOnce(Arc<AtomicBool>) -> Fut,
    ) -> Result<T, String>
    where
        Fut: Future<Output = Result<T, String>>,
    {
        let request = self.start(path)?;
        let cancel = request.cancellation();
        request.run(async move { estimate(cancel).await }).await
    }

    fn start(&self, path: PathBuf) -> Result<EstimateRequest<'_>, String> {
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self
            .cancellations
            .lock()
            .map_err(|error| error.to_string())?
            .insert(path.clone(), cancel.clone())
        {
            previous.store(true, Ordering::Release);
        }
        Ok(EstimateRequest {
            requests: self,
            path,
            cancel,
        })
    }

    pub fn cancel(&self, path: &Path) {
        if let Ok(cancellations) = self.cancellations.lock()
            && let Some(cancel) = cancellations.get(path)
        {
            cancel.store(true, Ordering::Release);
        }
    }
}

struct EstimateRequest<'a> {
    requests: &'a EstimateRequests,
    path: PathBuf,
    cancel: Arc<AtomicBool>,
}

impl EstimateRequest<'_> {
    fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    async fn run<T>(self, future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        match AssertUnwindSafe(future).catch_unwind().await {
            Ok(result) => result,
            Err(_) => {
                tracing::error!(target: "cap_desktop_export", "Export estimate panicked");
                Err("Export estimate failed unexpectedly".to_string())
            }
        }
    }
}

impl Drop for EstimateRequest<'_> {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Ok(mut cancellations) = self.requests.cancellations.lock()
            && cancellations
                .get(&self.path)
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancel))
        {
            let _ = cancellations.remove(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{executor::block_on, future};
    use std::task::Poll;

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn successful_request_returns_estimate_and_cleans_up() {
        let requests = EstimateRequests::default();
        let request = requests.start("example.cap".into()).unwrap();
        let cancel = request.cancellation();
        let result = block_on(request.run(async { Ok(42) }));
        assert_eq!(result, Ok(42));
        assert!(cancel.load(Ordering::Acquire));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn ordinary_error_is_preserved_and_cleans_up() {
        let requests = EstimateRequests::default();
        let request = requests.start("example.cap".into()).unwrap();
        let result = block_on(request.run(async { Err::<(), _>("Invalid resolution".into()) }));
        assert_eq!(result, Err("Invalid resolution".into()));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn polling_panic_returns_safe_error_and_drops_sample_resources() {
        let requests = EstimateRequests::default();
        let request = requests.start("example.cap".into()).unwrap();
        let cancel = request.cancellation();
        let dropped = Arc::new(AtomicBool::new(false));
        let signal = dropped.clone();
        let result = block_on(request.run(async move {
            let _sample = DropSignal(signal);
            let mut yielded = false;
            future::poll_fn(|cx| {
                if yielded {
                    Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
            })
            .await;
            future::poll_fn(|_| -> Poll<Result<(), String>> {
                panic!("synthetic pipeline validation failure with private details")
            })
            .await
        }));
        assert_eq!(result, Err("Export estimate failed unexpectedly".into()));
        assert!(dropped.load(Ordering::Acquire));
        assert!(cancel.load(Ordering::Acquire));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn dropping_pending_request_cancels_and_cleans_up() {
        let requests = EstimateRequests::default();
        let request = requests.start("example.cap".into()).unwrap();
        let cancel = request.cancellation();
        let mut running = Box::pin(request.run(future::pending::<Result<(), String>>()));
        assert!(running.as_mut().now_or_never().is_none());
        assert!(!cancel.load(Ordering::Acquire));
        drop(running);
        assert!(cancel.load(Ordering::Acquire));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn superseded_request_cannot_remove_replacement() {
        let requests = EstimateRequests::default();
        let path = PathBuf::from("example.cap");
        let first = requests.start(path.clone()).unwrap();
        let first_cancel = first.cancellation();
        let second = requests.start(path.clone()).unwrap();
        let second_cancel = second.cancellation();
        assert!(first_cancel.load(Ordering::Acquire));
        assert_eq!(block_on(first.run(async { Ok(()) })), Ok(()));
        assert!(!second_cancel.load(Ordering::Acquire));
        assert!(Arc::ptr_eq(
            requests.cancellations.lock().unwrap().get(&path).unwrap(),
            &second_cancel,
        ));
        requests.cancel(&path);
        assert!(second_cancel.load(Ordering::Acquire));
        drop(second);
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn panicking_request_cannot_remove_replacement() {
        let requests = EstimateRequests::default();
        let path = PathBuf::from("example.cap");
        let first = requests.start(path.clone()).unwrap();
        let second = requests.start(path.clone()).unwrap();
        let second_cancel = second.cancellation();
        let result = block_on(first.run(future::poll_fn(|_| -> Poll<Result<(), String>> {
            panic!("synthetic failure")
        })));
        assert!(result.is_err());
        assert!(Arc::ptr_eq(
            requests.cancellations.lock().unwrap().get(&path).unwrap(),
            &second_cancel,
        ));
        assert!(!second_cancel.load(Ordering::Acquire));
        requests.cancel(&path);
        assert!(second_cancel.load(Ordering::Acquire));
    }

    #[test]
    fn dropping_unpolled_request_cleans_up_registration() {
        let requests = EstimateRequests::default();
        let request = requests.start("example.cap".into()).unwrap();
        let cancel = request.cancellation();
        drop(request.run(future::pending::<Result<(), String>>()));
        assert!(cancel.load(Ordering::Acquire));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn cancellation_is_scoped_to_the_requested_project() {
        let requests = EstimateRequests::default();
        let first = requests.start("first.cap".into()).unwrap();
        let second = requests.start("second.cap".into()).unwrap();
        requests.cancel(Path::new("first.cap"));
        assert!(first.cancellation().load(Ordering::Acquire));
        assert!(!second.cancellation().load(Ordering::Acquire));
    }

    #[test]
    fn run_passes_the_registered_cancellation_to_the_estimate() {
        let requests = EstimateRequests::default();
        let path = PathBuf::from("example.cap");
        let result = block_on(requests.run(path.clone(), |cancel| {
            let requests = &requests;
            let path = path.clone();
            async move {
                assert!(!cancel.load(Ordering::Acquire));
                requests.cancel(&path);
                Ok(cancel.load(Ordering::Acquire))
            }
        }));
        assert_eq!(result, Ok(true));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn run_settles_a_panicking_estimate_and_cleans_up() {
        let requests = EstimateRequests::default();
        let observed = Arc::new(Mutex::new(None));
        let seen = observed.clone();
        let result = block_on(requests.run("example.cap".into(), |cancel| {
            *seen.lock().unwrap() = Some(cancel);
            future::poll_fn(|_| -> Poll<Result<(), String>> {
                panic!("synthetic rendering failure")
            })
        }));
        assert_eq!(result, Err("Export estimate failed unexpectedly".into()));
        let cancel = observed.lock().unwrap().take().unwrap();
        assert!(cancel.load(Ordering::Acquire));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn run_settles_a_panic_while_building_the_estimate() {
        let requests = EstimateRequests::default();
        let result = block_on(requests.run(
            "example.cap".into(),
            |_| -> future::Ready<Result<(), String>> { panic!("synthetic setup failure") },
        ));
        assert_eq!(result, Err("Export estimate failed unexpectedly".into()));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }

    #[test]
    fn new_request_can_succeed_after_a_panic() {
        let requests = EstimateRequests::default();
        let first = requests.start("example.cap".into()).unwrap();
        let result = block_on(first.run(future::poll_fn(|_| -> Poll<Result<(), String>> {
            panic!("synthetic failure")
        })));
        assert!(result.is_err());
        let second = requests.start("example.cap".into()).unwrap();
        assert!(!second.cancellation().load(Ordering::Acquire));
        assert_eq!(block_on(second.run(async { Ok(42) })), Ok(42));
        assert!(requests.cancellations.lock().unwrap().is_empty());
    }
}
