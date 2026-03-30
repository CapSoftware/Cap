/// Tauri commands exposed to the frontend for programmatic deep-link testing
/// and for querying current recording state.
use tauri::{command, AppHandle};

use crate::deeplink::handle_deeplink;

/// Trigger any `cap://` deep-link from the frontend (useful for tests / debugging).
#[command]
pub async fn trigger_deeplink(app: AppHandle, url: String) -> Result<(), String> {
    handle_deeplink(&app, &url);
    Ok(())
}
