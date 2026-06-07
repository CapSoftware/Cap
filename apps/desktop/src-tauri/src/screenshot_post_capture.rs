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
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;
use tokio::{sync::oneshot, time::sleep};

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
    DoNothing,
    AskEveryTime,
    ShowOverlay,
    CopyToClipboard,
    CopyFilePath,
    CopyMarkdownImage,
    Save,
    SaveToFolder,
    RevealInFinder,
    Upload,
}

impl From<PostScreenshotCaptureBehaviour> for ScreenshotPostCaptureAction {
    fn from(value: PostScreenshotCaptureBehaviour) -> Self {
        match value {
            PostScreenshotCaptureBehaviour::OpenEditor => Self::OpenEditor,
            PostScreenshotCaptureBehaviour::DoNothing => Self::DoNothing,
            PostScreenshotCaptureBehaviour::AskEveryTime => Self::AskEveryTime,
            PostScreenshotCaptureBehaviour::ShowOverlay => Self::ShowOverlay,
            PostScreenshotCaptureBehaviour::CopyToClipboard => Self::CopyToClipboard,
            PostScreenshotCaptureBehaviour::CopyFilePath => Self::CopyFilePath,
            PostScreenshotCaptureBehaviour::CopyMarkdownImage => Self::CopyMarkdownImage,
            PostScreenshotCaptureBehaviour::Save => Self::Save,
            PostScreenshotCaptureBehaviour::SaveToFolder => Self::SaveToFolder,
            PostScreenshotCaptureBehaviour::RevealInFinder => Self::RevealInFinder,
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
    let action = match action {
        ScreenshotPostCaptureAction::AskEveryTime => match prompt_post_capture_action(app).await? {
            Some(action) => action,
            None => return Ok(()),
        },
        action => action,
    };

    match action {
        ScreenshotPostCaptureAction::DoNothing => Ok(()),
        ScreenshotPostCaptureAction::AskEveryTime => Ok(()),
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
        ScreenshotPostCaptureAction::CopyFilePath => {
            wait_for_screenshot_image(path.as_path()).await?;
            copy_text_to_clipboard(app, path.to_string_lossy().to_string()).await?;
            notifications::send_notification(app, NotificationType::ScreenshotCopiedToClipboard);
            Ok(())
        }
        ScreenshotPostCaptureAction::CopyMarkdownImage => {
            wait_for_screenshot_image(path.as_path()).await?;
            copy_text_to_clipboard(app, markdown_image_for_path(path.as_path())?).await?;
            notifications::send_notification(app, NotificationType::ScreenshotCopiedToClipboard);
            Ok(())
        }
        ScreenshotPostCaptureAction::Save => {
            save_screenshot_image_file(app, &path).await?;
            notifications::send_notification(app, NotificationType::ScreenshotSaved);
            Ok(())
        }
        ScreenshotPostCaptureAction::SaveToFolder => {
            if save_screenshot_image_file_to_configured_directory(app, &path)
                .await?
                .is_some()
            {
                notifications::send_notification(app, NotificationType::ScreenshotSaved);
            }
            Ok(())
        }
        ScreenshotPostCaptureAction::RevealInFinder => {
            wait_for_screenshot_image(path.as_path()).await?;
            app.opener()
                .reveal_item_in_dir(path)
                .map_err(|err| format!("Failed to reveal screenshot in Finder: {err}"))?;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DialogButton {
    First,
    Second,
    Third,
}

async fn prompt_post_capture_action(
    app: &AppHandle,
) -> Result<Option<ScreenshotPostCaptureAction>, String> {
    match choose_post_capture_button(
        app,
        "After Screenshot",
        "Choose what Cap should do with this screenshot.",
        "Open editor",
        "More actions",
        "Do nothing",
    )
    .await?
    {
        DialogButton::First => Ok(Some(ScreenshotPostCaptureAction::OpenEditor)),
        DialogButton::Third => Ok(None),
        DialogButton::Second => match choose_post_capture_button(
            app,
            "After Screenshot",
            "Choose what Cap should do with this screenshot.",
            "Copy image",
            "Save Desktop",
            "More actions",
        )
        .await?
        {
            DialogButton::First => Ok(Some(ScreenshotPostCaptureAction::CopyToClipboard)),
            DialogButton::Second => Ok(Some(ScreenshotPostCaptureAction::Save)),
            DialogButton::Third => match choose_post_capture_button(
                app,
                "After Screenshot",
                "Choose what Cap should do with this screenshot.",
                "Save folder",
                "Upload link",
                "More actions",
            )
            .await?
            {
                DialogButton::First => Ok(Some(ScreenshotPostCaptureAction::SaveToFolder)),
                DialogButton::Second => Ok(Some(ScreenshotPostCaptureAction::Upload)),
                DialogButton::Third => match choose_post_capture_button(
                    app,
                    "After Screenshot",
                    "Choose what Cap should do with this screenshot.",
                    "Show overlay",
                    "Reveal in Finder",
                    "More actions",
                )
                .await?
                {
                    DialogButton::First => Ok(Some(ScreenshotPostCaptureAction::ShowOverlay)),
                    DialogButton::Second => Ok(Some(ScreenshotPostCaptureAction::RevealInFinder)),
                    DialogButton::Third => match choose_post_capture_button(
                        app,
                        "After Screenshot",
                        "Choose what Cap should do with this screenshot.",
                        "Copy path",
                        "Copy Markdown",
                        "Do nothing",
                    )
                    .await?
                    {
                        DialogButton::First => Ok(Some(ScreenshotPostCaptureAction::CopyFilePath)),
                        DialogButton::Second => {
                            Ok(Some(ScreenshotPostCaptureAction::CopyMarkdownImage))
                        }
                        DialogButton::Third => Ok(None),
                    },
                },
            },
        },
    }
}

async fn choose_post_capture_button(
    app: &AppHandle,
    title: &str,
    message: &str,
    first: &str,
    second: &str,
    third: &str,
) -> Result<DialogButton, String> {
    let first_label = first.to_string();
    let second_label = second.to_string();
    let third_label = third.to_string();
    let (tx, rx) = oneshot::channel();

    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            first_label.clone(),
            second_label.clone(),
            third_label.clone(),
        ))
        .show_with_result(move |result| {
            let _ = tx.send(result);
        });

    let result = rx
        .await
        .map_err(|err| format!("Failed to show screenshot action dialog: {err}"))?;

    Ok(dialog_result_to_button(
        result,
        &first_label,
        &second_label,
        &third_label,
    ))
}

fn dialog_result_to_button(
    result: MessageDialogResult,
    first: &str,
    second: &str,
    third: &str,
) -> DialogButton {
    match result {
        MessageDialogResult::Ok | MessageDialogResult::Yes => DialogButton::First,
        MessageDialogResult::No => DialogButton::Second,
        MessageDialogResult::Cancel => DialogButton::Third,
        MessageDialogResult::Custom(label) if label == first => DialogButton::First,
        MessageDialogResult::Custom(label) if label == second => DialogButton::Second,
        MessageDialogResult::Custom(label) if label == third => DialogButton::Third,
        MessageDialogResult::Custom(_) => DialogButton::Third,
    }
}

async fn choose_screenshot_save_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = oneshot::channel();

    app.dialog()
        .file()
        .set_title("Choose Screenshot Folder")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    let selected_path = rx
        .await
        .map_err(|err| format!("Failed to show screenshot folder dialog: {err}"))?
        .and_then(|path| path.as_path().map(Path::to_path_buf));

    if let Some(path) = selected_path.clone() {
        GeneralSettingsStore::update(app, |settings| {
            settings.screenshot_save_directory = Some(path);
        })?;
    }

    Ok(selected_path)
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
                    return Err(format!("Screenshot image was not ready: {e}"));
                }
                sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn wait_for_screenshot_image(path: &Path) -> Result<(), String> {
    read_screenshot_image(path).await.map(|_| ())
}

async fn copy_screenshot_to_clipboard(app: &AppHandle, path: &Path) -> Result<(), String> {
    let img_data = if let Some(img_data) = pending_screenshot_image(app, path) {
        img_data?
    } else {
        read_screenshot_image(path)
            .await
            .map_err(|err| format!("Failed to copy screenshot to clipboard: {err}"))?
    };

    app.state::<ArcLock<ClipboardContext>>()
        .write()
        .await
        .set_image(img_data)
        .map_err(|err| format!("Failed to copy screenshot to clipboard: {err}"))
}

async fn copy_text_to_clipboard(app: &AppHandle, text: String) -> Result<(), String> {
    app.state::<ArcLock<ClipboardContext>>()
        .write()
        .await
        .set_text(text)
        .map_err(|err| format!("Failed to copy screenshot text to clipboard: {err}"))
}

fn markdown_image_for_path(path: &Path) -> Result<String, String> {
    let url = Url::from_file_path(path)
        .map_err(|_| format!("Failed to create file URL for {}", path.display()))?;

    Ok(format!("![Screenshot](<{}>)", url.as_str()))
}

async fn save_screenshot_image_file(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let desktop_dir = dirs::desktop_dir()
        .ok_or_else(|| "Failed to resolve Desktop directory for screenshot export".to_string())?;
    save_screenshot_image_file_to_directory(app, path, &desktop_dir).await
}

async fn save_screenshot_image_file_to_configured_directory(
    app: &AppHandle,
    path: &Path,
) -> Result<Option<PathBuf>, String> {
    let target_dir = match configured_screenshot_save_directory(app) {
        Some(path) => path,
        None => match choose_screenshot_save_directory(app).await? {
            Some(path) => path,
            None => return Ok(None),
        },
    };

    save_screenshot_image_file_to_directory(app, path, &target_dir)
        .await
        .map(Some)
}

fn configured_screenshot_save_directory(app: &AppHandle) -> Option<PathBuf> {
    GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .and_then(|settings| settings.screenshot_save_directory)
        .filter(|path| !path.as_os_str().is_empty())
}

async fn save_screenshot_image_file_to_directory(
    app: &AppHandle,
    path: &Path,
    target_dir: &Path,
) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(target_dir).await.map_err(|err| {
        format!(
            "Failed to create screenshot save directory {}: {err}",
            target_dir.display()
        )
    })?;

    let target_path = screenshot_save_target_path(path, target_dir)?;

    if let Some(screenshot) = pending_screenshot(app, path) {
        write_pending_screenshot_png(screenshot, target_path.clone()).await?;
        return Ok(target_path);
    }

    copy_screenshot_image_file_to_path(path, target_path.clone()).await?;
    Ok(target_path)
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

    #[test]
    fn post_screenshot_capture_behaviour_maps_to_actions() {
        let mappings = [
            (
                PostScreenshotCaptureBehaviour::OpenEditor,
                ScreenshotPostCaptureAction::OpenEditor,
            ),
            (
                PostScreenshotCaptureBehaviour::DoNothing,
                ScreenshotPostCaptureAction::DoNothing,
            ),
            (
                PostScreenshotCaptureBehaviour::AskEveryTime,
                ScreenshotPostCaptureAction::AskEveryTime,
            ),
            (
                PostScreenshotCaptureBehaviour::ShowOverlay,
                ScreenshotPostCaptureAction::ShowOverlay,
            ),
            (
                PostScreenshotCaptureBehaviour::CopyToClipboard,
                ScreenshotPostCaptureAction::CopyToClipboard,
            ),
            (
                PostScreenshotCaptureBehaviour::CopyFilePath,
                ScreenshotPostCaptureAction::CopyFilePath,
            ),
            (
                PostScreenshotCaptureBehaviour::CopyMarkdownImage,
                ScreenshotPostCaptureAction::CopyMarkdownImage,
            ),
            (
                PostScreenshotCaptureBehaviour::Save,
                ScreenshotPostCaptureAction::Save,
            ),
            (
                PostScreenshotCaptureBehaviour::SaveToFolder,
                ScreenshotPostCaptureAction::SaveToFolder,
            ),
            (
                PostScreenshotCaptureBehaviour::RevealInFinder,
                ScreenshotPostCaptureAction::RevealInFinder,
            ),
            (
                PostScreenshotCaptureBehaviour::Upload,
                ScreenshotPostCaptureAction::Upload,
            ),
        ];

        for (behaviour, action) in mappings {
            assert_eq!(ScreenshotPostCaptureAction::from(behaviour), action);
        }
    }

    #[test]
    fn dialog_result_to_button_maps_custom_labels() {
        assert_eq!(
            dialog_result_to_button(
                MessageDialogResult::Custom("Open editor".to_string()),
                "Open editor",
                "More actions",
                "Do nothing",
            ),
            DialogButton::First
        );
        assert_eq!(
            dialog_result_to_button(
                MessageDialogResult::Custom("More actions".to_string()),
                "Open editor",
                "More actions",
                "Do nothing",
            ),
            DialogButton::Second
        );
        assert_eq!(
            dialog_result_to_button(
                MessageDialogResult::Custom("Do nothing".to_string()),
                "Open editor",
                "More actions",
                "Do nothing",
            ),
            DialogButton::Third
        );
    }

    #[test]
    fn markdown_image_for_path_uses_file_url() {
        let path = tempfile::tempdir()
            .unwrap()
            .path()
            .join("Launch Clip.cap")
            .join("original.png");

        let markdown = markdown_image_for_path(&path).unwrap();

        assert!(markdown.starts_with("![Screenshot](<file://"));
        assert!(markdown.contains("Launch%20Clip.cap/original.png"));
        assert!(markdown.ends_with(">)"));
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
