use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindow, Wry};
use tauri_plugin_decorum::WebviewWindowExt;

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MacOSPermissionSettings {
    ScreenRecording,
    // Accessibility,
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
            } //    MacOSPermissionSettings::Accessibility => {
              //        Command::new("open")
              // .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
              // .spawn()
              // .expect("Failed to open Accessibility settings");
              //    }
        },
    }
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MacOSPermissionsCheck {
    screen_recording: bool,
}

#[derive(Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "os")]
pub enum OSPermissionsCheck {
    MacOS(MacOSPermissionsCheck),
    Other
}

impl OSPermissionsCheck {
    pub fn necessary_granted(&self) -> bool {
        match self {
            Self::MacOS(macos) => macos.screen_recording,
            Self::Other => true
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
        .title("Cap Permissions")
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
