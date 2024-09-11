use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindow, Wry};

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MacOSPermissionSettings {
    ScreenRecording,
    Camera,
    Microphone,
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OSPermissionSettings {
    MacOS(MacOSPermissionSettings),
}

#[tauri::command]
#[specta::specta]
pub fn open_permission_settings(settings: OSPermissionSettings) {
    match settings {
        OSPermissionSettings::MacOS(macos) => match macos {
            MacOSPermissionSettings::ScreenRecording => {
                Command::new("open")
					.arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
					.spawn()
					.expect("Failed to open Screen Recording settings");
            }
            MacOSPermissionSettings::Camera => {
                Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
                    .spawn()
                    .expect("Failed to open Camera settings");
            }
            MacOSPermissionSettings::Microphone => {
                Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
                    .spawn()
                    .expect("Failed to open Microphone settings");
            }
        },
    }
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MacOSPermissionsCheck {
    screen_recording: bool,
    microphone: bool,
    camera: bool,
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "os")]
pub enum OSPermissionsCheck {
    MacOS(MacOSPermissionsCheck),
    Other,
}

impl OSPermissionsCheck {
    pub fn necessary_granted(&self) -> bool {
        match self {
            Self::MacOS(macos) => macos.screen_recording && macos.microphone && macos.camera,
            Self::Other => true,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn do_permissions_check() -> OSPermissionsCheck {
    #[cfg(target_os = "macos")]
    {
        OSPermissionsCheck::MacOS(MacOSPermissionsCheck {
            screen_recording: scap::has_permission(),
            microphone: {
                use nokhwa_bindings_macos::{AVAuthorizationStatus, AVMediaType};
                use objc::*;

                let cls = objc::class!(AVCaptureDevice);
                let status: AVAuthorizationStatus = unsafe {
                    msg_send![cls, authorizationStatusForMediaType:AVMediaType::Audio.into_ns_str()]
                };
                matches!(status, AVAuthorizationStatus::Authorized)
            },
            camera: {
                use nokhwa_bindings_macos::{AVAuthorizationStatus, AVMediaType};
                use objc::*;

                let cls = objc::class!(AVCaptureDevice);
                let status: AVAuthorizationStatus = unsafe {
                    msg_send![cls, authorizationStatusForMediaType:AVMediaType::Video.into_ns_str()]
                };
                matches!(status, AVAuthorizationStatus::Authorized)
            },
        })
    }

    #[cfg(not(target_os = "macos"))]
    OSpermissiosCheck::Other
}

#[tauri::command]
#[specta::specta]
pub fn open_permissions_window(app: &impl Manager<Wry>) {
    if let Some(window) = app.get_webview_window("permissions") {
        window.set_focus().ok();
        return;
    }

    WebviewWindow::builder(app, "permissions", WebviewUrl::App("/permissions".into()))
        .title("Cap")
        .inner_size(300.0, 325.0)
        .resizable(false)
        .maximized(false)
        .shadow(true)
        .accept_first_mouse(true)
        .transparent(true)
        .hidden_title(true)
        .decorations(false)
        .build()
        .ok();
}
