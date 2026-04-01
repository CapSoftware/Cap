use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("Not logged in. Run \"cap auth login --server URL\" or set CAP_API_KEY and CAP_SERVER_URL environment variables.")]
    NotConfigured,
    #[error("Failed to read config file at {path}: {source}")]
    ConfigRead {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("Failed to parse config file at {path}: {source}")]
    ConfigParse {
        path: PathBuf,
        source: toml::de::Error,
    },
    #[error("Failed to write config file at {path}: {source}")]
    ConfigWrite {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("Could not determine config directory")]
    NoConfigDir,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("Authentication failed. Check your API key or run \"cap auth login\".")]
    Unauthorized,
    #[error("Cannot reach {url}. Check the URL and your network connection.")]
    Unreachable { url: String },
    #[error("Request timed out after {timeout_secs}s")]
    Timeout { timeout_secs: u64 },
    #[error("Server returned {status}: {body}")]
    ServerError { status: u16, body: String },
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, thiserror::Error)]
pub enum UploadError {
    #[error("File not found: {0}")]
    FileNotFound(PathBuf),
    #[error("Unsupported format: {extension}. Supported: mp4, webm, mov, mkv, avi")]
    UnsupportedFormat { extension: String },
    #[error("Failed to read file: {0}")]
    IoError(#[from] std::io::Error),
    #[error("API error during upload: {0}")]
    Api(#[from] ApiError),
    #[error("All {max_retries} retries exhausted for chunk {part_number}")]
    ChunkFailed { part_number: u32, max_retries: u32 },
    #[error("Upload aborted: {reason}")]
    Aborted { reason: String },
    #[error("Authentication error: {0}")]
    Auth(#[from] AuthError),
}
