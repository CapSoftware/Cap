use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Mutex, PoisonError},
    time::Duration,
};

use base64::prelude::*;

use crate::windows::{CapWindowId, ShowCapWindow};
use cap_displays::{
    DisplayId, WindowId,
    bounds::{LogicalBounds, PhysicalSize},
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcut, GlobalShortcutExt};
use tauri_specta::Event;
use tokio::task::JoinHandle;
use tracing::error;

#[derive(tauri_specta::Event, Serialize, Type, Clone)]
pub struct TargetUnderCursor {
    display_id: Option<DisplayId>,
    window: Option<WindowUnderCursor>,
    screen: Option<ScreenUnderCursor>,
}

#[derive(Serialize, Type, Clone)]
pub struct WindowUnderCursor {
    id: WindowId,
    app_name: String,
    bounds: LogicalBounds,
    icon: Option<String>,
}

#[derive(Serialize, Type, Clone)]
pub struct ScreenUnderCursor {
    name: String,
    physical_size: PhysicalSize,
    refresh_rate: String,
}

#[specta::specta]
#[tauri::command]
pub async fn open_target_select_overlays(
    app: AppHandle,
    state: tauri::State<'_, WindowFocusManager>,
) -> Result<(), String> {
    let displays = cap_displays::Display::list()
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
                let display = cap_displays::Display::get_containing_cursor();
                let window = cap_displays::Window::get_topmost_at_cursor();

                let _ = TargetUnderCursor {
                    display_id: display.map(|d| d.id()),
                    window: window.and_then(|w| {
                        Some(WindowUnderCursor {
                            id: w.id(),
                            bounds: w.bounds()?,
                            app_name: w.owner_name()?,
                            icon: w.app_icon().map(|bytes| {
                                format!("data:image/png;base64,{}", BASE64_STANDARD.encode(&bytes))
                            }),
                        })
                    }),
                    screen: display.map(|d| ScreenUnderCursor {
                        name: d.name(),
                        physical_size: d.physical_size(),
                        refresh_rate: d.refresh_rate().to_string(),
                    }),
                }
                .emit(&app);

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
pub async fn close_target_select_overlays(
    app: AppHandle,
    // state: tauri::State<'_, WindowFocusManager>,
) -> Result<(), String> {
    for (id, window) in app.webview_windows() {
        if let Ok(CapWindowId::TargetSelectOverlay { .. }) = CapWindowId::from_str(&id) {
            let _ = window.close();
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
                    let Some(cap_main) = CapWindowId::Main.get(app) else {
                        window.close().ok();
                        break;
                    };

                    // If the main window is minimized or not visible, close the overlay
                    //
                    // This is a workaround for the fact that the Cap main window
                    // is minimized when opening settings, etc instead of it being
                    // closed.
                    if cap_main.is_minimized().ok().unwrap_or_default()
                        || cap_main.is_visible().map(|v| !v).ok().unwrap_or_default()
                    {
                        window.close().ok();
                        break;
                    }

                    #[cfg(windows)]
                    {
                        let should_refocus = cap_main.is_focused().ok().unwrap_or_default()
                            || window.is_focused().unwrap_or_default();

                        // If a Cap window is not focused we know something is trying to steal the focus.
                        // We need to move the overlay above it. We don't use `always_on_top` on the overlay because we need the Cap window to stay above it.
                        if !should_refocus {
                            window.set_focus().ok();
                        }
                    }

                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
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
