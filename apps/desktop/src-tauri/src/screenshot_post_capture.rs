use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use clipboard_rs::{Clipboard, ClipboardContext, RustImageData, common::RustImage};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::{
    ArcLock, PendingScreenshot, PendingScreenshots,
    general_settings::{GeneralSettingsStore, PostScreenshotCaptureBehaviour},
    notifications::{self, NotificationType},
    windows::ShowCapWindow,
};

const PENDING_ACTION_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Default)]
pub struct PendingScreenshotPostCaptureAction(Arc<Mutex<Option<PendingAction>>>);

#[derive(Clone)]
struct PendingAction {
    action: ScreenshotPostCaptureAction,
    created_at: Instant,
}

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotPostCaptureAction {
    #[default]
    OpenEditor,
    ShowOverlay,
    CopyToClipboard,
    Save,
    Upload,
}

impl From<PostScreenshotCaptureBehaviour> for ScreenshotPostCaptureAction {
    fn from(value: PostScreenshotCaptureBehaviour) -> Self {
        match value {
            PostScreenshotCaptureBehaviour::OpenEditor => Self::OpenEditor,
            PostScreenshotCaptureBehaviour::ShowOverlay => Self::ShowOverlay,
            PostScreenshotCaptureBehaviour::CopyToClipboard => Self::CopyToClipboard,
            PostScreenshotCaptureBehaviour::Save => Self::Save,
            PostScreenshotCaptureBehaviour::Upload => Self::Upload,
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

    pub fn from_pending_or_settings(app: &AppHandle) -> Self {
        app.try_state::<PendingScreenshotPostCaptureAction>()
            .and_then(|pending| pending.take())
            .unwrap_or_else(|| Self::from_settings(app))
    }
}

impl PendingScreenshotPostCaptureAction {
    pub fn set(&self, action: ScreenshotPostCaptureAction) {
        let mut pending = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        *pending = Some(PendingAction {
            action,
            created_at: Instant::now(),
        });
    }

    pub fn take(&self) -> Option<ScreenshotPostCaptureAction> {
        let mut pending = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let action = pending.take()?;

        if action.created_at.elapsed() <= PENDING_ACTION_TTL {
            Some(action.action)
        } else {
            None
        }
    }

    pub fn clear(&self) {
        let mut pending = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        *pending = None;
    }
}

pub fn set_pending_action(
    app: &AppHandle,
    action: ScreenshotPostCaptureAction,
) -> Result<(), String> {
    let pending = app
        .try_state::<PendingScreenshotPostCaptureAction>()
        .ok_or_else(|| "Screenshot post-capture state unavailable".to_string())?;
    pending.set(action);
    Ok(())
}

pub fn clear_pending_action(app: &AppHandle) {
    if let Some(pending) = app.try_state::<PendingScreenshotPostCaptureAction>() {
        pending.clear();
    }
}

pub async fn handle(
    app: &AppHandle,
    path: PathBuf,
    action: ScreenshotPostCaptureAction,
) -> Result<(), String> {
    match action {
        ScreenshotPostCaptureAction::OpenEditor => {
            ShowCapWindow::ScreenshotEditor { path }
                .show(app)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        ScreenshotPostCaptureAction::ShowOverlay => {
            ShowCapWindow::RecordingsOverlay
                .show(app)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        ScreenshotPostCaptureAction::CopyToClipboard => {
            copy_screenshot_to_clipboard(app, &path).await?;
            notifications::send_notification(app, NotificationType::ScreenshotCopiedToClipboard);
            Ok(())
        }
        ScreenshotPostCaptureAction::Save => {
            save_screenshot_image_file(&path).await?;
            Ok(())
        }
        ScreenshotPostCaptureAction::Upload => {
            match crate::upload_screenshot_internal(app, path).await? {
                crate::UploadResult::Success(_) => Ok(()),
                crate::UploadResult::NotAuthenticated => Ok(()),
                crate::UploadResult::UpgradeRequired => Ok(()),
                crate::UploadResult::PlanCheckFailed => {
                    notifications::send_notification(app, NotificationType::ShareableLinkFailed);
                    Ok(())
                }
            }
        }
    }
}

#[tauri::command(async)]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn take_screenshot_with_post_capture(
    app: AppHandle,
    target: ScreenCaptureTarget,
) -> Result<PathBuf, String> {
    let action = ScreenshotPostCaptureAction::from_pending_or_settings(&app);
    let path = crate::recording::take_screenshot(app.clone(), target).await?;
    handle(&app, path.clone(), action).await?;
    Ok(path)
}

fn pending_screenshot_image(app: &AppHandle, path: &Path) -> Option<Result<RustImageData, String>> {
    let key = path.parent()?.to_string_lossy().to_string();
    let pending = app.try_state::<PendingScreenshots>()?;
    pending.get(&key).map(image_from_pending_screenshot)
}

fn image_from_pending_screenshot(frame: PendingScreenshot) -> Result<RustImageData, String> {
    let image = match frame.channels {
        4 => image::RgbaImage::from_raw(frame.width, frame.height, frame.data)
            .map(image::DynamicImage::ImageRgba8),
        3 => image::RgbImage::from_raw(frame.width, frame.height, frame.data)
            .map(image::DynamicImage::ImageRgb8),
        channels => {
            return Err(format!("Unsupported screenshot channel count: {channels}"));
        }
    }
    .ok_or_else(|| {
        format!(
            "Invalid screenshot image data: {}x{}x{}",
            frame.width, frame.height, frame.channels
        )
    })?;

    Ok(RustImageData::from_dynamic_image(image))
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
    let img_data = if let Some(img_data) = pending_screenshot_image(app, path) {
        img_data?
    } else {
        read_screenshot_image(path).await?
    };

    app.state::<ArcLock<ClipboardContext>>()
        .write()
        .await
        .set_image(img_data)
        .map_err(|err| format!("Failed to copy screenshot to clipboard: {err}"))
}

async fn save_screenshot_image_file(path: &Path) -> Result<(), String> {
    let desktop_dir = dirs::desktop_dir()
        .ok_or_else(|| "Failed to resolve Desktop directory for screenshot export".to_string())?;

    let file_stem = path
        .parent()
        .and_then(|parent| parent.file_stem())
        .or_else(|| path.file_stem())
        .and_then(|stem| stem.to_str())
        .unwrap_or("Screenshot");

    let target_name = format!("{}.png", sanitize_filename::sanitize(file_stem));
    let target_path = desktop_dir.join(cap_utils::ensure_unique_filename(
        &target_name,
        &desktop_dir,
    )?);

    let started_at = Instant::now();
    loop {
        match tokio::fs::copy(path, &target_path).await {
            Ok(_) => return Ok(()),
            Err(err) if started_at.elapsed() < Duration::from_secs(2) => {
                sleep(Duration::from_millis(50)).await;
                if !path.exists() {
                    continue;
                }
                if err.kind() == std::io::ErrorKind::NotFound {
                    continue;
                }
            }
            Err(err) => {
                return Err(format!(
                    "Failed to save screenshot image to {}: {err}",
                    target_path.display()
                ));
            }
        }
    }
}
