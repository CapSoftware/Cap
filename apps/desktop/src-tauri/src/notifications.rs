use crate::{AppSounds, general_settings::GeneralSettingsStore};
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
            NotificationType::VideoSaved => ("视频已保存", "视频保存成功", false),
            NotificationType::VideoCopiedToClipboard => {
                ("视频已复制", "视频已复制到剪贴板", false)
            }
            NotificationType::ShareableLinkCopied => {
                ("链接已复制", "链接已复制到剪贴板", false)
            }
            NotificationType::UploadFailed => (
                "上传失败",
                "无法上传媒体，请重试",
                true,
            ),
            NotificationType::VideoSaveFailed => (
                "保存失败",
                "无法保存视频，请重试",
                true,
            ),
            NotificationType::VideoCopyFailed => (
                "复制失败",
                "无法将视频复制到剪贴板，请重试",
                true,
            ),
            NotificationType::ShareableLinkFailed => (
                "分享失败",
                "无法创建分享链接，请重试",
                true,
            ),
            NotificationType::ScreenshotSaved => {
                ("截图已保存", "截图保存成功", false)
            }
            NotificationType::ScreenshotCopiedToClipboard => {
                ("截图已复制", "截图已复制到剪贴板", false)
            }
            NotificationType::ScreenshotSaveFailed => (
                "保存失败",
                "无法保存截图，请重试",
                true,
            ),
            NotificationType::ScreenshotCopyFailed => (
                "复制失败",
                "无法将截图复制到剪贴板，请重试",
                true,
            ),
        }
    }

    #[allow(unused)]
    pub fn message(&self) -> &'static str {
        match self {
            NotificationType::UploadFailed => {
                "多次尝试后仍无法上传视频，请稍后重试。"
            }
            _ => "",
        }
    }

    #[allow(unused)]
    pub fn title(&self) -> &'static str {
        match self {
            NotificationType::UploadFailed => "上传失败",
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
