// File: crates/recording/src/cap_recording.rs
use cap_utils::Url;
use std::collections::HashMap;

// Re-export CameraFeed from within the crate
pub use crate::CameraFeed;

// Define public API types and re-exports here as needed
// (Assuming this is the root of the cap_recording crate, no `mod cap_recording` declaration)

/// Represents a camera feed source
#[derive(Debug, Clone)]
pub struct CameraFeed {
    pub id: String,
    pub name: String,
    pub url: Url,
}

/// List available camera feeds
pub async fn list_camera_feeds() -> Result<HashMap<String, CameraFeed>, String> {
    // Placeholder implementation
    let mut feeds = HashMap::new();
    feeds.insert(
        "default".to_string(),
        CameraFeed {
            id: "default".to_string(),
            name: "Default Camera".to_string(),
            url: Url::parse("device://video0").map_err(|e| e.to_string())?,
        },
    );
    Ok(feeds)
}