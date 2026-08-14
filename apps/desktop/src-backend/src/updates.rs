use cap_desktop_runtime::AppHandle;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::general_settings::GeneralSettingsStore;

#[derive(Serialize, Deserialize, Type, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Nightly,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub version: String,
    pub notes: Option<String>,
    pub channel: UpdateChannel,
}

#[derive(Serialize, Type, cap_desktop_runtime::Event, Clone, Debug)]
pub struct UpdateDownloadProgress {
    pub downloaded: u32,
    pub total: Option<u32>,
}

#[derive(Serialize, Type, cap_desktop_runtime::Event, Clone, Debug)]
pub struct UpdateReady {
    pub version: String,
    pub installed: bool,
}

#[derive(Default)]
pub struct UpdatesState;

fn current_channel(app: &AppHandle) -> UpdateChannel {
    GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|settings| settings.update_channel)
        .unwrap_or_default()
}

#[cap_desktop_runtime::command]
#[specta::specta]
pub async fn updates_check(app: AppHandle) -> Result<Option<UpdateCheckResult>, String> {
    let channel = current_channel(&app);
    app.native_request("updater.check", serde_json::json!({ "channel": channel }))
        .await
}

#[cap_desktop_runtime::command]
#[specta::specta]
pub async fn updates_download_and_install(app: AppHandle) -> Result<(), String> {
    app.native_request::<serde_json::Value, _>(
        "updater.downloadAndInstall",
        serde_json::json!({ "channel": current_channel(&app) }),
    )
    .await
    .map(|_| ())
}

#[cap_desktop_runtime::command]
#[specta::specta]
pub fn updates_channel_changed(app: AppHandle) -> Result<(), String> {
    app.native_operation(
        "updater.setChannel",
        serde_json::json!({ "channel": current_channel(&app) }),
    )
}

pub fn spawn_background_loop(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let _ = app.native_operation(
        "updater.configure",
        serde_json::json!({ "channel": current_channel(&app) }),
    );
}
