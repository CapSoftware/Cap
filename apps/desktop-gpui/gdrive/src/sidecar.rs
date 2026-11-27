use std::{
    fmt, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::upload::Redacted;

pub const FILE_NAME: &str = "drive-upload.json";
pub const VERSION: u32 = 1;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sidecar {
    pub version: u32,
    pub source: String,
    pub size: u64,
    pub modified_ms: i64,
    pub account_email: Option<String>,
    pub folder_id: Option<String>,
    pub session_uri: Option<String>,
    pub session_started_at_ms: Option<i64>,
    pub offset: u64,
    pub file_id: Option<String>,
    pub web_view_link: Option<String>,
    pub public: bool,
    pub last_error: Option<String>,
}

impl fmt::Debug for Sidecar {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Sidecar")
            .field("version", &self.version)
            .field("source", &self.source)
            .field("size", &self.size)
            .field("modified_ms", &self.modified_ms)
            .field("account_email", &self.account_email)
            .field("folder_id", &self.folder_id)
            .field("session_uri", &self.session_uri.as_ref().map(|_| Redacted))
            .field("session_started_at_ms", &self.session_started_at_ms)
            .field("offset", &self.offset)
            .field("file_id", &self.file_id)
            .field("web_view_link", &self.web_view_link)
            .field("public", &self.public)
            .field("last_error", &self.last_error)
            .finish()
    }
}

fn create_private(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

pub fn load(dir: &Path) -> Option<Sidecar> {
    let bytes = fs::read(path_in(dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn save(dir: &Path, sidecar: &Sidecar) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(sidecar).map_err(io::Error::other)?;
    let tmp = dir.join(format!(
        ".{FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = create_private(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path_in(dir))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn matches_source(sidecar: &Sidecar, source: &str, size: u64, modified_ms: i64) -> bool {
    sidecar.source == source && sidecar.size == size && sidecar.modified_ms == modified_ms
}
