#[cfg(not(test))]
type Job = Box<dyn FnOnce() + Send>;

#[cfg(not(test))]
fn queue() -> &'static flume::Sender<Job> {
    static QUEUE: std::sync::OnceLock<flume::Sender<Job>> = std::sync::OnceLock::new();
    QUEUE.get_or_init(|| {
        let (tx, rx) = flume::unbounded::<Job>();
        let spawned = std::thread::Builder::new()
            .name("cap-documents-writer".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    job();
                }
            });
        if let Err(error) = spawned {
            tracing::error!(%error, "could not start the documents writer");
        }
        tx
    })
}

#[cfg(not(test))]
pub fn submit(job: impl FnOnce() + Send + 'static) {
    if let Err(flume::SendError(job)) = queue().send(Box::new(job)) {
        job();
    }
}

#[cfg(test)]
pub fn submit(job: impl FnOnce() + Send + 'static) {
    job();
}

pub async fn run<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = flume::bounded(1);
    submit(move || {
        let _ = tx.send(job());
    });
    rx.recv_async().await.ok()
}

pub fn flush_blocking(timeout: std::time::Duration) -> bool {
    let (tx, rx) = flume::bounded(1);
    submit(move || {
        let _ = tx.send(());
    });
    rx.recv_timeout(timeout).is_ok()
}
