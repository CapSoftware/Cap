use crate::{AppSounds, NewNotification};
use tauri_specta::Event;

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

    pub fn message(&self) -> &'static str {
        match self {
            NotificationType::UploadFailed => {
                "Failed to upload your video after multiple attempts. Please try again later."
            }
            _ => "",
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            NotificationType::UploadFailed => "Upload Failed",
            _ => "",
        }
    }
}

pub fn send_notification(app: &tauri::AppHandle, notification_type: NotificationType) {
    let (title, body, is_error) = notification_type.details();

    println!(
        "Sending notification: Title: '{}', Body: '{}', Error: {}",
        title, body, is_error
    );

    AppSounds::Notification.play();

    let _ = NewNotification {
        title: title.to_string(),
        body: body.to_string(),
        is_error,
    }
    .emit(app);
}
