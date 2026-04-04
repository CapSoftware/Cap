use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use crate::{general_settings::GeneralSettingsStore, windows::CapWindowId};
#[cfg(target_os = "macos")]
use cidre::av;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
#[cfg(target_os = "macos")]
use std::{future::Future, str::FromStr, time::Duration};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tracing::instrument;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
    -> bool;
}

#[cfg(target_os = "macos")]
fn macos_prompt_screen_recording_access() {
    scap_screencapturekit::request_permission();
}

#[cfg(target_os = "macos")]
fn macos_prompt_accessibility_access() {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    let prompt_key = CFString::new("AXTrustedCheckOptionPrompt");
    let prompt_value = core_foundation::boolean::CFBoolean::true_value();

    let options =
        CFDictionary::from_CFType_pairs(&[(prompt_key.as_CFType(), prompt_value.as_CFType())]);

    unsafe {
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
    }
}

#[cfg(target_os = "macos")]
fn macos_run_on_main_thread<R: Send + 'static>(
    app: &tauri::AppHandle,
    callback: impl FnOnce() -> R + Send + 'static,
) -> Option<R> {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::sync_channel(1);

    if let Err(err) = app.run_on_main_thread(move || {
        let _ = tx.send(callback());
    }) {
        tracing::warn!("Failed to run permission action on main thread: {err}");
        return None;
    }

    rx.recv_timeout(Duration::from_secs(2)).ok()
}

#[cfg(target_os = "macos")]
fn macos_permission_settings_url(permission: &OSPermission) -> &'static str {
    match permission {
        OSPermission::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        OSPermission::Camera => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        }
        OSPermission::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        OSPermission::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_permission_needs_settings_fallback(permission: &OSPermission) -> bool {
    matches!(
        permission,
        OSPermission::ScreenRecording | OSPermission::Accessibility
    )
}

#[cfg(target_os = "macos")]
fn macos_focus_permission_window(app: &tauri::AppHandle) {
    if let Some(window) = ["onboarding", "main", "settings"]
        .into_iter()
        .find_map(|label| app.get_webview_window(label))
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn macos_activate_permission_request(app: &tauri::AppHandle) {
    if let Err(err) = app.set_dock_visibility(true) {
        tracing::warn!("Failed to show dock icon for permission request: {err}");
    }

    if let Err(err) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        tracing::warn!("Failed to set activation policy to Regular: {err}");
    }

    macos_focus_permission_window(app);

    if let Some(current_app) = unsafe {
        NSRunningApplication::runningApplicationWithProcessIdentifier(std::process::id() as _)
    } {
        unsafe {
            current_app
                .activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_sync_activation_policy(app: &tauri::AppHandle, should_show_dock: bool) {
    let policy = if should_show_dock {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };

    if let Err(err) = app.set_activation_policy(policy) {
        tracing::warn!("Failed to update activation policy: {err}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn sync_macos_dock_visibility(app: &tauri::AppHandle) {
    let should_hide_dock = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .is_some_and(|settings| settings.hide_dock_icon);

    let should_show_dock = !should_hide_dock
        || app.webview_windows().keys().any(|label| {
            CapWindowId::from_str(label)
                .map(|window_id| window_id.activates_dock())
                .unwrap_or(false)
        });

    macos_sync_activation_policy(app, should_show_dock);

    if let Err(err) = app.set_dock_visibility(should_show_dock) {
        tracing::warn!("Failed to update dock visibility: {err}");
    }
}

#[cfg(target_os = "macos")]
fn macos_permission_status(permission: &OSPermission, initial_check: bool) -> OSPermissionStatus {
    match permission {
        OSPermission::ScreenRecording => {
            let granted = scap_screencapturekit::has_permission();
            match (granted, initial_check) {
                (true, _) => OSPermissionStatus::Granted,
                (false, true) => OSPermissionStatus::Empty,
                (false, false) => OSPermissionStatus::Denied,
            }
        }
        OSPermission::Camera => {
            match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::video()) {
                Ok(av::AuthorizationStatus::NotDetermined) => OSPermissionStatus::Empty,
                Ok(av::AuthorizationStatus::Authorized) => OSPermissionStatus::Granted,
                Ok(_) => OSPermissionStatus::Denied,
                Err(err) => {
                    tracing::error!("Failed to query AV permission status: {err}");
                    OSPermissionStatus::Denied
                }
            }
        }
        OSPermission::Microphone => {
            match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::audio()) {
                Ok(av::AuthorizationStatus::NotDetermined) => OSPermissionStatus::Empty,
                Ok(av::AuthorizationStatus::Authorized) => OSPermissionStatus::Granted,
                Ok(_) => OSPermissionStatus::Denied,
                Err(err) => {
                    tracing::error!("Failed to query AV permission status: {err}");
                    OSPermissionStatus::Denied
                }
            }
        }
        OSPermission::Accessibility => {
            if unsafe { AXIsProcessTrusted() } {
                OSPermissionStatus::Granted
            } else if initial_check {
                OSPermissionStatus::Empty
            } else {
                OSPermissionStatus::Denied
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_request_permission(app: &tauri::AppHandle, permission: &OSPermission) {
    match permission {
        OSPermission::ScreenRecording => {
            if macos_run_on_main_thread(app, macos_prompt_screen_recording_access).is_none() {
                macos_prompt_screen_recording_access();
            }
        }
        OSPermission::Camera => {
            futures::executor::block_on(av::CaptureDevice::request_access_for_media_type(
                av::MediaType::video(),
            ))
            .ok();
        }
        OSPermission::Microphone => {
            futures::executor::block_on(av::CaptureDevice::request_access_for_media_type(
                av::MediaType::audio(),
            ))
            .ok();
        }
        OSPermission::Accessibility => {
            if macos_run_on_main_thread(app, macos_prompt_accessibility_access).is_none() {
                macos_prompt_accessibility_access();
            }
        }
    }
}

#[cfg(target_os = "macos")]
async fn macos_wait_for_permission_update_with<TCheck, TSleep>(
    mut check: TCheck,
    mut sleep: impl FnMut() -> TSleep,
) -> bool
where
    TCheck: FnMut() -> bool,
    TSleep: Future<Output = ()>,
{
    if check() {
        return true;
    }

    for _ in 0..10 {
        sleep().await;
        if check() {
            return true;
        }
    }

    false
}

#[cfg(target_os = "macos")]
async fn macos_wait_for_permission_update(permission: &OSPermission) -> bool {
    macos_wait_for_permission_update_with(
        || macos_permission_status(permission, false).permitted(),
        || tokio::time::sleep(Duration::from_millis(200)),
    )
    .await
}

#[cfg(target_os = "macos")]
fn macos_open_permission_settings(app: &tauri::AppHandle, permission: &OSPermission) {
    use std::process::Command;

    let process = Command::new("open")
        .arg(macos_permission_settings_url(permission))
        .spawn();

    match process {
        Ok(mut process) => {
            let app = app.clone();
            tokio::spawn(async move {
                match tokio::task::spawn_blocking(move || process.wait()).await {
                    Ok(Err(err)) => {
                        tracing::error!("Error waiting for permission settings process: {err}");
                    }
                    Err(err) => {
                        tracing::error!("Join error waiting for permission settings: {err}");
                    }
                    _ => {}
                }
                crate::tray::refresh_tray_menu_for_app(&app);
                sync_macos_dock_visibility(&app);
            });
        }
        Err(err) => {
            tracing::error!("Failed to open permission settings: {err}");
            sync_macos_dock_visibility(app);
        }
    }
}

#[derive(Debug, Serialize, Deserialize, specta::Type, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OSPermission {
    ScreenRecording,
    Camera,
    Microphone,
    Accessibility,
}

#[tauri::command(async)]
#[specta::specta]
pub fn open_permission_settings(_app: tauri::AppHandle, _permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        macos_activate_permission_request(&_app);
        macos_open_permission_settings(&_app, &_permission);
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_app))]
pub async fn request_permission(_app: tauri::AppHandle, _permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        macos_activate_permission_request(&_app);

        let permission = _permission;
        let app = _app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            macos_request_permission(&app, &permission);
        })
        .await
        .ok();

        let granted = macos_wait_for_permission_update(&_permission).await;

        if macos_permission_needs_settings_fallback(&_permission) && !granted {
            macos_open_permission_settings(&_app, &_permission);
        } else {
            sync_macos_dock_visibility(&_app);
        }
    }

    crate::tray::refresh_tray_menu_for_app(&_app);
}

#[derive(Serialize, Deserialize, Debug, specta::Type, Clone)]
#[serde(rename_all = "camelCase")]
pub enum OSPermissionStatus {
    // This platform does not require this permission
    NotNeeded,
    // The user has neither granted nor denied permission
    Empty,
    // The user has explicitly granted permission
    Granted,
    // The user has denied permission, or has granted it but not yet restarted
    Denied,
}

impl OSPermissionStatus {
    pub fn permitted(&self) -> bool {
        matches!(self, Self::NotNeeded | Self::Granted)
    }
}

#[derive(Serialize, Deserialize, Debug, specta::Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OSPermissionsCheck {
    pub screen_recording: OSPermissionStatus,
    pub microphone: OSPermissionStatus,
    pub camera: OSPermissionStatus,
    pub accessibility: OSPermissionStatus,
}

impl OSPermissionsCheck {
    pub fn necessary_granted(&self) -> bool {
        self.screen_recording.permitted() && self.accessibility.permitted()
    }
}

#[tauri::command(async)]
#[specta::specta]
pub fn do_permissions_check(_initial_check: bool) -> OSPermissionsCheck {
    #[cfg(target_os = "macos")]
    {
        OSPermissionsCheck {
            screen_recording: macos_permission_status(
                &OSPermission::ScreenRecording,
                _initial_check,
            ),
            microphone: macos_permission_status(&OSPermission::Microphone, _initial_check),
            camera: macos_permission_status(&OSPermission::Camera, _initial_check),
            accessibility: macos_permission_status(&OSPermission::Accessibility, _initial_check),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        OSPermissionsCheck {
            screen_recording: OSPermissionStatus::NotNeeded,
            microphone: OSPermissionStatus::NotNeeded,
            camera: OSPermissionStatus::NotNeeded,
            accessibility: OSPermissionStatus::NotNeeded,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_status_permitted_matches_granted_states() {
        assert!(OSPermissionStatus::Granted.permitted());
        assert!(OSPermissionStatus::NotNeeded.permitted());
        assert!(!OSPermissionStatus::Empty.permitted());
        assert!(!OSPermissionStatus::Denied.permitted());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn permission_settings_urls_match_expected_privacy_pages() {
        assert_eq!(
            macos_permission_settings_url(&OSPermission::ScreenRecording),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert_eq!(
            macos_permission_settings_url(&OSPermission::Accessibility),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        assert_eq!(
            macos_permission_settings_url(&OSPermission::Camera),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        );
        assert_eq!(
            macos_permission_settings_url(&OSPermission::Microphone),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn permission_update_wait_returns_true_once_permission_is_observed() {
        let mut checks = [false, false, true, true].into_iter();

        let granted =
            macos_wait_for_permission_update_with(|| checks.next().unwrap_or(true), || async {})
                .await;

        assert!(granted);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn permission_update_wait_returns_false_when_permission_never_changes() {
        let mut checks = [false, false, false].into_iter();

        let granted =
            macos_wait_for_permission_update_with(|| checks.next().unwrap_or(false), || async {})
                .await;

        assert!(!granted);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn settings_fallback_only_applies_to_screen_and_accessibility() {
        assert!(macos_permission_needs_settings_fallback(
            &OSPermission::ScreenRecording
        ));
        assert!(macos_permission_needs_settings_fallback(
            &OSPermission::Accessibility
        ));
        assert!(!macos_permission_needs_settings_fallback(
            &OSPermission::Camera
        ));
        assert!(!macos_permission_needs_settings_fallback(
            &OSPermission::Microphone
        ));
    }
}
