//! One file, downloaded to a hidden staging file beside its destination,
//! checked against the size and sha256 the catalogue pins, and renamed into
//! place only when both match. A crash, a cancel or a bad byte leaves the
//! destination untouched.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt as _;
use sha2::Digest as _;

use super::catalog::FileRef;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    Offline,
    Timeout,
    Http(u16),
    /// Wrong size or hash: a broken transfer or a bad mirror.
    Corrupt,
    NoSpace,
    Disk(String),
    Cancelled,
}

impl FetchError {
    pub fn retryable(&self) -> bool {
        match self {
            Self::Offline | Self::Timeout | Self::Corrupt => true,
            Self::Http(status) => *status == 408 || *status == 429 || *status >= 500,
            Self::NoSpace | Self::Disk(_) | Self::Cancelled => false,
        }
    }
}

pub(super) static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .user_agent(concat!("Cap-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
});

fn request_error(error: &reqwest::Error) -> FetchError {
    if error.is_timeout() {
        FetchError::Timeout
    } else if let Some(status) = error.status() {
        FetchError::Http(status.as_u16())
    } else {
        FetchError::Offline
    }
}

pub(super) fn io_error(error: std::io::Error) -> FetchError {
    if error.kind() == std::io::ErrorKind::StorageFull {
        FetchError::NoSpace
    } else {
        FetchError::Disk(error.to_string())
    }
}

/// `.<name>.<pid>-<n>.part` in the destination's folder, so the final rename
/// never crosses a filesystem and a stale one is easy to recognise.
pub(super) fn staging_path(destination: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    destination.with_file_name(format!(
        ".{name}.{}-{}.part",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

pub(super) fn is_staging_name(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".part")
}

/// Removes the staging file however the download ends.
struct Staging(PathBuf, bool);

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.1 {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

pub async fn fetch(
    file: &FileRef,
    destination: &Path,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FetchError> {
    let parent = destination
        .parent()
        .ok_or_else(|| FetchError::Disk("no parent folder".into()))?;
    std::fs::create_dir_all(parent).map_err(io_error)?;

    let response = HTTP
        .get(&file.url)
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(FetchError::Http(status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length != file.size)
    {
        return Err(FetchError::Corrupt);
    }

    let mut staging = Staging(staging_path(destination), false);
    let mut out = std::fs::File::create(&staging.0).map_err(io_error)?;
    let mut hasher = sha2::Sha256::new();
    let mut received = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancelled() {
            return Err(FetchError::Cancelled);
        }
        let chunk = chunk.map_err(|error| request_error(&error))?;
        received += chunk.len() as u64;
        if received > file.size {
            return Err(FetchError::Corrupt);
        }
        hasher.update(&chunk);
        out.write_all(&chunk).map_err(io_error)?;
        on_progress(received);
    }
    if received != file.size || <[u8; 32]>::from(hasher.finalize()) != file.sha256 {
        return Err(FetchError::Corrupt);
    }
    out.sync_all().map_err(io_error)?;
    drop(out);
    std::fs::rename(&staging.0, destination).map_err(io_error)?;
    staging.1 = true;
    Ok(())
}

/// [`fetch`] with up to three tries for errors a retry can fix.
pub async fn fetch_with_retries(
    file: &FileRef,
    destination: &Path,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FetchError> {
    const BACKOFF: [Duration; 2] = [Duration::from_millis(500), Duration::from_secs(2)];
    let mut attempt = 0;
    loop {
        match fetch(file, destination, cancelled, on_progress).await {
            Err(error) if error.retryable() && attempt < BACKOFF.len() && !cancelled() => {
                tracing::warn!(
                    url = file.url,
                    ?error,
                    attempt,
                    "asset download failed, retrying"
                );
                on_progress(0);
                tokio::time::sleep(BACKOFF[attempt]).await;
                attempt += 1;
            }
            result => return result,
        }
    }
}
