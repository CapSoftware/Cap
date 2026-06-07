use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use clipboard_rs::{Clipboard, ClipboardContext, RustImageData, common::RustImage};
use image::ImageEncoder;
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
            save_screenshot_image_file(app, &path).await?;
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

fn pending_screenshot(app: &AppHandle, path: &Path) -> Option<PendingScreenshot> {
    let key = path.parent()?.to_string_lossy().to_string();
    let pending = app.try_state::<PendingScreenshots>()?;
    pending.get(&key)
}

fn pending_screenshot_image(app: &AppHandle, path: &Path) -> Option<Result<RustImageData, String>> {
    pending_screenshot(app, path).map(image_from_pending_screenshot)
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

async fn save_screenshot_image_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    let desktop_dir = dirs::desktop_dir()
        .ok_or_else(|| "Failed to resolve Desktop directory for screenshot export".to_string())?;
    let target_path = screenshot_save_target_path(path, &desktop_dir)?;

    if let Some(screenshot) = pending_screenshot(app, path) {
        write_pending_screenshot_png(screenshot, target_path).await?;
        return Ok(());
    }

    copy_screenshot_image_file_to_path(path, target_path).await
}

fn screenshot_save_target_path(path: &Path, target_dir: &Path) -> Result<PathBuf, String> {
    let target_name = screenshot_save_target_name(path);
    Ok(target_dir.join(cap_utils::ensure_unique_filename(&target_name, target_dir)?))
}

fn screenshot_save_target_name(path: &Path) -> String {
    let file_stem = path
        .parent()
        .and_then(|parent| parent.file_stem())
        .or_else(|| path.file_stem())
        .and_then(|stem| stem.to_str())
        .unwrap_or("Screenshot");

    format!("{}.png", sanitize_filename::sanitize(file_stem))
}

#[cfg(test)]
async fn save_screenshot_image_file_to_dir(
    path: &Path,
    target_dir: &Path,
) -> Result<PathBuf, String> {
    let target_path = screenshot_save_target_path(path, target_dir)?;
    copy_screenshot_image_file_to_path(path, target_path.clone()).await?;
    Ok(target_path)
}

async fn copy_screenshot_image_file_to_path(
    path: &Path,
    target_path: PathBuf,
) -> Result<(), String> {
    read_screenshot_image(path).await?;

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

async fn write_pending_screenshot_png(
    screenshot: PendingScreenshot,
    target_path: PathBuf,
) -> Result<(), String> {
    let color_type = match screenshot.channels {
        4 => image::ColorType::Rgba8,
        3 => image::ColorType::Rgb8,
        channels => {
            return Err(format!("Unsupported screenshot channel count: {channels}"));
        }
    };

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::create(&target_path).map_err(|err| {
            format!(
                "Failed to save screenshot image to {}: {err}",
                target_path.display()
            )
        })?;
        let encoder = image::codecs::png::PngEncoder::new(std::io::BufWriter::new(file));

        encoder
            .write_image(
                &screenshot.data,
                screenshot.width,
                screenshot.height,
                color_type.into(),
            )
            .map_err(|err| {
                format!(
                    "Failed to save screenshot image to {}: {err}",
                    target_path.display()
                )
            })
    })
    .await
    .map_err(|err| format!("Failed to save screenshot image: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use clipboard_rs::common::RustImage;
    use image::GenericImageView;
    use std::panic::AssertUnwindSafe;

    fn write_test_png(path: &Path, color: [u8; 4]) {
        image::RgbaImage::from_pixel(2, 1, image::Rgba(color))
            .save(path)
            .unwrap();
    }

    #[test]
    fn pending_action_is_consumed_once() {
        let pending = PendingScreenshotPostCaptureAction::default();

        pending.set(ScreenshotPostCaptureAction::CopyToClipboard);

        assert_eq!(
            pending.take(),
            Some(ScreenshotPostCaptureAction::CopyToClipboard)
        );
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn pending_action_clear_discards_action() {
        let pending = PendingScreenshotPostCaptureAction::default();

        pending.set(ScreenshotPostCaptureAction::Upload);
        pending.clear();

        assert_eq!(pending.take(), None);
    }

    #[test]
    fn pending_action_expires() {
        let pending = PendingScreenshotPostCaptureAction::default();
        *pending.0.lock().unwrap() = Some(PendingAction {
            action: ScreenshotPostCaptureAction::Save,
            created_at: Instant::now() - PENDING_ACTION_TTL - Duration::from_secs(1),
        });

        assert_eq!(pending.take(), None);
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn pending_action_recovers_from_poisoned_mutex() {
        let pending = PendingScreenshotPostCaptureAction::default();
        let poisoned = pending.clone();

        let _ = std::panic::catch_unwind(AssertUnwindSafe(move || {
            let _guard = poisoned.0.lock().unwrap();
            panic!("poison pending screenshot action mutex");
        }));

        pending.set(ScreenshotPostCaptureAction::ShowOverlay);

        assert_eq!(
            pending.take(),
            Some(ScreenshotPostCaptureAction::ShowOverlay)
        );
    }

    #[test]
    fn image_from_pending_screenshot_supports_rgba_and_rgb() {
        let rgba = image_from_pending_screenshot(PendingScreenshot {
            data: vec![255, 0, 0, 255, 0, 255, 0, 255],
            width: 2,
            height: 1,
            channels: 4,
            created_at: Instant::now(),
        })
        .unwrap();
        assert_eq!(rgba.get_size(), (2, 1));

        let rgb = image_from_pending_screenshot(PendingScreenshot {
            data: vec![255, 0, 0, 0, 255, 0],
            width: 2,
            height: 1,
            channels: 3,
            created_at: Instant::now(),
        })
        .unwrap();
        assert_eq!(rgb.get_size(), (2, 1));
    }

    #[test]
    fn image_from_pending_screenshot_rejects_unsupported_channels() {
        let result = image_from_pending_screenshot(PendingScreenshot {
            data: vec![0, 0],
            width: 1,
            height: 1,
            channels: 2,
            created_at: Instant::now(),
        });

        match result {
            Ok(_) => panic!("expected unsupported channel count error"),
            Err(err) => assert!(err.contains("Unsupported screenshot channel count: 2")),
        }
    }

    #[tokio::test]
    async fn save_screenshot_image_file_to_dir_copies_png_with_project_name() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_dir = temp_dir.path().join("Launch Clip.cap");
        let target_dir = temp_dir.path().join("Desktop");
        let source_path = project_dir.join("original.png");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        write_test_png(&source_path, [255, 0, 0, 255]);

        let saved_path = save_screenshot_image_file_to_dir(&source_path, &target_dir)
            .await
            .unwrap();

        assert_eq!(saved_path.file_name().unwrap(), "Launch Clip.png");
        assert_eq!(image::open(saved_path).unwrap().dimensions(), (2, 1));
    }

    #[tokio::test]
    async fn save_screenshot_image_file_to_dir_uses_unique_filename() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_dir = temp_dir.path().join("Launch Clip.cap");
        let target_dir = temp_dir.path().join("Desktop");
        let source_path = project_dir.join("original.png");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        write_test_png(&source_path, [0, 255, 0, 255]);
        std::fs::write(target_dir.join("Launch Clip.png"), b"existing").unwrap();

        let saved_path = save_screenshot_image_file_to_dir(&source_path, &target_dir)
            .await
            .unwrap();

        assert_eq!(saved_path.file_name().unwrap(), "Launch Clip (1).png");
        assert_eq!(image::open(saved_path).unwrap().dimensions(), (2, 1));
    }

    #[tokio::test]
    async fn save_screenshot_image_file_to_dir_waits_for_valid_png_before_copying() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_dir = temp_dir.path().join("Launch Clip.cap");
        let target_dir = temp_dir.path().join("Desktop");
        let source_path = project_dir.join("original.png");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::create_dir_all(&target_dir).unwrap();
        std::fs::write(&source_path, []).unwrap();

        let source_path_for_writer = source_path.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(100)).await;
            write_test_png(&source_path_for_writer, [0, 0, 255, 255]);
        });

        let saved_path = save_screenshot_image_file_to_dir(&source_path, &target_dir)
            .await
            .unwrap();

        assert_eq!(saved_path.file_name().unwrap(), "Launch Clip.png");
        assert!(std::fs::metadata(&saved_path).unwrap().len() > 0);
        assert_eq!(image::open(saved_path).unwrap().dimensions(), (2, 1));
    }

    #[tokio::test]
    async fn write_pending_screenshot_png_writes_valid_png() {
        let temp_dir = tempfile::tempdir().unwrap();
        let target_path = temp_dir.path().join("Pending.png");

        write_pending_screenshot_png(
            PendingScreenshot {
                data: vec![255, 0, 0, 255, 0, 255, 0, 255],
                width: 2,
                height: 1,
                channels: 4,
                created_at: Instant::now(),
            },
            target_path.clone(),
        )
        .await
        .unwrap();

        assert!(std::fs::metadata(&target_path).unwrap().len() > 0);
        assert_eq!(image::open(target_path).unwrap().dimensions(), (2, 1));
    }
}
