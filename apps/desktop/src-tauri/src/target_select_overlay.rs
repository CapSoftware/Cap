use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Mutex, PoisonError},
    time::Duration,
};

use base64::prelude::*;
use cap_recording::screen_capture::ScreenCaptureTarget;

use crate::windows::{CapWindowId, ShowCapWindow};
use scap_targets::{
    Display, DisplayId, Window, WindowId,
    bounds::{LogicalBounds, PhysicalSize},
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcut, GlobalShortcutExt};
use tauri_specta::Event;
use tokio::task::JoinHandle;
use tracing::{error, instrument};

#[derive(tauri_specta::Event, Serialize, Type, Clone)]
pub struct TargetUnderCursor {
    display_id: Option<DisplayId>,
    window: Option<WindowUnderCursor>,
}

#[derive(Serialize, Type, Clone)]
pub struct WindowUnderCursor {
    id: WindowId,
    app_name: String,
    bounds: LogicalBounds,
}

#[derive(Serialize, Type, Clone)]
pub struct DisplayInformation {
    name: Option<String>,
    physical_size: Option<PhysicalSize>,
    refresh_rate: String,
}

#[specta::specta]
#[tauri::command]
#[instrument(skip(app, state))]
pub async fn open_target_select_overlays(
    app: AppHandle,
    state: tauri::State<'_, WindowFocusManager>,
    focused_target: Option<ScreenCaptureTarget>,
) -> Result<(), String> {
    let displays = scap_targets::Display::list()
        .into_iter()
        .map(|d| d.id())
        .collect::<Vec<_>>();
    for display_id in displays {
        let _ = ShowCapWindow::TargetSelectOverlay { display_id }
            .show(&app)
            .await;
    }

    let handle = tokio::spawn({
        let app = app.clone();

        async move {
            loop {
                {
                    let display = focused_target
                        .as_ref()
                        .map(|v| v.display())
                        .unwrap_or_else(scap_targets::Display::get_containing_cursor);
                    let window = focused_target
                        .as_ref()
                        .map(|v| v.window().and_then(|id| scap_targets::Window::from_id(&id)))
                        .unwrap_or_else(scap_targets::Window::get_topmost_at_cursor);

                    let _ = TargetUnderCursor {
                        display_id: display.map(|d| d.id()),
                        window: window.and_then(|w| {
                            Some(WindowUnderCursor {
                                id: w.id(),
                                bounds: w.display_relative_logical_bounds()?,
                                app_name: w.owner_name()?,
                            })
                        }),
                    }
                    .emit(&app);
                }

                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    });

    if let Some(task) = state
        .task
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .replace(handle)
    {
        task.abort();
    } else {
        // If task is already set we know we have already registered this.
        app.global_shortcut()
            .register("Escape")
            .map_err(|err| error!("Error registering global keyboard shortcut for Escape: {err}"))
            .ok();
    }

    Ok(())
}

#[specta::specta]
#[tauri::command]
#[instrument(skip(app))]
pub async fn close_target_select_overlays(app: AppHandle) -> Result<(), String> {
    for (id, window) in app.webview_windows() {
        if let Ok(CapWindowId::TargetSelectOverlay { .. }) = CapWindowId::from_str(&id) {
            let _ = window.close();
        }
    }

    Ok(())
}

#[specta::specta]
#[tauri::command]
#[instrument]
pub async fn get_window_icon(window_id: &str) -> Result<Option<String>, String> {
    let window_id = window_id
        .parse::<WindowId>()
        .map_err(|err| format!("Invalid window ID: {err}"))?;

    Ok(Window::from_id(&window_id)
        .ok_or("Window not found")?
        .app_icon()
        .map(|bytes| format!("data:image/png;base64,{}", BASE64_STANDARD.encode(&bytes))))
}

#[specta::specta]
#[tauri::command]
#[instrument]
pub async fn display_information(display_id: &str) -> Result<DisplayInformation, String> {
    let display_id = display_id
        .parse::<DisplayId>()
        .map_err(|err| format!("Invalid display ID: {err}"))?;
    let display = Display::from_id(&display_id).ok_or("Display not found")?;

    Ok(DisplayInformation {
        name: display.name(),
        physical_size: display.physical_size(),
        refresh_rate: display.refresh_rate().to_string(),
    })
}

#[specta::specta]
#[tauri::command]
#[instrument]
pub async fn focus_window(window_id: WindowId) -> Result<(), String> {
    let window = Window::from_id(&window_id).ok_or("Window not found")?;

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

        let pid = window
            .raw_handle()
            .owner_pid()
            .ok_or("Could not get window owner PID")?;

        if let Some(app) =
            unsafe { NSRunningApplication::runningApplicationWithProcessIdentifier(pid) }
        {
            unsafe {
                app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowPlacement, IsIconic, SW_RESTORE, SetForegroundWindow, SetWindowPlacement,
            ShowWindow, WINDOWPLACEMENT,
        };

        let hwnd = window.raw_handle().inner();

        unsafe {
            // Only restore if the window is actually minimized
            if IsIconic(hwnd).as_bool() {
                // Get current window placement to preserve size/position
                let mut wp = WINDOWPLACEMENT::default();
                wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;

                if GetWindowPlacement(hwnd, &mut wp).is_ok() {
                    // Restore using the previous placement to avoid resizing
                    wp.showCmd = SW_RESTORE.0 as u32;
                    let _ = SetWindowPlacement(hwnd, &wp);
                } else {
                    // Fallback to simple restore if placement fails
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
            }

            // Always try to bring to foreground
            let _ = SetForegroundWindow(hwnd);
        }
    }

    Ok(())
}

// Windows doesn't have a proper concept of window z-index's so we implement them in userspace :(
#[derive(Default)]
pub struct WindowFocusManager {
    task: Mutex<Option<JoinHandle<()>>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl WindowFocusManager {
    /// Called when a window is created to spawn it's task
    pub fn spawn(&self, id: &DisplayId, window: WebviewWindow) {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        tasks.insert(
            id.to_string(),
            tokio::spawn(async move {
                let app = window.app_handle();
                loop {
                    let cap_main = CapWindowId::Main.get(app);
                    let cap_settings = CapWindowId::Settings.get(app);

                    let has_cap_main = cap_main
                        .as_ref()
                        .and_then(|v| Some(v.is_minimized().ok()? || !v.is_visible().ok()?))
                        .unwrap_or(true);
                    let has_cap_settings = cap_settings
                        .and_then(|v| Some(v.is_minimized().ok()? || !v.is_visible().ok()?))
                        .unwrap_or(true);

                    // Close the overlay if the cap main and settings are not available.
                    if has_cap_main && has_cap_settings {
                        window.hide().ok();
                        break;
                    }

                    #[cfg(windows)]
                    if let Some(cap_main) = cap_main {
                        let should_refocus = cap_main.is_focused().ok().unwrap_or_default()
                            || window.is_focused().unwrap_or_default();

                        // If a Cap window is not focused we know something is trying to steal the focus.
                        // We need to move the overlay above it. We don't use `always_on_top` on the overlay because we need the Cap window to stay above it.
                        if !should_refocus {
                            window.set_focus().ok();
                        }
                    }

                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            }),
        );
    }

    /// Called when a specific overlay window is destroyed to cleanup it's resources
    pub fn destroy<R: tauri::Runtime>(&self, id: &DisplayId, global_shortcut: &GlobalShortcut<R>) {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(task) = tasks.remove(&id.to_string()) {
            task.abort();
        }

        // When all overlay windows are closed cleanup shared resources.
        if tasks.is_empty() {
            // Unregister keyboard shortcut
            // This messes with other applications if we don't remove it.
            global_shortcut
                .unregister("Escape")
                .map_err(|err| {
                    error!("Error unregistering global keyboard shortcut for Escape: {err}")
                })
                .ok();

            // Shutdown the cursor tracking task
            if let Some(task) = self
                .task
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
            {
                task.abort();
            }
        }
    }
}
