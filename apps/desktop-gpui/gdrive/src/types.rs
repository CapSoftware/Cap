use std::{future::Future, path::Path, time::Duration};

pub const DRIVE_FILE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
pub const SHARING_ID_PREFIX: &str = "gdrive:";
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
pub const VIDEO_MIME: &str = "video/mp4";
pub const FOLDER_MARKER: (&str, &str) = ("capFolder", "1");
pub const FILE_MARKER: (&str, &str) = ("capRecording", "1");
pub const DEFAULT_FOLDER_NAME: &str = "Cap";
pub const CHUNK_ALIGN: usize = 256 * 1024;
pub const DEFAULT_CHUNK_SIZE: usize = 64 * CHUNK_ALIGN;
pub const SESSION_MAX_AGE: Duration = Duration::from_secs(6 * 24 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
    pub revoke: String,
    pub api: String,
    pub upload: String,
}

impl Endpoints {
    pub fn google() -> Self {
        Self {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            api: "https://www.googleapis.com/drive/v3".into(),
            upload: "https://www.googleapis.com/upload/drive/v3".into(),
        }
    }

    pub fn local(base: &str) -> Self {
        let base = base.trim_end_matches('/');
        Self {
            authorize: format!("{base}/o/oauth2/v2/auth"),
            token: format!("{base}/token"),
            revoke: format!("{base}/revoke"),
            api: format!("{base}/drive/v3"),
            upload: format!("{base}/upload/drive/v3"),
        }
    }
}

pub fn sharing_id(file_id: &str) -> String {
    format!("{SHARING_ID_PREFIX}{file_id}")
}

pub fn file_id_from_sharing(id: &str) -> Option<&str> {
    id.strip_prefix(SHARING_ID_PREFIX)
        .filter(|file_id| !file_id.is_empty())
}

pub fn is_drive_sharing_id(id: &str) -> bool {
    id.starts_with(SHARING_ID_PREFIX)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrivateReason {
    SharingRestricted,
    RateLimited,
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkVisibility {
    Public,
    Private(PrivateReason),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DriveShare {
    pub file_id: String,
    pub web_view_link: String,
    pub folder_id: String,
    pub visibility: LinkVisibility,
    pub reused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub sent: u64,
    pub total: u64,
}

impl Progress {
    pub fn fraction(self) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        self.sent.min(self.total) as f64 / self.total as f64
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadOptions {
    pub chunk_size: usize,
    pub max_attempts: u32,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
}

impl Default for UploadOptions {
    fn default() -> Self {
        Self {
            chunk_size: DEFAULT_CHUNK_SIZE,
            max_attempts: 6,
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
        }
    }
}

pub struct ShareFileRequest<'a> {
    pub file: &'a Path,
    pub sidecar_dir: &'a Path,
    pub name: &'a str,
    pub description: Option<&'a str>,
    pub folder_name: &'a str,
    pub known_folder_id: Option<&'a str>,
    pub account_email: Option<&'a str>,
    pub options: UploadOptions,
}

pub trait TokenSource: Send + Sync {
    fn access_token(
        &self,
        force_refresh: bool,
    ) -> impl Future<Output = Result<String, DriveError>> + Send;
}

pub struct StaticToken(pub String);

impl TokenSource for StaticToken {
    fn access_token(
        &self,
        force_refresh: bool,
    ) -> impl Future<Output = Result<String, DriveError>> + Send {
        std::future::ready(if force_refresh {
            Err(DriveError::SignInAgain)
        } else {
            Ok(self.0.clone())
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DriveError {
    #[error("Google Drive is not connected")]
    NotConnected,
    #[error("no Google OAuth client is configured for Drive")]
    NotConfigured,
    #[error("Google Drive access was not granted")]
    Denied,
    #[error("Google Drive access was revoked or expired")]
    SignInAgain,
    #[error("Google Drive could not be reached")]
    Offline,
    #[error("Google Drive storage is full")]
    StorageFull,
    #[error("a Google Workspace administrator blocks this")]
    AdminBlocked,
    #[error("Google Drive asked Cap to slow down")]
    RateLimited,
    #[error("the Google Drive API is not enabled for this Google Cloud project")]
    ApiDisabled,
    #[error("the recording file is missing or unreadable: {0}")]
    LocalFile(String),
    #[error("cancelled")]
    Cancelled,
    #[error("Google Drive answered {status}: {reason}")]
    Server { status: u16, reason: String },
    #[error("unexpected response from Google Drive: {0}")]
    Protocol(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn google_endpoints_are_the_documented_ones() {
        assert_eq!(
            Endpoints::google(),
            Endpoints {
                authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
                token: "https://oauth2.googleapis.com/token".into(),
                revoke: "https://oauth2.googleapis.com/revoke".into(),
                api: "https://www.googleapis.com/drive/v3".into(),
                upload: "https://www.googleapis.com/upload/drive/v3".into(),
            }
        );
    }

    #[test]
    fn local_endpoints_use_the_same_paths_under_the_base() {
        let expected = Endpoints {
            authorize: "http://127.0.0.1:4000/o/oauth2/v2/auth".into(),
            token: "http://127.0.0.1:4000/token".into(),
            revoke: "http://127.0.0.1:4000/revoke".into(),
            api: "http://127.0.0.1:4000/drive/v3".into(),
            upload: "http://127.0.0.1:4000/upload/drive/v3".into(),
        };
        assert_eq!(Endpoints::local("http://127.0.0.1:4000"), expected);
        assert_eq!(Endpoints::local("http://127.0.0.1:4000/"), expected);
    }

    #[test]
    fn sharing_ids_carry_the_drive_prefix() {
        assert_eq!(sharing_id("abc"), "gdrive:abc");
        assert_eq!(file_id_from_sharing("gdrive:abc"), Some("abc"));
        assert_eq!(file_id_from_sharing("abc"), None);
        assert_eq!(file_id_from_sharing("gdrive:"), None);
        assert!(is_drive_sharing_id("gdrive:abc"));
        assert!(is_drive_sharing_id("gdrive:"));
        assert!(!is_drive_sharing_id("abc"));
        assert!(!is_drive_sharing_id("GDRIVE:abc"));
        assert!(!is_drive_sharing_id(""));
    }

    #[test]
    fn progress_fraction_is_bounded() {
        assert_eq!(Progress { sent: 0, total: 0 }.fraction(), 0.0);
        assert_eq!(Progress { sent: 5, total: 10 }.fraction(), 0.5);
        assert_eq!(
            Progress {
                sent: 10,
                total: 10
            }
            .fraction(),
            1.0
        );
        assert_eq!(
            Progress {
                sent: 12,
                total: 10
            }
            .fraction(),
            1.0
        );
    }

    #[test]
    fn default_upload_options_match_the_contract() {
        let options = UploadOptions::default();
        assert_eq!(options.chunk_size, 16 * 1024 * 1024);
        assert_eq!(options.chunk_size % CHUNK_ALIGN, 0);
        assert_eq!(options.max_attempts, 6);
        assert_eq!(options.backoff_base, Duration::from_secs(1));
        assert_eq!(options.backoff_max, Duration::from_secs(60));
    }

    #[test]
    fn static_token_returns_its_token_and_refuses_a_forced_refresh() {
        let source = StaticToken("ya29.token".into());
        assert_eq!(
            block_on(source.access_token(false)),
            Ok("ya29.token".into())
        );
        assert_eq!(
            block_on(source.access_token(true)),
            Err(DriveError::SignInAgain)
        );
    }

    #[test]
    fn api_disabled_has_its_own_message() {
        assert_eq!(
            DriveError::ApiDisabled.to_string(),
            "the Google Drive API is not enabled for this Google Cloud project"
        );
    }
}
