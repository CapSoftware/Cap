//! Model downloads that finish on slow and unreliable connections. There is
//! no limit on a whole transfer (the 900 MB Parakeet encoder takes over an
//! hour below 2 Mbit/s), only on a stall, and a connection that drops is
//! picked up again where the file stopped, with an HTTP range request.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::StreamExt;

/// How long a download waits for its next bytes before trying again.
pub const STALL: Duration = Duration::from_secs(60);
/// Tries per part: the first and four resumes.
pub const ATTEMPTS: u32 = 5;

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
});

/// How patient one download is (tests shorten it).
#[derive(Clone, Copy, Debug)]
pub struct Patience {
    pub stall: Duration,
    pub attempts: u32,
    pub backoff: Duration,
}

impl Default for Patience {
    fn default() -> Self {
        if cfg!(test) {
            return Self {
                stall: Duration::from_secs(2),
                attempts: 2,
                backoff: Duration::from_millis(10),
            };
        }
        Self {
            stall: STALL,
            attempts: ATTEMPTS,
            backoff: Duration::from_secs(2),
        }
    }
}

pub enum Progress<'a> {
    /// Bytes written to the file.
    Bytes(&'a [u8]),
    /// The server ignored the range: this many bytes already counted for the
    /// part are being written again.
    Rewound(u64),
}

enum Failure {
    /// The connection dropped, stalled or the server had a moment.
    Retry(String),
    Stop(String),
}

/// Writes `url` into `file` at `base`, from byte `have` of the resource (what
/// an earlier try already wrote there), resuming after dropped connections.
/// `file` holds exactly `base + have` bytes when this is called. Returns the
/// resource's length as written.
pub async fn part(
    url: &str,
    file: &mut File,
    base: u64,
    mut have: u64,
    patience: Patience,
    progress: &mut (dyn FnMut(Progress<'_>) + Send),
) -> Result<u64, String> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match once(url, file, base, &mut have, patience.stall, progress).await {
            Ok(()) => return Ok(have),
            Err(Failure::Stop(error)) => return Err(error),
            Err(Failure::Retry(error)) => {
                if attempt >= patience.attempts {
                    return Err(error);
                }
                tracing::warn!(url, attempt, have, %error, "model download interrupted, resuming");
                tokio::time::sleep(patience.backoff * attempt).await;
            }
        }
    }
}

async fn once(
    url: &str,
    file: &mut File,
    base: u64,
    have: &mut u64,
    stall: Duration,
    progress: &mut (dyn FnMut(Progress<'_>) + Send),
) -> Result<(), Failure> {
    let mut request = CLIENT.get(url);
    if *have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={}-", *have));
    }
    let response = match tokio::time::timeout(stall, request.send()).await {
        Err(_) => return Err(Failure::Retry("the server did not answer".into())),
        Ok(Err(error)) => return Err(Failure::Retry(error.to_string())),
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    if *have > 0 && status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // What is on disk is longer than the resource: start the part again.
        rewind(file, base, have, progress)?;
        return Err(Failure::Retry(format!("HTTP {status}")));
    }
    if status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return Err(Failure::Retry(format!("HTTP {status}")));
    }
    if !status.is_success() {
        return Err(Failure::Stop(format!("HTTP {status}")));
    }
    if *have > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        rewind(file, base, have, progress)?;
    }
    let mut stream = response.bytes_stream();
    loop {
        let chunk = match tokio::time::timeout(stall, stream.next()).await {
            Err(_) => return Err(Failure::Retry("the download stalled".into())),
            Ok(None) => return Ok(()),
            Ok(Some(Err(error))) => return Err(Failure::Retry(error.to_string())),
            Ok(Some(Ok(chunk))) => chunk,
        };
        file.write_all(&chunk)
            .map_err(|e| Failure::Stop(format!("Error while writing to file: {e}")))?;
        *have += chunk.len() as u64;
        progress(Progress::Bytes(&chunk));
    }
}

fn rewind(
    file: &mut File,
    base: u64,
    have: &mut u64,
    progress: &mut (dyn FnMut(Progress<'_>) + Send),
) -> Result<(), Failure> {
    file.set_len(base)
        .and_then(|()| file.seek(SeekFrom::Start(base)).map(|_| ()))
        .map_err(|e| Failure::Stop(format!("Error while writing to file: {e}")))?;
    progress(Progress::Rewound(*have));
    *have = 0;
    Ok(())
}

/// Opens `path` to continue a download: its bytes stay, the next write goes
/// at the end. Returns the file and its length.
pub fn reopen(path: &std::path::Path) -> std::io::Result<(File, u64)> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    let len = file.seek(SeekFrom::End(0))?;
    Ok((file, len))
}

/// Downloads `url` into `staging`, resuming what an earlier try left there,
/// and checks the whole file against `sha256` (lowercase hex). A corrupt
/// file is removed so the next try starts it again; an interrupted one stays
/// to be resumed. `received` sees byte counts as they arrive (negative when a
/// server ignored the range and bytes are written again).
pub async fn verified(
    url: &str,
    staging: &std::path::Path,
    sha256: &str,
    size: Option<u64>,
    received: &(dyn Fn(i64) + Send + Sync),
) -> Result<(), String> {
    use sha2::Digest as _;
    let (mut file, mut have) =
        reopen(staging).map_err(|e| format!("Failed to create {staging:?}: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    if size.is_some_and(|size| have > size) {
        restart(&mut file).map_err(|e| format!("Failed to create {staging:?}: {e}"))?;
        have = 0;
    } else if have > 0 {
        let mut kept =
            File::open(staging).map_err(|e| format!("Failed to read {staging:?}: {e}"))?;
        std::io::copy(&mut kept, &mut hasher)
            .map_err(|e| format!("Failed to read {staging:?}: {e}"))?;
        received(have as i64);
    }
    let mut on_progress = |event: Progress<'_>| match event {
        Progress::Bytes(chunk) => {
            hasher.update(chunk);
            received(chunk.len() as i64);
        }
        Progress::Rewound(bytes) => {
            hasher = sha2::Sha256::new();
            received(-(bytes as i64));
        }
    };
    part(
        url,
        &mut file,
        0,
        have,
        Patience::default(),
        &mut on_progress,
    )
    .await?;
    // On disk before it is checked and renamed into place, so a crash or
    // power cut never leaves a verified name on unwritten bytes.
    file.sync_all()
        .map_err(|e| format!("Error while writing to file: {e}"))?;
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if hex != sha256 {
        let _ = std::fs::remove_file(staging);
        return Err(format!("The download is corrupt (sha256 {hex})"));
    }
    Ok(())
}

/// Empties a file a download starts again.
pub fn restart(file: &mut File) -> std::io::Result<()> {
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0)).map(|_| ())
}

/// Bytes the volume holding `dir` must have free for `bytes` more of
/// download: the download itself plus room for the app to keep working.
pub fn space_needed(bytes: u64) -> u64 {
    bytes.saturating_add(SPACE_HEADROOM)
}

pub const SPACE_HEADROOM: u64 = 512 * 1024 * 1024;

/// `Some(missing bytes)` when the volume holding `dir` is too full for
/// `bytes` more of download, `None` when it fits or its free space is unknown.
pub fn missing_space(dir: &std::path::Path, bytes: u64) -> Option<u64> {
    let free = crate::meetings::health::free_bytes(dir)?;
    let needed = space_needed(bytes);
    (free < needed).then(|| needed - free)
}

/// A size for the not-enough-space message, rounded up to a tenth of a GB.
pub fn size_label(bytes: u64) -> String {
    let tenths = bytes.div_ceil(100_000_000).max(1);
    if tenths >= 10 {
        format!("{}.{} GB", tenths / 10, tenths % 10)
    } else {
        format!("{} MB", (bytes.div_ceil(1_000_000)).max(1))
    }
}
