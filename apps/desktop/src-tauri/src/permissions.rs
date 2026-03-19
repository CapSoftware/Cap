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

        let process = match _permission {
            OSPermission::ScreenRecording => Command::new("open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                )
                .spawn(),
            OSPermission::Camera => Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
                .spawn(),
            OSPermission::Microphone => Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
                .spawn(),
            OSPermission::Accessibility => Command::new("open")
                .arg(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                )
                .spawn(),
        };

        match process {
            Ok(mut process) => {
                tokio::spawn(async move {
                    let _ = process.wait().map_err(|err| {
                        tracing::error!("Error waiting for permission settings process: {err}")
                    });
                });
            }
            Err(err) => {
                tracing::error!("Failed to open permission settings: {err}");
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_app))]
pub async fn request_permission(_app: tauri::AppHandle, _permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        let needs_activation =
            matches!(_permission, OSPermission::Camera | OSPermission::Microphone);

        if needs_activation {
            if let Err(err) = _app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                tracing::warn!("Failed to set activation policy to Regular: {err}");
            }
        }

        match _permission {
            OSPermission::ScreenRecording => {
                scap_screencapturekit::request_permission();
            }
            OSPermission::Camera => {
                tauri::async_runtime::spawn_blocking(|| {
                    futures::executor::block_on(av::CaptureDevice::request_access_for_media_type(
                        av::MediaType::video(),
                    ))
                    .ok();
                })
                .await
                .ok();
            }
            OSPermission::Microphone => {
                tauri::async_runtime::spawn_blocking(|| {
                    futures::executor::block_on(av::CaptureDevice::request_access_for_media_type(
                        av::MediaType::audio(),
                    ))
                    .ok();
                })
                .await
                .ok();
            }
            OSPermission::Accessibility => {
                use core_foundation::base::TCFType;
                use core_foundation::dictionary::CFDictionary;
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

        if needs_activation {
            if let Err(err) = _app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
                tracing::warn!("Failed to restore activation policy to Accessory: {err}");
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
            match CaptureDevice::authorization_status_for_media_type(media_type) {
                Ok(AuthorizationStatus::NotDetermined) => OSPermissionStatus::Empty,
                Ok(AuthorizationStatus::Authorized) => OSPermissionStatus::Granted,
                Ok(_) => OSPermissionStatus::Denied,
                Err(err) => {
                    tracing::error!("Failed to query AV permission status: {err}");
                    OSPermissionStatus::Denied
                }
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
