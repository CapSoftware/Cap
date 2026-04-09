use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use scap_targets::{Display, DisplayId, Window as ScapWindow, bounds::LogicalBounds};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::{sync::RwLock, time::sleep};
use tracing::instrument;

use crate::{App, ArcLock, RecordingState};

const RECORDING_CONTROLS_LABEL: &str = "in-progress-recording";
const RECORDING_CONTROLS_WIDTH: f64 = 320.0;
const RECORDING_CONTROLS_HEIGHT: f64 = 150.0;
const RECORDING_CONTROLS_OFFSET_Y: f64 = 120.0;

pub struct FakeWindowBounds(pub Arc<RwLock<HashMap<String, HashMap<String, LogicalBounds>>>>);

#[tauri::command]
#[specta::specta]
#[instrument(skip(state))]
pub async fn set_fake_window_bounds(
    window: tauri::Window,
    name: String,
    bounds: LogicalBounds,
    state: tauri::State<'_, FakeWindowBounds>,
) -> Result<(), String> {
    let mut state = state.0.write().await;
    let map = state.entry(window.label().to_string()).or_default();

    map.insert(name, bounds);

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(state, window))]
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

fn get_display_id_for_cursor() -> Option<DisplayId> {
    Display::get_containing_cursor().map(|d| d.id())
}

fn get_display_by_id(id: &DisplayId) -> Option<Display> {
    Display::list().into_iter().find(|d| &d.id() == id)
}

fn calculate_bottom_center_position(display: &Display) -> Option<(f64, f64)> {
    let bounds = display.raw_handle().logical_bounds()?;
    let x = bounds.position().x();
    let y = bounds.position().y();
    let width = bounds.size().width();
    let height = bounds.size().height();

    let pos_x = x + (width - RECORDING_CONTROLS_WIDTH) / 2.0;
    let pos_y = y + height - RECORDING_CONTROLS_HEIGHT - RECORDING_CONTROLS_OFFSET_Y;
    Some((pos_x, pos_y))
}

const TARGET_CONTROLS_OFFSET_Y: f64 = 48.0;

pub fn calculate_recording_controls_position_for_target(
    capture_target: &ScreenCaptureTarget,
) -> Option<(f64, f64)> {
    match capture_target {
        ScreenCaptureTarget::Window { id } => {
            let window = ScapWindow::from_id(id)?;
            let bounds = window.raw_handle().logical_bounds()?;
            let pos_x =
                bounds.position().x() + (bounds.size().width() - RECORDING_CONTROLS_WIDTH) / 2.0;
            let pos_y = bounds.position().y() + bounds.size().height()
                - RECORDING_CONTROLS_HEIGHT
                - TARGET_CONTROLS_OFFSET_Y;
            Some((pos_x, pos_y))
        }
        ScreenCaptureTarget::Area { screen, bounds } => {
            let display = Display::from_id(screen)?;
            let display_bounds = display.raw_handle().logical_bounds()?;
            let abs_x = display_bounds.position().x() + bounds.position().x();
            let abs_y = display_bounds.position().y() + bounds.position().y();
            let pos_x = abs_x + (bounds.size().width() - RECORDING_CONTROLS_WIDTH) / 2.0;
            let pos_y = abs_y + bounds.size().height()
                - RECORDING_CONTROLS_HEIGHT
                - TARGET_CONTROLS_OFFSET_Y;
            Some((pos_x, pos_y))
        }
        _ => None,
    }
}

pub fn spawn_fake_window_listener(app: AppHandle, window: WebviewWindow) {
    window.set_ignore_cursor_events(true).ok();

    let is_recording_controls = window.label() == RECORDING_CONTROLS_LABEL;

    tokio::spawn(async move {
        let state = app.state::<FakeWindowBounds>();
        let mut current_display_id: Option<DisplayId> = get_display_id_for_cursor();
        let mut last_target_pos: Option<(f64, f64)> = None;

        loop {
            sleep(Duration::from_millis(1000 / 20)).await;

            if is_recording_controls {
                let capture_target = app.state::<ArcLock<App>>().try_read().ok().and_then(|s| {
                    match &s.recording_state {
                        RecordingState::Pending { target, .. } => Some(target.clone()),
                        RecordingState::Active(inner) => Some(inner.capture_target().clone()),
                        RecordingState::None => None,
                    }
                });

                let mut handled = false;

                if let Some(ref target) = capture_target {
                    match target {
                        ScreenCaptureTarget::Window { .. } => {
                            if let Some((px, py)) =
                                calculate_recording_controls_position_for_target(target)
                            {
                                let changed = match last_target_pos {
                                    Some((lx, ly)) => {
                                        (px - lx).abs() > 0.5 || (py - ly).abs() > 0.5
                                    }
                                    None => true,
                                };
                                if changed {
                                    let _ =
                                        window.set_position(tauri::LogicalPosition::new(px, py));
                                    last_target_pos = Some((px, py));
                                }
                                handled = true;
                            }
                        }
                        ScreenCaptureTarget::Area { .. } => {
                            handled = true;
                        }
                        _ => {}
                    }
                }

                if !handled && let Some(cursor_display_id) = get_display_id_for_cursor() {
                    let display_changed = current_display_id.as_ref() != Some(&cursor_display_id);

                    if display_changed
                        && let Some(display) = get_display_by_id(&cursor_display_id)
                        && let Some((pos_x, pos_y)) = calculate_bottom_center_position(&display)
                    {
                        let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));
                        current_display_id = Some(cursor_display_id);
                    }
                }
            }

            let map = state.0.read().await;

            let Some(windows) = map.get(window.label()) else {
                window.set_ignore_cursor_events(true).ok();
                continue;
            };

            let (Ok(window_position), Ok(mouse_position), Ok(scale_factor)) = (
                window.outer_position(),
                window.cursor_position(),
                window.scale_factor(),
            ) else {
                let _ = window.set_ignore_cursor_events(true);
                continue;
            };

            let mut ignore = true;

            for bounds in windows.values() {
                let x_min = (window_position.x as f64) + bounds.position().x() * scale_factor;
                let x_max = (window_position.x as f64)
                    + (bounds.position().x() + bounds.size().width()) * scale_factor;
                let y_min = (window_position.y as f64) + bounds.position().y() * scale_factor;
                let y_max = (window_position.y as f64)
                    + (bounds.position().y() + bounds.size().height()) * scale_factor;

                if mouse_position.x >= x_min
                    && mouse_position.x <= x_max
                    && mouse_position.y >= y_min
                    && mouse_position.y <= y_max
                {
                    ignore = false;
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

pub fn init(app: &AppHandle) {
    app.manage(FakeWindowBounds(Default::default()));
}
