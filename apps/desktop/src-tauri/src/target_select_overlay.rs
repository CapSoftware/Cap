use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Mutex, PoisonError},
    time::Duration,
};

use crate::windows::{CapWindowId, ShowCapWindow};
use cap_displays::{DisplayId, WindowId, bounds::LogicalBounds};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_specta::Event;
use tokio::task::JoinHandle;

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

#[specta::specta]
#[tauri::command]
pub async fn open_target_select_overlays(app: AppHandle) -> Result<(), String> {
    let displays = cap_displays::Display::list()
        .into_iter()
        .map(|d| d.id())
        .collect::<Vec<_>>();
    for display_id in displays {
        let _ = ShowCapWindow::TargetSelectOverlay { display_id }
            .show(&app)
            .await;
    }

    #[cfg(target_os = "macos")]
    tokio::spawn(async move {
        loop {
            let display = cap_displays::Display::get_containing_cursor();
            let windows = cap_displays::Window::list_containing_cursor();

            let mut window = None;

            #[cfg(target_os = "macos")]
            {
                let mut windows_with_level = windows
                    .into_iter()
                    .filter_map(|window| {
                        let level = window.raw_handle().level()?;
                        if level > 5 {
                            return None;
                        }
                        Some((window, level))
                    })
                    .collect::<Vec<_>>();

                windows_with_level.sort_by(|a, b| b.1.cmp(&a.1));

                if windows_with_level.len() > 0 {
                    window = Some(windows_with_level.swap_remove(0).0);
                }
            }

            let _ = TargetUnderCursor {
                display_id: display.map(|d| d.id()),
                window: window.and_then(|w| {
                    Some(WindowUnderCursor {
                        id: w.id(),
                        bounds: w.raw_handle().bounds()?,
                        app_name: w.raw_handle().owner_name()?,
                    })
                }),
            }
            .emit(&app);

            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub async fn close_target_select_overlays(app: AppHandle) -> Result<(), String> {
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
                    let cap_new_main = CapWindowId::NewMain.get(app);
                    if cap_main.is_none() && cap_new_main.is_none() {
                        window.close().ok();
                        continue;
                    }

                    // If the main window is minimized or not visible, close the overlay
                    //
                    // This is a workaround for the fact that the Cap main window
                    // is minimized when opening settings, etc instead of it being
                    // closed.
                    if cap_main
                        .as_ref()
                        .and_then(|v| v.is_minimized().ok())
                        .unwrap_or_default()
                        || cap_new_main
                            .as_ref()
                            .and_then(|v| v.is_minimized().ok())
                            .unwrap_or_default()
                        || cap_main
                            .as_ref()
                            .and_then(|v| v.is_visible().map(|v| !v).ok())
                            .unwrap_or_default()
                        || cap_new_main
                            .as_ref()
                            .and_then(|v| v.is_visible().map(|v| !v).ok())
                            .unwrap_or_default()
                    {
                        window.close().ok();
                        break;
                    }

                    #[cfg(windows)]
                    {
                        let should_refocus = cap_main
                            .and_then(|w| w.is_focused().ok())
                            .unwrap_or_default()
                            || cap_new_main
                                .and_then(|w| w.is_focused().ok())
                                .unwrap_or_default()
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

    /// Called when a window is destroyed to cleanup it's task
    pub fn destroy(&self, id: &DisplayId) {
        println!("DO DESTROY"); // TODO

        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(task) = tasks.remove(&id.to_string()) {
            let _ = task.abort();
        }
    }
}
