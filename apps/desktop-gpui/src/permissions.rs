//! OS permission checks -- `src-tauri/src/permissions.rs`, without Tauri.
//!
//! macOS is the only platform that gates onboarding on these. Windows and
//! Linux return [`OSPermissionStatus::NotNeeded`] for every row, matching
//! `do_permissions_check` over there.

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

    pub fn description(self) -> &'static str {
        match self {
            Self::ScreenRecording => {
                "Cap needs screen recording access to capture your display. You may need to restart Cap after granting this."
            }
            Self::Accessibility => {
                "Cap uses accessibility access to track mouse activity for automatic zoom segments."
            }
            Self::Microphone => "Optional. Needed to record microphone audio.",
            Self::Camera => "Optional. Needed to include your webcam in recordings.",
        }
    }

    pub fn required(self) -> bool {
        matches!(self, Self::ScreenRecording | Self::Accessibility)
    }

    pub fn icon(self) -> &'static str {
        match self {
            Self::ScreenRecording => "icons/monitor.svg",
            Self::Accessibility => "icons/cursor.svg",
            Self::Microphone => "icons/microphone.svg",
            Self::Camera => "icons/camera.svg",
        }
    }

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
    NotNeeded,
    Empty,
    Granted,
    Denied,
}

impl OSPermissionStatus {
    pub fn permitted(self) -> bool {
        matches!(self, Self::Granted | Self::NotNeeded)
    }
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
}

pub fn necessary_granted() -> bool {
    do_permissions_check(false).necessary_granted()
}

pub fn do_permissions_check(initial: bool) -> OSPermissionsCheck {
    #[cfg(target_os = "macos")]
    {
        macos::check(initial)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = initial;
        OSPermissionsCheck {
            screen_recording: OSPermissionStatus::NotNeeded,
            accessibility: OSPermissionStatus::NotNeeded,
            microphone: OSPermissionStatus::NotNeeded,
            camera: OSPermissionStatus::NotNeeded,
        }
    }
}

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

#[cfg(target_os = "macos")]
mod macos {
    use super::{OSPermission, OSPermissionStatus, OSPermissionsCheck};

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

    pub fn check(initial: bool) -> OSPermissionsCheck {
        OSPermissionsCheck {
            screen_recording: screen_status(initial),
            accessibility: accessibility_status(initial),
            microphone: media_status(false, initial),
            camera: media_status(true, initial),
        }
    }

    pub fn request(permission: OSPermission) {
        match permission {
            OSPermission::ScreenRecording => unsafe {
                let _ = CGRequestScreenCaptureAccess();
            },
            OSPermission::Accessibility => prompt_accessibility(),
            OSPermission::Microphone => request_media(false),
            OSPermission::Camera => request_media(true),
        }
    }

    fn classify(granted: bool, initial: bool) -> OSPermissionStatus {
        if granted {
            OSPermissionStatus::Granted
        } else if initial {
            OSPermissionStatus::Empty
        } else {
            OSPermissionStatus::Denied
        }
    }

    fn screen_status(initial: bool) -> OSPermissionStatus {
        classify(unsafe { CGPreflightScreenCaptureAccess() }, initial)
    }

    fn accessibility_status(initial: bool) -> OSPermissionStatus {
        classify(unsafe { AXIsProcessTrusted() }, initial)
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

    fn media_status(camera: bool, initial: bool) -> OSPermissionStatus {
        use cidre::av;

        let media = if camera {
            av::MediaType::video()
        } else {
            av::MediaType::audio()
        };
        match av::CaptureDevice::authorization_status_for_media_type(media) {
            Ok(av::AuthorizationStatus::Authorized) => OSPermissionStatus::Granted,
            Ok(av::AuthorizationStatus::NotDetermined) => {
                if initial {
                    OSPermissionStatus::Empty
                } else {
                    OSPermissionStatus::Denied
                }
            }
            Ok(_) | Err(_) => OSPermissionStatus::Denied,
        }
    }

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
