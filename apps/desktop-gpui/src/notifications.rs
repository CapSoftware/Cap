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

/// What became of a notification that opens something when clicked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Clicked,
    Closed,
    /// The platform would not take it (no notification service, a toast
    /// Windows refused): say it another way.
    NotShown,
}

/// Shows a notification and waits for the person to click or close it, on
/// Windows and Linux (macOS goes through GPUI's notification center). Blocks
/// until then, possibly for as long as the app runs, so callers give it its
/// own thread. `open` names the click on Linux servers that list actions.
#[cfg(not(target_os = "macos"))]
pub fn show_and_wait(title: &str, body: &str, open: &str) -> Outcome {
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body);
    #[cfg(target_os = "linux")]
    notification.auto_icon().action("default", open);
    #[cfg(not(target_os = "linux"))]
    let _ = open;
    #[cfg(target_os = "windows")]
    {
        if !cfg!(debug_assertions) {
            notification.app_id(APP_IDENTIFIER);
        }
        // Windows' long toast (about 25 s) rather than its short one: this
        // one says something went wrong and opens the notes window.
        notification.timeout(notify_rust::Timeout::Never);
    }
    let handle = match notification.show() {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!(%error, "could not show a notification");
            return Outcome::NotShown;
        }
    };
    let mut outcome = Outcome::Closed;
    let waited = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
        if matches!(
            response,
            notify_rust::NotificationResponse::Default
                | notify_rust::NotificationResponse::Action(_)
        ) {
            outcome = Outcome::Clicked;
        }
    });
    if let Err(error) = waited {
        tracing::warn!(%error, "lost track of a notification");
    }
    outcome
}

/// Asks macOS whether Cap may show notifications, at the moment one is
/// needed (never at launch): the first time, macOS asks the person; after
/// that it answers at once. `false` outside an app bundle (a dev build),
/// where the notification center cannot be used.
#[cfg(target_os = "macos")]
pub fn request_permission() -> flume::Receiver<bool> {
    use objc2_foundation::{NSBundle, NSError};
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    let (tx, rx) = flume::bounded(1);
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        tx.try_send(false).ok();
        return rx;
    }
    let completion = block2::RcBlock::new(
        move |granted: objc2::runtime::Bool, error: *mut NSError| {
            // SAFETY: when non-null, `error` is a valid NSError for this call.
            if let Some(error) = unsafe { error.as_ref() } {
                tracing::warn!(error = %error.localizedDescription(), "notification permission failed");
            }
            tx.try_send(granted.as_bool()).ok();
        },
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );
    rx
}
