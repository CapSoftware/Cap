use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use clipboard_rs::{Clipboard, ClipboardContext, RustImageData, common::RustImage};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::{
    ArcLock,
    general_settings::{GeneralSettingsStore, PostScreenshotCaptureBehaviour},
    notifications::{self, NotificationType},
    windows::ShowCapWindow,
};

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotPostCaptureAction {
    #[default]
    OpenEditor,
    ShowOverlay,
    CopyToClipboard,
}

impl From<PostScreenshotCaptureBehaviour> for ScreenshotPostCaptureAction {
    fn from(value: PostScreenshotCaptureBehaviour) -> Self {
        match value {
            PostScreenshotCaptureBehaviour::OpenEditor => Self::OpenEditor,
            PostScreenshotCaptureBehaviour::ShowOverlay => Self::ShowOverlay,
            PostScreenshotCaptureBehaviour::CopyToClipboard => Self::CopyToClipboard,
        }
    }
}

impl ScreenshotPostCaptureAction {
    pub fn from_settings(app: &AppHandle) -> Self {
        GeneralSettingsStore::get(app)
            .ok()
            .flatten()
            .map(|settings| settings.post_screenshot_capture_behaviour.into())
            .unwrap_or_default()
    }
}

pub async fn handle(
    app: &AppHandle,
    path: PathBuf,
    action: ScreenshotPostCaptureAction,
) -> Result<(), String> {
    match action {
        ScreenshotPostCaptureAction::OpenEditor => {
            let _ = ShowCapWindow::ScreenshotEditor { path }.show(app).await;
            Ok(())
        }
        ScreenshotPostCaptureAction::ShowOverlay => {
            let _ = ShowCapWindow::RecordingsOverlay.show(app).await;
            Ok(())
        }
        ScreenshotPostCaptureAction::CopyToClipboard => {
            copy_screenshot_to_clipboard(app, &path).await?;
            notifications::send_notification(app, NotificationType::ScreenshotCopiedToClipboard);
            Ok(())
        }
    }
}

async fn read_screenshot_image(path: &Path) -> Result<RustImageData, String> {
    let started_at = Instant::now();
    let path = path
        .to_str()
        .ok_or_else(|| format!("Invalid screenshot path: {}", path.display()))?;

    loop {
        match RustImageData::from_path(path) {
            Ok(img_data) => return Ok(img_data),
            Err(e) => {
                if started_at.elapsed() >= Duration::from_secs(2) {
                    return Err(format!("Failed to copy screenshot to clipboard: {e}"));
                }
                sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn copy_screenshot_to_clipboard(app: &AppHandle, path: &Path) -> Result<(), String> {
    let img_data = read_screenshot_image(path).await?;
    app.state::<ArcLock<ClipboardContext>>()
        .write()
        .await
        .set_image(img_data)
        .map_err(|err| format!("Failed to copy screenshot to clipboard: {err}"))
}
