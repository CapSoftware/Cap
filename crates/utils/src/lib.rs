use std::{future::Future, path::PathBuf};

use tracing::Instrument;

/// Wrapper around tokio::spawn that inherits the current tracing subscriber and span.
pub fn spawn_actor<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    use tracing::instrument::WithSubscriber;
    tokio::spawn(future.with_current_subscriber().in_current_span())
}

pub fn ensure_dir(path: &PathBuf) -> Result<PathBuf, std::io::Error> {
    std::fs::create_dir_all(path)?;
    Ok(path.clone())
}
