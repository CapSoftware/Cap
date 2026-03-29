use tauri::{command, AppHandle};

use crate::deeplink::handle_deep_link;

/// Tauri command: handle an incoming deep-link URL string.
/// Can be called from the frontend or from OS deep-link events registered
/// via the `tauri-plugin-deep-link` plugin setup hook.
#[command]
pub async fn handle_deep_link_cmd(app: AppHandle, url: String) -> Result<(), String> {
    handle_deep_link(app, url).await
}
