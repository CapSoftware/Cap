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
        let mut last_ignore_state = true;

        loop {
            sleep(Duration::from_millis(1000 / 20)).await;

            let window_position = match window.outer_position() {
                Ok(pos) => pos,
                Err(_) => continue,
            };

            let mouse_position = match window.cursor_position() {
                Ok(pos) => pos,
                Err(_) => continue,
            };

            let scale_factor = match window.scale_factor() {
                Ok(scale) => scale,
                Err(_) => continue,
            };

            let map = state.0.read().await;
            let windows = match map.get(window.label()) {
                Some(windows) => windows,
                None => {
                    if !last_ignore_state {
                        window.set_ignore_cursor_events(true).ok();
                        last_ignore_state = true;
                    }
                    continue;
                }
            };

            let mut should_ignore = true;

            for bounds in windows.values() {
                let x_min = window_position.x as f64 + bounds.x * scale_factor;
                let x_max = window_position.x as f64 + (bounds.x + bounds.width) * scale_factor;
                let y_min = window_position.y as f64 + bounds.y * scale_factor;
                let y_max = window_position.y as f64 + (bounds.y + bounds.height) * scale_factor;

                const PADDING: f64 = 2.0;
                if mouse_position.x >= (x_min - PADDING)
                    && mouse_position.x <= (x_max + PADDING)
                    && mouse_position.y >= (y_min - PADDING)
                    && mouse_position.y <= (y_max + PADDING)
                {
                    should_ignore = false;
                    break;
                }
            }

            if should_ignore != last_ignore_state {
                window.set_ignore_cursor_events(should_ignore).ok();

                if !should_ignore {
                    if !window.is_focused().unwrap_or(false) {
                        window.set_focus().ok();
                    }
                }

                last_ignore_state = should_ignore;
            }

            if !should_ignore && !window.is_focused().unwrap_or(false) {
                window.set_focus().ok();
            }
        }
    });
}
