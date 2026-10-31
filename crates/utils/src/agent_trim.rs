//! Receipts for agent-driven timeline edits, shared by the Cap CLI and the
//! desktop app that applies them.
//!
//! The CLI asks the running app to trim a clip edge over the deep-link
//! channel, which has no reply channel of its own. The app therefore leaves a
//! receipt behind, and the CLI reads it back to learn whether the edit was
//! applied or refused, and why.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

const RECEIPT_DIR_NAME: &str = "agent-trim";
const MAX_REQUEST_ID_LENGTH: usize = 64;

/// `so.cap.desktop`'s app-data dir -- where both stores live.
///
/// The identifier every Cap release has used (`so.cap.desktop`), resolved
/// the way each OS's app-data convention spells it, so recordings and
/// settings from 0.6.0 and earlier are found where those builds left them.
pub fn app_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CAP_GPUI_APP_DATA_DIR")
        && !dir.trim().is_empty()
    {
        return PathBuf::from(dir);
    }

    #[cfg(target_os = "macos")]
    {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join("Library/Application Support/so.cap.desktop")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("so.cap.desktop")
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|_| ".".into()))
                    .join(".local/share")
            });
        base.join("so.cap.desktop")
    }
}

pub fn receipt_dir() -> PathBuf {
    app_data_dir().join(RECEIPT_DIR_NAME)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrimOutcome {
    Applied,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrimReceipt {
    pub request_id: String,
    pub outcome: TrimOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The request id names the receipt file, so it may only be the characters a
/// UUID is made of: anything else would let a deep link choose where the app
/// writes.
pub fn is_valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= MAX_REQUEST_ID_LENGTH
        && request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

pub fn receipt_path_in(dir: &Path, request_id: &str) -> Option<PathBuf> {
    if !is_valid_request_id(request_id) {
        return None;
    }
    Some(dir.join(format!("{request_id}.json")))
}

pub fn write_receipt_in(dir: &Path, receipt: &TrimReceipt) -> std::io::Result<()> {
    let path = receipt_path_in(dir, &receipt.request_id).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid trim request id")
    })?;
    std::fs::create_dir_all(dir)?;
    let body = serde_json::to_vec_pretty(receipt)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let temporary = dir.join(format!(
        ".{}.{}.tmp",
        receipt.request_id,
        std::process::id()
    ));
    {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&body)?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, &path)
}

pub fn read_receipt_in(dir: &Path, request_id: &str) -> Option<TrimReceipt> {
    let path = receipt_path_in(dir, request_id)?;
    let body = std::fs::read(path).ok()?;
    serde_json::from_slice(&body).ok()
}

pub fn remove_receipt_in(dir: &Path, request_id: &str) {
    if let Some(path) = receipt_path_in(dir, request_id) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn write_receipt(receipt: &TrimReceipt) -> std::io::Result<()> {
    write_receipt_in(&receipt_dir(), receipt)
}

pub fn read_receipt(request_id: &str) -> Option<TrimReceipt> {
    read_receipt_in(&receipt_dir(), request_id)
}

pub fn remove_receipt(request_id: &str) {
    remove_receipt_in(&receipt_dir(), request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipts_round_trip_through_their_directory() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = TrimReceipt {
            request_id: "9f1b0c2e-0000-4000-8000-000000000001".to_string(),
            outcome: TrimOutcome::Applied,
            applied_seconds: Some(18.5),
            error: None,
        };

        write_receipt_in(dir.path(), &receipt).unwrap();

        assert_eq!(
            read_receipt_in(dir.path(), &receipt.request_id),
            Some(receipt)
        );
    }

    #[test]
    fn a_rejected_receipt_keeps_the_reason() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = TrimReceipt {
            request_id: "rejected".to_string(),
            outcome: TrimOutcome::Rejected,
            applied_seconds: None,
            error: Some(
                "Clip edge is stale: expected 20.000s, current value is 19.000s".to_string(),
            ),
        };

        write_receipt_in(dir.path(), &receipt).unwrap();

        let read = read_receipt_in(dir.path(), &receipt.request_id).unwrap();
        assert_eq!(read.outcome, TrimOutcome::Rejected);
        assert_eq!(read.error, receipt.error);
    }

    #[test]
    fn request_ids_may_not_choose_a_path() {
        assert!(is_valid_request_id("9f1b0c2e-0000-4000-8000-000000000001"));
        assert!(!is_valid_request_id(""));
        assert!(!is_valid_request_id("../escape"));
        assert!(!is_valid_request_id("a/b"));
        assert!(!is_valid_request_id(&"a".repeat(MAX_REQUEST_ID_LENGTH + 1)));
        assert!(receipt_path_in(Path::new("/tmp"), "../escape").is_none());
    }

    #[test]
    fn removed_receipts_are_gone() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = TrimReceipt {
            request_id: "removed".to_string(),
            outcome: TrimOutcome::Applied,
            applied_seconds: Some(1.0),
            error: None,
        };
        write_receipt_in(dir.path(), &receipt).unwrap();

        remove_receipt_in(dir.path(), &receipt.request_id);

        assert!(read_receipt_in(dir.path(), &receipt.request_id).is_none());
    }
}
