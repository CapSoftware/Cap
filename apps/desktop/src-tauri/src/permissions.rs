use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindow, Wry};

#[cfg(target_os = "macos")]
use nokhwa_bindings_macos::{AVAuthorizationStatus, AVMediaType};

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OSPermission {
    ScreenRecording,
    Camera,
    Microphone,
}

#[tauri::command(async)]
#[specta::specta]
pub fn open_permission_settings(permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        match permission {
            OSPermission::ScreenRecording => {
                Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                    .spawn()
                    .expect("Failed to open Screen Recording settings");
            }
            OSPermission::Camera => {
                Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
                    .spawn()
                    .expect("Failed to open Camera settings");
            }
            OSPermission::Microphone => {
                Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
                    .spawn()
                    .expect("Failed to open Microphone settings");
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn request_permission(permission: OSPermission) {
    #[cfg(target_os = "macos")]
    {
        match permission {
            OSPermission::ScreenRecording => {
                scap::request_permission();
            }
            OSPermission::Camera => request_av_permission(AVMediaType::Video),
            OSPermission::Microphone => request_av_permission(AVMediaType::Audio),
        }
    }
}

#[cfg(target_os = "macos")]
fn request_av_permission(media_type: AVMediaType) {
    use objc::{runtime::*, *};
    use tauri_nspanel::block::ConcreteBlock;

    let callback = move |_: BOOL| {};
    let cls = class!(AVCaptureDevice);
    let objc_fn_block: ConcreteBlock<(BOOL,), (), _> = ConcreteBlock::new(callback);
    let objc_fn_pass = objc_fn_block.copy();
    unsafe {
        let _: () = msg_send![cls, requestAccessForMediaType:media_type.into_ns_str() completionHandler:objc_fn_pass];
    };
}

#[derive(Serialize, Deserialize, Debug, specta::Type)]
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
        match self {
            Self::NotNeeded | Self::Granted => true,
            _ => false,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OSPermissionsCheck {
    pub screen_recording: OSPermissionStatus,
    pub microphone: OSPermissionStatus,
    pub camera: OSPermissionStatus,
}

impl OSPermissionsCheck {
    pub fn necessary_granted(&self) -> bool {
        self.screen_recording.permitted() && self.microphone.permitted() && self.camera.permitted()
    }
}

#[tauri::command(async)]
#[specta::specta]
pub fn do_permissions_check(initial_check: bool) -> OSPermissionsCheck {
    #[cfg(target_os = "macos")]
    {
        OSPermissionsCheck {
            screen_recording: {
                let result = scap::has_permission();
                match (result, initial_check) {
                    (true, _) => OSPermissionStatus::Granted,
                    (false, true) => OSPermissionStatus::Empty,
                    (false, false) => OSPermissionStatus::Denied,
                }
            },
            microphone: check_av_permission(AVMediaType::Audio),
            camera: check_av_permission(AVMediaType::Video),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        OSPermissionsCheck {
            screen_recording: OSPermissionStatus::NotNeeded,
            microphone: OSPermissionStatus::NotNeeded,
            camera: OSPermissionStatus::NotNeeded,
        };
    }
}

#[cfg(target_os = "macos")]
pub fn check_av_permission(media_type: AVMediaType) -> OSPermissionStatus {
    use objc::*;

    let cls = objc::class!(AVCaptureDevice);
    let status: AVAuthorizationStatus =
        unsafe { msg_send![cls, authorizationStatusForMediaType:media_type.into_ns_str()] };
    match status {
        AVAuthorizationStatus::NotDetermined => OSPermissionStatus::Empty,
        AVAuthorizationStatus::Authorized => OSPermissionStatus::Granted,
        _ => OSPermissionStatus::Denied,
    }
}

#[tauri::command(async)]
#[specta::specta]
pub fn open_permissions_window(app: &impl Manager<Wry>) {
    if let Some(window) = app.get_webview_window("permissions") {
        window.set_focus().ok();
        return;
    }

    WebviewWindow::builder(app, "permissions", WebviewUrl::App("/permissions".into()))
        .title("Cap")
        .inner_size(300.0, 256.0)
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
