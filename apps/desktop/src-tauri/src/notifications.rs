use crate::{AppSounds, general_settings::GeneralSettingsStore};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_notification::NotificationExt;

#[allow(unused)]
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
            NotificationType::VideoSaved => ("Video Saved", "Video saved successfully", false),
            NotificationType::VideoCopiedToClipboard => {
                ("Video Copied", "Video copied to clipboard", false)
            }
            NotificationType::ShareableLinkCopied => {
                ("Link Copied", "Link copied to clipboard", false)
            }
            NotificationType::UploadFailed => (
                "Upload Failed",
                "Unable to upload media. Please try again",
                true,
            ),
            NotificationType::VideoSaveFailed => (
                "Save Failed",
                "Unable to save video. Please try again",
                true,
            ),
            NotificationType::VideoCopyFailed => (
                "Copy Failed",
                "Unable to copy video to clipboard. Please try again",
                true,
            ),
            NotificationType::ShareableLinkFailed => (
                "Share Failed",
                "Unable to create shareable link. Please try again",
                true,
            ),
            NotificationType::ScreenshotSaved => {
                ("Screenshot Saved", "Screenshot saved successfully", false)
            }
            NotificationType::ScreenshotCopiedToClipboard => {
                ("Screenshot Copied", "Screenshot copied to clipboard", false)
            }
            NotificationType::ScreenshotSaveFailed => (
                "Save Failed",
                "Unable to save screenshot. Please try again",
                true,
            ),
            NotificationType::ScreenshotCopyFailed => (
                "Copy Failed",
                "Unable to copy screenshot to clipboard. Please try again",
                true,
            ),
        }
    }

    #[allow(unused)]
    pub fn message(&self) -> &'static str {
        match self {
            NotificationType::UploadFailed => {
                "Failed to upload your video after multiple attempts. Please try again later."
            }
            _ => "",
        }
    }

    #[allow(unused)]
    pub fn title(&self) -> &'static str {
        match self {
            NotificationType::UploadFailed => "Upload Failed",
            _ => "",
        }
    }

    pub fn send(self, app: &tauri::AppHandle) {
        send_notification(app, self);
    }
}

pub fn send_notification(app: &tauri::AppHandle, notification_type: NotificationType) {
    let enable_notifications = GeneralSettingsStore::get(app)
        .map(|settings| settings.is_some_and(|s| s.enable_notifications))
        .unwrap_or(false);

    if !enable_notifications {
        return;
    }

    let (title, body, _is_error) = notification_type.details();

    #[cfg(target_os = "linux")]
    tauri::async_runtime::spawn(async move {
        if let Err(error) = show_linux_notification(title, body).await {
            tracing::warn!(%error, "Failed to send notification");
        }
    });

    #[cfg(not(target_os = "linux"))]
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .ok();

    let skip_sound = matches!(
        notification_type,
        NotificationType::ScreenshotSaved
            | NotificationType::ScreenshotCopiedToClipboard
            | NotificationType::ScreenshotSaveFailed
            | NotificationType::ScreenshotCopyFailed
    );

    if !skip_sound {
        AppSounds::Notification.play();
    }
}

#[cfg(target_os = "linux")]
fn build_linux_notification(title: &str, body: &str) -> notify_rust::Notification {
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body).auto_icon();
    notification
}

#[cfg(target_os = "linux")]
pub(crate) async fn show_linux_notification(title: &str, body: &str) -> Result<(), String> {
    build_linux_notification(title, body)
        .show_async()
        .await
        .map(|_| ())
        .map_err(|error| format!("Failed to send notification: {error}"))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::build_linux_notification;

    #[test]
    fn linux_notification_preserves_content_and_application_icon() {
        let notification = build_linux_notification("Screenshot Saved", "Saved successfully");

        assert_eq!(notification.summary, "Screenshot Saved");
        assert_eq!(notification.body, "Saved successfully");
        assert_eq!(notification.icon, notification.appname);
        assert!(!notification.icon.is_empty());
    }
}
