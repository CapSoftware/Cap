use crate::{general_settings::GeneralSettingsStore, AppSounds};
use tauri_plugin_notification::NotificationExt;

pub enum NotificationType {
    VideoSaved,
    VideoCopiedToClipboard,
    ShareableLinkCopied,
    UploadFailed,
    VideoSaveFailed,
    VideoCopyFailed,
    ShareableLinkFailed,
    ScreenshotSaved,
    ScreenshotCopiedToClipboard,
    ScreenshotSaveFailed,
    ScreenshotCopyFailed,
}

impl NotificationType {
    fn details(&self) -> (&'static str, &'static str, bool) {
        match self {
            Self::VideoSaved => ("Video Saved", "Video saved successfully", false),
            Self::VideoCopiedToClipboard => {
                ("Video Copied", "Video copied to clipboard", false)
            }
            Self::ShareableLinkCopied => {
                ("Link Copied", "Link copied to clipboard", false)
            }
            Self::UploadFailed => (
                "Upload Failed",
                "Unable to upload media. Please try again",
                true,
            ),
            Self::VideoSaveFailed => (
                "Save Failed",
                "Unable to save video. Please try again",
                true,
            ),
            Self::VideoCopyFailed => (
                "Copy Failed",
                "Unable to copy video to clipboard. Please try again",
                true,
            ),
            Self::ShareableLinkFailed => (
                "Share Failed",
                "Unable to create shareable link. Please try again",
                true,
            ),
            Self::ScreenshotSaved => {
                ("Screenshot Saved", "Screenshot saved successfully", false)
            }
            Self::ScreenshotCopiedToClipboard => {
                ("Screenshot Copied", "Screenshot copied to clipboard", false)
            }
            Self::ScreenshotSaveFailed => (
                "Save Failed",
                "Unable to save screenshot. Please try again",
                true,
            ),
            Self::ScreenshotCopyFailed => (
                "Copy Failed",
                "Unable to copy screenshot to clipboard. Please try again",
                true,
            ),
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::UploadFailed => {
                "Failed to upload your video after multiple attempts. Please try again later."
            }
            _ => "",
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Self::UploadFailed => "Upload Failed",
            _ => "",
        }
    }

    pub fn send(self, app: &tauri::AppHandle) {
        send_notification(app, self);
    }
}

pub fn send_notification(app: &tauri::AppHandle, notification_type: NotificationType) {
    // Check if notifications are enabled in settings
    let enable_notifications = GeneralSettingsStore::get(app)
        .map(|settings| settings.map_or(false, |s| s.enable_notifications))
        .unwrap_or(false);

    if !enable_notifications {
        return;
    }

    let (title, body, is_error) = notification_type.details();

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .ok();

    AppSounds::Notification.play();
}
