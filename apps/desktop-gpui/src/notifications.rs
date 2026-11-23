//! Native desktop notifications, the way the Tauri app sent them: through
//! `notify-rust` (`tauri-plugin-notification` on macOS and Windows, the app's
//! own `show_linux_notification` on Linux), and only while "Enable
//! notifications" is on.

#[cfg(any(target_os = "macos", target_os = "windows"))]
const APP_IDENTIFIER: &str = "so.cap.desktop";

pub fn enabled() -> bool {
    crate::store::GeneralSettings::load().enable_notifications
}

/// Blocks while the platform takes the notification, so callers run it off
/// the UI thread.
pub fn show(title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    claim_application();
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body);
    #[cfg(target_os = "linux")]
    notification.auto_icon();
    #[cfg(target_os = "windows")]
    if !cfg!(debug_assertions) {
        notification.app_id(APP_IDENTIFIER);
    }
    notification
        .show()
        .map(|_| ())
        .map_err(|error| format!("Failed to send notification: {error}"))
}

#[cfg(target_os = "macos")]
fn claim_application() {
    static CLAIMED: std::sync::Once = std::sync::Once::new();
    CLAIMED.call_once(|| {
        if let Err(error) = notify_rust::set_application(APP_IDENTIFIER) {
            tracing::warn!(%error, "notifications will show under the default app");
        }
    });
}
