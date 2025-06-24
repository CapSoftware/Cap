use std::{str::FromStr, time::Duration};

use crate::windows::{CapWindowId, ShowCapWindow};
use cap_displays::DisplayId;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

#[derive(tauri_specta::Event, Serialize, Type, Clone)]
pub struct DisplayUnderCursorChanged {
    display_id: Option<DisplayId>,
}

#[specta::specta]
#[tauri::command]
pub async fn open_target_select_overlays(app: AppHandle) -> Result<(), String> {
    println!("OPEN SELECT OVERLAYS");
    for display in cap_displays::Display::list() {
        let _ = ShowCapWindow::TargetSelectOverlay {
            display_id: display.raw_id(),
        }
        .show(&app)
        .await;
    }

    tokio::spawn(async move {
        let mut selected_display = None;

        loop {
            let display = cap_displays::Display::get_at_cursor();

            if let Some(display) = display {
                if selected_display.replace(display).map(|v| v.raw_id()) != Some(display.raw_id()) {
                    let _ = DisplayUnderCursorChanged {
                        display_id: Some(display.raw_id()),
                    }
                    .emit(&app);
                }
            } else {
                if selected_display.take().map(|v| v.raw_id()) != None {
                    let _ = DisplayUnderCursorChanged { display_id: None }.emit(&app);
                }
            }

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
