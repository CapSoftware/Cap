use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use crate::{general_settings::GeneralSettingsStore, windows::CapWindowId};
#[cfg(target_os = "macos")]
use cidre::{av, sc};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
#[cfg(target_os = "macos")]
use std::{
    future::Future,
    str::FromStr,
    sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering},
    time::Duration,
};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tracing::instrument;

#[cfg(target_os = "macos")]
static MACOS_DOCK_VISIBILITY_SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static MACOS_PENDING_PANEL_WINDOWS: AtomicU32 = AtomicU32::new(0);
#[cfg(target_os = "macos")]
static MACOS_SCK_PERMISSION_MISMATCH_LOGGED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static MACOS_SCK_DISPLAYS_VALIDATED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static MACOS_SCK_DISPLAYS_VALIDATION_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static MACOS_SCK_LAST_STRICT_OUTCOME: AtomicU8 = AtomicU8::new(MACOS_SCK_OUTCOME_UNKNOWN);
#[cfg(target_os = "macos")]
static MACOS_SCK_LAST_VALIDATION_ATTEMPT: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);
#[cfg(target_os = "macos")]
const MACOS_SCK_VALIDATION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
// Strictly less than the retry interval: the backoff stamp is refreshed when
// an attempt completes, and a timeout that consumed the whole interval would
// otherwise leave zero backoff between attempts against a wedged replayd.
#[cfg(target_os = "macos")]
const MACOS_SCK_VALIDATION_TIMEOUT: Duration = Duration::from_secs(4);
#[cfg(target_os = "macos")]
const MACOS_SCK_OUTCOME_UNKNOWN: u8 = 0;
#[cfg(target_os = "macos")]
const MACOS_SCK_OUTCOME_OK: u8 = 1;
#[cfg(target_os = "macos")]
const MACOS_SCK_OUTCOME_FAILED: u8 = 2;

#[cfg(target_os = "macos")]
pub(crate) struct MacosPanelWindowActivationGuard {
    app: tauri::AppHandle,
}

#[cfg(target_os = "macos")]
impl Drop for MacosPanelWindowActivationGuard {
    fn drop(&mut self) {
        let pending = MACOS_PENDING_PANEL_WINDOWS.fetch_sub(1, Ordering::AcqRel);
        if pending == 1 {
            schedule_macos_dock_visibility_sync(&self.app);
        }
    }
}

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

// Changing the activation policy (which `set_dock_visibility` also does under
// the hood) while any window owns a fullscreen Space makes AppKit throw an
// NSException that aborts the process when it unwinds into Rust. Callers must
// leave the policy alone until fullscreen exits.
#[cfg(target_os = "macos")]
fn macos_any_window_fullscreen(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|window| window.is_fullscreen().unwrap_or(false))
}

#[cfg(target_os = "macos")]
pub(crate) fn prepare_macos_panel_window(
    app: &tauri::AppHandle,
) -> MacosPanelWindowActivationGuard {
    let prev = MACOS_PENDING_PANEL_WINDOWS.fetch_add(1, Ordering::AcqRel);

    if prev == 0 && !macos_any_window_fullscreen(app) {
        if let Err(err) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
            tracing::warn!("Failed to prepare macOS panel activation policy: {err}");
        }
    }

    MacosPanelWindowActivationGuard { app: app.clone() }
}

#[cfg(target_os = "macos")]
pub(crate) fn sync_macos_dock_visibility(app: &tauri::AppHandle) {
    if MACOS_PENDING_PANEL_WINDOWS.load(Ordering::Acquire) > 0 {
        return;
    }

    if macos_any_window_fullscreen(app) {
        return;
    }

    let should_hide_dock = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .is_some_and(|settings| settings.hide_dock_icon);

    let has_visible_panel_window = app.webview_windows().iter().any(|(label, window)| {
        CapWindowId::from_str(label)
            .map(|id| !id.activates_dock() && window.is_visible().unwrap_or(false))
            .unwrap_or(false)
    });

    if has_visible_panel_window && should_hide_dock {
        return;
    }

    let has_visible_dock_window = app.webview_windows().iter().any(|(label, window)| {
        CapWindowId::from_str(label)
            .map(|window_id| window_id.activates_dock() && window.is_visible().unwrap_or(false))
            .unwrap_or(false)
    });

    let should_show_dock = !should_hide_dock || has_visible_dock_window;

    macos_sync_activation_policy(app, should_show_dock);

    if let Err(err) = app.set_dock_visibility(should_show_dock) {
        tracing::warn!("Failed to update dock visibility: {err}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn schedule_macos_dock_visibility_sync(app: &tauri::AppHandle) {
    let generation = MACOS_DOCK_VISIBILITY_SYNC_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if MACOS_DOCK_VISIBILITY_SYNC_GENERATION.load(Ordering::Acquire) == generation {
            sync_macos_dock_visibility(&app);
        }
    });
}

#[cfg(target_os = "macos")]
fn macos_permission_status(permission: &OSPermission, initial_check: bool) -> OSPermissionStatus {
    match permission {
        OSPermission::ScreenRecording => {
            let granted = macos_screen_recording_available();
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

// The SCShareableContent snapshot behind this validation materialises every
// window/app/display on the system (~1MB+ of ObjC objects per call). Polling
// callers (devices snapshot emitter every 5s, permission UIs down to 250ms)
// used to re-run it for the whole process lifetime, leaking the graph on
// pool-less tokio threads at ~15MB/min until macOS exhausted swap (issue
// #2023, the 82GB incident). A successful validation is cached for the rest
// of the process: runtime revocation is caught by the cheap CGPreflight gate,
// and macOS relaunches the app on screen-recording permission changes anyway.
// Failed validations retry at most once per MACOS_SCK_VALIDATION_RETRY_INTERVAL.
#[cfg(target_os = "macos")]
fn macos_screen_recording_available() -> bool {
    macos_screen_recording_available_with(
        scap_screencapturekit::has_permission(),
        MACOS_SCK_DISPLAYS_VALIDATED.load(Ordering::Acquire),
        MACOS_SCK_LAST_STRICT_OUTCOME.load(Ordering::Acquire),
        objc2::MainThreadMarker::new().is_some(),
        macos_spawn_sck_displays_validation,
        || {
            // block_in_place covers the mutex acquisition too: waiters serialised
            // behind an in-flight validation would otherwise park a tokio worker
            // without telling the runtime.
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::task::block_in_place(macos_validate_sck_displays)
            } else {
                macos_validate_sck_displays()
            }
        },
    )
}

// SCShareableContent's completion needs the main run loop, so blocking the
// main thread on the strict validation deadlocks the whole app. Both
// 2026-08-03 macOS hang reports show it: onboarding tray rebuilds
// (run_on_main_thread → build_tray_menu → do_permissions_check) parked the
// main thread in block_on for 76+s until force-quit. Main-thread callers are
// the tray menu builds (tray.rs), create_tray, the setup-time log line
// (lib.rs), and RunEvent::Reopen → should_show_onboarding (lib.rs); they get
// the last strictly-observed answer without blocking — optimistic until the
// first strict validation completes, since CGPreflight already passed. Reopen
// consuming an optimistic answer is self-correcting: ShowCapWindow::Main
// re-checks off-main (windows.rs) and redirects back to Onboarding. The
// onboarding/permission UIs poll via async commands and keep the strict path.
#[cfg(target_os = "macos")]
fn macos_screen_recording_available_with(
    preflight_granted: bool,
    displays_validated: bool,
    last_strict_outcome: u8,
    on_main_thread: bool,
    spawn_background_validation: impl FnOnce(),
    validate: impl FnOnce() -> bool,
) -> bool {
    if !preflight_granted {
        return false;
    }

    if displays_validated {
        return true;
    }

    if on_main_thread {
        spawn_background_validation();
        return last_strict_outcome != MACOS_SCK_OUTCOME_FAILED;
    }

    validate()
}

#[cfg(target_os = "macos")]
struct MacosSckValidationInFlightReset;

#[cfg(target_os = "macos")]
impl Drop for MacosSckValidationInFlightReset {
    fn drop(&mut self) {
        MACOS_SCK_DISPLAYS_VALIDATION_IN_FLIGHT.store(false, Ordering::Release);
    }
}

// Blocking pool rather than a raw std::thread: pool threads carry the runtime
// handle without tokio's "entered" flag, so the validator's nested
// Handle::block_on is legal there (it panics on entered threads, which rules
// out tokio::spawn), they inherit the 16MiB stack configured in main.rs
// (SCK graph walks are why it was raised), and an idle pool thread is reused
// instead of spawning one per check. The Drop guard clears the in-flight
// latch even if the validation panics.
#[cfg(target_os = "macos")]
fn macos_spawn_sck_displays_validation() {
    if MACOS_SCK_DISPLAYS_VALIDATION_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn_blocking(|| {
        let _reset = MacosSckValidationInFlightReset;
        macos_validate_sck_displays();
    });
}

#[cfg(target_os = "macos")]
fn macos_validate_sck_displays() -> bool {
    // Serialise validators: concurrent callers during the first startup check
    // must wait for the in-flight validation rather than tripping the backoff
    // and transiently reporting a granted permission as denied.
    let mut last_attempt = MACOS_SCK_LAST_VALIDATION_ATTEMPT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if MACOS_SCK_DISPLAYS_VALIDATED.load(Ordering::Acquire) {
        return true;
    }
    if let Some(attempted_at) = *last_attempt
        && attempted_at.elapsed() < MACOS_SCK_VALIDATION_RETRY_INTERVAL
    {
        return false;
    }
    *last_attempt = Some(std::time::Instant::now());

    let validated = objc2::rc::autoreleasepool(|_| {
        tauri::async_runtime::block_on(async {
            // Bounded: a wedged replayd (post-sleep, or right after a TCC
            // grant before relaunch) can leave this future unresolved forever,
            // which would park whichever thread is validating.
            let content = match tokio::time::timeout(
                MACOS_SCK_VALIDATION_TIMEOUT,
                sc::ShareableContent::current(),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => {
                    tracing::warn!(
                        timeout_ms = MACOS_SCK_VALIDATION_TIMEOUT.as_millis() as u64,
                        "ScreenCaptureKit shareable content query timed out during permission check"
                    );
                    return false;
                }
            };
            match content {
                Ok(content) => {
                    let display_count = content.displays().len();
                    if display_count == 0
                        && !MACOS_SCK_PERMISSION_MISMATCH_LOGGED.swap(true, Ordering::AcqRel)
                    {
                        tracing::debug!(
                            window_count = content.windows().len(),
                            application_count = content.apps().len(),
                            "ScreenCaptureKit returned no displays despite CoreGraphics screen-recording permission"
                        );
                    }
                    display_count > 0
                }
                Err(error) => {
                    tracing::debug!(
                        error = %error,
                        "ScreenCaptureKit shareable content unavailable during permission check"
                    );
                    false
                }
            }
        })
    });

    if validated {
        MACOS_SCK_DISPLAYS_VALIDATED.store(true, Ordering::Release);
    }
    MACOS_SCK_LAST_STRICT_OUTCOME.store(
        if validated {
            MACOS_SCK_OUTCOME_OK
        } else {
            MACOS_SCK_OUTCOME_FAILED
        },
        Ordering::Release,
    );
    // Re-stamp on completion: an attempt can consume up to the SCK timeout,
    // so a start-only stamp would leave a timed-out attempt with an already
    // expired backoff window (back-to-back attempts against a wedged
    // replayd). The start stamp above stays as insurance in case this thread
    // dies mid-attempt.
    *last_attempt = Some(std::time::Instant::now());
    validated
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
    // The user just interacted with the permission prompt; drop the SCK
    // validation backoff so this poll loop sees fresh answers instead of a
    // stale negative from up to 5s ago. block_in_place because an in-flight
    // validation holds this mutex for up to the SCK timeout, and waiting it
    // out is deliberate — its result predates the grant, so the reset must
    // land after it finishes.
    if matches!(permission, OSPermission::ScreenRecording) {
        tokio::task::block_in_place(|| {
            *MACOS_SCK_LAST_VALIDATION_ATTEMPT
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        });
    }

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
    // Pool-wrapped because this runs on tokio/tauri worker threads (which have
    // no ambient NSAutoreleasePool) from polling callers; without it every
    // autoreleased AVFoundation/AppKit temporary leaks for the process lifetime.
    #[cfg(target_os = "macos")]
    {
        objc2::rc::autoreleasepool(|_| OSPermissionsCheck {
            screen_recording: macos_permission_status(
                &OSPermission::ScreenRecording,
                _initial_check,
            ),
            microphone: macos_permission_status(&OSPermission::Microphone, _initial_check),
            camera: macos_permission_status(&OSPermission::Camera, _initial_check),
            accessibility: macos_permission_status(&OSPermission::Accessibility, _initial_check),
        })
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
    fn main_thread_never_validates_inline() {
        use std::cell::Cell;

        let spawned = Cell::new(false);
        let validated_inline = Cell::new(false);

        let result = macos_screen_recording_available_with(
            true,
            false,
            MACOS_SCK_OUTCOME_UNKNOWN,
            true,
            || spawned.set(true),
            || {
                validated_inline.set(true);
                true
            },
        );

        assert!(result, "optimistic before the first strict validation");
        assert!(spawned.get(), "must kick a background validation");
        assert!(
            !validated_inline.get(),
            "the main thread must never run the blocking SCK validation"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn main_thread_reports_last_failed_strict_outcome() {
        use std::cell::Cell;

        let spawned = Cell::new(false);

        let result = macos_screen_recording_available_with(
            true,
            false,
            MACOS_SCK_OUTCOME_FAILED,
            true,
            || spawned.set(true),
            || unreachable!("main thread must not validate inline"),
        );

        assert!(!result, "a strictly-observed failure must not be masked");
        assert!(spawned.get(), "still revalidates in the background");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn off_main_thread_keeps_the_strict_path() {
        use std::cell::Cell;

        let spawned = Cell::new(false);
        let validated_inline = Cell::new(false);

        let result = macos_screen_recording_available_with(
            true,
            false,
            MACOS_SCK_OUTCOME_UNKNOWN,
            false,
            || spawned.set(true),
            || {
                validated_inline.set(true);
                false
            },
        );

        assert!(!result);
        assert!(validated_inline.get(), "off-main callers validate inline");
        assert!(!spawned.get());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preflight_denial_and_cached_validation_short_circuit() {
        let denied = macos_screen_recording_available_with(
            false,
            false,
            MACOS_SCK_OUTCOME_UNKNOWN,
            true,
            || unreachable!("no work when preflight is denied"),
            || unreachable!("no work when preflight is denied"),
        );
        assert!(!denied);

        let cached = macos_screen_recording_available_with(
            true,
            true,
            MACOS_SCK_OUTCOME_UNKNOWN,
            true,
            || unreachable!("no work once displays are validated"),
            || unreachable!("no work once displays are validated"),
        );
        assert!(cached);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sck_timeout_fits_inside_the_retry_backoff() {
        assert!(MACOS_SCK_VALIDATION_TIMEOUT < MACOS_SCK_VALIDATION_RETRY_INTERVAL);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn in_flight_latch_clears_even_when_validation_panics() {
        MACOS_SCK_DISPLAYS_VALIDATION_IN_FLIGHT.store(true, Ordering::Release);

        let panicked = std::panic::catch_unwind(|| {
            let _reset = MacosSckValidationInFlightReset;
            panic!("validation blew up");
        });

        assert!(panicked.is_err());
        assert!(!MACOS_SCK_DISPLAYS_VALIDATION_IN_FLIGHT.load(Ordering::Acquire));
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
