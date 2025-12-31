use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use cidre::av;
use tracing::instrument;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
    -> bool;
}

#[derive(Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OSPermission {
    ScreenRecording,
    Camera,
    Microphone,
    Accessibility,
}

#[tauri::command(async)]
#[specta::specta]
pub fn open_permission_settings(_permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let mut process = match _permission {
            OSPermission::ScreenRecording => Command::new("open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                )
                .spawn()
                .expect("Failed to open Screen Recording settings"),
            OSPermission::Camera => Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
                .spawn()
                .expect("Failed to open Camera settings"),
            OSPermission::Microphone => Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
                .spawn()
                .expect("Failed to open Microphone settings"),
            OSPermission::Accessibility => Command::new("open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                )
                .spawn()
                .expect("Failed to open Accessibility settings"),
        };

        // https://doc.rust-lang.org/stable/std/process/struct.Child.html#warning
        tokio::spawn(async move {
            let _ = process.wait().map_err(|err| {
                tracing::error!("Error waiting for accessibility child process: {err}")
            });
        });
    }
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn request_permission(_permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        use futures::executor::block_on;
        use std::thread;

        match _permission {
            OSPermission::ScreenRecording => {
                #[cfg(target_os = "macos")]
                scap_screencapturekit::request_permission();
            }
            OSPermission::Camera => {
                thread::spawn(|| {
                    block_on(av::CaptureDevice::request_access_for_media_type(
                        av::MediaType::video(),
                    ))
                    .ok();
                });
            }
            OSPermission::Microphone => {
                thread::spawn(|| {
                    block_on(av::CaptureDevice::request_access_for_media_type(
                        av::MediaType::audio(),
                    ))
                    .ok();
                });
            }
            OSPermission::Accessibility => {
                use core_foundation::base::TCFType;
                use core_foundation::dictionary::CFDictionary; // Import CFDictionaryRef
                use core_foundation::string::CFString;

                let prompt_key = CFString::new("AXTrustedCheckOptionPrompt");
                let prompt_value = core_foundation::boolean::CFBoolean::true_value();

                let options = CFDictionary::from_CFType_pairs(&[(
                    prompt_key.as_CFType(),
                    prompt_value.as_CFType(),
                )]);

                unsafe {
                    AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
                }
            }
        }
    }
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
        use cidre::av::{AuthorizationStatus, CaptureDevice, MediaType};

        fn check_av_permission(media_type: &'static MediaType) -> OSPermissionStatus {
            let status = CaptureDevice::authorization_status_for_media_type(media_type).unwrap();

            match status {
                AuthorizationStatus::NotDetermined => OSPermissionStatus::Empty,
                AuthorizationStatus::Authorized => OSPermissionStatus::Granted,
                _ => OSPermissionStatus::Denied,
            }
        }

        OSPermissionsCheck {
            screen_recording: {
                let result = scap_screencapturekit::has_permission();
                match (result, _initial_check) {
                    (true, _) => OSPermissionStatus::Granted,
                    (false, true) => OSPermissionStatus::Empty,
                    (false, false) => OSPermissionStatus::Denied,
                }
            },
            microphone: check_av_permission(MediaType::audio()),
            camera: check_av_permission(MediaType::video()),
            accessibility: if unsafe { AXIsProcessTrusted() } {
                OSPermissionStatus::Granted
            } else {
                OSPermissionStatus::Denied
            },
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
