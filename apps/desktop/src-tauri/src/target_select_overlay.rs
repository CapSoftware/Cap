use std::{str::FromStr, time::Duration};

use crate::windows::{CapWindowId, ShowCapWindow};
use cap_displays::{bounds::LogicalBounds, DisplayId, WindowId};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

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
    println!("OPEN SELECT OVERLAYS");
    for display in cap_displays::Display::list() {
        let _ = ShowCapWindow::TargetSelectOverlay {
            display_id: display.id(),
        }
        .show(&app)
        .await;
    }

    #[cfg(target_os = "macos")]
    tokio::spawn(async move {
        loop {
            let display = cap_displays::Display::get_containing_cursor();
            let mut windows = cap_displays::Window::list_containing_cursor();

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
    println!("CLOSE SELECT OVERLAYS");

    for (id, window) in app.webview_windows() {
        if let Ok(CapWindowId::TargetSelectOverlay { .. }) = CapWindowId::from_str(&id) {
            let _ = window.close();
        }
    }

    Ok(())
}
