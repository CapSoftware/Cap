//! OS permission checks -- `src-tauri/src/permissions.rs`, without Tauri.
//!
//! macOS is the only platform that gates onboarding on these. Windows and
//! Linux report [`OSPermissionStatus::NotNeeded`] for every row, matching
//! `do_permissions_check` over there.
//!
//! ## Detection, and why it is cheap
//!
//! Every check here is a preflight API: `CGPreflightScreenCaptureAccess` for
//! screen recording, `AXIsProcessTrusted` for accessibility, and
//! `AVCaptureDevice.authorizationStatus(for:)` for camera / microphone. None
//! of them prompt, and none of them materialise anything. The one API this
//! module must never call is `SCShareableContent` -- the Tauri app polled it
//! for permission state at 250ms and leaked the whole window/app/display
//! graph per call (~137KB, issue #2023, the 82GB incident). Zed does the same
//! thing from the other direction: its gpui fork touches `SCShareableContent`
//! exactly once, at the moment the user actually starts a screen share, and
//! has no permission poller at all.
//!
//! ## Status model
//!
//! The AV authorization statuses are surfaced distinctly the way the Tauri
//! app surfaces them: `notDetermined` maps to [`OSPermissionStatus::NotDetermined`]
//! (the "Grant" button -- requesting will show the system prompt), while
//! `denied` and `restricted` both map to [`OSPermissionStatus::Denied`] (the
//! "Open Settings" button -- the system prompt will never appear again).
//! Screen recording and accessibility only expose a boolean, so an
//! un-granted one is `NotDetermined` until a request cycle for it has
//! actually failed -- the per-permission `attempted` flags in
//! [`classify`] are this module's version of Tauri's `initial_check`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OSPermission {
    ScreenRecording,
    Accessibility,
    Microphone,
    Camera,
}

impl OSPermission {
    pub const ALL: &'static [Self] = &[
        Self::ScreenRecording,
        Self::Accessibility,
        Self::Microphone,
        Self::Camera,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::ScreenRecording => "Screen Recording",
            Self::Accessibility => "Accessibility",
            Self::Microphone => "Microphone",
            Self::Camera => "Camera",
        }
    }

    /// The one-line "why we need it" under the row name. Single line on
    /// purpose: the row's text column is a fixed width and truncates.
    pub fn blurb(self) -> &'static str {
        match self {
            Self::ScreenRecording => "Captures your screen and windows for recordings.",
            Self::Accessibility => "Tracks mouse activity for automatic zoom.",
            Self::Microphone => "Adds your voice to recordings.",
            Self::Camera => "Shows your webcam in recordings.",
        }
    }

    /// Screen recording and accessibility gate the app; mic and camera are
    /// optional. Same split as the Tauri app's `necessary_granted`.
    pub fn required(self) -> bool {
        matches!(self, Self::ScreenRecording | Self::Accessibility)
    }

    pub fn icon(self) -> &'static str {
        match self {
            // `screen.svg`, not `monitor.svg`: the latter is a multicolor
            // asset, and `svg()` is alpha-mask-only -- it renders as a blob.
            Self::ScreenRecording => "icons/screen.svg",
            Self::Accessibility => "icons/cursor.svg",
            Self::Microphone => "icons/microphone.svg",
            Self::Camera => "icons/camera.svg",
        }
    }

    /// The exact System Settings pane, verbatim from
    /// `macos_permission_settings_url` in the Tauri app.
    fn settings_url(self) -> &'static str {
        match self {
            Self::ScreenRecording => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            Self::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            Self::Microphone => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            Self::Camera => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OSPermissionStatus {
    /// This platform does not require this permission.
    NotNeeded,
    /// The user has neither granted nor denied it -- requesting will prompt.
    /// (Tauri calls this `Empty`.)
    NotDetermined,
    Granted,
    /// Denied or restricted -- the system prompt will not appear again, only
    /// System Settings can change it.
    Denied,
}

impl OSPermissionStatus {
    pub fn permitted(self) -> bool {
        matches!(self, Self::Granted | Self::NotNeeded)
    }
}

/// `AVAuthorizationStatus`, surfaced whole so `restricted` and `denied` stay
/// distinguishable up to the classification step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaAuthorization {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
}

impl MediaAuthorization {
    /// The Tauri mapping: `notDetermined` -> prompt-able, `authorized` ->
    /// granted, `denied` / `restricted` -> Settings-only.
    pub fn status(self) -> OSPermissionStatus {
        match self {
            Self::Authorized => OSPermissionStatus::Granted,
            Self::NotDetermined => OSPermissionStatus::NotDetermined,
            Self::Denied | Self::Restricted => OSPermissionStatus::Denied,
        }
    }
}

/// One preflight sweep, before classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawPermissions {
    pub screen_granted: bool,
    pub accessibility_granted: bool,
    pub microphone: MediaAuthorization,
    pub camera: MediaAuthorization,
}

/// Which boolean-API permissions have been through a failed request cycle,
/// flipping them from "Grant" to "Open Settings". Camera and microphone do
/// not need this: AV reports `notDetermined` vs `denied` directly.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AttemptedFlags {
    pub screen: bool,
    pub accessibility: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OSPermissionsCheck {
    pub screen_recording: OSPermissionStatus,
    pub accessibility: OSPermissionStatus,
    pub microphone: OSPermissionStatus,
    pub camera: OSPermissionStatus,
}

impl OSPermissionsCheck {
    pub fn get(self, permission: OSPermission) -> OSPermissionStatus {
        match permission {
            OSPermission::ScreenRecording => self.screen_recording,
            OSPermission::Accessibility => self.accessibility,
            OSPermission::Microphone => self.microphone,
            OSPermission::Camera => self.camera,
        }
    }

    pub fn necessary_granted(self) -> bool {
        self.screen_recording.permitted() && self.accessibility.permitted()
    }

    pub fn all_permitted(self) -> bool {
        OSPermission::ALL
            .iter()
            .all(|&permission| self.get(permission).permitted())
    }
}

/// Pure classification -- the whole status state machine, unit-tested below.
/// `None` is a platform that needs nothing.
pub fn classify(raw: Option<RawPermissions>, attempted: AttemptedFlags) -> OSPermissionsCheck {
    let Some(raw) = raw else {
        return OSPermissionsCheck {
            screen_recording: OSPermissionStatus::NotNeeded,
            accessibility: OSPermissionStatus::NotNeeded,
            microphone: OSPermissionStatus::NotNeeded,
            camera: OSPermissionStatus::NotNeeded,
        };
    };
    OSPermissionsCheck {
        screen_recording: bool_status(raw.screen_granted, attempted.screen),
        accessibility: bool_status(raw.accessibility_granted, attempted.accessibility),
        microphone: raw.microphone.status(),
        camera: raw.camera.status(),
    }
}

fn bool_status(granted: bool, attempted: bool) -> OSPermissionStatus {
    if granted {
        OSPermissionStatus::Granted
    } else if attempted {
        OSPermissionStatus::Denied
    } else {
        OSPermissionStatus::NotDetermined
    }
}

/// The live preflight sweep. Thread-safe (`main.rs` runs the startup gate off
/// the main thread on the strength of this), never prompts, ~30ms of XPC on
/// a cold TCC cache.
pub fn check_raw() -> Option<RawPermissions> {
    #[cfg(target_os = "macos")]
    {
        Some(macos::check_raw())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The startup / tray gate: screen recording + accessibility.
pub fn necessary_granted() -> bool {
    match check_raw() {
        Some(raw) => raw.screen_granted && raw.accessibility_granted,
        None => true,
    }
}

/// Show the system prompt. For screen recording and accessibility this only
/// ever works once per TCC reset -- callers own the "wait, then fall back to
/// System Settings" cycle (the onboarding window's verify task, mirroring
/// `request_permission` in the Tauri app). For camera / microphone the AV
/// request runs on its own thread and the system dialog outlives this call;
/// the caller's poll observes the answer.
pub fn request_permission(permission: OSPermission) {
    #[cfg(target_os = "macos")]
    macos::request(permission);
    #[cfg(not(target_os = "macos"))]
    let _ = permission;
}

pub fn open_permission_settings(permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        crate::platform::set_activation_policy(true);
        if let Err(error) = std::process::Command::new("open")
            .arg(permission.settings_url())
            .spawn()
        {
            tracing::warn!("opening permission settings failed: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = permission;
}

/// Relaunch the app -- the Tauri onboarding offers this after sending the
/// user to System Settings, because a fresh screen-recording or accessibility
/// grant often only takes effect in a new process. Spawns a detached shell
/// that reopens the bundle (or the bare binary in dev) after this process has
/// had a beat to exit, then quits.
pub fn relaunch() {
    let Ok(exe) = std::env::current_exe() else {
        tracing::error!("relaunch: current_exe unavailable");
        return;
    };

    #[cfg(target_os = "macos")]
    let command = {
        let bundle = exe
            .ancestors()
            .find(|path| path.extension().is_some_and(|ext| ext == "app"))
            .map(std::path::Path::to_path_buf);
        match bundle {
            Some(bundle) => format!("sleep 0.3; /usr/bin/open -n \"{}\"", bundle.display()),
            None => format!("sleep 0.3; exec \"{}\"", exe.display()),
        }
    };
    #[cfg(not(target_os = "macos"))]
    let command = format!("sleep 0.3; exec \"{}\"", exe.display());

    match std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .spawn()
    {
        Ok(_) => std::process::exit(0),
        Err(error) => tracing::error!("relaunch failed to spawn: {error}"),
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{MediaAuthorization, OSPermission, RawPermissions};

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(
            options: core_foundation::dictionary::CFDictionaryRef,
        ) -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// Preflight-only, wrapped in an autoreleasepool: the poll runs this on
    /// gpui's background threads, which have no ambient NSAutoreleasePool,
    /// and AVFoundation's status query autoreleases temporaries (the same
    /// leak class `do_permissions_check` in the Tauri app plugs the same way).
    pub fn check_raw() -> RawPermissions {
        objc2::rc::autoreleasepool(|_| RawPermissions {
            screen_granted: unsafe { CGPreflightScreenCaptureAccess() },
            accessibility_granted: unsafe { AXIsProcessTrusted() },
            microphone: media_authorization(false),
            camera: media_authorization(true),
        })
    }

    pub fn request(permission: OSPermission) {
        match permission {
            // Main-thread, synchronous: the Tauri app routes both of these
            // through `run_on_main_thread`. The calls return immediately;
            // the TCC prompt itself is posted by the OS out of process.
            OSPermission::ScreenRecording => unsafe {
                let _ = CGRequestScreenCaptureAccess();
            },
            OSPermission::Accessibility => prompt_accessibility(),
            OSPermission::Microphone => request_media(false),
            OSPermission::Camera => request_media(true),
        }
    }

    fn prompt_accessibility() {
        use core_foundation::base::TCFType;
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;

        let prompt_key = CFString::new("AXTrustedCheckOptionPrompt");
        let prompt_value = CFBoolean::true_value();
        let options =
            CFDictionary::from_CFType_pairs(&[(prompt_key.as_CFType(), prompt_value.as_CFType())]);
        unsafe {
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
        }
    }

    fn media_authorization(camera: bool) -> MediaAuthorization {
        use cidre::av;

        let media = if camera {
            av::MediaType::video()
        } else {
            av::MediaType::audio()
        };
        match av::CaptureDevice::authorization_status_for_media_type(media) {
            Ok(av::AuthorizationStatus::Authorized) => MediaAuthorization::Authorized,
            Ok(av::AuthorizationStatus::NotDetermined) => MediaAuthorization::NotDetermined,
            Ok(av::AuthorizationStatus::Restricted) => MediaAuthorization::Restricted,
            Ok(av::AuthorizationStatus::Denied) => MediaAuthorization::Denied,
            Err(error) => {
                tracing::error!("querying AV permission status failed: {error}");
                MediaAuthorization::Denied
            }
        }
    }

    /// The AV request blocks until the user answers the dialog, so it gets a
    /// plain thread of its own rather than a gpui background-pool thread. The
    /// answer lands in TCC; the caller's 1s poll observes it there.
    fn request_media(camera: bool) {
        std::thread::spawn(move || {
            use cidre::av;
            let media = if camera {
                av::MediaType::video()
            } else {
                av::MediaType::audio()
            };
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                let _ = runtime.block_on(av::CaptureDevice::request_access_for_media_type(media));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(
        screen: bool,
        ax: bool,
        mic: MediaAuthorization,
        camera: MediaAuthorization,
    ) -> Option<RawPermissions> {
        Some(RawPermissions {
            screen_granted: screen,
            accessibility_granted: ax,
            microphone: mic,
            camera,
        })
    }

    #[test]
    fn permitted_matches_granted_states() {
        assert!(OSPermissionStatus::Granted.permitted());
        assert!(OSPermissionStatus::NotNeeded.permitted());
        assert!(!OSPermissionStatus::NotDetermined.permitted());
        assert!(!OSPermissionStatus::Denied.permitted());
    }

    #[test]
    fn platform_without_permissions_is_all_not_needed() {
        let check = classify(None, AttemptedFlags::default());
        for &permission in OSPermission::ALL {
            assert_eq!(check.get(permission), OSPermissionStatus::NotNeeded);
        }
        assert!(check.necessary_granted());
        assert!(check.all_permitted());
    }

    #[test]
    fn media_statuses_surface_distinctly() {
        // notDetermined must stay promptable -- never "Denied" -- regardless
        // of any attempted flag (the bug the old `initial` flag had).
        let check = classify(
            raw(
                true,
                true,
                MediaAuthorization::NotDetermined,
                MediaAuthorization::Restricted,
            ),
            AttemptedFlags {
                screen: true,
                accessibility: true,
            },
        );
        assert_eq!(check.microphone, OSPermissionStatus::NotDetermined);
        assert_eq!(check.camera, OSPermissionStatus::Denied);

        assert_eq!(
            MediaAuthorization::Authorized.status(),
            OSPermissionStatus::Granted
        );
        assert_eq!(
            MediaAuthorization::Denied.status(),
            OSPermissionStatus::Denied
        );
    }

    #[test]
    fn boolean_permissions_flip_to_denied_only_after_an_attempt() {
        let fresh = classify(
            raw(
                false,
                false,
                MediaAuthorization::NotDetermined,
                MediaAuthorization::NotDetermined,
            ),
            AttemptedFlags::default(),
        );
        assert_eq!(fresh.screen_recording, OSPermissionStatus::NotDetermined);
        assert_eq!(fresh.accessibility, OSPermissionStatus::NotDetermined);

        let attempted = classify(
            raw(
                false,
                false,
                MediaAuthorization::NotDetermined,
                MediaAuthorization::NotDetermined,
            ),
            AttemptedFlags {
                screen: true,
                accessibility: false,
            },
        );
        assert_eq!(attempted.screen_recording, OSPermissionStatus::Denied);
        assert_eq!(attempted.accessibility, OSPermissionStatus::NotDetermined);
    }

    #[test]
    fn granted_beats_attempted() {
        let check = classify(
            raw(
                true,
                true,
                MediaAuthorization::Authorized,
                MediaAuthorization::Authorized,
            ),
            AttemptedFlags {
                screen: true,
                accessibility: true,
            },
        );
        assert!(check.all_permitted());
        assert!(check.necessary_granted());
    }

    #[test]
    fn necessary_ignores_optional_permissions() {
        let check = classify(
            raw(
                true,
                true,
                MediaAuthorization::Denied,
                MediaAuthorization::NotDetermined,
            ),
            AttemptedFlags::default(),
        );
        assert!(check.necessary_granted());
        assert!(!check.all_permitted());
    }

    #[test]
    fn settings_urls_match_the_tauri_privacy_panes() {
        assert_eq!(
            OSPermission::ScreenRecording.settings_url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        );
        assert_eq!(
            OSPermission::Accessibility.settings_url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
        assert_eq!(
            OSPermission::Microphone.settings_url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        );
        assert_eq!(
            OSPermission::Camera.settings_url(),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        );
    }
}
