use cap_media::platform::Bounds;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::{sync::RwLock, time::sleep};

pub struct FakeWindowBounds(pub Arc<RwLock<HashMap<String, HashMap<String, Bounds>>>>);

#[tauri::command]
#[specta::specta]
pub async fn set_fake_window_bounds(
    window: tauri::Window,
    name: String,
    bounds: Bounds,
    state: tauri::State<'_, FakeWindowBounds>,
) -> Result<(), String> {
    let mut state = state.0.write().await;
    let map = state.entry(window.label().to_string()).or_default();

    map.insert(name, bounds);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn remove_fake_window(
    window: tauri::Window,
    name: String,
    state: tauri::State<'_, FakeWindowBounds>,
) -> Result<(), String> {
    let mut state = state.0.write().await;
    let Some(map) = state.get_mut(window.label()) else {
        return Ok(());
    };

    map.remove(&name);

    if map.is_empty() {
        state.remove(window.label());
    }

    Ok(())
}

pub fn spawn_fake_window_listener(app: AppHandle, window: WebviewWindow) {
    tokio::spawn(async move {
        let state = app.state::<FakeWindowBounds>();

        loop {
            sleep(Duration::from_millis(1000 / 20)).await;

            let map = state.0.read().await;
            let Some(windows) = map.get(window.label()) else {
                window.set_ignore_cursor_events(true).ok();
                continue;
            };

            let window_position = window.outer_position().unwrap();
            let mouse_position = window.cursor_position().unwrap();
            let scale_factor = window.scale_factor().unwrap();

            let mut ignore = true;

            for bounds in windows.values() {
                let x_min = (window_position.x as f64) + bounds.x * scale_factor;
                let x_max = (window_position.x as f64) + (bounds.x + bounds.width) * scale_factor;
                let y_min = (window_position.y as f64) + bounds.y * scale_factor;
                let y_max = (window_position.y as f64) + (bounds.y + bounds.height) * scale_factor;

                if mouse_position.x >= x_min
                    && mouse_position.x <= x_max
                    && mouse_position.y >= y_min
                    && mouse_position.y <= y_max
                {
                    ignore = false;
                    // ShowCapturesPanel.emit(&app).ok();
                    break;
                }
            }

            window.set_ignore_cursor_events(ignore).ok();

            let focused = window.is_focused().unwrap_or(false);
            if !ignore {
                if !focused {
                    window.set_focus().ok();
                }
            } else if focused {
                window.set_ignore_cursor_events(ignore).ok();
            }
        }
    });
}
