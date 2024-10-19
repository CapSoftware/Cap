use tauri_plugin_notification::NotificationExt;

pub enum NotificationType {
    VideoSaved,
    VideoCopiedToClipboard,
    ShareableLinkCopied,
    UploadFailed,
}

impl NotificationType {
    fn details(&self) -> (&'static str, &'static str) {
        match self {
            NotificationType::VideoSaved => {
                ("Video Saved", "Your video has been successfully saved.")
            }
            NotificationType::VideoCopiedToClipboard => (
                "Video Copied",
                "Your video has been copied to the clipboard.",
            ),
            NotificationType::ShareableLinkCopied => (
                "Link Copied",
                "Shareable link has been copied to the clipboard.",
            ),
            NotificationType::UploadFailed => (
                "Upload Failed",
                "Failed to upload your video after multiple attempts. Please try again later.",
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
    let (title, body) = notification_type.details();

    println!("Sending notification: Title: '{}', Body: '{}'", title, body);

    match app.notification().builder().title(title).body(body).show() {
        Ok(_) => println!("Notification sent successfully"),
        Err(e) => eprintln!("Failed to send notification: {}", e),
    }
}
