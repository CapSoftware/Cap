use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

use base64::prelude::*;
use cap_recording::screen_capture::ScreenCaptureTarget;

use crate::{
    App, ArcLock, general_settings,
    recording_settings::RecordingTargetMode,
    window_exclusion::WindowExclusion,
    windows::{CapWindowId, ShowCapWindow},
};
use scap_targets::{
    Display, DisplayId, Window, WindowId,
    bounds::{LogicalBounds, LogicalSize, PhysicalSize},
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
    logical_size: Option<LogicalSize>,
    logical_bounds: Option<LogicalBounds>,
    refresh_rate: String,
}

#[specta::specta]
#[tauri::command]
#[instrument(skip(app, prewarmed))]
pub async fn prewarm_target_select_overlays(
    app: AppHandle,
    prewarmed: tauri::State<'_, PrewarmedOverlays>,
) -> Result<(), String> {
    if prewarmed.set_prewarming(true) {
        return Ok(());
    }

    prewarmed.cleanup_stale();

    let displays = scap_targets::Display::list();

    for display in displays {
        let display_id = display.id();

        if prewarmed.has(&display_id) {
            continue;
        }

        match (ShowCapWindow::TargetSelectOverlay {
            display_id: display_id.clone(),
            target_mode: None,
        })
        .show(&app)
        .await
        {
            Ok(window) => {
                prewarmed.store(display_id, window);
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to prewarm overlay for display {}: {}",
                    display_id,
                    e
                );
            }
        }
    }

    prewarmed.set_prewarming(false);

    Ok(())
}

#[specta::specta]
#[tauri::command]
#[instrument(skip(app, state, prewarmed))]
pub async fn open_target_select_overlays(
    app: AppHandle,
    state: tauri::State<'_, WindowFocusManager>,
    prewarmed: tauri::State<'_, PrewarmedOverlays>,
    focused_target: Option<ScreenCaptureTarget>,
    specific_display_id: Option<String>,
    target_mode: Option<RecordingTargetMode>,
) -> Result<(), String> {
    let start = Instant::now();

    let resolved_specific_display_id = specific_display_id.as_ref().map(|id_str| {
        id_str
            .parse::<DisplayId>()
            .unwrap_or_else(|_| Display::primary().id())
    });

    let display_ids = if let Some(display_id) = resolved_specific_display_id.clone() {
        vec![display_id]
    } else if let Some(display) = focused_target.as_ref().and_then(|t| t.display()) {
        vec![display.id()]
    } else {
        let displays = Display::list();
        if displays.is_empty() {
            vec![Display::primary().id()]
        } else {
            displays.into_iter().map(|display| display.id()).collect()
        }
    };

    let focus_display_id = resolved_specific_display_id
        .or_else(|| {
            focused_target
                .as_ref()
                .and_then(|t| t.display())
                .map(|d| d.id())
        })
        .or_else(|| Display::get_containing_cursor().map(|d| d.id()))
        .unwrap_or_else(|| Display::primary().id());

    for (id, window) in app.webview_windows() {
        if let Ok(CapWindowId::TargetSelectOverlay {
            display_id: existing_id,
        }) = CapWindowId::from_str(&id)
            && !display_ids
                .iter()
                .any(|display_id| display_id == &existing_id)
        {
            let _ = window.close();
        }
    }

    for display_id in &display_ids {
        let mut used_prewarmed = false;
        if let Some(window) = prewarmed.take(display_id) {
            window.show().ok();
            if display_id == &focus_display_id {
                window.set_focus().ok();
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
            let is_visible_after = window.is_visible().unwrap_or(false);

            if is_visible_after {
                used_prewarmed = true;
            } else {
                let _ = window.close();
            }
        }

        if used_prewarmed {
            continue;
        }

        let should_focus = display_id == &focus_display_id;

        if start.elapsed() < Duration::from_secs(1) {
            if let Ok(window) = (ShowCapWindow::TargetSelectOverlay {
                display_id: display_id.clone(),
                target_mode,
            })
            .show(&app)
            .await
            {
                window.show().ok();
                if should_focus {
                    window.set_focus().ok();
                }
            }
        } else {
            let app_clone = app.clone();
            let display_id_clone = display_id.clone();
            tokio::spawn(async move {
                if let Ok(window) = (ShowCapWindow::TargetSelectOverlay {
                    display_id: display_id_clone,
                    target_mode,
                })
                .show(&app_clone)
                .await
                {
                    window.show().ok();
                    if should_focus {
                        window.set_focus().ok();
                    }
                }
            });
        }
    }

    let focus_window = CapWindowId::TargetSelectOverlay {
        display_id: focus_display_id,
    }
    .get(&app);

    if let Some(window) = focus_window {
        window.set_focus().ok();
    }

    let window_exclusions = general_settings::GeneralSettingsStore::get(&app)
        .ok()
        .flatten()
        .map_or_else(general_settings::default_excluded_windows, |settings| {
            settings.excluded_windows
        });

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
                            if should_skip_window(&w, &window_exclusions) {
                                return None;
                            }

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
        app.global_shortcut()
            .register("Escape")
            .map_err(|err| error!("Error registering global keyboard shortcut for Escape: {err}"))
            .ok();
    }

    Ok(())
}

fn should_skip_window(window: &Window, exclusions: &[WindowExclusion]) -> bool {
    if exclusions.is_empty() {
        return false;
    }

    let owner_name = window.owner_name();
    let window_title = window.name();

    #[cfg(target_os = "macos")]
    let bundle_identifier = window.raw_handle().bundle_identifier();

    #[cfg(not(target_os = "macos"))]
    let bundle_identifier = None::<String>;

    exclusions.iter().any(|entry| {
        entry.matches(
            bundle_identifier.as_deref(),
            owner_name.as_deref(),
            window_title.as_deref(),
        )
    })
}

#[specta::specta]
#[tauri::command]
#[instrument(skip(app))]
pub async fn update_camera_overlay_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window("camera")
        .ok_or("Camera window not found")?;

    let width_u32 = width as u32;
    let height_u32 = height as u32;

    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: width_u32,
            height: height_u32,
        }))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: x as i32,
            y: y as i32,
        }))
        .map_err(|e| e.to_string())?;

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let logical_width = (width / scale_factor) as u32;
    let logical_height = (height / scale_factor) as u32;

    let state = app.state::<ArcLock<App>>();
    let app_state = state.read().await;
    app_state
        .camera_preview
        .notify_window_resized(logical_width, logical_height);

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
        logical_size: display.logical_size(),
        logical_bounds: display.raw_handle().logical_bounds(),
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
                let mut wp = WINDOWPLACEMENT {
                    length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                    ..Default::default()
                };

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

pub struct PrewarmedOverlays {
    windows: Mutex<HashMap<String, (WebviewWindow, Instant)>>,
    prewarming_in_progress: Mutex<bool>,
}

impl Default for PrewarmedOverlays {
    fn default() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
            prewarming_in_progress: Mutex::new(false),
        }
    }
}

impl PrewarmedOverlays {
    pub fn take(&self, display_id: &DisplayId) -> Option<WebviewWindow> {
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        windows.remove(&display_id.to_string()).map(|(w, _)| w)
    }

    pub fn store(&self, display_id: DisplayId, window: WebviewWindow) {
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        windows.insert(display_id.to_string(), (window, Instant::now()));
    }

    pub fn has(&self, display_id: &DisplayId) -> bool {
        let windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((window, created_at)) = windows.get(&display_id.to_string()) {
            if created_at.elapsed() > Duration::from_secs(30) {
                return false;
            }
            !window.is_visible().unwrap_or(false)
        } else {
            false
        }
    }

    pub fn set_prewarming(&self, in_progress: bool) -> bool {
        let mut prewarming = self
            .prewarming_in_progress
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let was_prewarming = *prewarming;
        *prewarming = in_progress;
        was_prewarming
    }

    pub fn cleanup_stale(&self) {
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        windows.retain(|_, (window, created_at)| {
            if created_at.elapsed() > Duration::from_secs(30) {
                let _ = window.close();
                false
            } else {
                true
            }
        });
    }
}

#[derive(Default)]
pub struct WindowFocusManager {
    task: Mutex<Option<JoinHandle<()>>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl WindowFocusManager {
    pub fn spawn(&self, id: &DisplayId, window: WebviewWindow) {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        tasks.insert(
            id.to_string(),
            tokio::spawn(async move {
                let app = window.app_handle();
                let mut main_window_was_seen = false;

                loop {
                    let cap_main = CapWindowId::Main.get(app);
                    let cap_settings = CapWindowId::Settings.get(app);

                    let main_window_available = cap_main.is_some();
                    let settings_window_available = cap_settings.is_some();

                    if main_window_available || settings_window_available {
                        main_window_was_seen = true;
                    }

                    if main_window_was_seen && !main_window_available && !settings_window_available
                    {
                        window.hide().ok();
                        break;
                    }

                    #[cfg(windows)]
                    if let Some(cap_main) = cap_main {
                        let should_refocus = cap_main.is_focused().ok().unwrap_or_default()
                            || window.is_focused().unwrap_or_default();

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
