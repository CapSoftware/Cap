pub mod auth;
pub mod client;
pub mod error;
pub mod thumbnail;
pub mod types;
pub mod upload;

pub use auth::AuthConfig;
pub use client::CapClient;
pub use error::{ApiError, AuthError, UploadError};
pub use thumbnail::generate_and_upload_thumbnail;
pub use types::{
    Chapter, CompleteMultipartRequest, CompleteMultipartResponse, ListVideosResponse, Organization,
    S3ConfigData, S3ConfigInput, S3ConfigResponse, UploadResult, UploadedPart, Video, VideoInfo,
    VideoMetadata, VideoSummary,
};
pub use upload::{detect_content_type, UploadEngine, UploadProgress};
